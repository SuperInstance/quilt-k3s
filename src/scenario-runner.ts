/**
 * ScenarioRunner — executes a single chaos scenario against a {@link Cluster}.
 *
 * Lifecycle: preflight (steady-state) → inject → wait → assert → heal → report.
 *
 * The actual fault-injection logic lives in `scenarios/*.ts`. Each scenario
 * exports an object that conforms to {@link Scenario}.
 */

import type { Cluster } from "./cluster.js";
import type { K3sClient } from "./k3s-client.js";
import {
  assertPodsHealthy,
  assertRecoveryTime,
  type AssertionResult,
  type HealthSnapshot,
} from "./assertions.js";
import { DEFAULT_RECOVERY_BUDGET_MS } from "./index.js";

/** Context handed to a scenario. */
export interface ScenarioContext {
  readonly cluster: Cluster;
  readonly client: K3sClient;
  readonly report: ScenarioReport;
  /** Abort the scenario early (e.g. on outer timeout). */
  signal: AbortSignal;
}

/** A scenario: injects a fault, optionally asserts, always reports. */
export interface Scenario {
  readonly name: string;
  readonly description: string;
  /** Recovery budget in ms; default is {@link DEFAULT_RECOVERY_BUDGET_MS}. */
  readonly recoveryBudgetMs?: number;
  /** Runs the scenario. Should throw on unrecoverable failure. */
  run(ctx: ScenarioContext): Promise<ScenarioResult>;
}

/** Per-scenario live report (mutated by the runner as it goes). */
export interface ScenarioReport {
  readonly name: string;
  readonly startedAt: number;
  endedAt: number;
  injectedAt: number | null;
  healedAt: number | null;
  assertions: AssertionResult[];
  passed: boolean;
  error: string | null;
}

/** Final per-scenario result. */
export interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly recoveredInMs: number | null;
  readonly assertions: readonly AssertionResult[];
  readonly error: string | null;
}

/** Engine that runs a sequence of scenarios and aggregates the report. */
export class ChaosEngine {
  private readonly scenarios: readonly Scenario[];
  private readonly cluster: Cluster;

  constructor(opts: { cluster: Cluster; scenarios?: readonly Scenario[] }) {
    this.cluster = opts.cluster;
    this.scenarios = opts.scenarios ?? [];
  }

  /** Run all scenarios sequentially. Stops on first failure unless `continueOnFailure`. */
  async runAll(opts: { continueOnFailure?: boolean } = {}): Promise<ChaosRunReport> {
    const results: ScenarioResult[] = [];
    for (const s of this.scenarios) {
      const runner = new ScenarioRunner(s, this.cluster);
      const result = await runner.run();
      results.push(result);
      if (!result.passed && !opts.continueOnFailure) break;
    }
    return { results, passed: results.every((r) => r.passed) };
  }
}

/** Aggregate report for a full `ChaosEngine.runAll` call. */
export interface ChaosRunReport {
  readonly results: readonly ScenarioResult[];
  readonly passed: boolean;
}

/**
 * Executes one {@link Scenario} end-to-end: preflight → inject → wait → assert → heal.
 */
export class ScenarioRunner {
  readonly scenario: Scenario;
  readonly cluster: Cluster;
  readonly budgetMs: number;

  constructor(scenario: Scenario, cluster: Cluster) {
    this.scenario = scenario;
    this.cluster = cluster;
    this.budgetMs = scenario.recoveryBudgetMs ?? DEFAULT_RECOVERY_BUDGET_MS;
  }

  async run(): Promise<ScenarioResult> {
    const report: ScenarioReport = {
      name: this.scenario.name,
      startedAt: Date.now(),
      endedAt: 0,
      injectedAt: null,
      healedAt: null,
      assertions: [],
      passed: false,
      error: null,
    };

    const ac = new AbortController();
    const ctx: ScenarioContext = {
      cluster: this.cluster,
      client: this.cluster.client,
      report,
      signal: ac.signal,
    };

    try {
      // 1) preflight: ensure steady state
      const before = await snapshotHealth(ctx);
      ctx.report.assertions.push(
        await assertPodsHealthy(before, { namespace: "quilt", minReady: 1 }),
      );

      // 2) inject
      ctx.report.injectedAt = Date.now();
      await this.scenario.run(ctx);
      ctx.report.healedAt = Date.now();

      // 3) assert recovery within budget
      const recovered = await waitForRecovery(ctx, this.budgetMs);
      ctx.report.assertions.push(recovered);

      // 4) heal any side effects the scenario didn't clean up
      await this.healBestEffort(ctx);

      ctx.report.passed = ctx.report.assertions.every((a) => a.passed);
    } catch (err) {
      ctx.report.error = err instanceof Error ? err.message : String(err);
      ctx.report.passed = false;
      try {
        await this.healBestEffort(ctx);
      } catch {
        /* swallow — we're already failing */
      }
    } finally {
      ctx.report.endedAt = Date.now();
      ac.abort();
    }

    const recoveredInMs =
      ctx.report.injectedAt !== null && ctx.report.healedAt !== null
        ? ctx.report.healedAt - ctx.report.injectedAt
        : null;

    return {
      name: ctx.report.name,
      passed: ctx.report.passed,
      recoveredInMs,
      assertions: ctx.report.assertions,
      error: ctx.report.error,
    };
  }

  private async healBestEffort(ctx: ScenarioContext): Promise<void> {
    // Scenarios that have side effects implement `heal`; default = no-op.
    const maybeHeal = (this.scenario as unknown as { heal?: (c: ScenarioContext) => Promise<void> }).heal;
    if (typeof maybeHeal === "function") {
      await maybeHeal(ctx);
    }
  }
}

// ───────────────────────── helpers ─────────────────────────

async function snapshotHealth(ctx: ScenarioContext): Promise<HealthSnapshot> {
  const pods = await ctx.cluster.getPods();
  return {
    takenAt: Date.now(),
    pods: pods.map((p) => ({
      namespace: p.namespace,
      name: p.name,
      ready: p.ready,
      status: p.status,
      restarts: p.restarts,
    })),
  };
}

async function waitForRecovery(ctx: ScenarioContext, budgetMs: number): Promise<AssertionResult> {
  const start = Date.now();
  let last: HealthSnapshot | null = null;
  while (Date.now() - start < budgetMs) {
    if (ctx.signal.aborted) break;
    last = await snapshotHealth(ctx);
    const ready = last.pods.every((p) => p.status === "Running" && p.ready !== "0/0");
    if (ready) {
      return assertRecoveryTime(start, Date.now(), budgetMs);
    }
    await sleep(250);
  }
  return assertRecoveryTime(start, Date.now(), budgetMs, last);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
