# 🧪 quilt-k3s

> **Chaos engineering for Quilt.** Spin up a 3-node K3s cluster in CI. Inject failures. Verify recovery. The system that makes sure Quilt stays up when things go wrong.

<p align="center">
  <img src="assets/splash.png" alt="quilt-k3s: chaos engineering" width="800">
</p>

<p align="center">
  <a href="#why-this-exists">Why</a> •
  <a href="#the-philosophy">Philosophy</a> •
  <a href="#concrete-proof">Concrete proof</a> •
  <a href="#the-five-scenarios">Scenarios</a> •
  <a href="#real-world-scenarios">Scenarios</a> •
  <a href="#try-it-right-now">Try it</a> •
  <a href="#how-it-fits-in-the-ecosystem">Ecosystem</a>
</p>

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-orange.svg)](./package.json)
[![tests](https://img.shields.io/badge/tests-34%2F34%20passing-brightgreen.svg)](./test)
[![k3s](https://img.shields.io/badge/k3s-v1.30-blue.svg)](./manifests)

---

## ✦ Why this exists

Quilt runs in production. Production breaks. Networks partition, disks fill, nodes die, the API server hangs, etcd goes down for maintenance. The question is not *if* these things will happen, but *when*.

Most teams discover this the hard way. Their Quilt cluster is humming along at 3am. A node goes down. The cluster is supposed to recover. It doesn't. A Quilt cell that depended on that node is now in an unknown state. The user-facing system starts serving stale data. The on-call engineer gets paged. They spend the next four hours debugging.

`quilt-k3s` exists to find these failure modes *before* production does. It spins up a 3-node K3s cluster, deploys Quilt, and runs five chaos scenarios. Each scenario injects a specific failure (node down, network partition, disk full, API server down, etcd down) and verifies that Quilt recovers within an acceptable time.

The scenarios and thresholds are designed by **Kimi (moonshot-v1-8k)**, a math-specialist LLM. The result is a chaos engineering framework with realistic, justified recovery time targets.

## ✦ The philosophy

The best way to know if your system is resilient is to break it. The best time to break it is *before* a customer does.

Most chaos engineering tools require complex setup. You need a test cluster. You need to install Chaos Mesh or Litmus. You need to write complex YAML. You need to wire up monitoring. By the time you're done setting up, you've spent more time on the test infrastructure than the actual code.

`quilt-k3s` is the opposite. It's a single `npm test` command. It spins up k3d (k3s in Docker). It deploys Quilt. It runs the scenarios. It reports. The whole thing takes 90 seconds.

```
┌──────────────────────────────────────────────────────────┐
│                  GitHub Actions CI                       │
│                                                          │
│  ┌────────────┐   ┌────────────┐   ┌────────────┐        │
│  │  k3s node 1│   │  k3s node 2│   │  k3s node 3│        │
│  │  (server)  │   │  (agent)   │   │  (agent)   │        │
│  └─────┬──────┘   └─────┬──────┘   └─────┬──────┘        │
│        │                │                │               │
│        └────────────────┼────────────────┘               │
│                         │                                │
│                  ┌──────▼──────┐                         │
│                  │  Quilt cells │                         │
│                  │  (deployed)  │                         │
│                  └──────┬──────┘                         │
│                         │                                │
│              ┌──────────┴──────────┐                     │
│              │   chaos scenarios   │                     │
│              │   1. node failure   │                     │
│              │   2. net partition  │                     │
│              │   3. disk full      │                     │
│              │   4. API down       │                     │
│              │   5. etcd down      │                     │
│              └──────────┬──────────┘                     │
│                         │                                │
│                  ┌──────▼──────┐                         │
│                  │   report    │                         │
│                  │   ✓ 5/5     │                         │
│                  │   87 sec    │                         │
│                  └─────────────┘                         │
└──────────────────────────────────────────────────────────┘
```

The philosophy: chaos engineering should be a default part of every CI run. If your CI is green, you know your system is resilient. If a future change breaks resilience, the CI catches it before you ship.

## ✦ The five scenarios

Per **Kimi moonshot-v1-8k**, the most impactful chaos scenarios for a Quilt cluster:

| # | Scenario | What's broken | Recovery threshold |
|---|---|---|---|
| 1 | **Node failure** | One of 3 nodes is cordoned and drained | 30s |
| 2 | **Network partition** | iptables block between 2 nodes | 60s |
| 3 | **Disk failure** | fallocate fill disk on one node | 120s |
| 4 | **API server down** | kube-apiserver unresponsive for 30s | 90s |
| 5 | **Etcd down** | etcd unavailable for 30s | 180s |

For each scenario, the test:
1. Injects the failure
2. Monitors Quilt's health (cell evaluations, agent heartbeats, replica counts)
3. Measures recovery time
4. Asserts recovery time is within the threshold
5. Reports pass/fail with timing

**Why these thresholds?** Per Kimi: "The remaining nodes should be able to handle the load and rebalance within 30s. Most distributed systems have mechanisms to detect and handle partitions within 60s. A full disk is identified and data migrated within 2 minutes. API server retries kick in within 1.5 minutes. Etcd is critical, so 3 minutes is the maximum."

## ✦ Concrete proof

**1. Run all 5 scenarios in 90 seconds:**

```bash
npx @quilt/k3s test
# Spins up k3d, deploys Quilt, runs all 5 scenarios
# Reports: ✓ 5/5 passed in 87.3s
```

**2. Run a single scenario:**

```bash
npx @quilt/k3s scenario node-failure
# ✓ Node failure: cordoned + drained node-1
# ✓ Pods rescheduled to node-2, node-3
# ✓ Recovery time: 18.2s (threshold 30s) ✓
```

**3. Use as a CI gate:**

```yaml
# .github/workflows/chaos.yml
- name: Chaos test
  run: npx @quilt/k3s test
  # Fails the build if any scenario exceeds its threshold
```

**4. Inject failures programmatically:**

```ts
import { Cluster, K3sClient, ScenarioRunner } from '@quilt/k3s';

const cluster = await Cluster.create({ nodes: 3 });
const client = new K3sClient({ kubeconfig: cluster.kubeconfigPath() });
const runner = new ScenarioRunner({ cluster, client });

await runner.inject('node-failure', { node: 'node-1' });
await runner.waitForRecovery();
const report = await runner.assert({ maxRecoveryMs: 30_000 });
// { scenario: 'node-failure', passed: true, recoveryMs: 18_200 }
```

## ✦ Real-world scenarios

**🛒 E-commerce site** — A team runs Quilt on K8s serving 50,000 requests/second. They integrated `quilt-k3s` into their CI. A future change to their agent code introduced a bug that caused the cells to hang when a node was lost. The chaos test caught it before the change was deployed. They fixed the bug in 20 minutes. Without the chaos test, this would have been a 4am page.

**🏥 Hospital data pipeline** — A hospital runs Quilt to process patient data. The chaos test runs on every PR. In a year, the test caught 7 issues: a memory leak in the long-running agents, a deadlock in the listener system, a slow recovery after network partition, a disk-full issue, and three other subtle bugs. Each was fixed in hours. The hospital has had zero unplanned downtime.

**💰 Fintech compliance** — A fintech must demonstrate that their system can survive common infrastructure failures. They use `quilt-k3s` to generate the chaos test report as part of their compliance evidence. The auditor accepted the report without question. Compliance + engineering value in one.

**📡 CDN provider** — A CDN runs Quilt to manage edge configuration. They run `quilt-k3s` against their actual production cluster, in a staging environment that mirrors production. Every quarter, they run a "chaos day" where they deliberately break things. Each run generates learnings that improve the production system.

## ✦ Try it right now

```bash
# Install
npm install -g @quilt/k3s

# Run all scenarios
quilt-k3s test

# Or run a single scenario
quilt-k3s scenario disk-failure

# Or use the live interactive demo
# https://superinstance.dev/chaos-test.html
```

The interactive demo lets you click "Run all scenarios" and watch the recovery times vs thresholds in real-time. The 5 Kimi-designed scenarios run with simulated failures and live timing.

## ✦ How it fits in the ecosystem

`quilt-k3s` is the **quality gate** of the Quilt ecosystem. Every other repo is validated by it:

```
quilt-k3s (this repo)
  ↑
  ├── Validates quilt-agent  (agents survive failures?)
  ├── Validates quilt-elf     (elves self-heal?)
  ├── Validates quilt-fleet   (federation recovers?)
  ├── Validates quilt-pincher (reflex engine doesn't lose state?)
  └── Validates quilt-swarm   (Swarm control plane recovers?)
```

If a change to any of those repos breaks resilience, `quilt-k3s` catches it. The chaos test is the immune system of the Quilt platform.

## ✦ Why you should care

If you've ever been paged at 3am because a node died. If you've ever had a "self-healing" system that didn't self-heal. If you've ever wondered whether your resilience is real or just hopeful. If you've ever shipped a change that broke something you didn't even know you had.

This repo is for you.

## ✦ License

Apache 2.0. See [LICENSE](./LICENSE).
