/**
 * Tests for T7: git-based claim protocol (claim-task.ts) and
 * suggested-next-step generator (suggested-next-step.ts).
 *
 * Test structure:
 *   1. Unit tests (skipGit: true) — logic without git
 *   2. Integration tests (real local git repos, file:// remote)
 *      a. Single-agent happy path
 *      b. Push-rejection: another agent wins the race
 *      c. 5-agent concurrent-claim simulation on 10 tasks
 *      d. All agents share GIT_AUTHOR_EMAIL — SHA discrimination still works
 *   3. Suggested-next-step tests (mocked Anthropic)
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
import {
  generateSuggestedNextStep,
  type SuggestedNextStepClient,
} from "../src/claim/suggested-next-step.js";
import type { Task } from "../src/types/task.js";

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
    branch: `feature/test-feature-${id}`,
    execution: {
      actor_type: "agent",
      last_updated_by: null,
      last_updated_at: null,
    },
    pr: { url: "", status: "not_created" },
    log: [
      {
        action: "created",
        by: "setup@test.com",
        at: "2026-04-14T00:00:00Z",
      },
    ],
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
 * Returns the absolute path.
 */
function createBareRepo(): string {
  const dir = trackDir(mkdtempSync(join(tmpdir(), "claim-bare-")));
  // Use -c init.defaultBranch=main to set the default branch without needing
  // a subsequent symbolic-ref command (which requires safe.bareRepository=all).
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

  // Create structure
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
  execSync(
    `git commit -m "initial"`,
    {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, ...GIT_ENV },
    },
  );
  execSync("git push -u origin main", { cwd: dir, stdio: "pipe" });

  return dir;
}

/**
 * Clone the bare repo into a new temp directory.
 * The resulting directory is a fresh, independent working copy.
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
  it("single agent: happy path — task transitions to in_progress on remote", async () => {
    const bare = createBareRepo();
    const seed = createSeededWorkspace(bare, 1);
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

    // Verify the task on the remote (pull into seed and read)
    execSync("git pull origin main", { cwd: seed, stdio: "pipe" });
    const task = readTaskFromDir(seed, "T1");
    expect(task.status).toBe("in_progress");
    expect(task.execution.last_updated_by).toBe("agent1@test.com");
  });

  it("push rejection: second agent loses when first already pushed", async () => {
    const bare = createBareRepo();
    createSeededWorkspace(bare, 1);
    const clone1 = cloneRepo(bare);
    const clone2 = cloneRepo(bare);

    // Agent 1 claims first
    const r1 = await claimTask({
      workspaceRoot: clone1,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "agent1@test.com",
      baseBranch: "main",
      skipJitter: true,
    });
    expect(r1.won).toBe(true);

    // Agent 2 still sees T1 as "ready" in its stale local clone (hasn't pulled).
    // It will commit, push → rejected → lose.
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

  it("loser's clone is reset to origin after push rejection", async () => {
    const bare = createBareRepo();
    createSeededWorkspace(bare, 2);
    const clone1 = cloneRepo(bare);
    const clone2 = cloneRepo(bare);

    // Agent 1 wins T1
    await claimTask({
      workspaceRoot: clone1,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "a1@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    // Agent 2 loses T1
    await claimTask({
      workspaceRoot: clone2,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: "a2@test.com",
      baseBranch: "main",
      skipJitter: true,
    });

    // After reset, clone2 should see T1 as in_progress and T2 as ready
    const t1 = readTaskFromDir(clone2, "T1");
    const t2 = readTaskFromDir(clone2, "T2");
    expect(t1.status).toBe("in_progress");
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

      // Map from taskId → email of winner
      const winners = new Map<string, string>();

      // Run until all tasks are claimed.
      // Each round: each agent tries to claim the first task it sees as ready.
      let maxRounds = TASK_COUNT * (AGENT_COUNT + 1);
      while (winners.size < TASK_COUNT && maxRounds-- > 0) {
        let progress = false;

        for (let a = 0; a < AGENT_COUNT; a++) {
          if (winners.size >= TASK_COUNT) break;

          const email = `agent${a + 1}@test.com`;

          // Find the first task this clone sees as ready
          for (let n = 1; n <= TASK_COUNT; n++) {
            const taskId = `T${n}`;
            if (winners.has(taskId)) continue;

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
              expect(winners.has(taskId)).toBe(false); // no double-claim
              winners.set(taskId, email);
              progress = true;
            }

            break; // one attempt per agent per round
          }
        }

        // If no agent made progress this round, break early
        if (!progress) break;
      }

      // All 10 tasks must be claimed
      expect(winners.size).toBe(TASK_COUNT);

      // Verify final state on remote: pull into a fresh clone and check all tasks
      const verifyDir = cloneRepo(bare);
      for (let n = 1; n <= TASK_COUNT; n++) {
        const task = readTaskFromDir(verifyDir, `T${n}`);
        expect(task.status).toBe("in_progress");
      }
    },
    30_000, // 30s timeout for git operations
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
              gitAuthorEmail: SHARED_EMAIL, // all agents share the same email
              baseBranch: "main",
              skipJitter: true,
            });

            if (result.won) {
              expect(winners.has(taskId)).toBe(false);
              winners.set(taskId, SHARED_EMAIL);
              progress = true;
            }

            break;
          }
        }

        if (!progress) break;
      }

      expect(winners.size).toBe(TASK_COUNT);

      // Final verification
      const verifyDir = cloneRepo(bare);
      for (let n = 1; n <= TASK_COUNT; n++) {
        const task = readTaskFromDir(verifyDir, `T${n}`);
        expect(task.status).toBe("in_progress");
      }
    },
    30_000,
  );
});

// ── Suggested-next-step tests ─────────────────────────────────────────────────

describe("generateSuggestedNextStep", () => {
  function makeBlockedTask(reason: Task["blocked_reason"]): Task {
    const t = makeReadyTask("T7");
    t.status = "blocked";
    t.blocked_reason = reason;
    return t;
  }

  function makeMockClient(responseText: string): SuggestedNextStepClient {
    return {
      messages: {
        async create() {
          return {
            content: [{ type: "text", text: responseText }],
          };
        },
      },
    };
  }

  it("returns the model's text response for a blocked task", async () => {
    const task = makeBlockedTask("budget_exceeded");
    const client = makeMockClient("Increase the token budget in workspace.yaml.");

    const hint = await generateSuggestedNextStep({
      task,
      anthropicClient: client,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 100,
    });

    expect(hint).toBe("Increase the token budget in workspace.yaml.");
  });

  it("includes task description in prompt context when provided", async () => {
    const task = makeBlockedTask("iteration_cap_exceeded");
    let capturedPrompt = "";

    const client: SuggestedNextStepClient = {
      messages: {
        async create(params) {
          capturedPrompt = params.messages[0].content;
          return { content: [{ type: "text", text: "Raise iteration cap." }] };
        },
      },
    };

    await generateSuggestedNextStep({
      task,
      taskDescription: "Implement the foo pipeline.",
      anthropicClient: client,
    });

    expect(capturedPrompt).toContain("Implement the foo pipeline.");
  });

  it("returns fallback string when client throws", async () => {
    const task = makeBlockedTask("runtime_error");

    const failingClient: SuggestedNextStepClient = {
      messages: {
        async create() {
          throw new Error("network error");
        },
      },
    };

    const hint = await generateSuggestedNextStep({
      task,
      anthropicClient: failingClient,
    });

    // Fallback should mention task ID and reason
    expect(hint).toContain("T7");
    expect(hint).toContain("runtime_error");
  });

  it("returns fallback string when response has no text block", async () => {
    const task = makeBlockedTask("no_progress");

    const weirdClient: SuggestedNextStepClient = {
      messages: {
        async create() {
          return { content: [] }; // empty content
        },
      },
    };

    const hint = await generateSuggestedNextStep({
      task,
      anthropicClient: weirdClient,
    });

    expect(hint).toContain("T7");
    expect(hint).toContain("no_progress");
  });

  it("includes blocked_details in the prompt when present", async () => {
    const task = makeBlockedTask("model_escalation_requested");
    task.blocked_details = { current_model: "claude-sonnet-4-6", iterations: 10 };
    let capturedPrompt = "";

    const client: SuggestedNextStepClient = {
      messages: {
        async create(params) {
          capturedPrompt = params.messages[0].content;
          return { content: [{ type: "text", text: "Escalate to Opus." }] };
        },
      },
    };

    await generateSuggestedNextStep({ task, anthropicClient: client });

    expect(capturedPrompt).toContain("current_model");
  });

  it("uses the provided model when specified", async () => {
    const task = makeBlockedTask("skill_missing");
    let usedModel = "";

    const client: SuggestedNextStepClient = {
      messages: {
        async create(params) {
          usedModel = params.model;
          return { content: [{ type: "text", text: "Add the skill." }] };
        },
      },
    };

    await generateSuggestedNextStep({
      task,
      anthropicClient: client,
      model: "claude-haiku-4-5-20251001",
    });

    expect(usedModel).toBe("claude-haiku-4-5-20251001");
  });
});
