#!/usr/bin/env node
/**
 * CLI entry point for `@quilt/k3s`.
 *
 *   npx @quilt/k3s test                          # run all 5 scenarios
 *   npx @quilt/k3s scenario <name>               # run a single scenario
 *   npx @quilt/k3s cluster {create|status|delete}
 *   npx @quilt/k3s report <path>                 # pretty-print a JSON report
 */

import { Command } from "commander";
import { Cluster } from "./cluster.js";
import { ChaosEngine, ScenarioRunner, DEFAULT_RECOVERY_BUDGET_MS } from "./index.js";
import { nodeFailure } from "../scenarios/node-failure.js";
import { networkPartition } from "../scenarios/network-partition.js";
import { diskFailure } from "../scenarios/disk-failure.js";
import { apiFailure } from "../scenarios/api-failure.js";
import { etcdFailure } from "../scenarios/etcd-failure.js";
import type { Scenario } from "./scenario-runner.js";

const ALL_SCENARIOS: readonly Scenario[] = [
  nodeFailure,
  networkPartition,
  diskFailure,
  apiFailure,
  etcdFailure,
];

const SCENARIOS_BY_NAME: ReadonlyMap<string, Scenario> = new Map(ALL_SCENARIOS.map((s) => [s.name, s]));

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("quilt-k3s")
    .description("K3s-based chaos testing for Quilt")
    .version("0.1.0");

  program
    .command("test")
    .description("Spin up a cluster, run all 5 chaos scenarios, report")
    .option("-n, --nodes <count>", "number of agent nodes", "3")
    .option("-c, --cluster <name>", "k3d cluster name", "quilt-chaos")
    .option("--keep-cluster", "do not delete the cluster after the run", false)
    .option("--continue-on-failure", "run all scenarios even if one fails", false)
    .option("-o, --output <path>", "write JSON report to this file", "chaos-report.json")
    .action(async (opts: { nodes: string; cluster: string; keepCluster: boolean; continueOnFailure: boolean; output: string }) => {
      const cluster = await Cluster.create({
        name: opts.cluster,
        nodes: Number.parseInt(opts.nodes, 10),
      });
      try {
        const engine = new ChaosEngine({ cluster, scenarios: ALL_SCENARIOS });
        const report = await engine.runAll({ continueOnFailure: opts.continueOnFailure });
        await writeReport(opts.output, report);
        printSummary(report);
        if (!report.passed) process.exitCode = 1;
      } finally {
        if (!opts.keepCluster) await cluster.delete();
      }
    });

  program
    .command("scenario <name>")
    .description("Run a single named scenario")
    .option("-c, --cluster <name>", "use an existing k3d cluster", "quilt-chaos")
    .option("--no-create", "do not auto-create the cluster if missing")
    .action(async (name: string, opts: { cluster: string; create: boolean }) => {
      const scenario = SCENARIOS_BY_NAME.get(name);
      if (!scenario) {
        console.error(`Unknown scenario: ${name}. Available: ${[...SCENARIOS_BY_NAME.keys()].join(", ")}`);
        process.exitCode = 2;
        return;
      }
      let cluster = await maybeExisting(opts.cluster, opts.create);
      if (!cluster) {
        console.error(`Cluster ${opts.cluster} does not exist. Re-run with --create or omit --no-create.`);
        process.exitCode = 1;
        return;
      }
      const runner = new ScenarioRunner(scenario, cluster);
      const result = await runner.run();
      printScenarioResult(result);
      if (!result.passed) process.exitCode = 1;
    });

  const clusterCmd = program.command("cluster").description("Manage the k3d cluster lifecycle");
  clusterCmd
    .command("create")
    .description("Create a k3d cluster")
    .option("-n, --nodes <count>", "number of agent nodes", "3")
    .option("-c, --cluster <name>", "k3d cluster name", "quilt-chaos")
    .action(async (opts: { nodes: string; cluster: string }) => {
      const c = await Cluster.create({ name: opts.cluster, nodes: Number.parseInt(opts.nodes, 10) });
      console.log(`Created cluster ${c.name} with ${c.nodes} agent nodes.`);
    });
  clusterCmd
    .command("status")
    .description("Print cluster status")
    .option("-c, --cluster <name>", "k3d cluster name", "quilt-chaos")
    .action(async (opts: { cluster: string }) => {
      const c = new Cluster({
        name: opts.cluster,
        image: "rancher/k3s:v1.30.2-k3s1",
        nodes: 3,
        executor: undefined as never,
        readyTimeoutMs: 0,
      });
      // Use the convenience static create() with the name as a probe.
      const exists = await probeExists(opts.cluster);
      if (!exists) {
        console.error(`Cluster ${opts.cluster} does not exist.`);
        process.exitCode = 1;
        return;
      }
      const nodes = await c.getNodes();
      console.table(nodes);
    });
  clusterCmd
    .command("delete")
    .description("Delete a k3d cluster")
    .option("-c, --cluster <name>", "k3d cluster name", "quilt-chaos")
    .action(async (opts: { cluster: string }) => {
      const c = await Cluster.create({ name: opts.cluster });
      await c.delete();
      console.log(`Deleted cluster ${c.name}.`);
    });

  program
    .command("report <path>")
    .description("Pretty-print a JSON chaos report")
    .action((path: string) => {
      // Lazy-read to keep `report` command cheap.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const data = JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
      console.log(JSON.stringify(data, null, 2));
    });

  await program.parseAsync(process.argv);
}

async function maybeExisting(name: string, allowCreate: boolean): Promise<Cluster | null> {
  // We don't have a direct "exists" check on a not-yet-constructed Cluster,
  // so we try to construct a transient one. If that fails, optionally create.
  try {
    return await Cluster.create({ name });
  } catch (err) {
    if (!allowCreate) return null;
    throw err;
  }
}

async function probeExists(name: string): Promise<boolean> {
  const { execa } = await import("execa");
  try {
    await execa("k3d", ["cluster", "get", name]);
    return true;
  } catch {
    return false;
  }
}

async function writeReport(path: string, report: unknown): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, JSON.stringify(report, null, 2), "utf8");
}

function printSummary(report: { results: ReadonlyArray<{ name: string; passed: boolean; recoveredInMs: number | null }>; passed: boolean }): void {
  console.log("\n┌─ Chaos report ─────────────────────────────────────");
  for (const r of report.results) {
    const mark = r.passed ? "✅" : "❌";
    const time = r.recoveredInMs === null ? "n/a" : `${r.recoveredInMs}ms`;
    console.log(`│ ${mark} ${r.name.padEnd(22)} ${time}`);
  }
  console.log(`└─ Overall: ${report.passed ? "PASS" : "FAIL"} (budget: ${DEFAULT_RECOVERY_BUDGET_MS}ms) ─`);
}

function printScenarioResult(r: { name: string; passed: boolean; recoveredInMs: number | null; error: string | null }): void {
  const mark = r.passed ? "✅" : "❌";
  const time = r.recoveredInMs === null ? "n/a" : `${r.recoveredInMs}ms`;
  console.log(`${mark} ${r.name} (${time})${r.error ? ` — ${r.error}` : ""}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
