/**
 * T7: Suggested-next-step generator.
 *
 * Produces a short triage hint for a blocked task using the Haiku tier.
 * The hint is written to task.execution.suggested_next_step for human operators.
 *
 * Never throws — any API or response failure returns a safe fallback string.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Task, BlockedReason } from "../types/task.js";

// ── Injectable client interface ───────────────────────────────────────────────

/**
 * Minimal Anthropic client interface for suggested-next-step generation.
 * Structurally compatible with AnthropicClient from run-task.ts.
 */
export interface SuggestedNextStepClient {
  messages: {
    create(params: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: "user"; content: string }>;
    }): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface GenerateSuggestedNextStepOptions {
  /** The blocked task (must have blocked_reason set). */
  task: Task;
  /** Optional description excerpt from tasks.md for additional context. */
  taskDescription?: string | null;
  /**
   * Anthropic client to use.
   * If omitted, creates one from ANTHROPIC_API_KEY environment variable.
   */
  anthropicClient?: SuggestedNextStepClient;
  /**
   * Model to use for generation.
   * Default: claude-haiku-4-5-20251001 (Haiku tier per workspace model_policy).
   */
  model?: string;
  /**
   * Maximum tokens for the generated hint.
   * Should come from agentConfig.budget.suggested_next_step_max_tokens.
   * Default: 500.
   */
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 500;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a one-sentence triage hint for a blocked task using the Haiku tier.
 *
 * Returns a concrete, actionable string telling a human operator what to do.
 * On any failure (network error, unexpected response shape), returns a safe
 * fallback string — callers do not need to handle exceptions from this function.
 */
export async function generateSuggestedNextStep(
  opts: GenerateSuggestedNextStepOptions,
): Promise<string> {
  const {
    task,
    taskDescription,
    anthropicClient,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
  } = opts;

  const client: SuggestedNextStepClient =
    anthropicClient ??
    (new Anthropic() as unknown as SuggestedNextStepClient);

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: buildPrompt(task, taskDescription) }],
    });

    const first = response.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      return first.text.trim();
    }
  } catch {
    // Fallthrough to fallback — error is non-fatal
  }

  return buildFallback(task.id, task.blocked_reason);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildPrompt(
  task: Task,
  taskDescription: string | null | undefined,
): string {
  const lines: string[] = [
    "A workflow task is blocked and needs a human triage suggestion.",
    "",
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Repo: ${task.repo}`,
    `Blocked reason: ${task.blocked_reason ?? "unknown"}`,
  ];

  if (task.blocked_details) {
    const details =
      typeof task.blocked_details === "string"
        ? task.blocked_details
        : JSON.stringify(task.blocked_details);
    lines.push(`Details: ${details}`);
  }

  if (taskDescription) {
    lines.push("", `Task description: ${taskDescription}`);
  }

  lines.push(
    "",
    "Write one concise sentence (under 100 words) for a human operator: " +
      "what specific action should they take to unblock this task? " +
      "Be concrete and actionable. No preamble, no trailing explanation.",
  );

  return lines.join("\n");
}

function buildFallback(taskId: string, reason: BlockedReason | null): string {
  const reasonStr = reason ?? "unknown";
  return (
    `Task ${taskId} is blocked (${reasonStr}). ` +
    "Review the task YAML and blocked_details, then reset the task to ready after resolving the underlying issue."
  );
}
