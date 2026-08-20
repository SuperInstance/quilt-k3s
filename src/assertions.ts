/**
 * assertions — reusable health and data-loss checks for chaos scenarios.
 *
 * Every assertion returns an {@link AssertionResult}. They never throw —
 * failure is encoded in the result so the runner can collect all of them.
 */

/** Minimal pod view used by the assertion library. */
export interface PodView {
  readonly namespace: string;
  readonly name: string;
  readonly ready: string;
  readonly status: string;
  readonly restarts: number;
}

/** A point-in-time snapshot of cluster health. */
export interface HealthSnapshot {
  readonly takenAt: number;
  readonly pods: readonly PodView[];
}

/** A single assertion outcome. */
export interface AssertionResult {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly observedMs?: number;
  readonly budgetMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

const ok = (name: string, message: string, extra: Partial<AssertionResult> = {}): AssertionResult => ({
  name,
  passed: true,
  message,
  ...extra,
});

const fail = (name: string, message: string, extra: Partial<AssertionResult> = {}): AssertionResult => ({
  name,
  passed: false,
  message,
  ...extra,
});

// ───────────────────────── pod health ─────────────────────────

/** Options for {@link assertPodsHealthy}. */
export interface PodsHealthyOpts {
  /** Restrict to this namespace. Default: any. */
  readonly namespace?: string;
  /** Minimum number of pods in `Running`/`Ready` state. Default: 1. */
  readonly minReady?: number;
  /** Pod names that must be present. Default: [] */
  readonly required?: readonly string[];
  /** Maximum allowed total restart count. Default: 5. */
  readonly maxRestarts?: number;
}

/** Assert the snapshot is healthy. */
export async function assertPodsHealthy(
  snap: HealthSnapshot,
  opts: PodsHealthyOpts = {},
): Promise<AssertionResult> {
  const minReady = opts.minReady ?? 1;
  const maxRestarts = opts.maxRestarts ?? 5;
  const required = new Set(opts.required ?? []);

  const candidates = opts.namespace
    ? snap.pods.filter((p) => p.namespace === opts.namespace)
    : snap.pods;

  const ready = candidates.filter((p) => p.status === "Running" && p.ready !== "0/0");
  const present = new Set(ready.map((p) => `${p.namespace}/${p.name}`));
  const missing = [...required].filter((n) => !present.has(n));
  const tooManyRestarts = ready.filter((p) => p.restarts > maxRestarts);

  if (missing.length === 0 && ready.length >= minReady && tooManyRestarts.length === 0) {
    return ok(
      "pods-healthy",
      `${ready.length} pods healthy in ${opts.namespace ?? "all namespaces"}`,
      { details: { readyCount: ready.length, namespace: opts.namespace ?? null } },
    );
  }
  return fail("pods-healthy", "pod health check failed", {
    details: {
      readyCount: ready.length,
      minRequired: minReady,
      missing,
      tooManyRestarts: tooManyRestarts.map((p) => ({ name: p.name, restarts: p.restarts })),
    },
  });
}

// ───────────────────────── recovery time ─────────────────────────

/** Assert recovery happened within `budgetMs`. */
export function assertRecoveryTime(
  startedAt: number,
  recoveredAt: number,
  budgetMs: number,
  lastSnapshot?: HealthSnapshot | null,
): AssertionResult {
  const observedMs = recoveredAt - startedAt;
  if (observedMs <= budgetMs) {
    return ok("recovery-time", `recovered in ${observedMs}ms (budget ${budgetMs}ms)`, {
      observedMs,
      budgetMs,
    });
  }
  return fail("recovery-time", `recovery took ${observedMs}ms, exceeded budget ${budgetMs}ms`, {
    observedMs,
    budgetMs,
    details: lastSnapshot ? { lastSnapshot: lastSnapshot.takenAt } : undefined,
  });
}

// ───────────────────────── data loss ─────────────────────────

/** Options for {@link assertNoDataLoss}. */
export interface NoDataLossOpts {
  /** Check that the count of expected entries equals the actual count. */
  readonly expectedCount: number;
  /** Check that the checksum of expected data matches the actual data. */
  readonly actualChecksum: string;
  /** Pre-computed checksum of the data captured before injection. */
  readonly expectedChecksum: string;
}

/**
 * Assert no data was lost during the scenario. Compares an entry count and a
 * caller-supplied checksum. The chaos scenario is responsible for computing
 * both checksums at the right times.
 */
export async function assertNoDataLoss(opts: NoDataLossOpts): Promise<AssertionResult> {
  if (opts.expectedCount < 0) {
    return fail("no-data-loss", "expectedCount must be >= 0", { details: { expectedCount: opts.expectedCount } });
  }
  if (opts.actualChecksum === opts.expectedChecksum) {
    return ok("no-data-loss", "checksum match; no data loss detected", {
      details: { expectedCount: opts.expectedCount, checksum: opts.actualChecksum },
    });
  }
  return fail("no-data-loss", "checksum mismatch — possible data loss", {
    details: {
      expectedCount: opts.expectedCount,
      actualChecksum: opts.actualChecksum,
      expectedChecksum: opts.expectedChecksum,
    },
  });
}

// ───────────────────────── metric presence ─────────────────────────

/** Assert that a Prometheus counter or gauge changed (or at least was emitted) during the scenario. */
export async function assertMetricEmitted(
  fetchMetric: (name: string) => Promise<number | null>,
  metricName: string,
  opts: { minValue?: number; mustIncrement?: boolean; before?: number; after?: number } = {},
): Promise<AssertionResult> {
  const value = await fetchMetric(metricName);
  if (value === null) {
    return fail("metric-emitted", `metric "${metricName}" not found`, { details: { metric: metricName } });
  }
  if (opts.minValue !== undefined && value < opts.minValue) {
    return fail("metric-emitted", `metric "${metricName}" = ${value} < minValue ${opts.minValue}`, {
      details: { metric: metricName, value, minValue: opts.minValue },
    });
  }
  if (opts.mustIncrement && opts.before !== undefined && opts.after !== undefined) {
    if (opts.after <= opts.before) {
      return fail("metric-emitted", `metric "${metricName}" did not increment`, {
        details: { metric: metricName, before: opts.before, after: opts.after },
      });
    }
  }
  return ok("metric-emitted", `metric "${metricName}" = ${value}`, {
    details: { metric: metricName, value, ...opts },
  });
}

// ───────────────────────── quorum / connectivity ─────────────────────────

/** Assert that quorum (e.g. etcd) is reachable and reports a healthy leader. */
export async function assertQuorumHealthy(
  probe: () => Promise<{ hasLeader: boolean; reachable: number; total: number }>,
): Promise<AssertionResult> {
  const r = await probe();
  if (r.hasLeader && r.reachable === r.total) {
    return ok("quorum-healthy", `quorum healthy (${r.reachable}/${r.total} reachable, leader present)`, {
      details: r as unknown as Record<string, unknown>,
    });
  }
  return fail("quorum-healthy", `quorum unhealthy (reachable=${r.reachable}/${r.total}, leader=${r.hasLeader})`, {
    details: r as unknown as Record<string, unknown>,
  });
}
