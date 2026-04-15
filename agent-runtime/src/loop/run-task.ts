/**
 * T6: Anthropic SDK tool-use loop with budget enforcement, dynamic skill loading,
 * and model policy resolution.
 *
 * Entry point: runTask(opts) → RunTaskResult
 *
 * Responsibilities:
 *   - Load task.yaml and tasks.md (skills + model overrides)
 *   - Load SKILL.md bodies from the workflow repo
 *   - Resolve model per phase (workspace defaults merged with task overrides)
 *   - Run Anthropic tool-use loop until end_turn, budget cap, or iteration cap
 *   - Budget enforcement: token cap → budget_exceeded
 *   - Iteration cap: max_iterations exceeded → iteration_cap_exceeded
 *   - No-progress detection: same tool+args 3 iterations in a row → no_progress
 *   - Escalation: model calls `escalate` tool → model_escalation_requested
 *   - Runtime errors: caught at top level → runtime_error, never leave in_progress
 *   - Emit task_work_iteration telemetry events to log sink
 *   - Write task.yaml state changes (blocked / in_review) and git commit+push
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import type { ModelPolicy } from "../config/resolve-model-policy.js";
import { resolveModel } from "../config/resolve-model-policy.js";
import { parseModelOverrides } from "../config/parse-model-overrides.js";
import { parseTasksMd } from "../eligibility/parse-tasks-md.js";
import type { LogSink } from "../logging/log-sink.js";
import type { Task, BlockedReason } from "../types/task.js";
import { taskYamlAbsPath, taskYamlRelPath, tasksMdAbsPath, skillMdAbsPath } from "../paths.js";
import type { AgentConfig } from "../config/validate-agent-yaml.js";
import {
  generateSuggestedNextStep,
  type SuggestedNextStepClient,
} from "../claim/suggested-next-step.js";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Minimal Anthropic messages interface.
 * Injectable for testing — tests can pass a mock without instantiating a real client.
 */
export interface AnthropicClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

export interface RunTaskOptions {
  /** Task ID to run (e.g. "T6"). */
  taskId: string;
  /** Feature directory ID (e.g. "distributed-agent-team"). */
  featureId: string;
  /** Absolute path to the management (workspace) repo root. */
  workspaceRoot: string;
  /** Absolute path to the workflow repo root (contains technical_skills/). */
  workflowRoot: string;
  /** Absolute path to the implementation repo root (where code changes happen). */
  taskRepoRoot: string;
  /** Validated agent configuration (budget, log_sink, etc.). */
  agentConfig: AgentConfig;
  /** Workspace-level model policy (all four phases). */
  workspaceModelPolicy: ModelPolicy;
  /** Log sink for structured telemetry events. */
  logSink: LogSink;
  /** GIT_AUTHOR_EMAIL of the running agent. */
  gitAuthorEmail: string;
  /** SSH private key path for git push. Omit to rely on ambient SSH config. */
  sshKeyPath?: string;
  /**
   * Skip git add/commit/push when writing task.yaml mutations.
   * Intended for unit tests that do not have a real git repo.
   */
  skipGit?: boolean;
  /**
   * Injectable Anthropic client. When omitted, a new Anthropic() client is
   * created from the ANTHROPIC_API_KEY environment variable.
   */
  anthropicClient?: AnthropicClient;
}

export type RunTaskResult =
  | { outcome: "in_review" }
  | {
      outcome: "blocked";
      reason: BlockedReason;
      details?: string | Record<string, unknown>;
    };

// ── Task YAML helpers ─────────────────────────────────────────────────────────

function loadTaskYaml(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
): Task {
  return parseYaml(
    readFileSync(taskYamlAbsPath(workspaceRoot, featureId, taskId), "utf-8"),
  ) as Task;
}

function saveTaskYaml(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  task: Task,
): void {
  writeFileSync(
    taskYamlAbsPath(workspaceRoot, featureId, taskId),
    yamlStringify(task),
    "utf-8",
  );
}

function gitCommitTaskYaml(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  commitMessage: string,
  sshKeyPath: string | undefined,
  branch: string,
): void {
  const relPath = taskYamlRelPath(featureId, taskId);
  const sshEnv = sshKeyPath
    ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
    : {};
  const env = { ...process.env, ...sshEnv } as NodeJS.ProcessEnv;

  execSync(`git -C "${workspaceRoot}" add "${relPath}"`, {
    env,
    stdio: "pipe",
  });
  execSync(
    `git -C "${workspaceRoot}" commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
    { env, stdio: "pipe" },
  );
  execSync(`git -C "${workspaceRoot}" push origin "${branch}"`, {
    env,
    stdio: "pipe",
  });
}

function markTaskBlocked(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  reason: BlockedReason,
  details: string | Record<string, unknown> | undefined,
  gitAuthorEmail: string,
  sshKeyPath: string | undefined,
  branch: string,
  skipGit: boolean,
): void {
  const task = loadTaskYaml(workspaceRoot, featureId, taskId);
  const now = new Date().toISOString();

  task.status = "blocked";
  task.blocked_reason = reason;
  task.blocked_details = details ?? null;
  task.execution.last_updated_by = gitAuthorEmail;
  task.execution.last_updated_at = now;
  task.log.push({
    action: "blocked",
    by: gitAuthorEmail,
    at: now,
    note: `Blocked by run-task: ${reason}`,
  });

  saveTaskYaml(workspaceRoot, featureId, taskId, task);

  if (!skipGit) {
    try {
      gitCommitTaskYaml(
        workspaceRoot,
        featureId,
        taskId,
        `chore(${taskId}): blocked — ${reason}`,
        sshKeyPath,
        branch,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          type: "task_yaml_git_error",
          taskId,
          operation: "block",
          error: (err as Error).message,
        }),
      );
    }
  }
}

function markTaskInReview(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  gitAuthorEmail: string,
  sshKeyPath: string | undefined,
  branch: string,
  skipGit: boolean,
): void {
  const task = loadTaskYaml(workspaceRoot, featureId, taskId);
  const now = new Date().toISOString();

  task.status = "in_review";
  task.execution.last_updated_by = gitAuthorEmail;
  task.execution.last_updated_at = now;
  task.log.push({
    action: "moved_to_in_review",
    by: gitAuthorEmail,
    at: now,
    note: "Implementation complete — awaiting review",
  });

  saveTaskYaml(workspaceRoot, featureId, taskId, task);

  if (!skipGit) {
    try {
      gitCommitTaskYaml(
        workspaceRoot,
        featureId,
        taskId,
        `chore(${taskId}): in_review`,
        sshKeyPath,
        branch,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          type: "task_yaml_git_error",
          taskId,
          operation: "in_review",
          error: (err as Error).message,
        }),
      );
    }
  }
}

// ── Suggested-next-step helper ────────────────────────────────────────────────

/**
 * After a task is marked blocked, generate a one-sentence triage hint using the
 * Haiku tier and persist it to task.execution.suggested_next_step.
 *
 * Non-fatal: all failures are logged as JSON to stderr and silently swallowed.
 * Only runs when skipGit is false (production mode) — tests use skipGit: true.
 */
async function writeSuggestedNextStep(opts: RunTaskOptions): Promise<void> {
  const {
    workspaceRoot,
    featureId,
    taskId,
    gitAuthorEmail,
    sshKeyPath,
    skipGit = false,
    anthropicClient,
    agentConfig,
    workspaceModelPolicy,
  } = opts;

  if (skipGit) return;

  try {
    const task = loadTaskYaml(workspaceRoot, featureId, taskId);

    const mdPath = tasksMdAbsPath(workspaceRoot, featureId);
    const tasksmdContent = existsSync(mdPath)
      ? readFileSync(mdPath, "utf-8")
      : "";
    const description = tasksmdContent
      ? extractTaskDescription(tasksmdContent, taskId)
      : null;

    const taskOverrides = tasksmdContent
      ? parseModelOverrides(tasksmdContent, taskId)
      : {};
    const hintModel = resolveModel(
      workspaceModelPolicy,
      taskOverrides,
      "suggested_next_step",
      taskId,
    );

    const hint = await generateSuggestedNextStep({
      task,
      taskDescription: description,
      anthropicClient: anthropicClient as unknown as SuggestedNextStepClient,
      model: hintModel,
      maxTokens: agentConfig.budget.suggested_next_step_max_tokens,
    });

    task.execution.suggested_next_step = hint;
    saveTaskYaml(workspaceRoot, featureId, taskId, task);

    try {
      gitCommitTaskYaml(
        workspaceRoot,
        featureId,
        taskId,
        `chore(${taskId}): add suggested_next_step`,
        sshKeyPath,
        task.branch,
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          type: "suggested_next_step_git_error",
          taskId,
          error: (err as Error).message,
        }),
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        type: "suggested_next_step_error",
        taskId,
        error: (err as Error).message,
      }),
    );
  }
}

// ── Tasks.md parsing helpers ──────────────────────────────────────────────────

/**
 * Extract the text content of the `### Description` subsection for a task in tasks.md.
 * Returns null if absent.
 */
function extractTaskDescription(
  tasksmdContent: string,
  taskId: string,
): string | null {
  const numericId = taskId.replace(/^T/, "");
  const headingRegex = new RegExp(`^## T${numericId}\\s+—`, "m");
  const headingMatch = headingRegex.exec(tasksmdContent);
  if (!headingMatch) return null;

  const headingLineEnd = tasksmdContent.indexOf("\n", headingMatch.index);
  if (headingLineEnd === -1) return null;

  const afterHeading = tasksmdContent.slice(headingLineEnd + 1);
  const nextHeadingMatch = /^## /m.exec(afterHeading);
  const taskSection = nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;

  const descMatch = /^### Description[ \t]*\n/im.exec(taskSection);
  if (!descMatch) return null;

  const afterDesc = taskSection.slice(descMatch.index + descMatch[0].length);
  const nextSubsection = /^##+ /m.exec(afterDesc);
  const descBody = nextSubsection
    ? afterDesc.slice(0, nextSubsection.index)
    : afterDesc;

  return descBody.trim() || null;
}

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(
  task: Task,
  skillBodies: Map<string, string>,
): string {
  const parts: string[] = [
    "You are an expert software engineer executing a task in an automated delivery workflow.",
    "",
    "## Task Context",
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    `Repository: ${task.repo}`,
    `Branch: ${task.branch}`,
    "",
    "## Available Tools",
    "- **bash**: Run shell commands (tests, builds, linters) in the implementation repository",
    "- **read_file**: Read any file by path",
    "- **write_file**: Create or overwrite a file",
    "- **edit_file**: Replace an exact string in a file (first occurrence only)",
    "- **git_add**: Stage files for commit",
    "- **git_commit**: Commit staged changes",
    "- **git_push**: Push branch to origin",
    "- **escalate**: Request escalation to a more capable model — use only when genuinely blocked by model capability limits",
    "",
    "## Execution Rules",
    "1. Implement the task as described in the user message.",
    "2. Run tests after each significant change to verify correctness.",
    "3. Commit your changes with clear, conventional commit messages.",
    "4. Push your branch when the implementation is complete.",
    "5. When the task is fully complete, stop calling tools (do not make further tool calls).",
    "6. Do not ask for clarification — make reasonable decisions and document them in commits.",
  ];

  if (skillBodies.size > 0) {
    parts.push("", "## Required Skills");
    for (const [slug, body] of skillBodies) {
      parts.push("", `### ${slug}`, "", body);
    }
  }

  return parts.join("\n");
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command in the implementation repository directory. " +
      "Use for running tests, builds, linters, and other shell operations. " +
      "Returns combined stdout/stderr output.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "Shell command to execute.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "File path. Absolute, or relative to the implementation repo root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating it if it does not exist.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "File path. Absolute, or relative to the implementation repo root.",
        },
        content: {
          type: "string",
          description: "Full file content to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace the first occurrence of old_string with new_string in a file. " +
      "old_string must appear exactly once.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "File path. Absolute, or relative to the implementation repo root.",
        },
        old_string: {
          type: "string",
          description: "Exact string to replace (must appear exactly once).",
        },
        new_string: {
          type: "string",
          description: "Replacement string.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "git_add",
    description: "Stage files for commit in the implementation repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "File paths to stage. Relative to the implementation repo root.",
        },
      },
      required: ["paths"],
    },
  },
  {
    name: "git_commit",
    description:
      "Commit staged changes in the implementation repository. " +
      "Use conventional commits format (feat:, fix:, chore:, etc.).",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "Commit message.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "git_push",
    description: "Push the current branch to origin in the implementation repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        branch: {
          type: "string",
          description: "Branch name to push.",
        },
      },
      required: ["branch"],
    },
  },
  {
    name: "escalate",
    description:
      "Request escalation to a more capable model. " +
      "Use ONLY when you are genuinely blocked by model capability limits — " +
      "not when you simply encounter a hard problem. " +
      "This stops the loop and flags the task for human triage.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description:
            "Detailed explanation of why escalation is needed and what was attempted.",
        },
      },
      required: ["reason"],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

interface ToolExecResult {
  output: string;
  /** True when the model called the `escalate` tool. */
  isEscalation?: boolean;
  escalationReason?: string;
}

function resolveFilePath(taskRepoRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(taskRepoRoot, path);
}

function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  taskRepoRoot: string,
  sshKeyPath: string | undefined,
): ToolExecResult {
  const sshEnv = sshKeyPath
    ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
    : {};
  const env = { ...process.env, ...sshEnv } as NodeJS.ProcessEnv;

  switch (toolName) {
    case "bash": {
      const command = toolInput["command"] as string;
      try {
        const output = execSync(command, {
          cwd: taskRepoRoot,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 120_000,
        });
        return { output: output.toString("utf-8") };
      } catch (err) {
        const e = err as {
          stdout?: Buffer;
          stderr?: Buffer;
          message: string;
          status?: number;
        };
        const stdout = e.stdout?.toString("utf-8") ?? "";
        const stderr = e.stderr?.toString("utf-8") ?? "";
        const combined = [stderr, stdout].filter(Boolean).join("\n") || e.message;
        return { output: `Exit ${e.status ?? 1}:\n${combined}` };
      }
    }

    case "read_file": {
      const filePath = resolveFilePath(taskRepoRoot, toolInput["path"] as string);
      if (!existsSync(filePath)) {
        return { output: `Error: file not found: ${filePath}` };
      }
      try {
        return { output: readFileSync(filePath, "utf-8") };
      } catch (err) {
        return { output: `Error reading file: ${(err as Error).message}` };
      }
    }

    case "write_file": {
      const filePath = resolveFilePath(taskRepoRoot, toolInput["path"] as string);
      const content = toolInput["content"] as string;
      try {
        writeFileSync(filePath, content, "utf-8");
        return { output: `Wrote ${content.length} bytes to ${filePath}` };
      } catch (err) {
        return { output: `Error writing file: ${(err as Error).message}` };
      }
    }

    case "edit_file": {
      const filePath = resolveFilePath(taskRepoRoot, toolInput["path"] as string);
      const oldStr = toolInput["old_string"] as string;
      const newStr = toolInput["new_string"] as string;
      if (!existsSync(filePath)) {
        return { output: `Error: file not found: ${filePath}` };
      }
      try {
        const content = readFileSync(filePath, "utf-8");
        const idx = content.indexOf(oldStr);
        if (idx === -1) {
          return { output: `Error: old_string not found in ${filePath}` };
        }
        const newContent =
          content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        writeFileSync(filePath, newContent, "utf-8");
        return { output: `Replaced in ${filePath}` };
      } catch (err) {
        return { output: `Error editing file: ${(err as Error).message}` };
      }
    }

    case "git_add": {
      const paths = toolInput["paths"] as string[];
      const pathArgs = paths.map((p) => `"${p}"`).join(" ");
      try {
        execSync(`git add ${pathArgs}`, {
          cwd: taskRepoRoot,
          env,
          stdio: "pipe",
        });
        return { output: `Staged: ${paths.join(", ")}` };
      } catch (err) {
        return { output: `Error staging files: ${(err as Error).message}` };
      }
    }

    case "git_commit": {
      const message = (toolInput["message"] as string).replace(/"/g, '\\"');
      try {
        const out = execSync(`git commit -m "${message}"`, {
          cwd: taskRepoRoot,
          env,
          stdio: "pipe",
        });
        return { output: out.toString("utf-8").trim() };
      } catch (err) {
        return { output: `Error committing: ${(err as Error).message}` };
      }
    }

    case "git_push": {
      const branchName = toolInput["branch"] as string;
      try {
        execSync(`git push origin "${branchName}"`, {
          cwd: taskRepoRoot,
          env,
          stdio: "pipe",
        });
        return { output: `Pushed to origin/${branchName}` };
      } catch (err) {
        return { output: `Error pushing: ${(err as Error).message}` };
      }
    }

    case "escalate": {
      return {
        output: "Escalation requested.",
        isEscalation: true,
        escalationReason: toolInput["reason"] as string,
      };
    }

    default:
      return { output: `Unknown tool: ${toolName}` };
  }
}

// ── No-progress detection ─────────────────────────────────────────────────────

/**
 * Produce a stable fingerprint for a set of tool-use blocks in one iteration.
 * Used to detect repeated tool calls across consecutive iterations.
 */
function toolCallsFingerprint(blocks: Anthropic.ToolUseBlock[]): string {
  const entries = blocks
    .map((b) => ({ name: b.name, input: b.input }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(entries);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run a single task activation end-to-end inside an Anthropic tool-use loop.
 *
 * Handles all terminal paths internally:
 *   - Success → marks task `in_review` in task.yaml
 *   - Budget/iteration/no-progress/escalation → marks task `blocked`
 *   - Uncaught runtime error → marks task `blocked` with `runtime_error`
 *
 * @returns RunTaskResult — always returns; never throws (runtime errors are caught).
 */
export async function runTask(opts: RunTaskOptions): Promise<RunTaskResult> {
  let result: RunTaskResult;

  // ── Outer try/catch: runtime-error path ────────────────────────────────────
  try {
    result = await runTaskInner(opts);
  } catch (err) {
    const e = err as Error;
    const stackSnippet = (e.stack ?? e.message).slice(0, 1000);
    const details: Record<string, unknown> = {
      error: e.message,
      stack: stackSnippet,
    };

    // Best-effort: write runtime_error to task.yaml so the task never stays in_progress
    try {
      const task = loadTaskYaml(
        opts.workspaceRoot,
        opts.featureId,
        opts.taskId,
      );
      markTaskBlocked(
        opts.workspaceRoot,
        opts.featureId,
        opts.taskId,
        "runtime_error",
        details,
        opts.gitAuthorEmail,
        opts.sshKeyPath,
        task.branch,
        opts.skipGit ?? false,
      );
    } catch {
      // If even writing the error fails, emit to stderr
      process.stderr.write(
        JSON.stringify({
          type: "run_task_error_unwritten",
          taskId: opts.taskId,
          error: e.message,
        }) + "\n",
      );
    }

    result = { outcome: "blocked", reason: "runtime_error", details };
  }

  // ── Suggested-next-step on any blocked outcome ──────────────────────────────
  // Generates a Haiku-tier triage hint and persists it to task.yaml.
  // Skipped when skipGit is true (test mode) — see writeSuggestedNextStep.
  if (result.outcome === "blocked") {
    await writeSuggestedNextStep(opts);
  }

  return result;
}

async function runTaskInner(opts: RunTaskOptions): Promise<RunTaskResult> {
  const {
    taskId,
    featureId,
    workspaceRoot,
    workflowRoot,
    taskRepoRoot,
    agentConfig,
    workspaceModelPolicy,
    logSink,
    gitAuthorEmail,
    sshKeyPath,
    skipGit = false,
    anthropicClient,
  } = opts;

  // ── 1. Load task.yaml ──────────────────────────────────────────────────────
  const task = loadTaskYaml(workspaceRoot, featureId, taskId);
  const branch = task.branch;

  // ── 2. Load tasks.md → parse skills + model overrides ─────────────────────
  const mdPath = tasksMdAbsPath(workspaceRoot, featureId);
  const tasksmdContent = existsSync(mdPath)
    ? readFileSync(mdPath, "utf-8")
    : "";

  const skillMap = tasksmdContent ? parseTasksMd(tasksmdContent) : {};
  const requiredSkills = skillMap[taskId]?.requiredSkills ?? [];
  const taskOverrides = tasksmdContent
    ? parseModelOverrides(tasksmdContent, taskId)
    : {};

  // ── 3. Load SKILL.md bodies ────────────────────────────────────────────────
  const skillBodies = new Map<string, string>();
  for (const slug of requiredSkills) {
    const skillPath = skillMdAbsPath(workflowRoot, slug);
    if (existsSync(skillPath)) {
      skillBodies.set(slug, readFileSync(skillPath, "utf-8"));
    }
  }

  // ── 4. Resolve implementation model ───────────────────────────────────────
  const implementationModel = resolveModel(
    workspaceModelPolicy,
    taskOverrides,
    "implementation",
    taskId,
  );

  // ── 5. Build system prompt ─────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(task, skillBodies);

  // ── 6. Build initial user message ─────────────────────────────────────────
  const userMessage =
    (tasksmdContent
      ? extractTaskDescription(tasksmdContent, taskId)
      : null) ?? task.title;

  // ── 7. Initialize client ───────────────────────────────────────────────────
  const client: AnthropicClient =
    anthropicClient ?? new Anthropic();

  // ── 8. Tool-use loop ───────────────────────────────────────────────────────
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let iterations = 0;
  const fingerprintHistory: string[] = [];

  const { max_tokens_per_task, max_iterations } = agentConfig.budget;

  while (true) {
    iterations++;

    // Iteration cap check (before API call)
    if (iterations > max_iterations) {
      const details = { iterations, max_iterations };
      markTaskBlocked(
        workspaceRoot,
        featureId,
        taskId,
        "iteration_cap_exceeded",
        details,
        gitAuthorEmail,
        sshKeyPath,
        branch,
        skipGit,
      );
      return { outcome: "blocked", reason: "iteration_cap_exceeded", details };
    }

    const iterStart = Date.now();

    // API call
    const response = await client.messages.create({
      model: implementationModel,
      max_tokens: 8192,
      system: [
        {
          type: "text" as const,
          text: systemPrompt,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const iterDuration = Date.now() - iterStart;

    // Accumulate tokens
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    const totalTokens = totalInputTokens + totalOutputTokens;

    // Extract tool-use blocks
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Emit task_work_iteration telemetry
    logSink.emit({
      type: "task_work_iteration",
      iteration: iterations,
      tokens: {
        in: response.usage.input_tokens,
        out: response.usage.output_tokens,
        total: response.usage.input_tokens + response.usage.output_tokens,
      },
      duration_ms: iterDuration,
      details: {
        model: implementationModel,
        stop_reason: response.stop_reason,
        cache_read_input_tokens:
          (response.usage as unknown as Record<string, unknown>)["cache_read_input_tokens"] ?? 0,
        cache_creation_input_tokens:
          (response.usage as unknown as Record<string, unknown>)["cache_creation_input_tokens"] ?? 0,
        tool_calls: toolUseBlocks.map((b) => b.name),
      },
    });

    // Token budget check (after API call)
    if (totalTokens > max_tokens_per_task) {
      const details = { totalTokens, max_tokens_per_task };
      markTaskBlocked(
        workspaceRoot,
        featureId,
        taskId,
        "budget_exceeded",
        details,
        gitAuthorEmail,
        sshKeyPath,
        branch,
        skipGit,
      );
      return { outcome: "blocked", reason: "budget_exceeded", details };
    }

    // End of loop — model finished
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      markTaskInReview(
        workspaceRoot,
        featureId,
        taskId,
        gitAuthorEmail,
        sshKeyPath,
        branch,
        skipGit,
      );
      return { outcome: "in_review" };
    }

    // No-progress detection: same tool calls 3 iterations in a row
    const fingerprint = toolCallsFingerprint(toolUseBlocks);
    fingerprintHistory.push(fingerprint);
    if (fingerprintHistory.length >= 3) {
      const last3 = fingerprintHistory.slice(-3);
      if (last3.every((f) => f === last3[0])) {
        const details = {
          repeated_calls: JSON.parse(fingerprint) as unknown,
          iterations,
        };
        markTaskBlocked(
          workspaceRoot,
          featureId,
          taskId,
          "no_progress",
          details,
          gitAuthorEmail,
          sshKeyPath,
          branch,
          skipGit,
        );
        return { outcome: "blocked", reason: "no_progress", details };
      }
    }

    // Push assistant turn to messages
    messages.push({ role: "assistant", content: response.content });

    // Execute tools and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolCall of toolUseBlocks) {
      const input = toolCall.input as Record<string, unknown>;
      const execResult = executeTool(
        toolCall.name,
        input,
        taskRepoRoot,
        sshKeyPath,
      );

      // Escalation path
      if (execResult.isEscalation) {
        const details: Record<string, unknown> = {
          reason: execResult.escalationReason,
          current_model: implementationModel,
          iterations,
        };
        markTaskBlocked(
          workspaceRoot,
          featureId,
          taskId,
          "model_escalation_requested",
          details,
          gitAuthorEmail,
          sshKeyPath,
          branch,
          skipGit,
        );
        return {
          outcome: "blocked",
          reason: "model_escalation_requested",
          details,
        };
      }

      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: toolCall.id,
        content: execResult.output,
      });
    }

    // Add tool results as next user turn
    messages.push({ role: "user", content: toolResults });
  }
}
