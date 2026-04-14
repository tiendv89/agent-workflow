/**
 * T11: End-to-end integration tests for the agent-runtime activation loop.
 *
 * Tests the full bootstrap → eligibility → claim → run-task pipeline
 * against local bare-git repos (no Docker, no external API).
 *
 * Scenario — three tasks in a single feature:
 *   T1 (success)   : eligible, mock Anthropic returns end_turn immediately → in_review
 *   T2 (budget)    : eligible, mock Anthropic returns a token count above the cap → blocked/budget_exceeded
 *   T3 (no-skill)  : requires a skill that is absent → skipped at eligibility, stays ready
 *
 * Acceptance checks:
 *   - T1 reaches status in_review (equivalent to "PR created" in a production run)
 *   - T2 reaches status blocked with blocked_reason budget_exceeded
 *   - T3 stays status ready (no orphan in in_progress)
 *   - No tasks are left orphaned in in_progress
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
import { parse as parseYaml, stringify as yamlStringify } from "yaml";

import { runBootstrap } from "../../src/bootstrap/bootstrap.js";
import { findEligibleTasks } from "../../src/eligibility/match.js";
import { claimTask } from "../../src/claim/claim-task.js";
import { runTask } from "../../src/loop/run-task.js";
import type { AnthropicClient } from "../../src/loop/run-task.js";
import type { Task } from "../../src/types/task.js";
import type { AgentConfig } from "../../src/config/validate-agent-yaml.js";
import type { ModelPolicy } from "../../src/config/resolve-model-policy.js";
import type { LogSink } from "../../src/logging/log-sink.js";
import type Anthropic from "@anthropic-ai/sdk";

// ── Constants ─────────────────────────────────────────────────────────────────

const FEATURE_ID = "test-feature";
const WORKSPACE_SSH_URL = "git@github.com:org/test-workspace.git";
const IMPL_REPO_ID = "impl-repo";
const MGMT_REPO_ID = "management-repo";

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test Agent",
  GIT_AUTHOR_EMAIL: "test-agent@example.com",
  GIT_COMMITTER_NAME: "Test Agent",
  GIT_COMMITTER_EMAIL: "test-agent@example.com",
};

const MODEL_POLICY: ModelPolicy = {
  implementation: {
    allowed: ["claude-sonnet-4-6"],
    default: "claude-sonnet-4-6",
  },
  self_review: {
    allowed: ["claude-sonnet-4-6"],
    default: "claude-sonnet-4-6",
  },
  pr_description: {
    allowed: ["claude-haiku-4-5-20251001"],
    default: "claude-haiku-4-5-20251001",
  },
  suggested_next_step: {
    allowed: ["claude-haiku-4-5-20251001"],
    default: "claude-haiku-4-5-20251001",
  },
};

const BASE_AGENT_CONFIG: AgentConfig = {
  watches: [WORKSPACE_SSH_URL],
  enabled: true,
  jitter_max_seconds: 0,
  budget: {
    max_tokens_per_task: 5_000,
    max_iterations: 10,
    suggested_next_step_max_tokens: 500,
  },
  log_sink: { enabled: false },
};

/** No-op log sink — keeps tests clean. */
const NULL_SINK: LogSink = {
  emit: () => {},
  close: async () => {},
};

// ── Cleanup tracking ──────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agent-integration-"));
  tmpDirs.push(d);
  return d;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

/** Create a bare git repo at path and return its file:// URL. */
function initBareRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  execSync("git -c init.defaultBranch=main init --bare", {
    cwd: path,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });
  return `file://${path}`;
}

/**
 * Seed a working clone from a bare repo, write files, commit, and push to main.
 * The working clone is cleaned up immediately after (only the bare repo persists).
 */
function seedRepo(
  bareUrl: string,
  files: Record<string, string>,
): void {
  const workDir = tmpDir();
  execSync(`git clone "${bareUrl}" .`, {
    cwd: workDir,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });
  execSync("git checkout -b main", {
    cwd: workDir,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });

  for (const [relPath, content] of Object.entries(files)) {
    const full = join(workDir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }

  execSync("git add -A", {
    cwd: workDir,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });
  execSync('git commit -m "seed: initial workspace content"', {
    cwd: workDir,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });
  execSync("git push origin main", {
    cwd: workDir,
    env: { ...process.env, ...GIT_ENV },
    stdio: "pipe",
  });
}

// ── Workspace builder ─────────────────────────────────────────────────────────

interface TaskSpec {
  id: string;
  status?: "ready" | "done";
  requiredSkill?: string;   // skill slug to declare in tasks.md (must exist in technical_skills/)
  dependsOn?: string[];
}

/**
 * Build a complete workspace directory structure on disk (not a git repo).
 *
 * Returns the workspace root path.
 */
function buildWorkspace(
  root: string,
  tasks: TaskSpec[],
  existingSkills: string[],   // skill slugs to create under technical_skills/
): string {
  // workspace.yaml
  writeFileSync(
    join(root, "workspace.yaml"),
    yamlStringify({
      workspace_id: "test-workspace",
      management_repo: MGMT_REPO_ID,
      repos: [
        {
          id: MGMT_REPO_ID,
          github: WORKSPACE_SSH_URL,
        },
        {
          id: IMPL_REPO_ID,
          github: "git@github.com:org/impl-repo.git",
        },
      ],
    }),
    "utf-8",
  );

  // Feature directory
  const featureDir = join(root, "docs", "features", FEATURE_ID);
  const tasksDir = join(featureDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  // tasks.md with ### Required skills per task
  const lines: string[] = ["# Tasks\n"];
  for (const spec of tasks) {
    lines.push(`## ${spec.id} — Test task ${spec.id}\n`);
    lines.push("### Description\n");
    lines.push(`Integration test task ${spec.id}.\n`);
    if (spec.requiredSkill) {
      lines.push("### Required skills\n");
      lines.push(`- ${spec.requiredSkill}\n`);
    } else {
      lines.push("### Required skills\n");
      lines.push("(none)\n");
    }
  }
  writeFileSync(join(featureDir, "tasks.md"), lines.join("\n"), "utf-8");

  // Task YAML files
  for (const spec of tasks) {
    const task: Task = {
      id: spec.id,
      title: `Test task ${spec.id}`,
      repo: IMPL_REPO_ID,
      status: spec.status ?? "ready",
      depends_on: spec.dependsOn ?? [],
      blocked_reason: null,
      branch: `feature/${FEATURE_ID}-${spec.id}`,
      execution: {
        actor_type: "agent",
        last_updated_by: null,
        last_updated_at: null,
      },
      pr: { url: "", status: "not_created" },
      log: [],
    };
    writeFileSync(join(tasksDir, `${spec.id}.yaml`), yamlStringify(task), "utf-8");
  }

  return root;
}

/**
 * Build a workflow repo directory with technical_skills/ populated.
 * Returns the workflow root path.
 */
function buildWorkflowRepo(root: string, skills: string[]): string {
  for (const slug of skills) {
    const skillDir = join(root, "technical_skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${slug}\n\nTest skill.\n`, "utf-8");
  }
  return root;
}

/** Read a task YAML from the workspace. */
function readTask(workspaceRoot: string, taskId: string): Task {
  return parseYaml(
    readFileSync(
      join(workspaceRoot, "docs", "features", FEATURE_ID, "tasks", `${taskId}.yaml`),
      "utf-8",
    ),
  ) as Task;
}

// ── Mock Anthropic clients ────────────────────────────────────────────────────

/**
 * Returns a mock Anthropic client whose messages.create() immediately signals
 * end_turn — simulating a model that finishes without calling any tools.
 */
function makeSuccessClient(): AnthropicClient {
  return {
    messages: {
      create: async () => ({
        id: "msg_test_success",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Task complete." }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50 },
      } as unknown as Anthropic.Message),
    },
  };
}

/**
 * Returns a mock Anthropic client whose messages.create() reports token usage
 * that exceeds the budget cap, triggering budget_exceeded.
 */
function makeBudgetBustClient(cap: number): AnthropicClient {
  return {
    messages: {
      create: async () => ({
        id: "msg_test_budget",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Working..." }],
        model: "claude-sonnet-4-6",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: cap + 1, output_tokens: 0 },
      } as unknown as Anthropic.Message),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent-runtime integration", () => {
  /**
   * Eligibility filter: a task whose required skill is absent from
   * technical_skills/ must not appear in findEligibleTasks output,
   * and a task_skipped_missing_skill event must be emitted.
   */
  it("skips task with missing skill at eligibility stage", () => {
    const root = tmpDir();
    const workspaceRoot = buildWorkspace(root, [
      { id: "T1", requiredSkill: "missing-skill" },
    ], []);
    const workflowRoot = buildWorkflowRepo(tmpDir(), []);   // no skills installed

    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      watches: [WORKSPACE_SSH_URL],
    };

    const events: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (msg: string) => { events.push(msg); };
    let eligible: Task[];
    try {
      eligible = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
    } finally {
      console.log = originalLog;
    }

    expect(eligible).toHaveLength(0);
    const skippedEvent = events.find((e) => {
      try { return JSON.parse(e).type === "task_skipped_missing_skill"; } catch { return false; }
    });
    expect(skippedEvent).toBeDefined();
    const parsed = JSON.parse(skippedEvent!);
    expect(parsed.missingSkills).toContain("missing-skill");

    // Task must still be ready (not blocked — skill-missing is non-fatal to task state)
    const task = readTask(workspaceRoot, "T1");
    expect(task.status).toBe("ready");
  });

  /**
   * Success path: mock Anthropic client returns end_turn on the first call.
   * Task must be marked in_review after runTask completes.
   */
  it("marks task in_review when model signals end_turn", async () => {
    const root = tmpDir();
    const workspaceRoot = buildWorkspace(root, [
      { id: "T1", requiredSkill: "test-skill" },
    ], ["test-skill"]);
    const workflowRoot = buildWorkflowRepo(tmpDir(), ["test-skill"]);
    const taskRepoRoot = tmpDir();   // empty dir is fine (skipGit skips real git ops)

    const result = await runTask({
      taskId: "T1",
      featureId: FEATURE_ID,
      workspaceRoot,
      workflowRoot,
      taskRepoRoot,
      agentConfig: BASE_AGENT_CONFIG,
      workspaceModelPolicy: MODEL_POLICY,
      logSink: NULL_SINK,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      skipGit: true,
      anthropicClient: makeSuccessClient(),
    });

    expect(result.outcome).toBe("in_review");
    const task = readTask(workspaceRoot, "T1");
    expect(task.status).toBe("in_review");
    expect(task.blocked_reason).toBeNull();
  });

  /**
   * Budget path: mock Anthropic client reports token usage over the cap.
   * Task must be marked blocked with blocked_reason: budget_exceeded.
   */
  it("marks task blocked/budget_exceeded when token cap is exceeded", async () => {
    const root = tmpDir();
    const cap = 1_000;
    const workspaceRoot = buildWorkspace(root, [
      { id: "T1", requiredSkill: "test-skill" },
    ], ["test-skill"]);
    const workflowRoot = buildWorkflowRepo(tmpDir(), ["test-skill"]);
    const taskRepoRoot = tmpDir();

    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      budget: { ...BASE_AGENT_CONFIG.budget, max_tokens_per_task: cap },
    };

    const result = await runTask({
      taskId: "T1",
      featureId: FEATURE_ID,
      workspaceRoot,
      workflowRoot,
      taskRepoRoot,
      agentConfig,
      workspaceModelPolicy: MODEL_POLICY,
      logSink: NULL_SINK,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      skipGit: true,
      anthropicClient: makeBudgetBustClient(cap),
    });

    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toBe("budget_exceeded");
    }
    const task = readTask(workspaceRoot, "T1");
    expect(task.status).toBe("blocked");
    expect(task.blocked_reason).toBe("budget_exceeded");
  });

  /**
   * Full three-task scenario:
   *   T1 (real-skill present)     → runTask with success mock → in_review
   *   T2 (real-skill present)     → runTask with budget-bust mock → blocked/budget_exceeded
   *   T3 (missing-skill absent)   → filtered out at eligibility → stays ready
   *
   * Acceptance criteria:
   *   - 1 task in_review  (T1)
   *   - 1 task blocked    (T2)
   *   - 1 task ready      (T3) — no orphan in in_progress
   *   - findEligibleTasks returns only T1 and T2 (T3 is skipped)
   */
  it("full scenario: success + budget + missing-skill → correct terminal states", async () => {
    const root = tmpDir();
    const workspaceRoot = buildWorkspace(root, [
      { id: "T1", requiredSkill: "real-skill" },
      { id: "T2", requiredSkill: "real-skill" },
      { id: "T3", requiredSkill: "phantom-skill" },
    ], ["real-skill"]);
    const workflowRoot = buildWorkflowRepo(tmpDir(), ["real-skill"]);
    // phantom-skill intentionally absent from technical_skills/

    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      watches: [WORKSPACE_SSH_URL],
      budget: { ...BASE_AGENT_CONFIG.budget, max_tokens_per_task: 500 },
    };

    // ── Eligibility ──────────────────────────────────────────────────────────
    const events: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (msg: string) => { events.push(msg); };
    let eligible: Task[];
    try {
      eligible = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
    } finally {
      console.log = originalLog;
    }

    // T1 and T2 eligible; T3 skipped
    expect(eligible.map((t) => t.id).sort()).toEqual(["T1", "T2"]);
    const skippedEvents = events.filter((e) => {
      try { return JSON.parse(e).type === "task_skipped_missing_skill"; } catch { return false; }
    });
    expect(skippedEvents).toHaveLength(1);
    expect(JSON.parse(skippedEvents[0]).taskId).toBe("T3");

    // ── T1: claim + run (success) ────────────────────────────────────────────
    const claimT1 = await claimTask({
      workspaceRoot,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      gitAuthorName: GIT_ENV.GIT_AUTHOR_NAME,
      skipGit: true,
      skipJitter: true,
    });
    expect(claimT1.won).toBe(true);

    const resultT1 = await runTask({
      taskId: "T1",
      featureId: FEATURE_ID,
      workspaceRoot,
      workflowRoot,
      taskRepoRoot: tmpDir(),
      agentConfig,
      workspaceModelPolicy: MODEL_POLICY,
      logSink: NULL_SINK,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      skipGit: true,
      anthropicClient: makeSuccessClient(),
    });
    expect(resultT1.outcome).toBe("in_review");

    // ── T2: claim + run (budget exceeded) ───────────────────────────────────
    const claimT2 = await claimTask({
      workspaceRoot,
      taskId: "T2",
      featureId: FEATURE_ID,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      gitAuthorName: GIT_ENV.GIT_AUTHOR_NAME,
      skipGit: true,
      skipJitter: true,
    });
    expect(claimT2.won).toBe(true);

    const resultT2 = await runTask({
      taskId: "T2",
      featureId: FEATURE_ID,
      workspaceRoot,
      workflowRoot,
      taskRepoRoot: tmpDir(),
      agentConfig,
      workspaceModelPolicy: MODEL_POLICY,
      logSink: NULL_SINK,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      skipGit: true,
      anthropicClient: makeBudgetBustClient(agentConfig.budget.max_tokens_per_task),
    });
    expect(resultT2.outcome).toBe("blocked");

    // ── Assert final task states ─────────────────────────────────────────────
    const t1 = readTask(workspaceRoot, "T1");
    const t2 = readTask(workspaceRoot, "T2");
    const t3 = readTask(workspaceRoot, "T3");

    // T1 → in_review (equivalent to "PR opened" in production)
    expect(t1.status).toBe("in_review");
    expect(t1.blocked_reason).toBeNull();

    // T2 → blocked/budget_exceeded
    expect(t2.status).toBe("blocked");
    expect(t2.blocked_reason).toBe("budget_exceeded");

    // T3 → ready (never touched — no orphan in_progress)
    expect(t3.status).toBe("ready");
    expect(t3.blocked_reason).toBeNull();

    // No task left in in_progress (orphan guard)
    const allStatuses = [t1.status, t2.status, t3.status];
    expect(allStatuses).not.toContain("in_progress");
  });

  /**
   * Bootstrap integration: validate agent.yaml, clone watched workspace and
   * workflow repo via real bare git repos (file:// transport, skipGit: false).
   *
   * Both the workspace and the workflow repo are created as local bare repos
   * so no network access or real GitHub is needed.
   */
  it("bootstrap: clones a fresh workspace and emits bootstrap_ready", async () => {
    // ── Bare repos ──────────────────────────────────────────────────────────
    const workspaceBareDir = join(tmpDir(), "test-workspace.git");
    const workspaceBareUrl = initBareRepo(workspaceBareDir);
    // Derived local name: extractRepoName("file:///…/test-workspace.git") → "test-workspace"
    const expectedWorkspaceName = "test-workspace";

    const workflowBareDir = join(tmpDir(), "agent-workflow.git");
    const workflowBareUrl = initBareRepo(workflowBareDir);

    // Seed the workspace bare repo with a minimal workspace.yaml
    seedRepo(workspaceBareUrl, {
      "workspace.yaml": yamlStringify({
        workspace_id: "test",
        management_repo: "mgmt",
        repos: [{ id: "mgmt", github: workspaceBareUrl }],
      }),
    });

    // Seed the workflow bare repo with a technical_skills/ directory
    seedRepo(workflowBareUrl, {
      "technical_skills/.keep": "",
    });

    // ── agent.yaml ──────────────────────────────────────────────────────────
    const agentYamlDir = tmpDir();
    const agentYamlPath = join(agentYamlDir, "agent.yaml");
    writeFileSync(
      agentYamlPath,
      yamlStringify({
        watches: [workspaceBareUrl],    // file:// URL — no real GitHub needed
        enabled: true,
        jitter_max_seconds: 0,
        budget: {
          max_tokens_per_task: 50_000,
          max_iterations: 10,
          suggested_next_step_max_tokens: 500,
        },
        log_sink: { enabled: false },
      }),
      "utf-8",
    );

    // ── Paths ────────────────────────────────────────────────────────────────
    const workspacesRoot = tmpDir();
    const workflowLocalPath = join(tmpDir(), "workflow-clone");

    // ── Run bootstrap ─────────────────────────────────────────────────────
    const events: Array<{ type: string }> = [];
    const result = await runBootstrap({
      agentYamlPath,
      workflowLocalPath,
      workflowUrl: workflowBareUrl,
      workspacesRoot,
      skipGit: false,
      emit: (e) => events.push(e as { type: string }),
    });

    expect(result.exitCode).toBe(0);
    expect(events.some((e) => e.type === "bootstrap_started")).toBe(true);
    expect(events.some((e) => e.type === "bootstrap_ready")).toBe(true);

    // Workspace was cloned to workspacesRoot/test-workspace
    const clonedWorkspace = join(workspacesRoot, expectedWorkspaceName);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(clonedWorkspace, ".git"))).toBe(true);
    expect(existsSync(join(clonedWorkspace, "workspace.yaml"))).toBe(true);
  });
});
