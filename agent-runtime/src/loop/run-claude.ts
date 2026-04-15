/**
 * T5: Claude Code CLI subprocess invocation.
 *
 * Replaces the raw Anthropic SDK tool-use loop (run-task.ts) with a thin
 * wrapper around `claude -p <agentContext> --max-turns <n>`. After the
 * subprocess exits, the task YAML is read to determine the outcome.
 *
 * Token audit (D3 option X / Y):
 *   Attempt to find a JSON usage line in stdout. If found and total tokens
 *   exceed maxTokens, override the outcome to budget_exceeded. If the format
 *   is not found, emit budget_audit_skipped and continue (option Y).
 */

import { spawnSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { Task, BlockedReason } from "../types/task.js";
import { taskYamlAbsPath, taskYamlRelPath } from "../paths.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type RunClaudeResult =
  | { outcome: "in_review" }
  | { outcome: "blocked"; reason: string; details?: unknown };

export interface RunClaudeOpts {
  taskId: string;
  featureId: string;
  workspaceRoot: string;
  taskRepoRoot: string;
  agentContext: string;
  maxTurns: number;
  maxTokens: number;
  sshKeyPath: string | undefined;
  gitAuthorEmail: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

/**
 * Scan stdout lines (in reverse) for a JSON object containing usage fields.
 * Claude Code may emit a usage summary when output includes structured data.
 * Returns total tokens (input + output) or undefined if not found.
 */
function extractTotalTokens(stdout: string): number | undefined {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (
        typeof usage?.input_tokens === "number" &&
        typeof usage?.output_tokens === "number"
      ) {
        return (usage.input_tokens as number) + (usage.output_tokens as number);
      }
    } catch {
      // Not a JSON line — keep scanning.
    }
  }
  return undefined;
}

/**
 * Write blocked state to the task YAML and commit+push to the management repo.
 * Called only when claude exits without updating the task status (still in_progress).
 */
function writeBlockedAndPush(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  task: Task,
  blockedReason: BlockedReason,
  note: string,
  gitAuthorEmail: string,
  sshKeyPath: string | undefined,
): void {
  const now = new Date().toISOString();
  task.status = "blocked";
  task.blocked_reason = blockedReason;
  task.execution.last_updated_by = gitAuthorEmail;
  task.execution.last_updated_at = now;
  task.log.push({ action: "blocked", by: gitAuthorEmail, at: now, note });

  const yamlPath = taskYamlAbsPath(workspaceRoot, featureId, taskId);
  writeFileSync(yamlPath, yamlStringify(task));

  const relPath = taskYamlRelPath(featureId, taskId);
  const sshEnv = sshKeyPath
    ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
    : {};
  const env = { ...process.env, ...sshEnv };
  const opts = { cwd: workspaceRoot, encoding: "utf-8" as const, env };

  execSync(`git add "${relPath}"`, opts);
  execSync(
    `git commit -m "chore(${taskId}): blocked — ${blockedReason}"`,
    opts,
  );
  execSync("git push origin HEAD", opts);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Invoke `claude -p <agentContext> --max-turns <n>` as a subprocess, then
 * read the task YAML to determine the outcome.
 */
export async function runClaude(opts: RunClaudeOpts): Promise<RunClaudeResult> {
  const {
    taskId,
    featureId,
    workspaceRoot,
    taskRepoRoot,
    agentContext,
    maxTurns,
    maxTokens,
    sshKeyPath,
    gitAuthorEmail,
  } = opts;

  // Build subprocess environment — inject SSH command if a key is available.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no`;
  }

  emit({ type: "claude_spawn", task_id: taskId, max_turns: maxTurns });

  const spawnResult = spawnSync(
    "claude",
    ["-p", agentContext, "--max-turns", String(maxTurns)],
    {
      cwd: taskRepoRoot,
      env,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50 MB
    },
  );

  emit({
    type: "claude_exit",
    task_id: taskId,
    exit_code: spawnResult.status,
    signal: spawnResult.signal ?? null,
  });

  // ── Token audit (D3) ──────────────────────────────────────────────────────
  const totalTokens =
    spawnResult.stdout ? extractTotalTokens(spawnResult.stdout) : undefined;

  if (totalTokens === undefined) {
    emit({
      type: "budget_audit_skipped",
      task_id: taskId,
      reason: "usage format not found in stdout",
    });
  } else {
    emit({ type: "budget_audit", task_id: taskId, total_tokens: totalTokens, max_tokens: maxTokens });
  }

  // ── Outcome determination ─────────────────────────────────────────────────
  let task: Task;
  try {
    task = parseYaml(
      readFileSync(taskYamlAbsPath(workspaceRoot, featureId, taskId), "utf-8"),
    ) as Task;
  } catch (e) {
    return {
      outcome: "blocked",
      reason: "runtime_error",
      details: `Failed to read task YAML after claude exit: ${String(e)}`,
    };
  }

  if (task.status === "in_review") {
    return { outcome: "in_review" };
  }

  if (task.status === "blocked") {
    const reason = task.blocked_reason ?? "unknown";
    // Token overage takes precedence over the agent's own blocked_reason.
    if (totalTokens !== undefined && totalTokens > maxTokens) {
      return {
        outcome: "blocked",
        reason: "budget_exceeded",
        details: {
          total_tokens: totalTokens,
          max_tokens: maxTokens,
          original_reason: reason,
        },
      };
    }
    return { outcome: "blocked", reason, details: task.blocked_details };
  }

  // Task is still in_progress — claude exited without completing the task.
  const note =
    spawnResult.error
      ? `process error: ${spawnResult.error.message}`
      : `task still in_progress after claude exit (code ${spawnResult.status ?? "null"})`;

  emit({ type: "task_blocked", task_id: taskId, reason: "runtime_error", note });

  try {
    writeBlockedAndPush(
      workspaceRoot,
      featureId,
      taskId,
      task,
      "runtime_error",
      note,
      gitAuthorEmail,
      sshKeyPath,
    );
  } catch (pushErr) {
    emit({
      type: "blocked_push_failed",
      task_id: taskId,
      details: String(pushErr),
    });
  }

  return { outcome: "blocked", reason: "runtime_error", details: note };
}
