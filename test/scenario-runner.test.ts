/**
 * Tests for {@link ScenarioRunner} and {@link ChaosEngine}.
 *
 * Uses an in-memory {@link Cluster} stub and a fake {@link K3sClient} so the
 * runner logic can be exercised without any external process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ChaosEngine,
  ScenarioRunner,
  type Cluster,
  type ClusterNode,
  type ClusterPod,
  type Scenario,
  type ScenarioContext,
} from "../src/index.js";
import type { K3sClient } from "../src/k3s-client.js";
import type { AssertionResult, HealthSnapshot, PodView } from "../src/assertions.js";

class FakeCluster {
  nodes: ClusterNode[];
  pods: ClusterPod[];
  client: K3sClient;

  constructor(nodes: ClusterNode[], pods: ClusterPod[]) {
    this.nodes = nodes;
    this.pods = pods;
    this.client = {} as K3sClient;
  }

  get name(): string {
    return "fake";
  }
  get image(): string {
    return "fake";
  }
  getNodes(): Promise<readonly ClusterNode[]> {
    return Promise.resolve(this.nodes);
  }
  getPods(): Promise<readonly ClusterPod[]> {
    return Promise.resolve(this.pods);
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  get isDeleted(): boolean {
    return false;
  }
  kubeconfigPath(): string {
    return "/tmp/fake";
  }
  // The Cluster class also exposes `client`; cast through unknown.
}

function makeCluster(): FakeCluster {
  return new FakeCluster(
    [
      { name: "s0", role: "server", state: "ready", ipAddress: "10.0.0.1" },
      { name: "a0", role: "agent", state: "ready", ipAddress: "10.0.0.2" },
      { name: "a1", role: "agent", state: "ready", ipAddress: "10.0.0.3" },
    ],
    [
      { namespace: "quilt", name: "quilt-cell-0", ready: "1/1", status: "Running", restarts: 0, node: "a0", age: "10s" },
      { namespace: "quilt", name: "quilt-agent-x", ready: "1/1", status: "Running", restarts: 0, node: "a1", age: "10s" },
    ],
  );
}

function makeScenario(name: string, opts: { shouldThrow?: boolean; healthy?: boolean } = {}): Scenario {
  return {
    name,
    description: `fake scenario ${name}`,
    recoveryBudgetMs: 1_000,
    async run(_ctx: ScenarioContext): Promise<void> {
      if (opts.shouldThrow) throw new Error("boom");
    },
  };
}

test("ScenarioRunner returns passed=true when preflight and recovery both succeed", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const scenario = makeScenario("happy", { healthy: true });
  const runner = new ScenarioRunner(scenario, cluster);
  const result = await runner.run();
  assert.equal(result.name, "happy");
  assert.equal(result.passed, true);
  assert.equal(result.error, null);
  assert.ok(result.recoveredInMs !== null, "recoveredInMs should be set");
  assert.ok(result.assertions.length >= 1);
});

test("ScenarioRunner captures the error message when the scenario throws", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const scenario = makeScenario("boom", { shouldThrow: true });
  const runner = new ScenarioRunner(scenario, cluster);
  const result = await runner.run();
  assert.equal(result.passed, false);
  assert.equal(result.error, "boom");
});

test("ScenarioRunner invokes the scenario's optional heal() method", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  let healCalls = 0;
  const scenario: Scenario = {
    name: "heal-me",
    description: "",
    recoveryBudgetMs: 1_000,
    async run() {
      /* no-op */
    },
    async heal() {
      healCalls += 1;
    },
  };
  // The ScenarioRunner only invokes heal if it exists on the scenario object.
  // We attach it as a non-enumerable property to simulate the optional hook.
  Object.defineProperty(scenario, "heal", {
    value: async () => {
      healCalls += 1;
    },
    writable: true,
    enumerable: true,
  });
  const runner = new ScenarioRunner(scenario, cluster);
  await runner.run();
  assert.equal(healCalls, 1);
});

test("ChaosEngine.runAll runs all scenarios and aggregates results", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const engine = new ChaosEngine({
    cluster,
    scenarios: [makeScenario("a"), makeScenario("b"), makeScenario("c")],
  });
  const report = await engine.runAll();
  assert.equal(report.results.length, 3);
  assert.equal(report.passed, true);
  assert.deepEqual(
    report.results.map((r) => r.name),
    ["a", "b", "c"],
  );
});

test("ChaosEngine.runAll stops on first failure by default", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const engine = new ChaosEngine({
    cluster,
    scenarios: [makeScenario("a"), makeScenario("b", { shouldThrow: true }), makeScenario("c")],
  });
  const report = await engine.runAll();
  assert.equal(report.results.length, 2);
  assert.equal(report.passed, false);
});

test("ChaosEngine.runAll continues past failure when continueOnFailure is set", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const engine = new ChaosEngine({
    cluster,
    scenarios: [makeScenario("a"), makeScenario("b", { shouldThrow: true }), makeScenario("c")],
  });
  const report = await engine.runAll({ continueOnFailure: true });
  assert.equal(report.results.length, 3);
  assert.equal(report.passed, false);
});

test("ScenarioRunner records assertion results in order", async () => {
  const cluster = makeCluster() as unknown as Cluster;
  const scenario = makeScenario("ordered");
  const runner = new ScenarioRunner(scenario, cluster);
  const result = await runner.run();
  // At minimum, the preflight `pods-healthy` and the `recovery-time`
  // assertions should be present.
  const names = result.assertions.map((a: AssertionResult) => a.name);
  assert.ok(names.includes("pods-healthy"));
  assert.ok(names.includes("recovery-time"));
  // The first recorded assertion is the preflight, the last is recovery.
  assert.equal(result.assertions[0]?.name, "pods-healthy");
  assert.equal(result.assertions[result.assertions.length - 1]?.name, "recovery-time");
});

test("HealthSnapshot is correctly shaped for assertions", () => {
  const snap: HealthSnapshot = {
    takenAt: 1000,
    pods: [
      { namespace: "quilt", name: "p1", ready: "1/1", status: "Running", restarts: 0 },
      { namespace: "quilt", name: "p2", ready: "0/1", status: "Pending", restarts: 0 },
    ] satisfies PodView[],
  };
  assert.equal(snap.pods.length, 2);
  assert.equal(snap.takenAt, 1000);
});
