/**
 * @quilt/k3s — K3s-based chaos testing framework for Quilt.
 *
 * Public entry point. Re-exports the four primary abstractions:
 *
 *   - {@link Cluster}        — ephemeral k3d cluster lifecycle
 *   - {@link K3sClient}      — typed wrapper around the Kubernetes API
 *   - {@link ScenarioRunner} — runs a single chaos scenario
 *   - {@link ChaosEngine}    — orchestrates a full chaos run
 *
 * Plus shared types and the assertion library.
 *
 * @packageDocumentation
 */

export { Cluster } from "./cluster.js";
export type { ClusterOptions, ClusterNode, ClusterPod } from "./cluster.js";

export { K3sClient } from "./k3s-client.js";
export type { ExecResult, Patch, CordonOptions } from "./k3s-client.js";

export { ScenarioRunner } from "./scenario-runner.js";
export type {
  Scenario,
  ScenarioContext,
  ScenarioResult,
  ScenarioReport,
} from "./scenario-runner.js";

export { ChaosEngine } from "./scenario-runner.js";

export * from "./assertions.js";
export type { AssertionResult, HealthSnapshot } from "./assertions.js";

/** Version of the `@quilt/k3s` library. */
export const VERSION = "0.1.0";

/** Default recovery budget (ms) used when scenarios don't override. */
export const DEFAULT_RECOVERY_BUDGET_MS = 30_000;
