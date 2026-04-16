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

import { spawn, execSync } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { Task, BlockedReason } from "../types/task.js";
import { taskYamlAbsPath, taskYamlRelPath, featureLogsDirPath, logFileRelPath } from "../paths.js";
import { deriveLogPath, toSafeIso } from "../logging/log-sink.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type RunClaudeResult =
  | { outcome: "in_review" }
  | { outcome: "blocked"; reason: string; details?: unknown };

export interface RunClaudeOpts {
  taskId: string;
  featureId: string;
  workspaceRoot: string;
  taskRepoRoot: string;
  /** Absolute path to the workflow repo (contains technical_skills/). */
  workflowLocalPath: string;
  agentContext: string;
  maxTurns: number;
  maxTokens: number;
  sshKeyPath: string | undefined;
  gitAuthorEmail: string;
  taskBranch: string;
  /** When true, write captured stdout to the JSONL log file and commit+push. */
  logSinkEnabled: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

/**
 * Option B — Pre-flight toolchain check.
 *
 * Detects which package manager / runtime the repo needs by inspecting
 * well-known lock files and manifests, then verifies each required tool
 * exists via `which`. Returns the list of missing tool names (empty = all OK).
 *
 * This runs before spawning claude so zero tokens are spent when the
 * container image is missing a tool.
 */
const TOOLCHAIN_MARKERS: Array<{ file: string; tool: string }> = [
  { file: "yarn.lock",        tool: "yarn"    },
  { file: "pnpm-lock.yaml",   tool: "pnpm"    },
  { file: "go.mod",           tool: "go"      },
  { file: "requirements.txt", tool: "python3" },
  { file: "pyproject.toml",   tool: "python3" },
  { file: "Cargo.toml",       tool: "cargo"   },
];

function checkRequiredTools(taskRepoRoot: string): string[] {
  const missing: string[] = [];
  const checked = new Set<string>();

  for (const { file, tool } of TOOLCHAIN_MARKERS) {
    if (checked.has(tool)) continue;
    if (!existsSync(join(taskRepoRoot, file))) continue;
    checked.add(tool);
    try {
      execSync(`which ${tool}`, { stdio: "pipe" });
    } catch {
      missing.push(tool);
    }
  }

  return missing;
}

/**
 * Option A — Hard-stop instruction appended to every agent context.
 *
 * Safety net for tools the pre-flight doesn't know about (e.g. jq, forge,
 * custom CLIs). If the agent hits a 127 exit code for any tool, it must
 * block immediately instead of burning turns trying workarounds.
 */
const MISSING_TOOL_INSTRUCTION = `

## Hard stop rule — missing tools
If any shell command exits with code 127 ("command not found"), do NOT attempt to install it, use an alternative, or work around it in any way. This is a container environment problem that the runtime must fix — the agent cannot fix it. Immediately set the task status to \`blocked\`, set \`blocked_reason\` to \`missing_tool\`, record which tool was missing in \`blocked_details\`, and stop.`;

/**
 * Symlink workspace and workflow skills into the task repo's .claude/skills/
 * directory so Claude Code can discover them natively.
 *
 * Two skill sources (in precedence order — first writer wins):
 *   1. workspaceRoot/.claude/skills/   — workflow skills (pr-create, start-implementation,
 *                                        pr-self-review, …) plus workspace-level technical skills
 *   2. workflowLocalPath/technical_skills/ — canonical technical skills (fallback if absent
 *                                            from the workspace)
 *
 * Existing entries in taskRepoRoot/.claude/skills/ are never overwritten — EEXIST
 * is silently skipped so task-repo-native skills take precedence.
 *
 * This is a best-effort operation; a single failed symlink never aborts the run.
 */
function setupSkillSymlinks(
  taskRepoRoot: string,
  workspaceRoot: string,
  workflowLocalPath: string,
): void {
  const targetSkillsDir = join(taskRepoRoot, ".claude", "skills");
  mkdirSync(targetSkillsDir, { recursive: true });

  const sourceDirs = [
    join(workspaceRoot, ".claude", "skills"),
    join(workflowLocalPath, "workflow_skills"),
    join(workflowLocalPath, "technical_skills"),
  ];

  for (const sourceDir of sourceDirs) {
    if (!existsSync(sourceDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(sourceDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const linkPath = join(targetSkillsDir, entry);
      const targetPath = join(sourceDir, entry);
      try {
        symlinkSync(targetPath, linkPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          emit({ type: "skill_symlink_warn", skill: entry, details: String(e) });
        }
        // EEXIST: already linked (from a prior activation or task-repo native) — skip.
      }
    }
  }
}

/**
 * Scan stdout lines for token usage across all formats:
 *
 * - stream-json assistant events:
 *     {"type":"assistant","message":{"usage":{"input_tokens":N,"output_tokens":N,...}}}
 *   These fire once per turn; we sum all turns for the total.
 *
 * - Legacy flat usage object (plain-text / json format):
 *     {"usage":{"input_tokens":N,"output_tokens":N}}
 *
 * Returns accumulated total tokens, or undefined if no usage lines are found.
 */
function extractTotalTokens(stdout: string): number | undefined {
  let total = 0;
  let found = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;

      // stream-json: assistant event carries per-turn usage inside message.
      if (parsed.type === "assistant") {
        const msg = parsed.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (
          typeof usage?.input_tokens === "number" &&
          typeof usage?.output_tokens === "number"
        ) {
          total += (usage.input_tokens as number) + (usage.output_tokens as number);
          found = true;
        }
        continue;
      }

      // Legacy flat shape.
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (
        typeof usage?.input_tokens === "number" &&
        typeof usage?.output_tokens === "number"
      ) {
        total += (usage.input_tokens as number) + (usage.output_tokens as number);
        found = true;
      }
    } catch {
      // Not a JSON line — skip.
    }
  }

  return found ? total : undefined;
}

/**
 * Write blocked state to the task YAML and commit+push to the management repo.
 * Called only when claude exits without updating the task status (still in_progress).
 * Writes blocked_context with wip_branch, wip_sha (from git rev-parse HEAD), and pushed_at.
 */
function writeBlockedAndPush(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  task: Task,
  blockedReason: BlockedReason,
  note: string,
  taskBranch: string,
  gitAuthorEmail: string,
  sshKeyPath: string | undefined,
): void {
  const now = new Date().toISOString();
  task.status = "blocked";
  task.blocked_reason = blockedReason;

  let wipSha = "unknown";
  try {
    wipSha = execSync(
      `git -C "${workspaceRoot}" rev-parse HEAD`,
      { encoding: "utf-8", stdio: "pipe" },
    ).trim();
  } catch {
    // best-effort; leave wipSha as "unknown" if rev-parse fails
  }
  task.blocked_context = {
    wip_branch: taskBranch,
    wip_sha: wipSha,
    pushed_at: now,
  };

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

/**
 * Write captured claude stdout to the per-run JSONL log file and commit+push.
 * The file contains: run_started event, raw claude output, run_ended event.
 * Raw claude output lines are written as-is — they may or may not be JSON.
 */
function flushLogAndPush(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  taskBranch: string,
  runStartIso: string,
  gitAuthorEmail: string,
  stdout: string,
  outcome: string,
  sshKeyPath: string | undefined,
): void {
  const logPath = deriveLogPath(workspaceRoot, featureId, taskId, runStartIso);
  mkdirSync(featureLogsDirPath(workspaceRoot, featureId, taskId), { recursive: true });

  // Header event — written synchronously so partial logs are still useful.
  appendFileSync(
    logPath,
    JSON.stringify({ at: runStartIso, by: gitAuthorEmail, type: "run_started" }) + "\n",
  );

  // Raw claude output (may be plain text or JSON events).
  if (stdout) {
    appendFileSync(logPath, stdout);
    if (!stdout.endsWith("\n")) appendFileSync(logPath, "\n");
  }

  // Footer event.
  appendFileSync(
    logPath,
    JSON.stringify({ at: new Date().toISOString(), by: gitAuthorEmail, type: "run_ended", details: { outcome } }) + "\n",
  );

  const logFilename = `${toSafeIso(runStartIso)}.jsonl`;
  const relPath = logFileRelPath(featureId, taskId, logFilename);
  const sshEnv = sshKeyPath
    ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
    : {};
  const env = { ...process.env, ...sshEnv } as NodeJS.ProcessEnv;

  execSync(`git -C "${workspaceRoot}" add "${relPath}"`, { env, stdio: "pipe" });
  execSync(`git -C "${workspaceRoot}" commit -m "chore: flush task log ${taskId}"`, { env, stdio: "pipe" });
  execSync(`git -C "${workspaceRoot}" push origin "${taskBranch}"`, { env, stdio: "pipe" });
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
    workflowLocalPath,
    agentContext,
    maxTurns,
    maxTokens,
    sshKeyPath,
    gitAuthorEmail,
    taskBranch,
    logSinkEnabled,
  } = opts;

  const runStartIso = new Date().toISOString();

  // Build subprocess environment — inject SSH command if a key is available.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no`;
  }

  // ── Option B: Pre-flight toolchain check ─────────────────────────────────
  // Verify required tools exist before spending any tokens. If a tool is
  // missing the container image must be fixed — block immediately.
  const missingTools = checkRequiredTools(taskRepoRoot);
  if (missingTools.length > 0) {
    const details = `missing tools in container: ${missingTools.join(", ")}`;
    emit({ type: "preflight_failed", task_id: taskId, reason: "missing_tool", details });
    return { outcome: "blocked", reason: "missing_tool", details };
  }

  // ── Skill symlinks ────────────────────────────────────────────────────────
  // Symlink workspace and workflow skills into taskRepoRoot so Claude Code
  // discovers them natively (pr-create, start-implementation, etc.).
  setupSkillSymlinks(taskRepoRoot, workspaceRoot, workflowLocalPath);

  // ── Option A: Append hard-stop instruction ───────────────────────────────
  // Fallback for tools the pre-flight doesn't know about.
  const effectiveAgentContext = agentContext + MISSING_TOOL_INSTRUCTION;

  emit({ type: "claude_spawn", task_id: taskId, max_turns: maxTurns });

  // Use async spawn so stdout streams to the container log in real-time
  // while also being captured for the JSONL log sink.
  const spawnResult = await new Promise<{
    stdout: string;
    status: number | null;
    signal: string | null;
    error?: Error;
  }>((resolve) => {
    const stdoutChunks: string[] = [];

    const child = spawn(
      "claude",
      [
        "-p", effectiveAgentContext,
        "--max-turns", String(maxTurns),
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ],
      { cwd: taskRepoRoot, env },
    );

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    // Tee stdout: capture for log sink + stream to container stdout.
    child.stdout.on("data", (chunk: string) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });

    // Surface claude's stderr directly to the container log.
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
    });

    child.on("error", (error: Error) => {
      resolve({ stdout: stdoutChunks.join(""), status: null, signal: null, error });
    });

    child.on("close", (code: number | null, signal: string | null) => {
      resolve({ stdout: stdoutChunks.join(""), status: code, signal });
    });
  });

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
  let result: RunClaudeResult;

  let task: Task;
  try {
    task = parseYaml(
      readFileSync(taskYamlAbsPath(workspaceRoot, featureId, taskId), "utf-8"),
    ) as Task;
  } catch (e) {
    result = {
      outcome: "blocked",
      reason: "runtime_error",
      details: `Failed to read task YAML after claude exit: ${String(e)}`,
    };
    // Log flush is best-effort when the task YAML itself is unreadable.
    if (logSinkEnabled) {
      try {
        flushLogAndPush(workspaceRoot, featureId, taskId, taskBranch, runStartIso, gitAuthorEmail, spawnResult.stdout ?? "", result.outcome, sshKeyPath);
      } catch (logErr) {
        emit({ type: "log_flush_failed", task_id: taskId, details: String(logErr) });
      }
    }
    return result;
  }

  if (task.status === "in_review") {
    result = { outcome: "in_review" };
  } else if (task.status === "blocked") {
    const reason = task.blocked_reason ?? "unknown";
    // Token overage takes precedence over the agent's own blocked_reason.
    if (totalTokens !== undefined && totalTokens > maxTokens) {
      result = {
        outcome: "blocked",
        reason: "budget_exceeded",
        details: {
          total_tokens: totalTokens,
          max_tokens: maxTokens,
          original_reason: reason,
        },
      };
    } else {
      result = { outcome: "blocked", reason, details: task.blocked_details };
    }
  } else {
    // Task is still in_progress — claude exited without completing the task.
    const note =
      spawnResult.error
        ? `process error: ${spawnResult.error.message}`
        : `task still in_progress after claude exit (code ${spawnResult.status ?? "null"})`;

    emit({ type: "task_blocked", task_id: taskId, reason: "runtime_error", note });

    try {
      writeBlockedAndPush(workspaceRoot, featureId, taskId, task, "runtime_error", note, taskBranch, gitAuthorEmail, sshKeyPath);
    } catch (pushErr) {
      emit({ type: "blocked_push_failed", task_id: taskId, details: String(pushErr) });
    }

    result = { outcome: "blocked", reason: "runtime_error", details: note };
  }

  // ── Flush log to management repo ──────────────────────────────────────────
  if (logSinkEnabled) {
    try {
      flushLogAndPush(
        workspaceRoot,
        featureId,
        taskId,
        taskBranch,
        runStartIso,
        gitAuthorEmail,
        spawnResult.stdout ?? "",
        result.outcome,
        sshKeyPath,
      );
    } catch (logErr) {
      emit({ type: "log_flush_failed", task_id: taskId, details: String(logErr) });
    }
  }

  return result;
}
