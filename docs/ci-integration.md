# CI Integration

This document explains how `quilt-k3s` slots into your CI pipeline, with
concrete examples for GitHub Actions, GitLab CI, and Jenkins.

The TL;DR is: spin up a 3-node k3d cluster, deploy Quilt into it, run the
chaos gauntlet, gate the PR on the result.

## Table of contents

- [GitHub Actions](#github-actions)
  - [Default workflow](#default-workflow)
  - [Matrix by node count](#matrix-by-node-count)
  - [Parallel sharding by scenario](#parallel-sharding-by-scenario)
  - [Release-gate workflow](#release-gate-workflow)
- [GitLab CI](#gitlab-ci)
- [Jenkins](#jenkins)
- [Required permissions and capabilities](#required-permissions-and-capabilities)
- [Caching and speed-ups](#caching-and-speed-ups)
- [Debugging failures](#debugging-failures)

---

## GitHub Actions

The repository ships a ready-to-go workflow at
[`.github/workflows/chaos-ci.yml`](../.github/workflows/chaos-ci.yml). The
sections below describe how to adapt it.

### Default workflow

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with: { node-version: "20" }

- run: npm ci
- run: npm run build

- run: |
    curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh \
      | TAG=v5.6.0 bash
- run: k3d cluster create quilt-chaos --agents 3 --wait
- run: kubectl apply -f manifests/
- run: node dist/cli.js test --continue-on-failure --output chaos-report.json
```

The workflow uploads `chaos-report.json` + JUnit XML as artifacts and
fails the job if any scenario exceeds its recovery budget.

### Matrix by node count

To assert the recovery budget holds at different cluster sizes, run the
gauntlet against 3-, 5-, and 7-node clusters in parallel.

```yaml
strategy:
  fail-fast: false
  matrix:
    nodes: [3, 5, 7]

steps:
  - run: k3d cluster create quilt-chaos --agents ${{ matrix.nodes }} --wait
  - run: node dist/cli.js test --nodes ${{ matrix.nodes }} --output report-${{ matrix.nodes }}.json
```

### Parallel sharding by scenario

For very large PR backlogs, each scenario can be sharded onto its own
runner. A scenario-level `report.json` is much easier to bisect than a
5-scenario bundle.

```yaml
strategy:
  fail-fast: false
  matrix:
    scenario: [node-failure, network-partition, disk-failure, api-failure, etcd-failure]

steps:
  - run: k3d cluster create quilt-shard --agents 3 --wait
  - run: |
      node dist/cli.js scenario ${{ matrix.scenario }} \
        --cluster quilt-shard \
        --output shard-${{ matrix.scenario }}.json
```

Then aggregate the shard outputs in a final summary job (or use a custom
GitHub Actions reporter).

### Release-gate workflow

The chaos gauntlet should run on every PR, but you can also run an
**extended** version (10× iterations, tighter budgets) on every release
tag. The extra runs catch flaky tests and edge-case failure modes.

```yaml
on:
  push:
    tags: ["v*"]

jobs:
  chaos-extended:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - run: k3d cluster create quilt-rel --agents 3 --wait
      - run: |
          for i in 1 2 3 4 5 6 7 8 9 10; do
            node dist/cli.js test --keep-cluster --output report-$i.json
          done
      - uses: actions/upload-artifact@v4
        with: { name: chaos-extended, path: report-*.json }
```

Release the tag only if every iteration passes.

---

## GitLab CI

```yaml
stages:
  - chaos

chaos:
  stage: chaos
  image: ubuntu:22.04
  tags: [docker, k3d-capable]
  before_script:
    - apt-get update && apt-get install -y curl
    - curl -sL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | TAG=v5.6.0 bash
    - curl -fsL https://deb.nodesource.com/setup_20.x | bash -
    - apt-get install -y nodejs
  script:
    - npm ci
    - npm run build
    - k3d cluster create gitlab-quilt --agents 3 --wait
    - kubectl apply -f manifests/
    - node dist/cli.js test --output chaos-report.json
  artifacts:
    when: always
    paths:
      - chaos-report.json
    reports:
      junit: chaos-junit.xml
```

`quilt-k3s` writes a JUnit XML alongside the JSON report if you pass
`--output chaos-junit.xml` AND the run is configured to convert — or
you can do it yourself with `node -e ...` like the GitHub workflow.

---

## Jenkins

```groovy
pipeline {
  agent { label 'docker && k3d' }
  stages {
    stage('build') {
      steps {
        sh 'npm ci && npm run build'
      }
    }
    stage('chaos') {
      steps {
        sh 'k3d cluster create jenkins-quilt --agents 3 --wait'
        sh 'kubectl apply -f manifests/'
        sh 'node dist/cli.js test --output chaos-report.json'
      }
    }
  }
  post {
    always {
      archiveArtifacts artifacts: 'chaos-report.json', allowEmptyArchive: true
      junit testResults: 'chaos-junit.xml', allowEmptyResults: true
    }
  }
}
```

---

## Required permissions and capabilities

For the chaos CI to run, the runner must be able to:

| Capability                                            | Why                                                |
| ----------------------------------------------------- | -------------------------------------------------- |
| Run Docker (privileged or `--cap-add=SYS_ADMIN`)      | k3d runs K3s inside Docker containers.             |
| Pull from `ghcr.io` and `docker.io`                   | The k3d image, the Quilt images.                   |
| Install `k3d`, `kubectl`, `node`                      | Standard installer + `apt`.                        |
| Mount `/var/lib/docker` (or use a remote Docker host) | k3d creates overlay networks there.                |
| ≥ 4 GiB RAM                                           | 3-node cluster + 2 Quilt pods.                     |
| ≥ 20 GiB disk                                         | K3s images, Quilt images, the chaos report artifacts. |

**Do not** run the gauntlet against a cluster that holds real data. The
scenarios will kill API servers, fill disks, and partition networks.

---

## Caching and speed-ups

The slowest step in CI is usually the K3s image pull. Pre-pull it:

```yaml
- name: Pre-pull K3s image
  run: docker pull rancher/k3s:v1.30.2-k3s1
```

If you re-use the same cluster across jobs in a single workflow, the
`--keep-cluster` flag on `node dist/cli.js test` saves ~30 s per job.

For multi-PR throughput, consider a self-hosted runner pool with a
pre-pulled image baked into the AMI.

---

## Debugging failures

When a scenario fails in CI:

1. **Download the `chaos-report` artifact.** It contains:
   - the JSON report (one entry per scenario, with assertion messages),
   - the JUnit XML (drop into the GitHub Actions UI for filtering).
2. **Look at the assertion `message` field.** The library writes
   human-readable failure causes there.
3. **Reproduce locally:**
   ```sh
   npx @quilt/k3s cluster create --cluster quilt-debug --nodes 3
   npx @quilt/k3s scenario <failing-scenario> --cluster quilt-debug
   npx @quilt/k3s cluster delete --cluster quilt-debug
   ```
4. **Check the Quilt agent logs:** `kubectl -n quilt logs -l app.kubernetes.io/name=quilt-agent`.
5. **Check the cell logs:** `kubectl -n quilt logs quilt-cell-0`.

If a scenario is flaky (> 1 % failure rate across 100 iterations), file
an issue. We treat chaos flakes as bugs in either Quilt or the scenario
— never as "expected chaos."
