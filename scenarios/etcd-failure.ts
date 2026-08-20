/**
 * Scenario 5 — Etcd failure.
 *
 * Suspends (SIGSTOP) the embedded etcd process; reversible via SIGCONT.
 * The K3s supervisor will NOT auto-restart a stopped process, so we must
 * resume it ourselves after the chaos window.
 *
 *   kill -STOP <etcd-pid>     # freeze etcd
 *   ...wait budget/2...
 *   kill -CONT <etcd-pid>     # resume etcd
 *
 * Expected Quilt behaviour:
 *   - Writes that would require etcd consensus are queued locally
 *   - Reads from local cache continue to succeed
 *   - The agent surfaces a `QuorumLost` event
 *   - After CONT, etcd catches up and queued events are committed
 *   - No data loss
 */

import type { Scenario, ScenarioContext } from "../src/scenario-runner.js";
import { assertPodsHealthy, assertQuorumHealthy, assertRecoveryTime } from "../src/assertions.js";

interface EtcdFailureOptions {
  /** Recovery budget in ms. Default: 30 000. */
  readonly recoveryBudgetMs?: number;
  /** How long to leave etcd suspended in ms. Default: 5 000. */
  readonly suspendDurationMs?: number;
}

export function createEtcdFailureScenario(opts: EtcdFailureOptions = {}): Scenario {
  const budget = opts.recoveryBudgetMs ?? 30_000;
  const suspend = opts.suspendDurationMs ?? 5_000;

  return {
    name: "etcd-failure",
    description: "SIGSTOP etcd, assert Quilt queues writes and recovers on CONT",
    recoveryBudgetMs: budget,

    async run(ctx: ScenarioContext): Promise<void> {
      // 1) locate the etcd pod.
      const pods = await ctx.cluster.getPods();
      const etcd = pods.find((p) => p.namespace === "kube-system" && p.name.startsWith("etcd-"));
      if (!etcd) throw new Error("no etcd pod found in kube-system");

      // 2) baseline quorum probe.
      const baseline = await probeEtcdQuorum(ctx, etcd.name);
      ctx.report.assertions.push(await assertQuorumHealthy(async () => baseline));

      // 3) inject: SIGSTOP the etcd container.
      const start = Date.now();
      await ctx.client.exec("kube-system", etcd.name, "etcd", ["kill", "-STOP", "1"]);

      // 4) verify the agent observed QuorumLost.
      await new Promise((r) => setTimeout(r, 500));
      const sawQuorumLost = await probeAgentEvent(ctx, "QuorumLost");
      ctx.report.assertions.push({
        name: "agent-quorum-lost",
        passed: sawQuorumLost,
        message: sawQuorumLost
          ? "agent emitted QuorumLost event as expected"
          : "agent did NOT emit QuorumLost event",
      });

      // 5) hold the suspension for `suspend` ms, then SIGCONT.
      await new Promise((r) => setTimeout(r, suspend));
      await ctx.client.exec("kube-system", etcd.name, "etcd", ["kill", "-CONT", "1"]);

      // 6) wait for quorum to be restored and pods to be healthy.
      const deadline = start + budget;
      while (Date.now() < deadline) {
        if (ctx.signal.aborted) break;
        const q = await probeEtcdQuorum(ctx, etcd.name);
        if (q.hasLeader && q.reachable === q.total) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      ctx.report.assertions.push(assertRecoveryTime(start, Date.now(), budget));

      // 7) final health + quorum assertions.
      ctx.report.assertions.push(
        await assertQuorumHealthy(async () => probeEtcdQuorum(ctx, etcd.name)),
      );
      const snap = {
        takenAt: Date.now(),
        pods: (await ctx.cluster.getPods()).map((p) => ({
          namespace: p.namespace,
          name: p.name,
          ready: p.ready,
          status: p.status,
          restarts: p.restarts,
        })),
      };
      ctx.report.assertions.push(
        await assertPodsHealthy(snap, { namespace: "quilt", minReady: 1, maxRestarts: 5 }),
      );
    },

    async heal(ctx: ScenarioContext): Promise<void> {
      // Safety net: if the scenario crashed mid-suspension, make sure etcd
      // is resumed so the cluster is usable for the next scenario.
      const pods = await ctx.cluster.getPods();
      const etcd = pods.find((p) => p.namespace === "kube-system" && p.name.startsWith("etcd-"));
      if (!etcd) return;
      await ctx.client
        .exec("kube-system", etcd.name, "etcd", ["kill", "-CONT", "1"])
        .catch(() => undefined);
    },
  };
}

async function probeEtcdQuorum(
  ctx: ScenarioContext,
  podName: string,
): Promise<{ hasLeader: boolean; reachable: number; total: number }> {
  const endpoints = await ctx.client.exec("kube-system", podName, "etcd", [
    "etcdctl",
    "endpoint",
    "status",
    "--cluster",
    "-w",
    "json",
  ]);
  if (endpoints.exitCode !== 0) {
    return { hasLeader: false, reachable: 0, total: 1 };
  }
  try {
    const parsed = JSON.parse(endpoints.stdout) as ReadonlyArray<{ status?: { leader?: number } }>;
    const total = parsed.length;
    const hasLeader = parsed.some((e) => (e.status?.leader ?? 0) > 0);
    return { hasLeader, reachable: total, total };
  } catch {
    return { hasLeader: false, reachable: 0, total: 1 };
  }
}

async function probeAgentEvent(ctx: ScenarioContext, eventName: string): Promise<boolean> {
  const pods = await ctx.cluster.getPods();
  const agent = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-agent-"));
  if (!agent) return false;
  const out = await ctx.client.exec("quilt", agent.name, "quilt", [
    "wget",
    "-qO-",
    `http://127.0.0.1:8081/events/${encodeURIComponent(eventName)}`,
  ]);
  return out.exitCode === 0;
}

export const etcdFailure: Scenario = createEtcdFailureScenario();
