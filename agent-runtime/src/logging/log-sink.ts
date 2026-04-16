import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { featureLogsDirPath, logFileRelPath } from "../paths.js";

/** Known top-level fields on a log event. Reject anything outside this set. */
const KNOWN_FIELDS = new Set([
  "at",
  "by",
  "type",
  "iteration",
  "tokens",
  "duration_ms",
  "details",
]);

/** Token counts for a single LLM call. */
export interface EventTokens {
  in: number;
  out: number;
  total: number;
}

/** A structured JSONL event written to the log sink. */
export interface LogEvent {
  /** ISO 8601 timestamp of when the event occurred. */
  at: string;
  /** GIT_AUTHOR_EMAIL of the agent that emitted this event. */
  by: string;
  /** Event type identifier (e.g. "task_work_iteration", "run_started"). */
  type: string;
  /** Tool-use loop iteration number, if applicable. */
  iteration?: number;
  /** Token counts for this event, if applicable. */
  tokens?: EventTokens;
  /** Wall-clock duration in milliseconds, if applicable. */
  duration_ms?: number;
  /** Arbitrary structured context for this event type. */
  details?: Record<string, unknown>;
}

/**
 * Input to emit(). `at` and `by` are auto-filled by the sink if omitted.
 * Unknown top-level fields are rejected at runtime for forward-compat safety.
 */
export type EmitInput = Omit<LogEvent, "at" | "by"> & {
  at?: string;
  by?: string;
};

/** Why the run ended — recorded in the final `run_ended` event. */
export type RunEndReason = "done" | "blocked" | "error";

/** The handle returned by openLogSink(). */
export interface LogSink {
  /**
   * Buffer a log event. The event is not written to disk until close().
   * Throws on unknown top-level fields or if called after close().
   */
  emit(event: EmitInput): void;
  /**
   * Flush the in-memory buffer to disk, append `run_ended`, then
   * git add/commit/push the log file (unless skipGit is set).
   *
   * Idempotent — subsequent calls after the first are no-ops.
   */
  close(reason: RunEndReason): Promise<void>;
}

export interface OpenLogSinkOptions {
  /** Absolute path to the workspace (management repo) root. */
  workspaceRoot: string;
  /** Feature identifier (e.g. "distributed-agent-team"). */
  featureId: string;
  /** Task identifier (e.g. "T4"). */
  taskId: string;
  /**
   * ISO 8601 start timestamp for this run.
   * Used to derive the log filename — colons are replaced with dashes.
   */
  runStartIso: string;
  /** GIT_AUTHOR_EMAIL of the agent; stamped as `by` on every event. */
  gitAuthorEmail: string;
  /** Commit SHA of the workflow repo at agent startup. */
  workflowCommitSha: string;
  /** Version string identifying the agent.yaml in use (e.g. content hash or path). */
  agentYamlVersion: string;
  /** Feature branch to push the log commit to. */
  branch: string;
  /** SSH private key path for git push. Omit to rely on ambient SSH config. */
  sshKeyPath?: string;
  /**
   * Skip git add/commit/push on close().
   * Intended for unit tests that do not need a real git repo.
   */
  skipGit?: boolean;
}

/**
 * Replace colons with dashes to make an ISO timestamp filesystem-safe.
 * @example toSafeIso("2026-04-14T12:00:00.000Z") → "2026-04-14T12-00-00.000Z"
 */
export function toSafeIso(iso: string): string {
  return iso.replace(/:/g, "-");
}

/**
 * Derive the absolute path for a run's JSONL log file.
 * Pattern: <workspaceRoot>/docs/features/<featureId>/logs/<taskId>/<safeIso>.jsonl
 */
export function deriveLogPath(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
  runStartIso: string,
): string {
  return join(
    featureLogsDirPath(workspaceRoot, featureId, taskId),
    `${toSafeIso(runStartIso)}.jsonl`,
  );
}

function validateEmitInput(event: Record<string, unknown>): void {
  for (const key of Object.keys(event)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new Error(
        `Unknown top-level field in log event: "${key}". ` +
          `Known fields: ${[...KNOWN_FIELDS].join(", ")}`,
      );
    }
  }
}

function appendLine(filePath: string, event: LogEvent): void {
  appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Open a per-run JSONL log sink for a single task activation.
 *
 * - Immediately writes a `run_started` event to disk (synchronous).
 * - Subsequent events via emit() are buffered in memory.
 * - close() flushes the buffer, appends `run_ended`, and commits+pushes.
 *
 * Because each run writes to a uniquely-named file (taskId + runStartIso),
 * two concurrent runs for different tasks never contend on the same file.
 */
export function openLogSink(opts: OpenLogSinkOptions): LogSink {
  const {
    workspaceRoot,
    featureId,
    taskId,
    runStartIso,
    gitAuthorEmail,
    workflowCommitSha,
    agentYamlVersion,
    branch,
    sshKeyPath,
    skipGit = false,
  } = opts;

  const filePath = deriveLogPath(workspaceRoot, featureId, taskId, runStartIso);
  mkdirSync(featureLogsDirPath(workspaceRoot, featureId, taskId), { recursive: true });

  // Write run_started synchronously — so even a crashed run leaves a valid partial file.
  appendLine(filePath, {
    at: runStartIso,
    by: gitAuthorEmail,
    type: "run_started",
    details: {
      workflow_commit_sha: workflowCommitSha,
      agent_yaml_version: agentYamlVersion,
    },
  });

  const buffer: LogEvent[] = [];
  let closed = false;

  return {
    emit(event: EmitInput): void {
      if (closed) {
        throw new Error("Cannot emit after close()");
      }
      validateEmitInput(event as Record<string, unknown>);
      buffer.push({
        at: event.at ?? new Date().toISOString(),
        by: event.by ?? gitAuthorEmail,
        type: event.type,
        ...(event.iteration !== undefined && { iteration: event.iteration }),
        ...(event.tokens !== undefined && { tokens: event.tokens }),
        ...(event.duration_ms !== undefined && {
          duration_ms: event.duration_ms,
        }),
        ...(event.details !== undefined && { details: event.details }),
      });
    },

    async close(reason: RunEndReason): Promise<void> {
      if (closed) return;
      closed = true;

      // Flush buffered events to disk.
      for (const event of buffer) {
        appendLine(filePath, event);
      }

      // Append the terminal run_ended event.
      appendLine(filePath, {
        at: new Date().toISOString(),
        by: gitAuthorEmail,
        type: "run_ended",
        details: { reason },
      });

      if (skipGit) return;

      // Commit and push the completed log file as a single atomic batch.
      const relPath = logFileRelPath(
        featureId,
        taskId,
        `${toSafeIso(runStartIso)}.jsonl`,
      );
      const sshEnv = sshKeyPath
        ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
        : {};
      const env = { ...process.env, ...sshEnv } as NodeJS.ProcessEnv;

      execSync(`git -C "${workspaceRoot}" add "${relPath}"`, {
        env,
        stdio: "pipe",
      });
      execSync(
        `git -C "${workspaceRoot}" commit -m "chore: flush task log ${taskId}"`,
        { env, stdio: "pipe" },
      );
      execSync(`git -C "${workspaceRoot}" push origin "${branch}"`, {
        env,
        stdio: "pipe",
      });
    },
  };
}
