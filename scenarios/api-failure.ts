/**
 * Scenario 4 — API server failure.
 *
 * Kills the K3s API server (kube-apiserver) mid-flight by exec'ing
 * `kill -9 1` inside the k3d server container.
 *
 * Expected Quilt behaviour:
 *   - The agent caches its last-known state
 *   - The cell continues to serve reads from local cache
 *   - The K3s supervisor restarts the API server automatically
 *   - The agent reconnects within 30 s and replays any buffered events
 */

import type { Scenario, ScenarioContext } from "../src/scenario-runner.js";
import { assertRecoveryTime } from "../src/assertions.js";

interface ApiFailureOptions {
  /** Recovery budget in ms. Default: 30 000. */
  readonly recoveryBudgetMs?: number;
  /** Number of times to kill the API server. Default: 1. */
  readonly kills?: number;
  /** Pause between kills in ms. Default: 1 000. */
  readonly pauseMs?: number;
}

export function createApiFailureScenario(opts: ApiFailureOptions = {}): Scenario {
  const budget = opts.recoveryBudgetMs ?? 30_000;
  const kills = opts.kills ?? 1;
  const pause = opts.pauseMs ?? 1_000;

  return {
    name: "api-failure",
    description: "Kill the K3s API server, assert the agent reconnects within budget",
    recoveryBudgetMs: budget,

    async run(ctx: ScenarioContext): Promise<void> {
      // 1) locate the server node.
      const nodes = await ctx.cluster.getNodes();
      const server = nodes.find((n) => n.role === "server");
      if (!server) throw new Error("no server node found in cluster");

      // 2) probe the API once so we know it was healthy BEFORE we kill it.
      const before = await probeApi(ctx, server.name);
      if (!before.reachable) {
        throw new Error("API server is not reachable before the scenario; refusing to run");
      }

      // 3) inject: SIGKILL the API server's PID 1 inside the k3d container.
      //    K3s has a supervisor that will restart it; this is the chaos we want.
      const start = Date.now();
      for (let i = 0; i < kills; i += 1) {
        const r = await ctx.client.execOnK3dNode(server.name, [
          "k3s",
          "kubectl",
          "-n",
          "kube-system",
          "exec",
          "kube-apiserver",
          "--",
          "kill",
          "-9",
          "1",
        ]);
        // Non-zero is fine — the API is going down.
        void r;
        if (i < kills - 1) await new Promise((res) => setTimeout(res, pause));
      }

      // 4) wait for the API to come back and the agent to reconnect.
      //    The agent publishes a "control-plane-restored" event on its
      //    `/events` stream; we poll it. Fall back to the API being reachable.
      while (Date.now() - start < budget) {
        if (ctx.signal.aborted) break;
        const after = await probeApi(ctx, server.name);
        const agentReconnected = await probeAgentReconnected(ctx);
        if (after.reachable && agentReconnected) {
          ctx.report.assertions.push(assertRecoveryTime(start, Date.now(), budget));
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      ctx.report.assertions.push(
        assertRecoveryTime(start, Date.now(), budget, null),
      );
    },

    async heal(_ctx: ScenarioContext): Promise<void> {
      // The K3s supervisor will have restarted the API server by now; no
      // further action needed. We keep the hook for symmetry.
    },
  };
}

async function probeApi(
  ctx: ScenarioContext,
  serverNode: string,
): Promise<{ reachable: boolean; latencyMs: number }> {
  const out = await ctx.client.execOnK3dNode(serverNode, [
    "k3s",
    "kubectl",
    "get",
    "--raw",
    "/healthz",
  ]);
  return { reachable: out.exitCode === 0 && out.stdout.includes("ok"), latencyMs: out.durationMs };
}

async function probeAgentReconnected(ctx: ScenarioContext): Promise<boolean> {
  const pods = await ctx.cluster.getPods();
  const agent = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-agent-"));
  if (!agent) return false;
  // We can't hit the API directly while it's down, so check the agent's own
  // /healthz which reports `apiserver: connected` when the connection is up.
  const out = await ctx.client.exec("quilt", agent.name, "quilt", [
    "wget",
    "-qO-",
    "http://127.0.0.1:8081/healthz",
  ]);
  return out.exitCode === 0 && /apiserver['":\s]+connected/.test(out.stdout);
}

export const apiFailure: Scenario = createApiFailureScenario();
