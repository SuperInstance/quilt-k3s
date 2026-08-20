/**
 * Scenario 1 — Node failure.
 *
 * Cordons and drains an agent node, asserts that the Quilt agent DaemonSet
 * is rescheduled and that the quilt-cell StatefulSet pod re-spawns within
 * the recovery budget.
 *
 *   kubectl cordon <node>
 *   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
 *
 * Expected Quilt behaviour:
 *   - quilt-agent on the dying node is rescheduled to a healthy node
 *   - quilt-cell reaches the previous generation within 30 s
 *   - no data loss (the cell is a StatefulSet with persistent storage)
 */

import type { Scenario, ScenarioContext } from "../src/scenario-runner.js";
import { assertPodsHealthy } from "../src/assertions.js";

interface NodeFailureOptions {
  /** Recovery budget in ms. Default: 30 000. */
  readonly recoveryBudgetMs?: number;
  /** Only consider agents in this state for selection. Default: "ready". */
  readonly preferredState?: "ready" | "any";
}

export function createNodeFailureScenario(opts: NodeFailureOptions = {}): Scenario {
  const budget = opts.recoveryBudgetMs ?? 30_000;
  const preferredState = opts.preferredState ?? "ready";

  return {
    name: "node-failure",
    description: "Cordon + drain a node, assert Quilt recovers within budget",
    recoveryBudgetMs: budget,

    async run(ctx: ScenarioContext): Promise<void> {
      // 1) pick a victim node (prefer an agent that is currently Ready)
      const nodes = await ctx.cluster.getNodes();
      const victim =
        preferredState === "any"
          ? nodes.find((n) => n.role === "agent")
          : nodes.find((n) => n.role === "agent" && n.state === "ready");
      if (!victim) {
        throw new Error("no agent node available to fail");
      }

      // 2) inject: cordon + drain
      await ctx.client.cordon(victim.name);
      await ctx.client.drain(victim.name, {
        ignoreDaemonsets: true,
        deleteEmptyDirData: true,
        force: true,
        timeoutSeconds: 60,
      });

      // 3) wait for the rescheduled pods to be Ready (bounded by run()).
      // The ScenarioRunner will perform the recovery-time assertion for us;
      // we also add a stronger "all quilt pods are Ready" assertion here so
      // that the report makes the success criteria explicit.
      const deadline = Date.now() + budget;
      let last: import("../src/assertions.js").HealthSnapshot | null = null;
      while (Date.now() < deadline) {
        if (ctx.signal.aborted) break;
        const pods = await ctx.cluster.getPods();
        last = {
          takenAt: Date.now(),
          pods: pods.map((p) => ({
            namespace: p.namespace,
            name: p.name,
            ready: p.ready,
            status: p.status,
            restarts: p.restarts,
          })),
        };
        const ready = last.pods.filter(
          (p) =>
            p.namespace === "quilt" &&
            p.status === "Running" &&
            p.ready !== "0/0" &&
            p.node !== victim.name,
        );
        if (ready.length >= 2) {
          ctx.report.assertions.push(
            await assertPodsHealthy(last, {
              namespace: "quilt",
              minReady: 2,
              maxRestarts: 5,
            }),
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      // If we got here, the loop timed out — record a failure.
      ctx.report.assertions.push(
        await assertPodsHealthy(
          last ?? { takenAt: Date.now(), pods: [] },
          { namespace: "quilt", minReady: 2, maxRestarts: 5 },
        ),
      );
    },

    async heal(ctx: ScenarioContext): Promise<void> {
      // Best-effort uncordon of every cordoned node. Production chaos CI
      // re-creates the cluster for each run, but local developers may want
      // to reuse a cluster between runs.
      const nodes = await ctx.cluster.getNodes();
      for (const n of nodes) {
        try {
          await ctx.client.uncordon(n.name);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export const nodeFailure: Scenario = createNodeFailureScenario();
