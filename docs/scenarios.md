# Chaos Scenarios — Deep Dive

This document describes the five chaos scenarios in detail: the precise
mechanics of the fault, the Quilt behavior we expect, the assertions we
make, and the recovery budget we hold the implementation to.

All scenarios run against a 3-node K3s cluster (1 server + 3 agents) created
via [k3d](https://k3d.io/). The cluster is fully ephemeral; each `quilt-k3s
test` invocation creates a fresh one and tears it down at the end.

## Table of Contents

- [Scenario 1 — Node Failure](#scenario-1--node-failure)
- [Scenario 2 — Network Partition](#scenario-2--network-partition)
- [Scenario 3 — Disk Failure](#scenario-3--disk-failure)
- [Scenario 4 — API Server Failure](#scenario-4--api-server-failure)
- [Scenario 5 — Etcd Failure](#scenario-5--etcd-failure)
- [Adding a new scenario](#adding-a-new-scenario)

---

## Scenario 1 — Node Failure

**File:** [`scenarios/node-failure.ts`](../scenarios/node-failure.ts)

**What gets broken.** One agent node is selected at random and made
unschedulable. All evictable pods on it are then evicted.

**Injection.**

```sh
kubectl cordon  k3d-quilt-agent-1
kubectl drain   k3d-quilt-agent-1 \
  --ignore-daemonsets \
  --delete-emptydir-data \
  --force \
  --timeout=60s
```

**Expected Quilt behavior.**

1. The `quilt-agent` DaemonSet pod on the dying node is re-scheduled to one
   of the two remaining agent nodes within seconds.
2. The `quilt-cell-0` StatefulSet pod is recreated on a healthy node.
3. Because the cell uses a StatefulSet with a `PersistentVolumeClaim`,
   the new pod re-attaches to the same PVC; data is preserved.
4. The agent's `/healthz` reports `apiserver: connected` once the new
   pod has registered with the API server.

**Assertions.**

- `pods-healthy` (preflight) — at least one `quilt` pod is `Ready`.
- `pods-healthy` (post-inject) — at least two `quilt` pods are `Ready`
  AND none are scheduled on the cordoned node.
- `recovery-time` — recovery completes within **30 000 ms**.

**Recovery budget.** 30 seconds.

**Knobs.**

```ts
createNodeFailureScenario({
  recoveryBudgetMs: 30_000,   // default
  preferredState: "ready",    // or "any"
});
```

---

## Scenario 2 — Network Partition

**File:** [`scenarios/network-partition.ts`](../scenarios/network-partition.ts)

**What gets broken.** Pod-to-pod traffic between the `quilt-cell-0` pod and
one of the `quilt-agent-*` pods is blackholed with `iptables -j DROP`
inside a `nettools` sidecar that has `NET_ADMIN`.

**Injection.**

```sh
# Inside the cell's nettools sidecar, peer = the agent pod's IP.
iptables -A OUTPUT -d <agent-ip> -j DROP
iptables -A INPUT  -s <agent-ip> -j DROP
# …wait partitionDurationMs…
iptables -D OUTPUT -d <agent-ip> -j DROP
iptables -D INPUT  -s <agent-ip> -j DROP
```

**Expected Quilt behavior.**

1. The cell's write path times out (or retries with backoff) instead of
   crashing or silently dropping the write.
2. Writes enqueued during the partition are persisted to the local
   write-ahead log and drained once the partition heals.
3. The agent's `/healthz` may briefly report `peer: disconnected` for
   the cell; it returns to `peer: connected` after the rules are removed.
4. The cell's `quilt-cell checksum --json` output is identical before
   and after the scenario (no data loss).

**Assertions.**

- `recovery-time` — pods are healthy within **30 000 ms** of partition heal.
- `no-data-loss` — entry count and SHA-256 checksum of cell data match
  the pre-partition snapshot.
- (Implicit) the cell process does not crash.

**Recovery budget.** 30 seconds.

**Knobs.**

```ts
createNetworkPartitionScenario({
  recoveryBudgetMs: 30_000,        // default
  partitionDurationMs: 5_000,      // default
});
```

---

## Scenario 3 — Disk Failure

**File:** [`scenarios/disk-failure.ts`](../scenarios/disk-failure.ts)

**What gets broken.** The cell's persistent volume is filled to 100 % with
`fallocate`. The cell must not silently corrupt data; it must mark itself
`Degraded` and increment a `quilt_storage_errors_total` counter.

**Injection.**

```sh
# Inside the cell container:
fallocate -l 95% /var/lib/quilt/_chaos_fill
# Top up with a 64 MiB file in a loop until dd exits non-zero (ENOSPC).
while :; do
  dd if=/dev/zero of=/var/lib/quilt/_chaos_fill.x bs=1M count=64 2>/dev/null || break
done
```

**Expected Quilt behavior.**

1. The cell's storage layer catches the `ENOSPC` error and marks the
   cell as `Degraded` (visible via `GET /healthz` → `status: "Degraded"`).
2. New writes return HTTP 507 (Insufficient Storage) instead of
   silently failing or corrupting the DB.
3. The `quilt_storage_errors_total` counter is incremented.
4. After space is freed (`rm /var/lib/quilt/_chaos_fill*`), the cell
   returns to `Healthy` within the recovery budget.

**Assertions.**

- `cell-degraded` (custom) — `/healthz` reports `Degraded` while the
  disk is full.
- `recovery-time` — cell is `Healthy` within **5 000 ms** of disk free.
- `metric-emitted` — `quilt_storage_errors_total` after > before.
- `pods-healthy` — final pod snapshot is clean.

**Recovery budget.** 5 seconds (the post-free window — disk fill is
intentionally slow to force the worst case).

**Knobs.**

```ts
createDiskFailureScenario({
  recoveryBudgetMs: 5_000,    // default
  dataDir: "/var/lib/quilt",  // default
  fillPercent: 95,            // default
});
```

---

## Scenario 4 — API Server Failure

**File:** [`scenarios/api-failure.ts`](../scenarios/api-failure.ts)

**What gets broken.** The K3s API server is killed (SIGKILL PID 1 inside
the kube-apiserver container). K3s's supervisor restarts it; the chaos
we want is the seconds-long window of API unavailability.

**Injection.**

```sh
# Inside the k3d server node, run `kill -9 1` against the kube-apiserver
# container via k3d node exec.
k3s kubectl -n kube-system exec kube-apiserver -- kill -9 1
```

**Expected Quilt behavior.**

1. The agent caches its last-known resource snapshot.
2. The cell continues to serve reads from its local store.
3. When the API server comes back, the agent reconnects and replays any
   events that were buffered in-memory.
4. The agent's `/healthz` transitions from `apiserver: connected` →
   `apiserver: disconnected` → `apiserver: connected`.

**Assertions.**

- (Implicit) `apiserver: disconnected` is observed during the fault.
- `recovery-time` — both the API server AND the agent are healthy within
  **30 000 ms**.

**Recovery budget.** 30 seconds.

**Knobs.**

```ts
createApiFailureScenario({
  recoveryBudgetMs: 30_000,   // default
  kills: 1,                   // number of SIGKILLs to send
  pauseMs: 1_000,             // pause between kills
});
```

---

## Scenario 5 — Etcd Failure

**File:** [`scenarios/etcd-failure.ts`](../scenarios/etcd-failure.ts)

**What gets broken.** The embedded etcd process is suspended with
`SIGSTOP` (not killed). This freezes the control-plane's consensus
engine without losing state. We then `SIGCONT` it to resume.

> Note: we use `SIGSTOP`/`SIGCONT` rather than `kill -9` because
> etcd is the source of truth; we want a reversible fault.

**Injection.**

```sh
# Inside the etcd container:
kill -STOP 1     # freeze
# …wait suspendDurationMs…
kill -CONT 1     # resume
```

**Expected Quilt behavior.**

1. Writes that require etcd consensus time out and are queued locally
   by the agent.
2. Reads from the agent's local cache continue to succeed.
3. The agent emits a `QuorumLost` event (queryable via
   `GET /events/QuorumLost`).
4. After `SIGCONT`, etcd catches up; the agent's queued events are
   committed; the agent emits a `QuorumRestored` event.

**Assertions.**

- `quorum-healthy` (baseline) — etcd has a leader and all members are
  reachable before the fault.
- `agent-quorum-lost` (custom) — `GET /events/QuorumLost` returns 200
  during the fault.
- `recovery-time` — quorum is restored AND pods are healthy within
  **30 000 ms**.
- `quorum-healthy` (post) — same as baseline.
- `pods-healthy` — final pod snapshot is clean.

**Recovery budget.** 30 seconds.

**Knobs.**

```ts
createEtcdFailureScenario({
  recoveryBudgetMs: 30_000,     // default
  suspendDurationMs: 5_000,     // default
});
```

---

## Adding a new scenario

1. Create `scenarios/<your-scenario>.ts`. Export a `Scenario` object
   directly (or a factory `createXxxScenario()` if you need options).
2. Wire it into [`src/cli.ts`](../src/cli.ts) by importing the scenario
   and adding it to the `ALL_SCENARIOS` array.
3. Add a matching `assertXxx` helper in
   [`src/assertions.ts`](../src/assertions.ts) if the existing primitives
   don't cover your checks.
4. Add tests in `test/scenarios/<your-scenario>.test.ts` that exercise
   your scenario's logic with a mocked `K3sClient`.
5. Document the scenario here with the same template as the others.
6. Add a `manifests/<your-piece>.yaml` if your scenario needs new
   K8s resources (e.g. a sidecar with `NET_ADMIN`).

Pull requests that add a new scenario are reviewed by both
`@SuperInstance/quilt-k3s-maintainers` and
`@SuperInstance/quilt-agent-reviewers` (see
[`CODEOWNERS`](../.github/CODEOWNERS)).
