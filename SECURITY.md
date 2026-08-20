# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

As `quilt-k3s` is currently pre-1.0, only the latest minor release receives
security updates. Critical fixes may be back-ported to the previous minor at
the maintainers' discretion.

## Reporting a Vulnerability

**Please do not file a public issue for security vulnerabilities.**

Report privately via one of the following channels:

- **Email:** security@superinstance.dev (PGP key on request)
- **GitHub:** open a [private security advisory][gh-advisory] on this repo

[gh-advisory]: https://github.com/SuperInstance/quilt-k3s/security/advisories/new

We will acknowledge receipt within 48 hours and aim to ship a fix or
mitigation within 14 days, depending on severity.

### What to include

A good report contains:

1. A clear description of the vulnerability and its impact.
2. A reproducer (commit SHA, scenario name, command line, manifest, etc.).
3. The affected version(s) of `@quilt/k3s`.
4. Your assessment of severity (CVSS, if you have it).
5. Whether you intend to disclose publicly and, if so, on what timeline.

We follow [coordinated disclosure][cd] — please give us a reasonable window
(typically 90 days) before publishing details.

[cd]: https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure

## Scope

In scope:

- The `@quilt/k3s` library (`src/`, `scenarios/`, `manifests/`).
- The GitHub Actions workflow at `.github/workflows/chaos-ci.yml` (e.g.
  command injection in scenario arguments, arbitrary k3d node execution).
- The CLI (`src/cli.ts`).

Out of scope:

- Vulnerabilities in upstream dependencies (`@kubernetes/client-node`,
  `execa`, `commander`, etc.) — please report those upstream.
- The K3s / k3d projects themselves.
- The Quilt runtime; report those in
  [quilt-core](https://github.com/SuperInstance/quilt-core).

## Hardening Notes for Operators

`quilt-k3s` executes arbitrary commands inside a 3-node k3d cluster. To run
the chaos gauntlet safely:

- **Never run against a production cluster.** The scenarios are designed to
  kill API servers, fill disks, and partition the network.
- Run inside an ephemeral VM, a CI runner, or a developer laptop. The
  workflow provided in `.github/workflows/chaos-ci.yml` uses an ephemeral
  `ubuntu-22.04` runner for exactly this reason.
- The `iptables`, `fallocate`, and `kill` invocations require the `NET_ADMIN`
  capability or `privileged: true` on the affected containers. Only grant
  these to the `quilt-cell` and `quilt-agent` containers as required by
  `manifests/`.
- Treat the generated `chaos-report.json` artifact as containing no
  sensitive material, but DO NOT include real cluster credentials in
  kubeconfig that is uploaded to CI.

## Acknowledgements

We thank the following reporters (with their permission) for responsible
disclosures:

<!--
  This section is intentionally empty. Add reporters here when issues are
  fixed and disclosed.
-->
