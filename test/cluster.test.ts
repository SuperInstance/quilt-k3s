/**
 * Tests for {@link Cluster}.
 *
 * Every test injects a mock {@link Executor} so no real k3d is spawned. The
 * mock records the invocations and returns canned responses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Cluster, type Executor } from "../src/cluster.js";

interface MockState {
  invocations: Array<{ command: string; args: readonly string[] }>;
  responses: Map<string, { stdout: string; stderr: string; exitCode: number }>;
}

function makeExecutor(initial: MockState["responses"] = new Map()): { executor: Executor; state: MockState } {
  const state: MockState = { invocations: [], responses: initial };
  const executor: Executor = {
    async exec(command, args) {
      state.invocations.push({ command, args });
      const key = `${command} ${args.join(" ")}`;
      const r = state.responses.get(key);
      if (r) return r;
      // Default: success with empty stdout.
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
  return { executor, state };
}

const NODES_JSON = JSON.stringify([
  { name: "k3d-quilt-server-0", role: "server", state: { status: "ready" }, ip: { address: "172.18.0.2" } },
  { name: "k3d-quilt-agent-0", role: "agent", state: { status: "ready" }, ip: { address: "172.18.0.3" } },
  { name: "k3d-quilt-agent-1", role: "agent", state: { status: "ready" }, ip: { address: "172.18.0.4" } },
  { name: "k3d-quilt-agent-2", role: "agent", state: { status: "ready" }, ip: { address: "172.18.0.5" } },
]);

const PODS_JSON = JSON.stringify({
  items: [
    {
      metadata: { name: "quilt-cell-0", namespace: "quilt" },
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true, restartCount: 0 }],
      },
      spec: { nodeName: "k3d-quilt-agent-0" },
    },
    {
      metadata: { name: "quilt-agent-abc", namespace: "quilt" },
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true, restartCount: 1 }],
      },
      spec: { nodeName: "k3d-quilt-agent-1" },
    },
  ],
});

test("Cluster.create shells out to k3d with the right arguments", async () => {
  const { executor, state } = makeExecutor(
    new Map([
      ["k3d cluster create quilt-test --image rancher/k3s:v1.30.2-k3s1 --agents 3 --wait --timeout 60s", { stdout: "", stderr: "", exitCode: 0 }],
      ["k3d node list --output json --cluster quilt-test", { stdout: NODES_JSON, stderr: "", exitCode: 0 }],
    ]),
  );

  const c = await Cluster.create({
    name: "quilt-test",
    nodes: 3,
    image: "rancher/k3s:v1.30.2-k3s1",
    executor,
    readyTimeoutMs: 60_000,
  });

  assert.equal(c.name, "quilt-test");
  assert.equal(c.nodes, 3);
  assert.equal(state.invocations[0]?.command, "k3d");
  assert.deepEqual(state.invocations[0]?.args, [
    "cluster",
    "create",
    "quilt-test",
    "--image",
    "rancher/k3s:v1.30.2-k3s1",
    "--agents",
    "3",
    "--wait",
    "--timeout",
    "60s",
  ]);
});

test("Cluster.create throws when k3d exits non-zero", async () => {
  const { executor } = makeExecutor(
    new Map([
      ["k3d cluster create quilt-bad --image rancher/k3s:v1.30.2-k3s1 --agents 1 --wait --timeout 60s", { stdout: "", stderr: "FATA[0000] image not found", exitCode: 1 }],
    ]),
  );

  await assert.rejects(
    () => Cluster.create({ name: "quilt-bad", nodes: 1, image: "rancher/k3s:v1.30.2-k3s1", executor, readyTimeoutMs: 60_000 }),
    /image not found/,
  );
});

test("Cluster.getNodes parses the k3d JSON output", async () => {
  const { executor } = makeExecutor(
    new Map([
      ["k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 3 --wait --timeout 60s", { stdout: "", stderr: "", exitCode: 0 }],
      ["k3d node list --output json --cluster q", { stdout: NODES_JSON, stderr: "", exitCode: 0 }],
    ]),
  );

  const c = await Cluster.create({ name: "q", nodes: 3, executor, readyTimeoutMs: 60_000 });
  const nodes = await c.getNodes();
  assert.equal(nodes.length, 4);
  assert.equal(nodes[0]?.role, "server");
  assert.equal(nodes[1]?.role, "agent");
  assert.equal(nodes[1]?.state, "ready");
  assert.equal(nodes[1]?.ipAddress, "172.18.0.3");
});

test("Cluster.getPods parses kubectl JSON", async () => {
  const responses = new Map<string, { stdout: string; stderr: string; exitCode: number }>();
  responses.set("k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 3 --wait --timeout 60s", { stdout: "", stderr: "", exitCode: 0 });
  responses.set("k3d node list --output json --cluster q", { stdout: NODES_JSON, stderr: "", exitCode: 0 });
  responses.set("kubectl --kubeconfig ~/.k3d/q/kubeconfig.yaml get pods -A -o json", { stdout: PODS_JSON, stderr: "", exitCode: 0 });

  const { executor } = makeExecutor(responses);
  const c = await Cluster.create({ name: "q", nodes: 3, executor, readyTimeoutMs: 60_000 });
  const pods = await c.getPods();
  assert.equal(pods.length, 2);
  assert.equal(pods[0]?.name, "quilt-cell-0");
  assert.equal(pods[0]?.namespace, "quilt");
  assert.equal(pods[0]?.ready, "1/1");
  assert.equal(pods[0]?.status, "Running");
  assert.equal(pods[0]?.node, "k3d-quilt-agent-0");
  assert.equal(pods[1]?.restarts, 1);
});

test("Cluster.waitForReady resolves when all nodes are ready", async () => {
  let call = 0;
  const { executor } = makeExecutor();
  // Custom executor that alternates "notready" → "ready".
  const custom: Executor = {
    async exec(command, args) {
      const key = `${command} ${args.join(" ")}`;
      if (key.startsWith("k3d cluster create")) return { stdout: "", stderr: "", exitCode: 0 };
      if (key === "k3d node list --output json --cluster q") {
        call += 1;
        if (call < 2) {
          return {
            stdout: JSON.stringify([{ name: "s0", role: "server", state: { status: "ready" } }]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: NODES_JSON, stderr: "", exitCode: 0 };
      }
      return executor.exec(command, args);
    },
  };
  const c = await Cluster.create({ name: "q", nodes: 3, executor: custom, readyTimeoutMs: 5_000 });
  await c.waitForReady();
  assert.ok(call >= 2, "expected at least 2 node list calls");
});

test("Cluster.waitForReady throws on timeout", async () => {
  const { executor } = makeExecutor(
    new Map([
      ["k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 1 --wait --timeout 1s", { stdout: "", stderr: "", exitCode: 0 }],
      [
        "k3d node list --output json --cluster q",
        { stdout: JSON.stringify([{ name: "s0", role: "server", state: { status: "notready" } }]), stderr: "", exitCode: 0 },
      ],
    ]),
  );
  const c = await Cluster.create({ name: "q", nodes: 1, executor, readyTimeoutMs: 1_000 });
  await assert.rejects(() => c.waitForReady(), /did not become Ready/);
});

test("Cluster.delete is idempotent and invokes k3d exactly once", async () => {
  const { executor, state } = makeExecutor(
    new Map([
      ["k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 1 --wait --timeout 1s", { stdout: "", stderr: "", exitCode: 0 }],
      ["k3d cluster delete q", { stdout: "", stderr: "", exitCode: 0 }],
    ]),
  );
  const c = await Cluster.create({ name: "q", nodes: 1, executor, readyTimeoutMs: 1_000 });
  await c.delete();
  await c.delete(); // second call should be a no-op
  const deleteCalls = state.invocations.filter((i) => i.args[0] === "cluster" && i.args[1] === "delete");
  assert.equal(deleteCalls.length, 1);
  assert.equal(c.isDeleted, true);
});

test("Cluster.exists returns true when k3d cluster get succeeds", async () => {
  const { executor } = makeExecutor(
    new Map([
      ["k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 1 --wait --timeout 1s", { stdout: "", stderr: "", exitCode: 0 }],
      ["k3d cluster get q", { stdout: NODES_JSON, stderr: "", exitCode: 0 }],
    ]),
  );
  const c = await Cluster.create({ name: "q", nodes: 1, executor, readyTimeoutMs: 1_000 });
  assert.equal(await c.exists(), true);
});

test("Cluster.kubeconfigPath returns the well-known path", async () => {
  const { executor } = makeExecutor(
    new Map([
      ["k3d cluster create q --image rancher/k3s:v1.30.2-k3s1 --agents 1 --wait --timeout 1s", { stdout: "", stderr: "", exitCode: 0 }],
    ]),
  );
  const c = await Cluster.create({ name: "q", nodes: 1, executor, readyTimeoutMs: 1_000 });
  assert.equal(c.kubeconfigPath(), "~/.k3d/q/kubeconfig.yaml");
});
