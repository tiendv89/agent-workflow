/**
 * T7: Git-based claim protocol with commit-SHA contention detection.
 *
 * Atomically claims a `ready` task by mutating the task YAML, committing
 * on the base branch of the workspace (management) repo, and pushing.
 *
 * Contention resolution is SHA-based, not identity-based:
 *   - All competing agents commit locally, then race to push.
 *   - First agent to push wins (fast-forward accepted).
 *   - Losers get a non-fast-forward rejection; they fetch the remote HEAD SHA
 *     and compare it to their own commit SHA.
 *   - SHA match  → this agent's commit landed (rebase re-ordered the push) → won.
 *   - SHA differ → another agent's commit is there → lost.
 *
 * This means the protocol is correct even when multiple agents share a single
 * GIT_AUTHOR_EMAIL — identity strings are never compared.
 *
 * Pre-commit jitter (50–500 ms, bounded by jitter_max_seconds) de-synchronises
 * agents that pull from the same cron tick and reduces the collision rate.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { Task } from "../types/task.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ClaimTaskOptions {
  /** Absolute path to the management (workspace) repo root. */
  workspaceRoot: string;
  /** Task ID to claim (e.g. "T7"). */
  taskId: string;
  /** Feature directory ID (e.g. "distributed-agent-team"). */
  featureId: string;
  /**
   * GIT_AUTHOR_EMAIL for the claim commit.
   * Sourced from the resolved environment by the caller (not read from process.env
   * directly so the protocol is testable with arbitrary identities).
   */
  gitAuthorEmail: string;
  /** GIT_AUTHOR_NAME for the claim commit. Defaults to gitAuthorEmail if omitted. */
  gitAuthorName?: string;
  /** SSH private key path for git push. Omit to rely on ambient SSH config. */
  sshKeyPath?: string;
  /**
   * Upper bound on the random pre-commit jitter in seconds.
   * Actual jitter is random(50ms, min(500ms, jitterMaxSeconds * 1000)).
   * Default: 0.5.
   */
  jitterMaxSeconds?: number;
  /**
   * Base branch of the workspace repo to push the claim commit to.
   * The claim commit always goes to this branch — not to the task's feature branch.
   * Default: "main".
   */
  baseBranch?: string;
  /** Skip the pre-commit jitter sleep. Intended for unit/integration tests. */
  skipJitter?: boolean;
  /**
   * Skip all git operations (add / commit / push / fetch / reset).
   * The task YAML is still mutated on disk.
   * Intended for unit tests that do not set up a real git repo.
   */
  skipGit?: boolean;
}

/**
 * Result returned by claimTask.
 *   won: true  — this agent owns the task; proceed with implementation.
 *   won: false — another agent won the race, or the task was no longer claimable.
 */
export type ClaimResult =
  | { won: true }
  | {
      won: false;
      reason:
        | "task_not_ready"   // task.status !== "ready" when we read it
        | "push_rejected"    // another agent's commit is on remote HEAD
        | "post_claim_mismatch"; // won the push but YAML doesn't confirm our claim
    };

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskYamlPath(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
): string {
  return join(
    workspaceRoot,
    "docs",
    "features",
    featureId,
    "tasks",
    `${taskId}.yaml`,
  );
}

function taskRelPath(featureId: string, taskId: string): string {
  return join("docs", "features", featureId, "tasks", `${taskId}.yaml`);
}

function readTask(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
): Task {
  return parseYaml(
    readFileSync(taskYamlPath(workspaceRoot, featureId, taskId), "utf-8"),
  ) as Task;
}

function writeTask(workspaceRoot: string, featureId: string, task: Task): void {
  writeFileSync(
    taskYamlPath(workspaceRoot, featureId, task.id),
    yamlStringify(task),
    "utf-8",
  );
}

function buildGitEnv(
  gitAuthorEmail: string,
  gitAuthorName: string,
  sshKeyPath: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: gitAuthorName,
    GIT_AUTHOR_EMAIL: gitAuthorEmail,
    GIT_COMMITTER_NAME: gitAuthorName,
    GIT_COMMITTER_EMAIL: gitAuthorEmail,
    ...(sshKeyPath
      ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
      : {}),
  } as NodeJS.ProcessEnv;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to atomically claim a `ready` task.
 *
 * On success, the task YAML on the management repo's base branch is updated
 * with `status: in_progress` and a `claimed` log entry.  The commit SHA is the
 * arbitration token — only the agent whose SHA ends up as remote HEAD is the winner.
 *
 * @returns `{ won: true }` if this agent successfully claimed the task.
 *          `{ won: false, reason }` if the claim failed or was lost to another agent.
 */
export async function claimTask(opts: ClaimTaskOptions): Promise<ClaimResult> {
  const {
    workspaceRoot,
    taskId,
    featureId,
    gitAuthorEmail,
    gitAuthorName = gitAuthorEmail,
    sshKeyPath,
    jitterMaxSeconds = 0.5,
    baseBranch = "main",
    skipJitter = false,
    skipGit = false,
  } = opts;

  // ── 1. Read task from disk; verify it is still ready ────────────────────────
  // Always read from disk — never rely on a cached in-memory task object.
  const task = readTask(workspaceRoot, featureId, taskId);
  if (task.status !== "ready") {
    return { won: false, reason: "task_not_ready" };
  }

  // ── 2. Pre-commit jitter ────────────────────────────────────────────────────
  // Sleep a random duration to de-synchronise agents that pulled from the same
  // cron tick. Bounded by min(500ms, jitterMaxSeconds * 1000).
  if (!skipJitter) {
    const maxMs = Math.min(jitterMaxSeconds * 1000, 500);
    const minMs = 50;
    const jitterMs = minMs + Math.random() * Math.max(0, maxMs - minMs);
    await sleep(jitterMs);
  }

  // ── 3. Mutate task YAML ─────────────────────────────────────────────────────
  const now = new Date().toISOString();
  task.status = "in_progress";
  task.execution.last_updated_by = gitAuthorEmail;
  task.execution.last_updated_at = now;
  task.log.push({
    action: "claimed",
    by: gitAuthorEmail,
    at: now,
    note: "Claimed via git-based claim protocol.",
  });
  writeTask(workspaceRoot, featureId, task);

  if (skipGit) {
    return { won: true };
  }

  // ── 4. git add + commit ─────────────────────────────────────────────────────
  const relPath = taskRelPath(featureId, taskId);
  const env = buildGitEnv(gitAuthorEmail, gitAuthorName, sshKeyPath);

  execSync(`git -C "${workspaceRoot}" add "${relPath}"`, {
    env,
    stdio: "pipe",
  });
  execSync(
    `git -C "${workspaceRoot}" commit -m "chore(${taskId}): claim — status in_progress"`,
    { env, stdio: "pipe" },
  );

  // Record the commit SHA before pushing — this is the arbitration token.
  const ourSha = execSync(
    `git -C "${workspaceRoot}" rev-parse HEAD`,
    { env, stdio: "pipe", encoding: "utf-8" },
  ).trim();

  // ── 5. git push ─────────────────────────────────────────────────────────────
  // Use spawnSync so we can inspect the exit code without throwing.
  const pushResult = spawnSync(
    "git",
    ["-C", workspaceRoot, "push", "origin", baseBranch],
    { env, encoding: "utf-8" },
  );

  if (pushResult.status !== 0) {
    // Push rejected — fetch to see what landed on the remote.
    try {
      execSync(
        `git -C "${workspaceRoot}" fetch origin "${baseBranch}"`,
        { env, stdio: "pipe" },
      );
    } catch {
      // Fetch failed — assume we lost, clean up local state.
      tryResetToRemote(workspaceRoot, baseBranch, env);
      return { won: false, reason: "push_rejected" };
    }

    const remoteHeadSha = execSync(
      `git -C "${workspaceRoot}" rev-parse "origin/${baseBranch}"`,
      { env, stdio: "pipe", encoding: "utf-8" },
    ).trim();

    if (remoteHeadSha !== ourSha) {
      // Another agent's commit is on the remote — we lost.
      // Reset local branch to origin so the next claim attempt starts clean.
      tryResetToRemote(workspaceRoot, baseBranch, env);
      return { won: false, reason: "push_rejected" };
    }

    // remoteHeadSha === ourSha: our commit is on the remote despite the initial
    // rejection (e.g. a concurrent rebase re-ordered the push). We won.
  }

  // ── 6. Post-claim verification ──────────────────────────────────────────────
  // Re-read the YAML from disk to confirm our mutation is present.
  // This guards against the rare case where another process modified the file
  // between our push succeeding and our re-read.
  const confirmed = readTask(workspaceRoot, featureId, taskId);
  if (
    confirmed.status !== "in_progress" ||
    confirmed.execution.last_updated_by !== gitAuthorEmail
  ) {
    return { won: false, reason: "post_claim_mismatch" };
  }

  return { won: true };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Best-effort reset of the local branch to match origin.
 * Used after losing a push race so the next claim attempt starts from a clean state.
 */
function tryResetToRemote(
  workspaceRoot: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): void {
  try {
    execSync(
      `git -C "${workspaceRoot}" reset --hard "origin/${baseBranch}"`,
      { env, stdio: "pipe" },
    );
  } catch {
    // Intentionally ignored — best-effort cleanup.
  }
}
