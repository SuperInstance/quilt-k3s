/**
 * Tests for the assertion library.
 *
 * No external dependencies — every assertion is a pure function of its
 * inputs (or of a small async fetcher that we control).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPodsHealthy,
  assertRecoveryTime,
  assertNoDataLoss,
  assertMetricEmitted,
  assertQuorumHealthy,
  type HealthSnapshot,
  type PodView,
} from "../src/assertions.js";

function pod(overrides: Partial<PodView> = {}): PodView {
  return {
    namespace: "quilt",
    name: "p1",
    ready: "1/1",
    status: "Running",
    restarts: 0,
    ...overrides,
  };
}

function snap(pods: PodView[]): HealthSnapshot {
  return { takenAt: 100, pods };
}

test("assertPodsHealthy passes when enough pods are Ready and restarts are low", async () => {
  const r = await assertPodsHealthy(snap([pod(), pod({ name: "p2" })]), { minReady: 2 });
  assert.equal(r.passed, true);
  assert.equal(r.name, "pods-healthy");
});

test("assertPodsHealthy fails when namespace filter removes all pods", async () => {
  const r = await assertPodsHealthy(snap([pod({ namespace: "other" })]), {
    namespace: "quilt",
    minReady: 1,
  });
  assert.equal(r.passed, false);
  assert.equal(r.name, "pods-healthy");
  assert.ok((r.details as { readyCount: number }).readyCount === 0);
});

test("assertPodsHealthy fails when a required pod is missing", async () => {
  const r = await assertPodsHealthy(
    snap([pod({ name: "quilt-cell-0" })]),
    { namespace: "quilt", minReady: 1, required: ["quilt/quilt-cell-0", "quilt/quilt-agent-0"] },
  );
  assert.equal(r.passed, false);
  const missing = (r.details as { missing: string[] }).missing;
  assert.deepEqual(missing, ["quilt/quilt-agent-0"]);
});

test("assertPodsHealthy fails when a pod has too many restarts", async () => {
  const r = await assertPodsHealthy(
    snap([pod({ name: "flappy", restarts: 20 })]),
    { namespace: "quilt", minReady: 1, maxRestarts: 5 },
  );
  assert.equal(r.passed, false);
  const tooMany = (r.details as { tooManyRestarts: Array<{ name: string }> }).tooManyRestarts;
  assert.equal(tooMany.length, 1);
  assert.equal(tooMany[0]?.name, "flappy");
});

test("assertRecoveryTime passes when observed time is within budget", () => {
  const r = assertRecoveryTime(1_000, 5_000, 10_000);
  assert.equal(r.passed, true);
  assert.equal(r.observedMs, 4_000);
  assert.equal(r.budgetMs, 10_000);
});

test("assertRecoveryTime fails when observed time exceeds budget", () => {
  const r = assertRecoveryTime(1_000, 20_000, 10_000);
  assert.equal(r.passed, false);
  assert.equal(r.observedMs, 19_000);
});

test("assertRecoveryTime includes lastSnapshot timestamp on failure", () => {
  const r = assertRecoveryTime(0, 2_000, 1_000, { takenAt: 1_900, pods: [] });
  assert.equal(r.passed, false);
  assert.deepEqual(r.details, { lastSnapshot: 1_900 });
});

test("assertNoDataLoss passes when checksums match", async () => {
  const r = await assertNoDataLoss({
    expectedCount: 42,
    actualChecksum: "abc123",
    expectedChecksum: "abc123",
  });
  assert.equal(r.passed, true);
});

test("assertNoDataLoss fails when checksums differ", async () => {
  const r = await assertNoDataLoss({
    expectedCount: 42,
    actualChecksum: "abc123",
    expectedChecksum: "def456",
  });
  assert.equal(r.passed, false);
  assert.equal(r.name, "no-data-loss");
});

test("assertNoDataLoss rejects negative expectedCount", async () => {
  const r = await assertNoDataLoss({
    expectedCount: -1,
    actualChecksum: "x",
    expectedChecksum: "x",
  });
  assert.equal(r.passed, false);
});

test("assertMetricEmitted fails when the fetcher returns null", async () => {
  const r = await assertMetricEmitted(async () => null, "quilt_anything");
  assert.equal(r.passed, false);
  assert.match(r.message, /not found/);
});

test("assertMetricEmitted fails when value is below minValue", async () => {
  const r = await assertMetricEmitted(async () => 1, "quilt_x", { minValue: 5 });
  assert.equal(r.passed, false);
  assert.match(r.message, /< minValue 5/);
});

test("assertMetricEmitted fails when mustIncrement is set but value did not increase", async () => {
  const r = await assertMetricEmitted(
    async () => 10,
    "quilt_x",
    { mustIncrement: true, before: 10, after: 10 },
  );
  assert.equal(r.passed, false);
  assert.match(r.message, /did not increment/);
});

test("assertMetricEmitted passes when value is within bounds and counter incremented", async () => {
  const r = await assertMetricEmitted(
    async () => 11,
    "quilt_x",
    { mustIncrement: true, before: 10, after: 11, minValue: 0 },
  );
  assert.equal(r.passed, true);
});

test("assertQuorumHealthy passes when a leader exists and all members are reachable", async () => {
  const r = await assertQuorumHealthy(async () => ({ hasLeader: true, reachable: 3, total: 3 }));
  assert.equal(r.passed, true);
});

test("assertQuorumHealthy fails when there is no leader", async () => {
  const r = await assertQuorumHealthy(async () => ({ hasLeader: false, reachable: 3, total: 3 }));
  assert.equal(r.passed, false);
  assert.match(r.message, /unhealthy/);
});

test("assertQuorumHealthy fails when only a minority is reachable", async () => {
  const r = await assertQuorumHealthy(async () => ({ hasLeader: true, reachable: 1, total: 3 }));
  assert.equal(r.passed, false);
});
