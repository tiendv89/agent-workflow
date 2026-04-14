/**
 * Parses the optional `### Model overrides` subsection from a task's entry in tasks.md.
 *
 * Returns { [phase]: { allowed, default } } for each declared phase.
 * Returns an empty object when the subsection is absent or cannot be parsed
 * (with a model_override_parse_warning event emitted to stdout).
 */

import { parse as parseYaml } from "yaml";

/** The four phases for which model selection is defined. */
export type Phase =
  | "implementation"
  | "self_review"
  | "pr_description"
  | "suggested_next_step";

/** Model allowlist for one execution phase. */
export interface PhasePolicy {
  /** Model IDs the agent may use for this phase. */
  allowed: string[];
  /** Model to use by default; must be in allowed. */
  default: string;
}

/** Task-level model overrides keyed by phase. Only declared phases are present. */
export type ModelOverrides = Partial<Record<Phase, PhasePolicy>>;

/** Emitted to stdout when a ### Model overrides section cannot be parsed. */
export interface ModelOverrideParseWarning {
  type: "model_override_parse_warning";
  taskId: string;
  reason: string;
}

const VALID_PHASES = new Set<string>([
  "implementation",
  "self_review",
  "pr_description",
  "suggested_next_step",
]);

function emitWarning(warning: ModelOverrideParseWarning): void {
  console.log(JSON.stringify(warning));
}

/**
 * Extract the raw text content of the `### Model overrides` block for a given
 * task from the full tasks.md text.
 *
 * Scoping rules:
 *   - Task section starts at `## T<n>` heading line.
 *   - Task section ends at the next `## ` heading or EOF.
 *   - Model overrides block starts at `### Model overrides` within the section.
 *   - Block ends at the next `### ` / `## ` heading or end of task section.
 */
function extractModelOverridesBlock(tasksmd: string, taskId: string): string | null {
  const numericId = taskId.replace(/^T/, "");

  // Find the heading line for this task
  const headingRegex = new RegExp(`^## T${numericId}(?:[ \\t]|$)`, "m");
  const headingMatch = headingRegex.exec(tasksmd);
  if (!headingMatch) return null;

  // Skip to after this heading line
  const headingLineEnd = tasksmd.indexOf("\n", headingMatch.index);
  if (headingLineEnd === -1) return null;
  const afterHeading = tasksmd.slice(headingLineEnd + 1);

  // Scope to this task's section (ends at next ## heading)
  const nextHeadingMatch = /^## /m.exec(afterHeading);
  const taskSection = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;

  // Find ### Model overrides within this section
  const overridesMatch = /^### Model overrides[ \t]*\n/m.exec(taskSection);
  if (!overridesMatch) return null;

  const afterOverrides = taskSection.slice(
    overridesMatch.index + overridesMatch[0].length,
  );

  // Block ends at the next subsection heading or end of task section
  const nextSubsectionMatch = /^##+ /m.exec(afterOverrides);
  const block = nextSubsectionMatch
    ? afterOverrides.slice(0, nextSubsectionMatch.index)
    : afterOverrides;

  return block.trim();
}

function isValidPhasePolicy(val: unknown): val is PhasePolicy {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    Array.isArray(obj["allowed"]) &&
    (obj["allowed"] as unknown[]).every((m) => typeof m === "string") &&
    (obj["allowed"] as unknown[]).length > 0 &&
    typeof obj["default"] === "string" &&
    (obj["default"] as string).length > 0
  );
}

/**
 * Parse the `### Model overrides` subsection for a given task from tasks.md text.
 *
 * @param tasksmd - Full text of the tasks.md file.
 * @param taskId  - Task ID, e.g. "T3".
 * @returns Parsed overrides for declared phases; empty object if absent or malformed.
 */
export function parseModelOverrides(tasksmd: string, taskId: string): ModelOverrides {
  const block = extractModelOverridesBlock(tasksmd, taskId);
  if (block === null || block === "") return {};

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (e) {
    emitWarning({
      type: "model_override_parse_warning",
      taskId,
      reason: `YAML parse error in ### Model overrides: ${(e as Error).message}`,
    });
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    emitWarning({
      type: "model_override_parse_warning",
      taskId,
      reason: "### Model overrides block must be a YAML mapping",
    });
    return {};
  }

  const result: ModelOverrides = {};

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!VALID_PHASES.has(key)) {
      emitWarning({
        type: "model_override_parse_warning",
        taskId,
        reason: `Unknown phase "${key}" — skipping. Valid phases: ${[...VALID_PHASES].join(", ")}`,
      });
      continue;
    }
    if (!isValidPhasePolicy(value)) {
      emitWarning({
        type: "model_override_parse_warning",
        taskId,
        reason: `Phase "${key}" must have allowed (non-empty string array) and default (non-empty string) — skipping`,
      });
      continue;
    }
    result[key as Phase] = value;
  }

  return result;
}
