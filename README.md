# quilt-k3s

```
  ____        _ _       _  ___   ____
 / __ \      (_) |     | |/ _ \/ ___|
| |  | |_   _ _| |_   _| | | | \___ \
| |  | | | | | | | | | | | |_| |___) |
| |__| | |_| | | | |_| | |  _  |  __/
 \___\_\\__,_|_|_|\__, |_|_| |_|_|
                   __/ |
                  |___/

   K3s-based chaos testing for Quilt
   Self-healing verification in under 30s
```

> **Mission:** Bulletproof Quilt's resilience through automated chaos engineering on K3s.
> Every Quilt release is hardened by replaying the five classic failure scenarios that
> haunt distributed systems — and asserting the cluster self-heals before the user notices.

`quilt-k3s` is the chaos-testing half of the Quilt ecosystem. It spins up an ephemeral
three-node K3s cluster (via [k3d](https://k3d.io/) — K3s-in-Docker), deploys Quilt into it,
then systematically breaks things: nodes, networks, disks, the API server, etcd. For every
break, it asserts that Quilt's self-healing loop, retry logic, and state-sync machinery
recover the system within budget — **typically under 30 seconds end-to-end**.

This is the safety net that lets the rest of the Quilt stack ship with confidence.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Chaos Scenarios](#chaos-scenarios)
  - [1. Node Failure](#1-node-failure)
  - [2. Network Partition](#2-network-partition)
  - [3. Disk Failure](#3-disk-failure)
  - [4. API Server Failure](#4-api-server-failure)
  - [5. Etcd Failure](#5-etcd-failure)
- [How It Works](#how-it-works)
- [CI Integration](#ci-integration)
- [Repository Layout](#repository-layout)
- [Cross-References](#cross-references)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

```bash
# Install the CLI (or use npx — no global install required)
npx @quilt/k3s test
```

That single command:

1. Spins up a 3-node K3s cluster in Docker via k3d.
2. Deploys `quilt-agent` and a representative `quilt-cell` StatefulSet.
3. Waits for steady-state health.
4. Runs all 5 chaos scenarios sequentially.
5. Asserts recovery within budget for each.
6. Tears the cluster down and prints a green ✅ or red ❌ report.

You can also run a single scenario in isolation:

```bash
npx @quilt/k3s scenario node-failure       # only scenario #1
npx @quilt/k3s scenario network-partition  # only scenario #2
```

Or manage the cluster lifecycle directly:

```bash
npx @quilt/k3s cluster create    # start a 3-node k3d cluster
npx @quilt/k3s cluster status    # list nodes + pods
npx @quilt/k3s cluster delete    # tear it down
```

### Prerequisites

- Docker (20.10+)
- Node.js 18+
- ~4 GB free RAM for the 3-node cluster
- Linux, macOS, or WSL2

### Programmatic use

```ts
import { ChaosEngine, Cluster, ScenarioRunner } from "@quilt/k3s";

const cluster = await Cluster.create({ nodes: 3 });
const engine = new ChaosEngine({ cluster });

const report = await engine.runAll();
// report.scenarios.forEach(s => console.log(s.name, s.recoveredInMs, s.passed));

await cluster.delete();
```

---

## Chaos Scenarios

Each scenario is a deterministic experiment: inject a fault, wait, assert recovery,
report. They are designed to be **fast** (most recover in well under 30 s) and
**composable** (you can re-run any one of them thousands of times in CI).

### 1. Node Failure

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| What gets broken | A whole Kubernetes node is cordoned and drained.                       |
| Injection method | `kubectl cordon <node>` then `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data` |
| Expected Quilt behavior | The `quilt-agent` DaemonSet on the dying node is rescheduled to a healthy node, the `quilt-cell` StatefulSet's pod is recreated, and state-sync catches up. |
| Recovery assertion | All `quilt-agent` pods are `Ready` and the cell reaches the previous generation within 30 s. |

### 2. Network Partition

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| What gets broken | Pod-to-pod traffic between the cell and the agent is blackholed with `iptables`. |
| Injection method | `iptables -A INPUT -s <peer-ip> -j DROP` inside a sidecar with `NET_ADMIN` |
| Expected Quilt behavior | The retry loop on both sides backs off and times out; once the partition heals, queued writes are drained and state-sync reconciles. |
| Recovery assertion | `quilt-cell` queue depth returns to baseline AND no entries are lost (checksum match). |

### 3. Disk Failure

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| What gets broken | The cell's persistent volume is filled to 100 % with `fallocate`.      |
| Injection method | `fallocate -l 95% /var/lib/quilt/cell.db` and append until `ENOSPC`    |
| Expected Quilt behavior | The agent logs the I/O error, marks the cell as `Degraded`, and the cell refuses new writes until the disk is freed. No silent corruption. |
| Recovery assertion | Cell returns to `Healthy` within 5 s of disk space being released AND a `quilt_storage_errors_total` counter incremented (not silenced). |

### 4. API Server Failure

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| What gets broken | The K3s API server is killed mid-flight.                               |
| Injection method | `k3s kubectl -n kube-system exec kube-apiserver -- kill -9 1` (via k3d exec) |
| Expected Quilt behavior | The agent caches its last-known state, the cell continues to serve reads, and the control plane comes back via the K3s supervisor. |
| Recovery assertion | `quilt-agent` reconnects to the API server within 30 s and replays any buffered events. |

### 5. Etcd Failure

| Field           | Value                                                                  |
| --------------- | ---------------------------------------------------------------------- |
| What gets broken | The embedded etcd instance is stopped.                                  |
| Injection method | `k3s kubectl -n kube-system exec etcd -- kill -STOP $PID` (SIGSTOP, reversible) |
| Expected Quilt behavior | Writes that would require etcd consensus are queued locally; reads from local cache continue to succeed. The agent surfaces a `QuorumLost` event. |
| Recovery assertion | After `kill -CONT`, etcd catches up and the agent's queued events are committed. No data loss. |

For deep-dive mechanics see [`docs/scenarios.md`](docs/scenarios.md).

---

## How It Works

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  scenario    │───▶│ k3s-client   │───▶│ k3d cluster  │
│  (inject)    │    │ (kubectl-via-│    │ (3 nodes)    │
│              │    │  REST)       │    │              │
└──────┬───────┘    └──────────────┘    └──────┬───────┘
       │                                       │
       ▼                                       ▼
┌──────────────┐                      ┌──────────────┐
│ assertions   │◀─────────────────────│ quilt-agent  │
│ (assert      │                      │ + quilt-cell │
│  recovery)   │                      │  deployed    │
└──────┬───────┘                      └──────────────┘
       │
       ▼
  report.json
```

The loop is:

1. **Inject** — `ScenarioRunner` calls `K3sClient` to apply a fault (cordon, `iptables`,
   `fallocate`, kill, etc.).
2. **Wait** — poll Quilt's health endpoints with backoff.
3. **Assert** — `assertions.ts` checks recovery within budget; data-loss checksums where
   applicable.
4. **Report** — append a structured result to the run report.
5. **Heal** — reverse the fault so the next scenario starts from a clean slate.

---

## CI Integration

A ready-to-go GitHub Actions workflow lives at
[`.github/workflows/chaos-ci.yml`](.github/workflows/chaos-ci.yml). It:

- Spins up an Ubuntu runner.
- Installs k3d, kubectl, Node 20.
- Boots a 3-node cluster.
- Deploys Quilt from the current commit.
- Runs all 5 scenarios.
- Uploads `chaos-report.json` and JUnit XML as artifacts.
- Fails the PR if any scenario exceeds its recovery budget.

See [`docs/ci-integration.md`](docs/ci-integration.md) for matrix strategies, parallel
sharding, and how to wire this into a release-gate workflow.

---

## Repository Layout

```
quilt-k3s/
├── src/                     # TypeScript library + CLI
│   ├── index.ts             # Public exports
│   ├── cluster.ts           # k3d cluster lifecycle
│   ├── k3s-client.ts        # Kubernetes API wrapper
│   ├── scenario-runner.ts   # Single-scenario executor
│   ├── assertions.ts        # Reusable health/data-loss assertions
│   └── cli.ts               # `npx @quilt/k3s …` entry point
├── scenarios/               # The 5 chaos scenarios
│   ├── node-failure.ts
│   ├── network-partition.ts
│   ├── disk-failure.ts
│   ├── api-failure.ts
│   └── etcd-failure.ts
├── manifests/               # K8s manifests for Quilt under test
│   ├── quilt-agent.yaml
│   └── quilt-cell.yaml
├── test/                    # Vitest / Jest test suite (mocks k3d)
│   ├── cluster.test.ts
│   ├── scenario-runner.test.ts
│   └── assertions.test.ts
├── docs/
│   ├── scenarios.md
│   └── ci-integration.md
├── .github/
│   ├── workflows/chaos-ci.yml
│   ├── dependabot.yml
│   └── CODEOWNERS
├── package.json
├── tsconfig.json
├── .eslintrc.cjs
├── .editorconfig
├── .gitignore
├── SECURITY.md
└── LICENSE
```

---

## Cross-References

`quilt-k3s` is one of five repositories in the Quilt ecosystem. It depends on and
exercises:

- **[quilt-core](https://github.com/SuperInstance/quilt-core)** — the runtime that the
  scenarios assert against. `quilt-k3s` lists it as a `peerDependency`.
- **[quilt-agent](https://github.com/SuperInstance/quilt-agent)** — the DaemonSet
  deployed into the chaos cluster (see `manifests/quilt-agent.yaml`).
- **[quilt-fleet](https://github.com/SuperInstance/quilt-fleet)** — the orchestrator
  that schedules Quilt cells across many clusters; chaos runs here harden fleet-level
  decisions like re-sharding after a node loss.
- **[quilt-elf](https://github.com/SuperInstance/quilt-elf)** — the embedded language
  runtime that powers Quilt's self-healing scripts. Network-partition and disk-failure
  scenarios specifically assert ELF script behavior under fault.

---

## Contributing

1. Fork & branch from `main`.
2. Add a scenario? Start from `scenarios/_template.ts` and wire it into
   `scenarios/index.ts` and the `test` subcommand.
3. `npm test` — all tests must pass with the mocked k3d backend.
4. `npm run lint` — must be clean.
5. Open a PR — the chaos CI workflow will run the full 5-scenario gauntlet on your
   branch. No PR merges if any scenario regresses.

---

## License

Copyright 2024 The Quilt Authors.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this
file except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the specific language governing
permissions and limitations under the License.
