/**
 * Tests for T3: open-workspace-pr.ts
 *
 * Unit tests only — no real GitHub API calls. `spawnSync` (used for curl) is
 * mocked via vi.mock. `skipGit: true` suppresses execSync git operations.
 *
 * Covers:
 *   1. parseGitHubCoords — standard .git URL, URL without .git, HTTPS throws
 *   2. openWorkspacePr — existing open PR reused (no POST)
 *   3. openWorkspacePr — no open PR → POST, URL written to YAML
 *   4. openWorkspacePr — workspace_pr written to disk in all cases
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { stringify as yamlStringify, parse as parseYaml } from "yaml";
import type { Task } from "../src/types/task.js";
import {
  parseGitHubCoords,
  openWorkspacePr,
} from "../src/claim/open-workspace-pr.js";

// ── Mock node:child_process (spawnSync only; execSync stays real) ─────────────

vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FEATURE_ID = "test-feature";
const TASK_ID = "T3";
const REPO_OWNER = "test-owner";
const REPO_NAME = "test-repo";
const BRANCH = `feature/${FEATURE_ID}-${TASK_ID}`;
const BASE_BRANCH = "main";
const GITHUB_TOKEN = "ghp_test_token";

const SAMPLE_PR_URL = "https://github.com/test-owner/test-repo/pull/42";
const SAMPLE_PR_NUMBER = 42;

function makeTask(id: string): Task {
  return {
    id,
    title: `Test Task ${id}`,
    repo: "test-repo",
    status: "in_progress",
    depends_on: [],
    blocked_reason: null,
    blocked_context: null,
    branch: `feature/${FEATURE_ID}-${id}`,
    execution: {
      actor_type: "agent",
      last_updated_by: "agent@test.com",
      last_updated_at: "2026-04-15T00:00:00Z",
    },
    pr: { url: "", status: "not_created" },
    workspace_pr: null,
    log: [{ action: "claimed", by: "agent@test.com", at: "2026-04-15T00:00:00Z" }],
  };
}

// ── Temp directory helpers ────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeWorkspaceDir(task: Task): string {
  const dir = mkdtempSync(join(tmpdir(), "open-pr-unit-"));
  tmpDirs.push(dir);
  const tasksDir = join(dir, "docs", "features", FEATURE_ID, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, `${task.id}.yaml`), yamlStringify(task), "utf-8");
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

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  vi.clearAllMocks();
});

// ── Helpers to build mock spawnSync return values ─────────────────────────────

function mockSpawnResult(jsonBody: unknown): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [],
    stdout: JSON.stringify(jsonBody),
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
  } as unknown as ReturnType<typeof spawnSync>;
}

// ── 1. parseGitHubCoords ──────────────────────────────────────────────────────

describe("parseGitHubCoords", () => {
  it("parses standard SSH URL with .git suffix", () => {
    const result = parseGitHubCoords("git@github.com:tiendv89/project-workspace.git");
    expect(result).toEqual({ owner: "tiendv89", repo: "project-workspace" });
  });

  it("parses SSH URL without .git suffix", () => {
    const result = parseGitHubCoords("git@github.com:my-org/my-repo");
    expect(result).toEqual({ owner: "my-org", repo: "my-repo" });
  });

  it("throws a descriptive error for an HTTPS URL", () => {
    expect(() =>
      parseGitHubCoords("https://github.com/owner/repo.git"),
    ).toThrow(/Cannot parse GitHub owner\/repo/);
  });

  it("throws a descriptive error for a malformed string", () => {
    expect(() => parseGitHubCoords("not-a-url")).toThrow(
      /Cannot parse GitHub owner\/repo/,
    );
  });
});

// ── 2. openWorkspacePr — existing open PR (no POST) ──────────────────────────

describe("openWorkspacePr — existing open PR", () => {
  it("returns alreadyExisted: true and reuses the existing PR URL", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    const mockSpy = vi.mocked(spawnSync);

    // GET /pulls?... returns a non-empty array (PR already open)
    mockSpy.mockReturnValueOnce(
      mockSpawnResult([{ html_url: SAMPLE_PR_URL, number: SAMPLE_PR_NUMBER }]),
    );

    const result = await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    expect(result.prUrl).toBe(SAMPLE_PR_URL);
    expect(result.prNumber).toBe(SAMPLE_PR_NUMBER);
    expect(result.alreadyExisted).toBe(true);

    // Only one curl call (GET) — no POST
    expect(mockSpy).toHaveBeenCalledTimes(1);
    const [, getArgs] = mockSpy.mock.calls[0];
    const argsArray = getArgs as string[];
    expect(argsArray.some((a) => a.includes("/pulls"))).toBe(true);
    expect(argsArray.includes("POST")).toBe(false);
  });

  it("writes workspace_pr to YAML with status: open", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    vi.mocked(spawnSync).mockReturnValueOnce(
      mockSpawnResult([{ html_url: SAMPLE_PR_URL, number: SAMPLE_PR_NUMBER }]),
    );

    await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    const task = readTaskFromDir(dir, TASK_ID);
    expect(task.workspace_pr).toEqual({ url: SAMPLE_PR_URL, status: "open" });
  });
});

// ── 3. openWorkspacePr — no open PR → POST ────────────────────────────────────

describe("openWorkspacePr — no existing PR", () => {
  it("calls POST and returns alreadyExisted: false", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    const mockSpy = vi.mocked(spawnSync);

    const newPrUrl = "https://github.com/test-owner/test-repo/pull/99";
    const newPrNumber = 99;

    // GET returns empty array (no existing PR)
    mockSpy.mockReturnValueOnce(mockSpawnResult([]));
    // POST returns the new PR
    mockSpy.mockReturnValueOnce(
      mockSpawnResult({ html_url: newPrUrl, number: newPrNumber }),
    );

    const result = await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    expect(result.prUrl).toBe(newPrUrl);
    expect(result.prNumber).toBe(newPrNumber);
    expect(result.alreadyExisted).toBe(false);

    // Two curl calls: GET then POST
    expect(mockSpy).toHaveBeenCalledTimes(2);
    const [, postArgs] = mockSpy.mock.calls[1];
    const argsArray = postArgs as string[];
    expect(argsArray.includes("POST")).toBe(true);
  });

  it("writes workspace_pr to YAML after POST", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    const mockSpy = vi.mocked(spawnSync);

    const newPrUrl = "https://github.com/test-owner/test-repo/pull/100";

    mockSpy.mockReturnValueOnce(mockSpawnResult([]));
    mockSpy.mockReturnValueOnce(
      mockSpawnResult({ html_url: newPrUrl, number: 100 }),
    );

    await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    const task = readTaskFromDir(dir, TASK_ID);
    expect(task.workspace_pr).toEqual({ url: newPrUrl, status: "open" });
  });

  it("uses feat(<taskId>): <title> as PR title", async () => {
    const task = makeTask(TASK_ID);
    const dir = makeWorkspaceDir(task);
    const mockSpy = vi.mocked(spawnSync);

    mockSpy.mockReturnValueOnce(mockSpawnResult([]));
    mockSpy.mockReturnValueOnce(
      mockSpawnResult({ html_url: SAMPLE_PR_URL, number: SAMPLE_PR_NUMBER }),
    );

    await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    const [, postArgs] = mockSpy.mock.calls[1];
    const argsArray = postArgs as string[];
    const bodyIndex = argsArray.indexOf("-d") + 1;
    const body = JSON.parse(argsArray[bodyIndex]);
    expect(body.title).toBe(`feat(${TASK_ID}): ${task.title}`);
    expect(body.head).toBe(BRANCH);
    expect(body.base).toBe(BASE_BRANCH);
  });

  it("throws when POST response lacks html_url or number", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    const mockSpy = vi.mocked(spawnSync);

    mockSpy.mockReturnValueOnce(mockSpawnResult([]));
    // Simulate API error response (e.g. token invalid)
    mockSpy.mockReturnValueOnce(
      mockSpawnResult({ message: "Bad credentials", documentation_url: "https://docs.github.com" }),
    );

    await expect(
      openWorkspacePr({
        workspaceRoot: dir,
        featureId: FEATURE_ID,
        taskId: TASK_ID,
        branch: BRANCH,
        baseBranch: BASE_BRANCH,
        githubToken: "bad-token",
        repoOwner: REPO_OWNER,
        repoName: REPO_NAME,
        skipGit: true,
      }),
    ).rejects.toThrow("GitHub API PR creation failed");
  });
});

// ── 4. GET call includes correct query params ─────────────────────────────────

describe("openWorkspacePr — GET query params", () => {
  it("passes head=owner:branch and state=open in the GET URL", async () => {
    const dir = makeWorkspaceDir(makeTask(TASK_ID));
    const mockSpy = vi.mocked(spawnSync);

    mockSpy.mockReturnValueOnce(
      mockSpawnResult([{ html_url: SAMPLE_PR_URL, number: SAMPLE_PR_NUMBER }]),
    );

    await openWorkspacePr({
      workspaceRoot: dir,
      featureId: FEATURE_ID,
      taskId: TASK_ID,
      branch: BRANCH,
      baseBranch: BASE_BRANCH,
      githubToken: GITHUB_TOKEN,
      repoOwner: REPO_OWNER,
      repoName: REPO_NAME,
      skipGit: true,
    });

    const [, getArgs] = mockSpy.mock.calls[0];
    const argsArray = getArgs as string[];
    const url = argsArray[argsArray.length - 1];
    expect(url).toContain("state=open");
    expect(url).toContain(encodeURIComponent(`${REPO_OWNER}:${BRANCH}`));
  });
});
