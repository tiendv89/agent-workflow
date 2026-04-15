/**
 * T7/T2: Git-based claim protocol with task-branch creation and SHA contention detection.
 *
 * The orchestrator creates feature/<featureId>-<taskId> before committing the claim.
 * The management repo is on the task branch from the moment the claim succeeds.
 *
 * Contention resolution is SHA-based, not identity-based:
 *   - Competing agents create the task branch from the same main HEAD and race to push.
 *   - First push wins (fast-forward). Loser gets a non-fast-forward rejection, fetches,
 *     and compares SHA with origin/<taskBranch>.
 *   - SHA match  → this agent's commit landed (rebase re-ordered the push) → won.
 *   - SHA differ → another agent's commit is on remote HEAD → lost.
 *
 * Branch-already-exists handling (re-claim or blocked recovery):
 *   - blocked_context null:  interrupted prior claim — checkout + reset to origin/<branch>.
 *   - blocked_context non-null: blocked recovery path — return branch_blocked_recovery.
 *
 * Pre-commit jitter (50–500 ms, bounded by jitter_max_seconds) de-synchronises agents
 * that pull from the same cron tick and reduces the collision rate.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { Task } from "../types/task.js";
import { taskYamlAbsPath, taskYamlRelPath, taskBranchName } from "../paths.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ClaimTaskOptions {
  /** Absolute path to the management (workspace) repo root. */
  workspaceRoot: string;
  /** Task ID to claim (e.g. "T7"). */
  taskId: string;
  /** Feature directory ID (e.g. "task-branch-lifecycle"). */
  featureId: string;
  /**
   * GIT_AUTHOR_EMAIL for the claim commit.
   * Sourced from the resolved environment by the caller — not read from process.env
   * directly so the protocol is testable with arbitrary identities.
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
   * Base branch of the workspace repo (e.g. "main").
   * The orchestrator is reset to this branch before claiming, and losers are
   * reset back to it after a push rejection.
   * Default: "main".
   */
  baseBranch?: string;
  /** Skip the pre-commit jitter sleep. Intended for unit/integration tests. */
  skipJitter?: boolean;
  /**
   * Skip all git operations (fetch / checkout / add / commit / push).
   * The task YAML is still mutated on disk.
   * Intended for unit tests that do not set up a real git repo.
   */
  skipGit?: boolean;
}

/**
 * Result returned by claimTask.
 *   won: true                     — this agent owns the task; proceed with implementation.
 *   won: false, reason: ...       — claim failed or was lost.
 */
export type ClaimResult =
  | { won: true }
  | {
      won: false;
      reason:
        | "task_not_ready"           // task.status !== "ready" when we read it
        | "push_rejected"            // another agent's commit is on remote HEAD
        | "post_claim_mismatch"      // won the push but YAML doesn't confirm our claim
        | "branch_blocked_recovery"; // task branch exists + blocked_context non-null → S5
    };

// ── Internal helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTask(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
): Task {
  return parseYaml(
    readFileSync(taskYamlAbsPath(workspaceRoot, featureId, taskId), "utf-8"),
  ) as Task;
}

function writeTask(workspaceRoot: string, featureId: string, task: Task): void {
  writeFileSync(
    taskYamlAbsPath(workspaceRoot, featureId, task.id),
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

/**
 * Check whether a branch exists on origin.
 * Uses `git ls-remote --exit-code`: exit 0 = found, exit 2 = not found.
 */
function remoteHasBranch(
  workspaceRoot: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const result = spawnSync(
    "git",
    ["-C", workspaceRoot, "ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
    { env, encoding: "utf-8" },
  );
  return result.status === 0;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to atomically claim a `ready` task.
 *
 * On success the management repo's local HEAD is on the task branch
 * (feature/<featureId>-<taskId>) with the claim commit. The task YAML has
 * status: in_progress and task.branch set to the canonical task branch name.
 *
 * @returns `{ won: true }` if this agent successfully claimed the task.
 *          `{ won: false, reason }` if the claim failed or was lost.
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

  const env = buildGitEnv(gitAuthorEmail, gitAuthorName, sshKeyPath);

  // ── 1. Fetch + reset to clean base branch ─────────────────────────────────
  // Always start from a known-good state so the task YAML reflects the latest
  // remote state, not a stale local copy.
  if (!skipGit) {
    try {
      execSync(`git -C "${workspaceRoot}" fetch origin`, { env, stdio: "pipe" });
      execSync(
        `git -C "${workspaceRoot}" reset --hard "origin/${baseBranch}"`,
        { env, stdio: "pipe" },
      );
    } catch {
      return { won: false, reason: "push_rejected" };
    }
  }

  // ── 2. Read task from disk; verify it is still ready ─────────────────────
  // `let` so we can rebind after inheriting an existing task branch (case b).
  let task = readTask(workspaceRoot, featureId, taskId);
  if (task.status !== "ready") {
    return { won: false, reason: "task_not_ready" };
  }

  // ── 3. Determine task branch; handle branch-exists cases ─────────────────
  const branch = taskBranchName(featureId, taskId);

  if (!skipGit) {
    const branchExists = remoteHasBranch(workspaceRoot, branch, env);

    if (!branchExists) {
      // Case a: first claim — create the task branch from current HEAD (clean main).
      try {
        execSync(
          `git -C "${workspaceRoot}" checkout -b "${branch}"`,
          { env, stdio: "pipe" },
        );
      } catch {
        tryResetToRemote(workspaceRoot, baseBranch, env);
        return { won: false, reason: "push_rejected" };
      }
    } else if (!task.blocked_context) {
      // Case b: branch exists + no blocked_context — interrupted prior claim.
      // Checkout the existing branch and reset to origin state.
      try {
        execSync(
          `git -C "${workspaceRoot}" checkout "${branch}"`,
          { env, stdio: "pipe" },
        );
        execSync(
          `git -C "${workspaceRoot}" reset --hard "origin/${branch}"`,
          { env, stdio: "pipe" },
        );
      } catch {
        tryResetToRemote(workspaceRoot, baseBranch, env);
        return { won: false, reason: "push_rejected" };
      }
      // Re-read YAML from the branch state — another agent may have already
      // committed a claim here while we were checking. If the task is no longer
      // "ready" on this branch we lost the race.
      task = readTask(workspaceRoot, featureId, taskId);
      if (task.status !== "ready") {
        tryResetToRemote(workspaceRoot, baseBranch, env);
        return { won: false, reason: "push_rejected" };
      }
    } else {
      // Case c: branch exists + blocked_context non-null — blocked recovery (S5).
      // Do not attempt a new claim; the caller handles the recovery flow.
      return { won: false, reason: "branch_blocked_recovery" };
    }
  }

  // ── 4. Pre-commit jitter ──────────────────────────────────────────────────
  if (!skipJitter) {
    const maxMs = Math.min(jitterMaxSeconds * 1000, 500);
    const minMs = 50;
    const jitterMs = minMs + Math.random() * Math.max(0, maxMs - minMs);
    await sleep(jitterMs);
  }

  // ── 5. Mutate task YAML ───────────────────────────────────────────────────
  const now = new Date().toISOString();
  task.status = "in_progress";
  task.branch = branch;
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

  // ── 6. git add + commit ───────────────────────────────────────────────────
  const relPath = taskYamlRelPath(featureId, taskId);

  execSync(`git -C "${workspaceRoot}" add "${relPath}"`, {
    env,
    stdio: "pipe",
  });
  execSync(
    `git -C "${workspaceRoot}" commit -m "chore(${taskId}): claim — status in_progress"`,
    { env, stdio: "pipe" },
  );

  // Record the commit SHA — this is the arbitration token.
  const ourSha = execSync(
    `git -C "${workspaceRoot}" rev-parse HEAD`,
    { env, stdio: "pipe", encoding: "utf-8" },
  ).trim();

  // ── 7. git push to task branch ────────────────────────────────────────────
  const pushResult = spawnSync(
    "git",
    ["-C", workspaceRoot, "push", "origin", branch],
    { env, encoding: "utf-8" },
  );

  if (pushResult.status !== 0) {
    // Push rejected — fetch and compare SHA against origin/<branch>.
    try {
      execSync(
        `git -C "${workspaceRoot}" fetch origin "${branch}"`,
        { env, stdio: "pipe" },
      );
    } catch {
      tryResetToRemote(workspaceRoot, baseBranch, env);
      return { won: false, reason: "push_rejected" };
    }

    const remoteHeadSha = execSync(
      `git -C "${workspaceRoot}" rev-parse "origin/${branch}"`,
      { env, stdio: "pipe", encoding: "utf-8" },
    ).trim();

    if (remoteHeadSha !== ourSha) {
      // Another agent's commit is on the remote — we lost.
      tryResetToRemote(workspaceRoot, baseBranch, env);
      return { won: false, reason: "push_rejected" };
    }

    // remoteHeadSha === ourSha: our commit landed despite the rejection. We won.
  }

  // ── 8. Post-claim verification ────────────────────────────────────────────
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
 * Best-effort reset of the local repo to origin/<baseBranch>.
 * Used after losing a push race so the next activation starts from a clean state.
 */
function tryResetToRemote(
  workspaceRoot: string,
  baseBranch: string,
  env: NodeJS.ProcessEnv,
): void {
  try {
    execSync(
      `git -C "${workspaceRoot}" checkout "${baseBranch}"`,
      { env, stdio: "pipe" },
    );
    execSync(
      `git -C "${workspaceRoot}" reset --hard "origin/${baseBranch}"`,
      { env, stdio: "pipe" },
    );
  } catch {
    // Intentionally ignored — best-effort cleanup.
  }
}
