/**
 * Cluster — manages an ephemeral k3d (K3s-in-Docker) cluster for chaos runs.
 *
 * The class is intentionally thin: it shells out to the `k3d` and `kubectl`
 * CLIs via the injected {@link Executor} so the production path can be mocked
 * in tests.
 */

import { K3sClient } from "./k3s-client.js";

/** Options accepted by {@link Cluster.create}. */
export interface ClusterOptions {
  /** Number of agent (worker) nodes. Server (control-plane) is always 1. Default: 3. */
  readonly nodes?: number;
  /** k3d cluster name. Default: "quilt-chaos". */
  readonly name?: string;
  /** K3s image to use. Default: "rancher/k3s:v1.30.2-k3s1". */
  readonly image?: string;
  /** Inject a custom executor (used by tests). */
  readonly executor?: Executor;
  /** Milliseconds to wait for nodes to become Ready. Default: 60_000. */
  readonly readyTimeoutMs?: number;
}

/** Description of a single cluster node, as returned by `k3d node list`. */
export interface ClusterNode {
  readonly name: string;
  readonly role: "server" | "agent";
  readonly state: "ready" | "notready" | "unknown";
  readonly ipAddress?: string;
}

/** Description of a single pod, as returned by `kubectl get pods -A`. */
export interface ClusterPod {
  readonly namespace: string;
  readonly name: string;
  readonly ready: string;
  readonly status: string;
  readonly restarts: number;
  readonly node?: string;
  readonly age: string;
}

/**
 * Minimal subprocess interface so tests can mock k3d/kubectl invocations
 * without spawning real processes.
 */
export interface Executor {
  exec(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Default executor that shells out via Node's `child_process`. */
const defaultExecutor: Executor = {
  async exec(command, args) {
    const { execa } = await import("execa");
    try {
      const result = await execa(command, [...args]);
      return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; exitCode?: number };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: e.exitCode ?? 1,
      };
    }
  },
};

/**
 * Manages a k3d cluster. Construct via {@link Cluster.create}; always pair
 * with a {@link Cluster.delete} call (or use `await using` in modern Node).
 */
export class Cluster {
  readonly name: string;
  readonly image: string;
  readonly nodes: number;
  private readonly executor: Executor;
  private readonly readyTimeoutMs: number;
  private _client: K3sClient | null = null;
  private _deleted = false;

  private constructor(opts: Required<Omit<ClusterOptions, "executor" | "readyTimeoutMs">> & { executor: Executor; readyTimeoutMs: number }) {
    this.name = opts.name;
    this.image = opts.image;
    this.nodes = opts.nodes;
    this.executor = opts.executor;
    this.readyTimeoutMs = opts.readyTimeoutMs;
  }

  /**
   * Provision a new k3d cluster with 1 server + `opts.nodes` agents.
   * Does NOT wait for Ready — call {@link Cluster.waitForReady} explicitly.
   * This separation lets tests verify failure paths.
   *
   * @throws if the cluster already exists or if `k3d` is not installed.
   */
  static async create(options: ClusterOptions = {}): Promise<Cluster> {
    const cluster = new Cluster({
      name: options.name ?? "quilt-chaos",
      image: options.image ?? "rancher/k3s:v1.30.2-k3s1",
      nodes: options.nodes ?? 3,
      executor: options.executor ?? defaultExecutor,
      readyTimeoutMs: options.readyTimeoutMs ?? 60_000,
    });
    await cluster.provision();
    return cluster;
  }

  /** Get a {@link K3sClient} bound to this cluster's kubeconfig. */
  get client(): K3sClient {
    if (this._client === null) {
      this._client = new K3sClient({ kubeconfig: this.kubeconfigPath() });
    }
    return this._client;
  }

  /** Filesystem path to the kubeconfig file generated for this cluster. */
  kubeconfigPath(): string {
    return `~/.k3d/${this.name}/kubeconfig.yaml`;
  }

  /** Returns true if the underlying k3d cluster still exists. */
  async exists(): Promise<boolean> {
    const { exitCode } = await this.executor.exec("k3d", ["cluster", "get", this.name]);
    return exitCode === 0;
  }

  /** Returns true if the cluster has been deleted. */
  get isDeleted(): boolean {
    return this._deleted;
  }

  /** Tear the cluster down. Idempotent. */
  async delete(): Promise<void> {
    if (this._deleted) return;
    await this.executor.exec("k3d", ["cluster", "delete", this.name]);
    this._deleted = true;
  }

  /** List all nodes in the cluster. */
  async getNodes(): Promise<readonly ClusterNode[]> {
    const { stdout } = await this.executor.exec("k3d", [
      "node",
      "list",
      "--output",
      "json",
      "--cluster",
      this.name,
    ]);
    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout) as ReadonlyArray<{
      name: string;
      role: string;
      state?: { status?: string };
      ip?: { address?: string };
    }>;
    return raw.map((n) => ({
      name: n.name,
      role: (n.role === "server" ? "server" : "agent") as ClusterNode["role"],
      state: ((): ClusterNode["state"] => {
        const s = n.state?.status;
        if (s === "ready") return "ready";
        if (s === "notready") return "notready";
        return "unknown";
      })(),
      ipAddress: n.ip?.address,
    }));
  }

  /** List all pods across all namespaces. */
  async getPods(): Promise<readonly ClusterPod[]> {
    const { stdout } = await this.executor.exec("kubectl", [
      "--kubeconfig",
      this.kubeconfigPath(),
      "get",
      "pods",
      "-A",
      "-o",
      "json",
    ]);
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout) as {
      items: ReadonlyArray<{
        metadata: { name: string; namespace: string };
        status: {
          phase?: string;
          containerStatuses?: ReadonlyArray<{ restartCount: number; ready: boolean }>;
        };
        spec: { nodeName?: string };
      }>;
    };
    return parsed.items.map((p) => {
      const containers = p.status.containerStatuses ?? [];
      const ready = containers.filter((c) => c.ready).length;
      const total = containers.length;
      return {
        namespace: p.metadata.namespace,
        name: p.metadata.name,
        ready: total === 0 ? "0/0" : `${ready}/${total}`,
        status: p.status.phase ?? "Unknown",
        restarts: containers.reduce((acc, c) => acc + c.restartCount, 0),
        node: p.spec.nodeName,
        age: "0s",
      };
    });
  }

  /** Wait until every node reports `Ready`. */
  async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      const nodes = await this.getNodes();
      const allReady = nodes.length > 0 && nodes.every((n) => n.state === "ready");
      if (allReady) return;
      await sleep(500);
    }
    throw new Error(`Cluster ${this.name} did not become Ready within ${this.readyTimeoutMs}ms`);
  }

  // ───────────────────────── private ─────────────────────────

  private async provision(): Promise<void> {
    const args = [
      "cluster",
      "create",
      this.name,
      "--image",
      this.image,
      "--agents",
      String(this.nodes),
      "--wait",
      "--timeout",
      `${Math.floor(this.readyTimeoutMs / 1000)}s`,
    ];
    const { exitCode, stderr } = await this.executor.exec("k3d", args);
    if (exitCode !== 0) {
      throw new Error(`k3d cluster create failed: ${stderr}`);
    }
    // Note: we do NOT call waitForReady here. The caller decides whether to
    //   block until the cluster is ready. This keeps `provision()` focused
    //   on the k3d invocation and lets tests verify failure paths.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
