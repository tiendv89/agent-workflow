/**
 * Tests for T5: run-claude.ts — writeBlockedAndPush writes blocked_context.
 *
 * Unit tests — node:child_process is fully mocked to avoid real git and
 * real claude invocations.
 *
 * Covers:
 *   1. blocked_context written with wip_branch, wip_sha, pushed_at on crash-block
 *   2. wip_branch matches the taskBranch passed to runClaude
 *   3. wip_sha falls back to "unknown" when git rev-parse throws
 *   4. blocked_context stays null when task reaches in_review (happy path)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import type { Task } from "../src/types/task.js";
import { runClaude } from "../src/loop/run-claude.js";

// ── Mock node:child_process ───────────────────────────────────────────────────

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(),
    execSync: vi.fn(),
  };
});

// ── Constants ─────────────────────────────────────────────────────────────────

const FEATURE_ID = "test-feature";
const TASK_ID = "T5";
const TASK_BRANCH = `feature/${FEATURE_ID}-${TASK_ID}`;
const GIT_AUTHOR_EMAIL = "test@example.com";
const FAKE_SHA = "abc123def456789deadbeef";

// ── Temp workspace helpers ────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  vi.clearAllMocks();
});

function makeTempWorkspace(
  initialStatus: Task["status"] = "in_progress",
): { workspaceRoot: string; taskYamlPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "run-claude-test-"));
  tmpDirs.push(dir);
  const tasksDir = join(dir, "docs", "features", FEATURE_ID, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const task: Task = {
    id: TASK_ID,
    title: "Test task",
    repo: "test-repo",
    status: initialStatus,
    depends_on: [],
    blocked_reason: null,
    blocked_context: null,
    branch: TASK_BRANCH,
    execution: {
      actor_type: "agent",
      last_updated_by: GIT_AUTHOR_EMAIL,
      last_updated_at: "2026-04-15T10:00:00Z",
    },
    pr: { url: "", status: "not_created" },
    workspace_pr: null,
    log: [],
  };

  const taskYamlPath = join(tasksDir, `${TASK_ID}.yaml`);
  writeFileSync(taskYamlPath, yamlStringify(task), "utf-8");
  return { workspaceRoot: dir, taskYamlPath };
}

function makeSpawnResult(
  overrides: Partial<ReturnType<typeof spawnSync>> = {},
): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as unknown as ReturnType<typeof spawnSync>;
}

function readTask(workspaceRoot: string): Task {
  return parseYaml(
    readFileSync(
      join(workspaceRoot, "docs", "features", FEATURE_ID, "tasks", `${TASK_ID}.yaml`),
      "utf-8",
    ),
  ) as Task;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runClaude — crash-block path (T5)", () => {
  it("writes blocked_context with wip_branch, wip_sha, pushed_at when task stays in_progress", async () => {
    const { workspaceRoot } = makeTempWorkspace("in_progress");

    // claude exits 0 but does NOT update task YAML (task remains in_progress)
    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ status: 0 }));

    // git rev-parse returns fake SHA; all other git commands are no-ops
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      if (String(cmd).includes("rev-parse")) return `${FAKE_SHA}\n` as never;
      return "" as never;
    });

    const result = await runClaude({
      taskId: TASK_ID,
      featureId: FEATURE_ID,
      workspaceRoot,
      taskRepoRoot: workspaceRoot,
      agentContext: "test context",
      maxTurns: 10,
      maxTokens: 5_000,
      sshKeyPath: undefined,
      gitAuthorEmail: GIT_AUTHOR_EMAIL,
      taskBranch: TASK_BRANCH,
      logSinkEnabled: false,
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") expect(result.reason).toBe("runtime_error");

    const task = readTask(workspaceRoot);
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("runtime_error");
    expect(task.blocked_context).not.toBeNull();
    expect(task.blocked_context?.wip_branch).toBe(TASK_BRANCH);
    expect(task.blocked_context?.wip_sha).toBe(FAKE_SHA);
    expect(task.blocked_context?.pushed_at).toBeTruthy();
    expect(new Date(task.blocked_context!.pushed_at).getTime()).toBeGreaterThan(0);
  });

  it("uses the taskBranch option as wip_branch", async () => {
    const { workspaceRoot } = makeTempWorkspace("in_progress");
    const customBranch = "feature/custom-feature-TX";

    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ status: 1 }));
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      if (String(cmd).includes("rev-parse")) return `${FAKE_SHA}\n` as never;
      return "" as never;
    });

    await runClaude({
      taskId: TASK_ID,
      featureId: FEATURE_ID,
      workspaceRoot,
      taskRepoRoot: workspaceRoot,
      agentContext: "test",
      maxTurns: 10,
      maxTokens: 5_000,
      sshKeyPath: undefined,
      gitAuthorEmail: GIT_AUTHOR_EMAIL,
      taskBranch: customBranch,
      logSinkEnabled: false,
    });

    const task = readTask(workspaceRoot);
    expect(task.blocked_context?.wip_branch).toBe(customBranch);
  });

  it("falls back to wip_sha 'unknown' when git rev-parse throws", async () => {
    const { workspaceRoot } = makeTempWorkspace("in_progress");

    vi.mocked(spawnSync).mockReturnValueOnce(makeSpawnResult({ status: 0 }));
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      if (String(cmd).includes("rev-parse")) throw new Error("not a git repo");
      return "" as never;
    });

    await runClaude({
      taskId: TASK_ID,
      featureId: FEATURE_ID,
      workspaceRoot,
      taskRepoRoot: workspaceRoot,
      agentContext: "test",
      maxTurns: 10,
      maxTokens: 5_000,
      sshKeyPath: undefined,
      gitAuthorEmail: GIT_AUTHOR_EMAIL,
      taskBranch: TASK_BRANCH,
      logSinkEnabled: false,
    });

    const task = readTask(workspaceRoot);
    expect(task.blocked_context?.wip_sha).toBe("unknown");
    // other fields still written
    expect(task.blocked_context?.wip_branch).toBe(TASK_BRANCH);
    expect(task.blocked_context?.pushed_at).toBeTruthy();
  });

  it("does NOT write blocked_context when task reaches in_review", async () => {
    const { workspaceRoot } = makeTempWorkspace("in_progress");

    // stub claude updates the task to in_review
    vi.mocked(spawnSync).mockImplementation(() => {
      const taskYamlPath = join(
        workspaceRoot, "docs", "features", FEATURE_ID, "tasks", `${TASK_ID}.yaml`,
      );
      const task = parseYaml(readFileSync(taskYamlPath, "utf-8")) as Task;
      task.status = "in_review";
      writeFileSync(taskYamlPath, yamlStringify(task), "utf-8");
      return makeSpawnResult({ status: 0 });
    });

    vi.mocked(execSync).mockReturnValue("" as never);

    const result = await runClaude({
      taskId: TASK_ID,
      featureId: FEATURE_ID,
      workspaceRoot,
      taskRepoRoot: workspaceRoot,
      agentContext: "test",
      maxTurns: 10,
      maxTokens: 5_000,
      sshKeyPath: undefined,
      gitAuthorEmail: GIT_AUTHOR_EMAIL,
      taskBranch: TASK_BRANCH,
      logSinkEnabled: false,
    });

    expect(result.outcome).toBe("in_review");

    // rev-parse must NOT have been called
    const revParseCalls = vi.mocked(execSync).mock.calls.filter(
      ([cmd]) => String(cmd).includes("rev-parse"),
    );
    expect(revParseCalls).toHaveLength(0);

    // blocked_context must stay null
    const task = readTask(workspaceRoot);
    expect(task.blocked_context).toBeNull();
  });
});
