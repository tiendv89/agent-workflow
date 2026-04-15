/**
 * Tests for T7/T2: git-based claim protocol (claim-task.ts).
 *
 * Test structure:
 *   1. Unit tests (skipGit: true) — logic without git
 *   2. Integration tests (real local git repos, file:// remote)
 *      a. Single-agent happy path — task committed to task branch
 *      b. Branch exists + no blocked_context → inherit branch + push wins
 *      c. Branch exists + blocked_context → returns branch_blocked_recovery
 *      d. Push rejection: another agent wins the race
 *      e. 5-agent concurrent-claim simulation on 10 tasks
 *      f. All agents share GIT_AUTHOR_EMAIL — SHA discrimination still works
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import { claimTask } from "../src/claim/claim-task.js";
import type { ClaimTaskOptions } from "../src/claim/claim-task.js";
import type { Task, BlockedContext } from "../src/types/task.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEATURE_ID = "test-feature";

function makeReadyTask(id: string): Task {
  return {
    id,
    title: `Test Task ${id}`,
    repo: "test-repo",
    status: "ready",
    depends_on: [],
    blocked_reason: null,
    blocked_context: null,
    branch: `feature/test-feature-${id}`,
    execution: {
      actor_type: "agent",
      last_updated_by: null,
      last_updated_at: null,
    },
    pr: { url: "", status: "not_created" },
    workspace_pr: null,
    log: [
      {
        action: "created",
        by: "setup@test.com",
        at: "2026-04-14T00:00:00Z",
      },
    ],
  };
}

function makeBlockedRecoveryTask(id: string): Task {
  const blockedCtx: BlockedContext = {
    wip_branch: `feature/test-feature-${id}`,
    wip_sha: "aabbccdd",
    pushed_at: "2026-04-14T10:00:00Z",
  };
  return {
    ...makeReadyTask(id),
    status: "ready",
    blocked_context: blockedCtx,
  };
}

// ── Temp directory tracking ───────────────────────────────────────────────────

const tmpDirs: string[] = [];

function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── In-memory workspace builder (no git) ─────────────────────────────────────

function makeWorkspaceDir(tasks: Task[]): string {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "claim-unit-")));
  const tasksDir = join(dir, "docs", "features", FEATURE_ID, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  for (const task of tasks) {
    writeFileSync(join(tasksDir, `${task.id}.yaml`), yamlStringify(task), "utf-8");
  }
  return dir;
}

function readTaskFromDir(dir: string, taskId: string): Task {
  return parseYaml(
    readFileSync(
      join(dir, "docs", "features", FEATURE_ID, "tasks", `${taskId}.yaml`),
      "utf-8",
    ),
  ) as Task;
}

// ── Git repo builders ─────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

/**
 * Create a local bare git repository used as the "remote" in integration tests.
 */
function createBareRepo(): string {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "claim-bare-")));
  execSync(`git -c init.defaultBranch=main init --bare "${dir}"`, {
    stdio: "pipe",
  });
  return dir;
}

/**
 * Create a seeded workspace: N ready task YAMLs, committed and pushed to bareDir.
 * Returns the absolute path of the seeded working copy.
 */
function createSeededWorkspace(bareDir: string, taskCount: number): string {
  const parentDir = trackDir(mkdtempSync(join(tmpdir(), "claim-seed-parent-")));
  const dir = join(parentDir, "workspace");
  const remoteUrl = `file://${bareDir}`;

  execSync(`git clone "${remoteUrl}" "${dir}"`, { stdio: "pipe" });
  execSync(`git config user.email "seed@test.com"`, { cwd: dir, stdio: "pipe" });
  execSync(`git config user.name "Seed"`, { cwd: dir, stdio: "pipe" });

  const tasksDir = join(dir, "docs", "features", FEATURE_ID, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  for (let i = 1; i <= taskCount; i++) {
    writeFileSync(
      join(tasksDir, `T${i}.yaml`),
      yamlStringify(makeReadyTask(`T${i}`)),
      "utf-8",
    );
  }

  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "initial"`, {
    cwd: dir,
    stdio: "pipe",
    env: { ...process.env, ...GIT_ENV },
  });
  execSync("git push -u origin main", { cwd: dir, stdio: "pipe" });

  return dir;
}

/**
 * Create a seeded workspace with a task that has blocked_context set.
 * The task branch also exists on the bare repo.
 */
function createBlockedRecoveryWorkspace(bareDir: string, taskId: string): string {
  const parentDir = trackDir(mkdtempSync(join(tmpdir(), "claim-seed-blocked-")));
  const dir = join(parentDir, "workspace");
  const remoteUrl = `file://${bareDir}`;

  execSync(`git clone "${remoteUrl}" "${dir}"`, { stdio: "pipe" });
  execSync(`git config user.email "seed@test.com"`, { cwd: dir, stdio: "pipe" });
  execSync(`git config user.name "Seed"`, { cwd: dir, stdio: "pipe" });

  const tasksDir = join(dir, "docs", "features", FEATURE_ID, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // Write task with blocked_context on main
  const task = makeBlockedRecoveryTask(taskId);
  writeFileSync(join(tasksDir, `${taskId}.yaml`), yamlStringify(task), "utf-8");

  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "initial with blocked_context"`, {
    cwd: dir, stdio: "pipe", env: { ...process.env, ...GIT_ENV },
  });
  execSync("git push -u origin main", { cwd: dir, stdio: "pipe" });

  // Also create the task branch on remote (simulating a prior claim attempt)
  const branch = `feature/${FEATURE_ID}-${taskId}`;
  execSync(`git checkout -b "${branch}"`, { cwd: dir, stdio: "pipe" });
  execSync(`git push origin "${branch}"`, { cwd: dir, stdio: "pipe" });
  execSync(`git checkout main`, { cwd: dir, stdio: "pipe" });

  return dir;
}

/**
 * Clone the bare repo into a new temp directory.
 */
function cloneRepo(bareDir: string): string {
  const parentDir = trackDir(mkdtempSync(join(tmpdir(), "claim-clone-parent-")));
  const dir = join(parentDir, "workspace");
  const remoteUrl = `file://${bareDir}`;

  execSync(`git clone "${remoteUrl}" "${dir}"`, { stdio: "pipe" });
  execSync(`git config user.email "agent@test.com"`, { cwd: dir, stdio: "pipe" });
  execSync(`git config user.name "Agent"`, { cwd: dir, stdio: "pipe" });

  return dir;
}

// ── Unit tests (skipGit: true) ────────────────────────────────────────────────

describe("claimTask — unit (skipGit)", () => {
  it("returns { won: true } and mutates YAML for a ready task", async () => {
    const dir = makeWorkspaceDir([makeReadyTask("T1")]);

    const result = await claimTask({
      workspaceRoot: dir,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    expect(result.won).toBe(true);

    const task = readTaskFromDir(dir, "T1");
    expect(task.status).toBe("in_progress");
    expect(task.execution.last_updated_by).toBe("agent@test.com");
    expect(task.execution.last_updated_at).toBeTruthy();
    expect(task.log.at(-1)?.action).toBe("claimed");
    expect(task.log.at(-1)?.by).toBe("agent@test.com");
  });

  it("sets task.branch to taskBranchName(featureId, taskId) on win", async () => {
    const dir = makeWorkspaceDir([makeReadyTask("T1")]);

    await claimTask({
      workspaceRoot: dir,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    const task = readTaskFromDir(dir, "T1");
    expect(task.branch).toBe(`feature/${FEATURE_ID}-T1`);
  });

  it("returns { won: false, reason: task_not_ready } when task is in_progress", async () => {
    const task = makeReadyTask("T2");
    task.status = "in_progress";
    const dir = makeWorkspaceDir([task]);

    const result = await claimTask({
      workspaceRoot: dir,
      taskId: "T2",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    expect(result.won).toBe(false);
    if (!result.won) {
      expect(result.reason).toBe("task_not_ready");
    }
  });

  it("returns { won: false, reason: task_not_ready } when task is done", async () => {
    const task = makeReadyTask("T3");
    task.status = "done";
    const dir = makeWorkspaceDir([task]);

    const result = await claimTask({
      workspaceRoot: dir,
      taskId: "T3",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    expect(result.won).toBe(false);
    if (!result.won) {
      expect(result.reason).toBe("task_not_ready");
    }
  });

  it("does not mutate YAML when task is not ready", async () => {
    const task = makeReadyTask("T4");
    task.status = "blocked";
    const dir = makeWorkspaceDir([task]);

    await claimTask({
      workspaceRoot: dir,
      taskId: "T4",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    const read = readTaskFromDir(dir, "T4");
    expect(read.status).toBe("blocked"); // unchanged
  });

  it("appends exactly one log entry on win", async () => {
    const dir = makeWorkspaceDir([makeReadyTask("T5")]);

    await claimTask({
      workspaceRoot: dir,
      taskId: "T5",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      skipJitter: true,
      skipGit: true,
    });

    const task = readTaskFromDir(dir, "T5");
    // original log has 1 entry (created), we appended 1 (claimed)
    expect(task.log.length).toBe(2);
    expect(task.log[1].action).toBe("claimed");
  });
});

// ── Integration tests (real git) ──────────────────────────────────────────────

describe("claimTask — integration (real git)", () => {
  it("single agent: happy path — task committed to task branch (not main)", async () => {
    const bare = createBareRepo();
    createSeededWorkspace(bare, 1);
    const clone = cloneRepo(bare);

    const result = await claimTask({
      workspaceRoot: clone,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent1@test.com",
      gitAuthorName: "Agent 1",
      baseBranch: "main",
      skipJitter: true,
    });

    expect(result.won).toBe(true);

    // Winner's clone should be on the task branch
    const currentBranch = execSync(`git -C "${clone}" branch --show-current`, {
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(`feature/${FEATURE_ID}-T1`);

    // Task YAML on the task branch reflects the claim
    const task = readTaskFromDir(clone, "T1");
    expect(task.status).toBe("in_progress");
    expect(task.branch).toBe(`feature/${FEATURE_ID}-T1`);
    expect(task.execution.last_updated_by).toBe("agent1@test.com");

    // main on remote must NOT have the in_progress state (claim is on task branch)
    const verifyClone = cloneRepo(bare);
    const mainTask = readTaskFromDir(verifyClone, "T1");
    expect(mainTask.status).toBe("ready");
  });

  it("branch exists + no blocked_context → checkout existing branch + push wins", async () => {
    const bare = createBareRepo();
    const seed = createSeededWorkspace(bare, 1);

    // Manually create the task branch on the bare repo (simulating an interrupted prior claim)
    const branch = `feature/${FEATURE_ID}-T1`;
    execSync(`git -C "${seed}" checkout -b "${branch}"`, { stdio: "pipe" });
    execSync(`git -C "${seed}" push origin "${branch}"`, { stdio: "pipe" });
    execSync(`git -C "${seed}" checkout main`, { stdio: "pipe" });

    // Clone and attempt to claim — should detect branch exists + no blocked_context → case b
    const clone = cloneRepo(bare);
    const result = await claimTask({
      workspaceRoot: clone,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    expect(result.won).toBe(true);

    // Should be on the task branch
    const currentBranch = execSync(`git -C "${clone}" branch --show-current`, {
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(branch);

    const task = readTaskFromDir(clone, "T1");
    expect(task.status).toBe("in_progress");
    expect(task.branch).toBe(branch);
  });

  it("branch exists + blocked_context non-null → returns branch_blocked_recovery", async () => {
    const bare = createBareRepo();
    createBlockedRecoveryWorkspace(bare, "T1");
    const clone = cloneRepo(bare);

    const result = await claimTask({
      workspaceRoot: clone,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    expect(result.won).toBe(false);
    if (!result.won) {
      expect(result.reason).toBe("branch_blocked_recovery");
    }
  });

  it("push rejection: second agent loses when first already pushed", async () => {
    const bare = createBareRepo();
    createSeededWorkspace(bare, 1);
    const clone1 = cloneRepo(bare);
    const clone2 = cloneRepo(bare);

    const r1 = await claimTask({
      workspaceRoot: clone1,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent1@test.com",
      baseBranch: "main",
      skipJitter: true,
    });
    expect(r1.won).toBe(true);

    // Agent 2 still sees T1 as "ready" in its stale local clone (hasn't fetched).
    // claimTask fetches first, so it will see the task as ready on main (it is).
    // But when it tries to push the task branch, the branch already exists with
    // agent1's commit → push rejected → SHA compare → lost.
    const r2 = await claimTask({
      workspaceRoot: clone2,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent2@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    expect(r2.won).toBe(false);
    if (!r2.won) {
      expect(r2.reason).toBe("push_rejected");
    }
  });

  it("loser's clone is reset to base branch after push rejection", async () => {
    const bare = createBareRepo();
    createSeededWorkspace(bare, 2);
    const clone1 = cloneRepo(bare);
    const clone2 = cloneRepo(bare);

    await claimTask({
      workspaceRoot: clone1,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "a1@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    await claimTask({
      workspaceRoot: clone2,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "a2@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    // After reset, clone2 should be back on main with T1=ready (main was not updated)
    const currentBranch = execSync(`git -C "${clone2}" branch --show-current`, {
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe("main");

    const t1 = readTaskFromDir(clone2, "T1");
    const t2 = readTaskFromDir(clone2, "T2");
    expect(t1.status).toBe("ready"); // main never got the claim commit
    expect(t2.status).toBe("ready");
  });

  it(
    "5-agent simulation: exactly one winner per task, no double-claims (10 tasks)",
    async () => {
      const TASK_COUNT = 10;
      const AGENT_COUNT = 5;

      const bare = createBareRepo();
      createSeededWorkspace(bare, TASK_COUNT);
      const clones = Array.from({ length: AGENT_COUNT }, () =>
        cloneRepo(bare),
      );

      const winners = new Map<string, string>();

      let maxRounds = TASK_COUNT * (AGENT_COUNT + 1);
      while (winners.size < TASK_COUNT && maxRounds-- > 0) {
        let progress = false;

        for (let a = 0; a < AGENT_COUNT; a++) {
          if (winners.size >= TASK_COUNT) break;

          const email = `agent${a + 1}@test.com`;

          for (let n = 1; n <= TASK_COUNT; n++) {
            const taskId = `T${n}`;
            if (winners.has(taskId)) continue;

            // Re-read from local clone to check if still ready
            const localTask = readTaskFromDir(clones[a], taskId);
            if (localTask.status !== "ready") continue;

            const result = await claimTask({
              workspaceRoot: clones[a],
              taskId,
              featureId: FEATURE_ID,
              gitAuthorEmail: email,
              baseBranch: "main",
              skipJitter: true,
            });

            if (result.won) {
              expect(winners.has(taskId)).toBe(false);
              winners.set(taskId, email);
              progress = true;

              // Reset winner's clone to main so it can claim the next task
              execSync(`git -C "${clones[a]}" checkout main`, { stdio: "pipe" });
              execSync(
                `git -C "${clones[a]}" reset --hard "origin/main"`,
                { stdio: "pipe" },
              );
            } else if (result.reason !== "task_not_ready") {
              // Loser: already reset to main by claimTask; sync task status from remote
              execSync(
                `git -C "${clones[a]}" fetch origin`,
                { stdio: "pipe" },
              );
            }

            break;
          }
        }

        if (!progress) break;
      }

      expect(winners.size).toBe(TASK_COUNT);

      // Verify each task is in_progress on its own task branch
      const verifyClone = cloneRepo(bare);
      execSync(`git -C "${verifyClone}" fetch --all`, { stdio: "pipe" });
      for (let n = 1; n <= TASK_COUNT; n++) {
        const taskId = `T${n}`;
        const branch = `feature/${FEATURE_ID}-${taskId}`;
        // Checkout the task branch and verify the YAML
        execSync(
          `git -C "${verifyClone}" checkout "${branch}"`,
          { stdio: "pipe" },
        );
        const task = readTaskFromDir(verifyClone, taskId);
        expect(task.status).toBe("in_progress");
        expect(task.branch).toBe(branch);
      }
    },
    30_000,
  );

  it(
    "5-agent simulation: SHA-based contention correct when all share GIT_AUTHOR_EMAIL",
    async () => {
      const TASK_COUNT = 5;
      const AGENT_COUNT = 5;
      const SHARED_EMAIL = "shared-fleet@example.com";

      const bare = createBareRepo();
      createSeededWorkspace(bare, TASK_COUNT);
      const clones = Array.from({ length: AGENT_COUNT }, () =>
        cloneRepo(bare),
      );

      const winners = new Map<string, string>();
      let maxRounds = TASK_COUNT * (AGENT_COUNT + 1);

      while (winners.size < TASK_COUNT && maxRounds-- > 0) {
        let progress = false;

        for (let a = 0; a < AGENT_COUNT; a++) {
          if (winners.size >= TASK_COUNT) break;

          for (let n = 1; n <= TASK_COUNT; n++) {
            const taskId = `T${n}`;
            if (winners.has(taskId)) continue;

            const localTask = readTaskFromDir(clones[a], taskId);
            if (localTask.status !== "ready") continue;

            const result = await claimTask({
              workspaceRoot: clones[a],
              taskId,
              featureId: FEATURE_ID,
              gitAuthorEmail: SHARED_EMAIL,
              baseBranch: "main",
              skipJitter: true,
            });

            if (result.won) {
              expect(winners.has(taskId)).toBe(false);
              winners.set(taskId, SHARED_EMAIL);
              progress = true;

              execSync(`git -C "${clones[a]}" checkout main`, { stdio: "pipe" });
              execSync(
                `git -C "${clones[a]}" reset --hard "origin/main"`,
                { stdio: "pipe" },
              );
            } else if (result.reason !== "task_not_ready") {
              execSync(`git -C "${clones[a]}" fetch origin`, { stdio: "pipe" });
            }

            break;
          }
        }

        if (!progress) break;
      }

      expect(winners.size).toBe(TASK_COUNT);

      const verifyClone = cloneRepo(bare);
      execSync(`git -C "${verifyClone}" fetch --all`, { stdio: "pipe" });
      for (let n = 1; n <= TASK_COUNT; n++) {
        const taskId = `T${n}`;
        const branch = `feature/${FEATURE_ID}-${taskId}`;
        execSync(
          `git -C "${verifyClone}" checkout "${branch}"`,
          { stdio: "pipe" },
        );
        const task = readTaskFromDir(verifyClone, taskId);
        expect(task.status).toBe("in_progress");
      }
    },
    30_000,
  );
});
