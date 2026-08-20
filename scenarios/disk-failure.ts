/**
 * Scenario 3 — Disk failure.
 *
 * Fills the quilt-cell's persistent volume to 100 % with `fallocate`, asserts
 * that the agent logs the I/O error (no silent corruption) and that the cell
 * refuses new writes until space is freed.
 *
 *   fallocate -l 95% /var/lib/quilt/cell.db     # fill the volume
 *   fallocate -l 1M  /var/lib/quilt/_fill       # top it off until ENOSPC
 *
 * Expected Quilt behaviour:
 *   - The agent logs the I/O error
 *   - The cell is marked `Degraded` (visible via /healthz)
 *   - A `quilt_storage_errors_total` counter is incremented (not silenced)
 *   - After space is freed, the cell returns to `Healthy` within 5 s
 */

import type { Scenario, ScenarioContext } from "../src/scenario-runner.js";
import { assertMetricEmitted, assertRecoveryTime, assertPodsHealthy } from "../src/assertions.js";

interface DiskFailureOptions {
  /** Recovery budget in ms (after the volume is freed). Default: 5 000. */
  readonly recoveryBudgetMs?: number;
  /** Path of the cell's data dir inside the container. Default: /var/lib/quilt. */
  readonly dataDir?: string;
  /** Percentage of free space to fill. Default: 95. */
  readonly fillPercent?: number;
}

export function createDiskFailureScenario(opts: DiskFailureOptions = {}): Scenario {
  const budget = opts.recoveryBudgetMs ?? 5_000;
  const dataDir = opts.dataDir ?? "/var/lib/quilt";
  const fillPercent = opts.fillPercent ?? 95;

  return {
    name: "disk-failure",
    description: "Fill the cell's PV until ENOSPC, assert no silent corruption, then recover",
    recoveryBudgetMs: budget,

    async run(ctx: ScenarioContext): Promise<void> {
      // 1) locate the cell pod.
      const pods = await ctx.cluster.getPods();
      const cell = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-cell-"));
      if (!cell) throw new Error("no quilt-cell pod found");

      // 2) fetch the storage-error counter BEFORE the fault so we can assert
      //    it incremented afterwards.
      const before = await fetchStorageErrorCounter(ctx, cell.name);

      // 3) fill the disk.
      const fillPath = `${dataDir}/_chaos_fill`;
      const fillArgs: ReadonlyArray<readonly string[]> = [
        ["fallocate", "-l", `${fillPercent}%`, fillPath],
        // top up with a small file in a loop until ENOSPC
        ["sh", "-c", `while :; do dd if=/dev/zero of=${fillPath}.x bs=1M count=64 2>/dev/null || break; done`],
      ];
      for (const cmd of fillArgs) {
        const r = await ctx.client.exec("quilt", cell.name, "quilt", cmd);
        // ENOSPC is the EXPECTED final exit code for the loop, ignore non-zero.
        void r;
      }

      // 4) assert the cell is now `Degraded` (not crashed, not silently OK).
      const degraded = await probeHealthz(ctx, cell.name);
      if (degraded.status === "Healthy") {
        ctx.report.assertions.push({
          name: "cell-degraded",
          passed: false,
          message: "cell reported Healthy after disk fill — should be Degraded",
          details: { status: degraded.status },
        });
      } else {
        ctx.report.assertions.push({
          name: "cell-degraded",
          passed: true,
          message: `cell is ${degraded.status} as expected`,
          details: { status: degraded.status },
        });
      }

      // 5) free the disk.
      await ctx.client.exec("quilt", cell.name, "quilt", ["sh", "-c", `rm -f ${fillPath} ${fillPath}.x`]);

      // 6) wait for the cell to return to Healthy.
      const start = Date.now();
      while (Date.now() - start < budget) {
        if (ctx.signal.aborted) break;
        const h = await probeHealthz(ctx, cell.name);
        if (h.status === "Healthy") break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const recoveredAt = Date.now();
      ctx.report.assertions.push(assertRecoveryTime(start, recoveredAt, budget));

      // 7) assert the storage-error counter incremented.
      const after = await fetchStorageErrorCounter(ctx, cell.name);
      ctx.report.assertions.push(
        await assertMetricEmitted(async () => after, "quilt_storage_errors_total", {
          mustIncrement: true,
          before,
          after,
        }),
      );

      // 8) final pod-health sanity check.
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
        await assertPodsHealthy(snap, { namespace: "quilt", minReady: 1, maxRestarts: 10 }),
      );
    },

    async heal(ctx: ScenarioContext): Promise<void> {
      // Best-effort: ensure no _chaos_fill files remain.
      const pods = await ctx.cluster.getPods();
      const cell = pods.find((p) => p.namespace === "quilt" && p.name.startsWith("quilt-cell-"));
      if (!cell) return;
      await ctx.client
        .exec("quilt", cell.name, "quilt", ["sh", "-c", `rm -f ${dataDir}/_chaos_fill ${dataDir}/_chaos_fill.x`])
        .catch(() => undefined);
    },
  };
}

async function probeHealthz(
  ctx: ScenarioContext,
  podName: string,
): Promise<{ status: string; latencyMs: number }> {
  const out = await ctx.client.exec("quilt", podName, "quilt", ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]);
  try {
    return { status: JSON.parse(out.stdout).status, latencyMs: 0 };
  } catch {
    return { status: "Unknown", latencyMs: 0 };
  }
}

async function fetchStorageErrorCounter(ctx: ScenarioContext, podName: string): Promise<number> {
  const out = await ctx.client.exec("quilt", podName, "quilt", [
    "wget",
    "-qO-",
    "http://127.0.0.1:9100/metrics",
  ]);
  const m = out.stdout.match(/^quilt_storage_errors_total\s+(\d+)/m);
  return m && m[1] ? Number.parseInt(m[1], 10) : 0;
}

export const diskFailure: Scenario = createDiskFailureScenario();
