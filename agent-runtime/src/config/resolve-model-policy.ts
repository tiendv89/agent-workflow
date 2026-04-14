/**
 * Merges workspace-level model_policy with task-level ### Model overrides
 * and returns the effective model selection for a given phase.
 *
 * Merge rule: task-level overrides replace the workspace default for each
 * declared phase. Undeclared phases inherit workspace defaults.
 */

import type { Phase, PhasePolicy, ModelOverrides } from "./parse-model-overrides.js";

export type { Phase, PhasePolicy };

/** Full workspace model_policy (all four phases required). */
export interface ModelPolicy {
  implementation: PhasePolicy;
  self_review: PhasePolicy;
  pr_description: PhasePolicy;
  suggested_next_step: PhasePolicy;
}

/** Emitted to stdout when the resolved default is not in allowed. */
export interface ModelFallbackEvent {
  type: "model_fallback";
  taskId: string;
  phase: Phase;
  requested: string;
  fallback: string;
  reason: string;
}

function emitFallback(event: ModelFallbackEvent): void {
  console.log(JSON.stringify(event));
}

/**
 * Resolve the effective PhasePolicy for a given phase by merging workspace
 * defaults with task-level overrides.
 *
 * If the resolved default is not in the allowed list (configuration error),
 * falls back to the first item in allowed and emits a model_fallback event.
 *
 * @param workspacePolicy - workspace.yaml model_policy (all phases present).
 * @param taskOverrides   - Parsed task-level overrides from parse-model-overrides.
 * @param phase           - The phase to resolve.
 * @param taskId          - Used in fallback events for diagnostics.
 */
export function resolvePhasePolicy(
  workspacePolicy: ModelPolicy,
  taskOverrides: ModelOverrides,
  phase: Phase,
  taskId: string,
): PhasePolicy {
  const base = workspacePolicy[phase];
  const override = taskOverrides[phase];
  const effective: PhasePolicy = override ?? base;

  if (!effective.allowed.includes(effective.default)) {
    const fallback = effective.allowed[0]!;
    emitFallback({
      type: "model_fallback",
      taskId,
      phase,
      requested: effective.default,
      fallback,
      reason: `default model "${effective.default}" is not in allowed list [${effective.allowed.join(", ")}] — falling back to "${fallback}"`,
    });
    return { ...effective, default: fallback };
  }

  return effective;
}

/**
 * Resolve the effective model ID for a given phase.
 * The most common call site — returns just the default model string.
 *
 * @param workspacePolicy - workspace.yaml model_policy.
 * @param taskOverrides   - Parsed task-level overrides.
 * @param phase           - The phase to resolve.
 * @param taskId          - Used in fallback events for diagnostics.
 */
export function resolveModel(
  workspacePolicy: ModelPolicy,
  taskOverrides: ModelOverrides,
  phase: Phase,
  taskId: string,
): string {
  return resolvePhasePolicy(workspacePolicy, taskOverrides, phase, taskId).default;
}
