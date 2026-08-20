/**
 * K3sClient — typed wrapper around the Kubernetes API + kubectl exec.
 *
 * Wraps `@kubernetes/client-node` for typed CRUD operations and shells out to
 * `kubectl exec` for things that the API can't do (iptables, fallocate, etc).
 */

import { CoreV1Api, KubernetesObject, V1Pod } from "@kubernetes/client-node";

/** Options for {@link K3sClient.cordon}. */
export interface CordonOptions {
  /** Also evict pods with this call. Equivalent to `kubectl drain`. */
  readonly drain?: boolean;
  /** Continue even if there are pods not managed by a ReplicationController etc. */
  readonly force?: boolean;
  /** Ignore DaemonSet-managed pods. */
  readonly ignoreDaemonsets?: boolean;
  /** Delete pods with emptyDir volumes. */
  readonly deleteEmptyDirData?: boolean;
  /** Per-request timeout in seconds. */
  readonly timeoutSeconds?: number;
}

/** A JSON Merge Patch (RFC 7396). */
export type Patch = Readonly<Record<string, unknown>>;

/** Result of a `kubectl exec` invocation. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/** Subprocess executor — kept narrow so tests can stub it. */
export type SubprocessExec = (command: string, args: readonly string[]) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** Options for {@link K3sClient}. */
export interface K3sClientOptions {
  /** Path to a kubeconfig file. If omitted, the default `KUBECONFIG` env / `~/.kube/config` is used. */
  readonly kubeconfig?: string;
  /** Inject a subprocess executor (used by tests). */
  readonly executor?: SubprocessExec;
}

/**
 * Thin wrapper around the Kubernetes API plus the bits of `kubectl` we need
 * that aren't directly expressible as a REST call.
 */
export class K3sClient {
  private readonly core: CoreV1Api;
  private readonly kubeconfig: string | undefined;
  private readonly exec: SubprocessExec;

  constructor(opts: K3sClientOptions = {}) {
    this.kubeconfig = opts.kubeconfig;
    this.exec =
      opts.executor ??
      (async (command, args) => {
        const { execa } = await import("execa");
        try {
          const r = await execa(command, [...args]);
          return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: 0 };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; exitCode?: number };
          return {
            stdout: e.stdout ?? "",
            stderr: e.stderr ?? "",
            exitCode: e.exitCode ?? 1,
          };
        }
      });

    // Lazy-load the client so tests that only use kubectl-style methods don't
    // need a valid kubeconfig.
    const k8s = this.loadClient();
    this.core = k8s;
  }

  // ───────────────────────── node ops ─────────────────────────

  /** Mark `nodeName` as unschedulable (`kubectl cordon`). */
  async cordon(nodeName: string): Promise<void> {
    const patch: Patch = { spec: { unschedulable: true } };
    await this.patchNode(nodeName, patch);
  }

  /** Mark `nodeName` as schedulable again (`kubectl uncordon`). */
  async uncordon(nodeName: string): Promise<void> {
    const patch: Patch = { spec: { unschedulable: false } };
    await this.patchNode(nodeName, patch);
  }

  /**
   * Drain a node: cordon it, then evict all evictable pods.
   *
   * @throws if any pod refuses to be evicted within the timeout.
   */
  async drain(nodeName: string, opts: CordonOptions = {}): Promise<void> {
    await this.cordon(nodeName);
    const pods = await this.listPodsOnNode(nodeName);
    for (const pod of pods) {
      if (shouldSkipDuringDrain(pod, opts)) continue;
      await this.deletePod(pod.metadata!.namespace!, pod.metadata!.name!, {
        gracePeriodSeconds: opts.timeoutSeconds ?? 30,
      });
    }
  }

  // ───────────────────────── pod ops ─────────────────────────

  /** List pods scheduled on a given node. */
  async listPodsOnNode(nodeName: string): Promise<readonly V1Pod[]> {
    const fieldSelector = encodeURIComponent(`spec.nodeName=${nodeName}`);
    const resp = await this.core.listPodForAllNamespaces(undefined, undefined, fieldSelector);
    return resp.items;
  }

  /** Delete a pod by namespace + name. */
  async deletePod(namespace: string, name: string, opts: { gracePeriodSeconds?: number } = {}): Promise<void> {
    await this.core.deleteNamespacedPod(
      name,
      namespace,
      undefined,
      undefined,
      opts.gracePeriodSeconds,
      undefined,
      "Background",
    );
  }

  /** Apply a JSON merge patch to a pod. */
  async patchPod(namespace: string, name: string, patch: Patch): Promise<V1Pod> {
    return (await this.core.patchNamespacedPod(
      name,
      namespace,
      patch as unknown as KubernetesObject,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )) as V1Pod;
  }

  // ───────────────────────── generic ops ─────────────────────────

  /** Apply a JSON merge patch to a node. */
  async patchNode(name: string, patch: Patch): Promise<void> {
    await this.core.patchNode(name, patch as unknown as KubernetesObject, undefined, undefined, undefined, undefined, undefined, undefined);
  }

  /** Apply a JSON merge patch to an arbitrary namespaced object. */
  async patchNamespaced(kind: string, namespace: string, name: string, patch: Patch): Promise<void> {
    const safeKind = kind.toLowerCase();
    // The K8s client API has one method per kind, so we dispatch on the kind
    // string. Anything outside this small set throws.
    switch (safeKind) {
      case "pod":
        await this.patchPod(namespace, name, patch);
        return;
      case "deployment":
        await this.core.patchNamespacedDeployment(name, namespace, patch as unknown as KubernetesObject, undefined, undefined, undefined, undefined, undefined);
        return;
      case "statefulset":
        await this.core.patchNamespacedStatefulSet(name, namespace, patch as unknown as KubernetesObject, undefined, undefined, undefined, undefined, undefined);
        return;
      case "configmap":
        await this.core.patchNamespacedConfigMap(name, namespace, patch as unknown as KubernetesObject, undefined, undefined, undefined, undefined, undefined);
        return;
      case "service":
        await this.core.patchNamespacedService(name, namespace, patch as unknown as KubernetesObject, undefined, undefined, undefined, undefined, undefined);
        return;
      default:
        throw new Error(`K3sClient.patchNamespaced: unsupported kind "${kind}"`);
    }
  }

  // ───────────────────────── exec ─────────────────────────

  /**
   * Run `command` inside `container` of `pod` in `namespace`. Returns the
   * combined stdout/stderr and exit code. Times out after `timeoutMs`.
   */
  async exec(
    namespace: string,
    pod: string,
    container: string,
    command: readonly string[],
    opts: { timeoutMs?: number; kubeconfigOverride?: string } = {},
  ): Promise<ExecResult> {
    const kc = opts.kubeconfigOverride ?? this.kubeconfig;
    const args: string[] = [];
    if (kc) args.push("--kubeconfig", kc);
    args.push("exec", "-n", namespace, pod, "-c", container, "--");
    args.push(...command);

    const start = Date.now();
    const result = await this.exec("kubectl", args);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run `command` on the k3d host (i.e. inside the k3d container). Used by
   * the API-server and etcd failure scenarios.
   */
  async execOnK3dNode(nodeName: string, command: readonly string[]): Promise<ExecResult> {
    const args = ["node", "exec", nodeName, "--"];
    args.push(...command);
    const start = Date.now();
    const result = await this.exec("k3d", args);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
    };
  }

  // ───────────────────────── private ─────────────────────────

  private loadClient(): CoreV1Api {
    // Lazy import so the consumer pays nothing if they only use kubectl exec.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const k8s = require("@kubernetes/client-node") as typeof import("@kubernetes/client-node");
    const { KubeConfig, CoreV1Api: CApi } = k8s;
    const kc = new KubeConfig();
    if (this.kubeconfig) {
      kc.loadFromFile(this.kubeconfig);
    } else {
      kc.loadFromDefault();
    }
    return kc.makeApiClient(CApi);
  }
}

function shouldSkipDuringDrain(pod: V1Pod, opts: CordonOptions): boolean {
  const ownerKinds = (pod.metadata?.ownerReferences ?? []).map((o) => o.kind);
  if (opts.ignoreDaemonsets && ownerKinds.includes("DaemonSet")) return true;
  if (!opts.force && ownerKinds.length === 0) return true;
  return false;
}
