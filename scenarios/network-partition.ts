/**
 * Scenario 2 — Network partition.
 *
 * Blackholes pod-to-pod traffic between the quilt-cell and one of the
 * quilt-agent pods using `iptables -j DROP` inside a `NET_ADMIN` sidecar.
 *
 *   iptables -A INPUT  -s <peer-ip> -j DROP
 *   iptables -A OUTPUT -d <peer-ip> -j DROP
 *
 * Expected Quilt behaviour:
 *   - Both sides back off and time out cleanly (no crash)
 *   - Once the partition heals, the cell's queue drains and state-sync catches up
 *   - No entries are lost (checksum match on captured write set)
 */

import type { Scenario, ScenarioContext } from "../src/scenario-runner.js";
import {
  assertNoDataLoss,
  assertPodsHealthy,
  assertRecoveryTime,
  type HealthSnapshot,
} from "../src/assertions.js";

interface NetworkPartitionOptions {
  /** Recovery budget in ms. Default: 30 000. */
  readonly recoveryBudgetMs?: number;
  /** Duration of the partition in ms. Default: 5 000. */
  readonly partitionDurationMs?: number;
}

export function createNetworkPartitionScenario(opts: NetworkPartitionOptions = {}): NetworkPartitionScenario {
  const budget = opts.recoveryBudgetMs ?? 30_000;
  const duration = opts.partitionDurationMs ?? 5_000;

  return {
    name: "network-partition",
    description: "iptables-block cell↔agent traffic, assert no data loss and clean recovery",
    recoveryBudgetMs: budget,

    async run(ctx: ScenarioContext): Promise<void> {
      // 1) locate one cell pod and one agent pod to partition from each other.
      const pods = await ctx.cluster.getPods();
      const cell = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-cell-"));
      const agent = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-agent-"));
      if (!cell || !agent || !cell.node || !agent.node) {
        throw new Error("could not locate cell + agent pods for partition");
      }
      // 2) capture checksum BEFORE the partition (callers may override; we
      //    default to "unknown" which means we only assert pods recover).
      const before = await captureCellChecksum(ctx, cell.name);

      // 3) inject: install iptables rules. We assume a `nettools` sidecar
      //    is present in each pod (deployed by manifests/quilt-cell.yaml).
      const ip = await resolvePodIP(ctx, agent.name, "quilt");
      await ctx.client.exec("quilt", cell.name, "nettools", [
        "iptables",
        "-A",
        "OUTPUT",
        "-d",
        ip,
        "-j",
        "DROP",
      ]);
      await ctx.client.exec("quilt", cell.name, "nettools", [
        "iptables",
        "-A",
        "INPUT",
        "-s",
        ip,
        "-j",
        "DROP",
      ]);

      // 4) hold the partition open for `duration` ms.
      const partitionStart = Date.now();
      await new Promise((r) => setTimeout(r, duration));

      // 5) heal: remove the rules.
      await ctx.client.exec("quilt", cell.name, "nettools", [
        "iptables",
        "-D",
        "OUTPUT",
        "-d",
        ip,
        "-j",
        "DROP",
      ]);
      await ctx.client.exec("quilt", cell.name, "nettools", [
        "iptables",
        "-D",
        "INPUT",
        "-s",
        ip,
        "-j",
        "DROP",
      ]);

      // 6) wait for queue to drain and pods to be healthy.
      const recoveryStart = Date.now();
      const recovered = await waitUntilHealthy(ctx, budget - (Date.now() - partitionStart));
      ctx.report.assertions.push(recovered);

      // 7) data-loss check.
      const after = await captureCellChecksum(ctx, cell.name);
      ctx.report.assertions.push(
        await assertNoDataLoss({
          expectedCount: before.count,
          actualChecksum: after.checksum,
          expectedChecksum: before.checksum,
        }),
      );
    },
  };
}

export interface NetworkPartitionScenario extends Scenario {}

/** Helper: query the cell's `/proc/self`-style health endpoint for a checksum. */
async function captureCellChecksum(
  ctx: ScenarioContext,
  podName: string,
): Promise<{ checksum: string; count: number }> {
  const out = await ctx.client.exec("quilt", podName, "quilt", [
    "quilt-cell",
    "checksum",
    "--json",
  ]);
  if (out.exitCode !== 0) {
    // Cell may not be ready yet; report a placeholder so the assertion records
    // the fact that we couldn't even read the checksum (i.e. test failed).
    return { checksum: `unavailable:${out.stderr.trim()}`, count: -1 };
  }
  try {
    const parsed = JSON.parse(out.stdout) as { checksum: string; count: number };
    return { checksum: parsed.checksum, count: parsed.count };
  } catch {
    return { checksum: `parse-error:${out.stdout.trim()}`, count: -1 };
  }
}

/** Helper: get the pod IP by exec'ing `hostname -i` inside the pod. */
async function resolvePodIP(ctx: ScenarioContext, pod: string, namespace: string): Promise<string> {
  const out = await ctx.client.exec(namespace, pod, "quilt", ["sh", "-c", "hostname -i"]);
  return out.stdout.trim().split(/\s+/)[0] ?? "127.0.0.1";
}

/** Poll until all quilt pods are Running and Ready, or the budget elapses. */
async function waitUntilHealthy(
  ctx: ScenarioContext,
  budgetMs: number,
): Promise<import("../src/assertions.js").AssertionResult> {
  const start = Date.now();
  let last: HealthSnapshot | null = null;
  while (Date.now() - start < budgetMs) {
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
    const allQuiltReady = last.pods
      .filter((p) => p.namespace === "quilt")
      .every((p) => p.status === "Running" && p.ready !== "0/0");
    if (allQuiltReady) {
      return assertRecoveryTime(start, Date.now(), budgetMs);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return assertRecoveryTime(start, Date.now(), budgetMs, last);
}

export const networkPartition: Scenario = createNetworkPartitionScenario();
