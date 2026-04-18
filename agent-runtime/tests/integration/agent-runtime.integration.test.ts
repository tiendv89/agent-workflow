/**
 * T11 / T6: End-to-end integration tests for the agent-runtime activation loop.
 *
 * Tests the full bootstrap → eligibility → claim → run-claude pipeline
 * against local bare-git repos (no Docker, no external API).
 *
 * Scenario coverage:
 *   eligibility  : task with missing skill is filtered out at eligibility stage
 *   bootstrap    : clone a workspace + workflow repo via file:// transport
 *   runClaude    : stub claude binary writes in_review to task YAML → outcome in_review
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";

import { runBootstrap } from "../../src/bootstrap/bootstrap.js";
import { findEligibleTasks } from "../../src/eligibility/match.js";
import type { EligibleTask } from "../../src/eligibility/match.js";
import { claimTask } from "../../src/claim/claim-task.js";
import { runClaude } from "../../src/loop/run-claude.js";
import type { Task } from "../../src/types/task.js";
import type { AgentConfig } from "../../src/config/validate-agent-yaml.js";

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

const BASE_AGENT_CONFIG: AgentConfig = {
  watches: [WORKSPACE_SSH_URL],
  enabled: true,
  jitter_max_seconds: 0,
  budget: {
    max_tokens_per_task: 5_000,
    max_iterations: 10,
  },
  log_sink: { enabled: false },
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
  requiredSkill?: string;
  dependsOn?: string[];
}

function buildWorkspace(
  root: string,
  tasks: TaskSpec[],
  existingSkills: string[],
): string {
  writeFileSync(
    join(root, "workspace.yaml"),
    yamlStringify({
      workspace_id: "test-workspace",
      management_repo: MGMT_REPO_ID,
      repos: [
        { id: MGMT_REPO_ID, github: WORKSPACE_SSH_URL },
        { id: IMPL_REPO_ID, github: "git@github.com:org/impl-repo.git" },
      ],
    }),
    "utf-8",
  );

  const featureDir = join(root, "docs", "features", FEATURE_ID);
  const tasksDir = join(featureDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

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

  for (const spec of tasks) {
    const task: Task = {
      id: spec.id,
      title: `Test task ${spec.id}`,
      repo: IMPL_REPO_ID,
      status: spec.status ?? "ready",
      depends_on: spec.dependsOn ?? [],
      blocked_reason: null,
      blocked_context: null,
      branch: `feature/${FEATURE_ID}-${spec.id}`,
      execution: {
        actor_type: "agent",
        last_updated_by: null,
        last_updated_at: null,
      },
      pr: { url: "", status: "not_created" },
      workspace_pr: null,
      log: [],
    };
    writeFileSync(join(tasksDir, `${spec.id}.yaml`), yamlStringify(task), "utf-8");
  }

  return root;
}

function buildWorkflowRepo(root: string, skills: string[]): string {
  for (const slug of skills) {
    const skillDir = join(root, "technical_skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# ${slug}\n\nTest skill.\n`, "utf-8");
  }
  return root;
}

function readTask(workspaceRoot: string, taskId: string): Task {
  return parseYaml(
    readFileSync(
      join(workspaceRoot, "docs", "features", FEATURE_ID, "tasks", `${taskId}.yaml`),
      "utf-8",
    ),
  ) as Task;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent-runtime integration", () => {
  /**
   * Eligibility filter: a task whose required skill is absent from
   * technical_skills/ must not appear in findEligibleTasks output.
   */
  it("skips task with missing skill at eligibility stage", () => {
    const root = tmpDir();
    const workspaceRoot = buildWorkspace(root, [
      { id: "T1", requiredSkill: "missing-skill" },
    ], []);
    const workflowRoot = buildWorkflowRepo(tmpDir(), []);

    const agentConfig: AgentConfig = {
      ...BASE_AGENT_CONFIG,
      watches: [WORKSPACE_SSH_URL],
    };

    const events: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (msg: string) => { events.push(msg); };
    let eligible: EligibleTask[];
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

    const task = readTask(workspaceRoot, "T1");
    expect(task.status).toBe("ready");
  });

  /**
   * runClaude smoke test: stub claude binary writes status: in_review to the
   * task YAML and exits 0. runClaude must return outcome: in_review.
   *
   * The stub is placed in a temp bin dir that is prepended to PATH, so
   * spawnSync("claude", ...) resolves to it without any production binary.
   */
  it("runClaude: stub claude writing in_review → outcome in_review", async () => {
    const workspaceRoot = buildWorkspace(tmpDir(), [
      { id: "T1", status: "ready" },
    ], []);
    const taskRepoRoot = tmpDir();

    // ── Claim the task so it is in_progress ──────────────────────────────────
    const claim = await claimTask({
      workspaceRoot,
      taskId: "T1",
      featureId: FEATURE_ID,
      gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
      gitAuthorName: GIT_ENV.GIT_AUTHOR_NAME,
      skipGit: true,
      skipJitter: true,
    });
    expect(claim.won).toBe(true);

    // ── Stub claude binary ───────────────────────────────────────────────────
    // Reads WORKSPACE_ROOT and FEATURE_ID from the agentContext (-p arg),
    // then writes status: in_review to the task YAML directly.
    const binDir = tmpDir();
    const taskYamlPath = join(
      workspaceRoot, "docs", "features", FEATURE_ID, "tasks", "T1.yaml",
    );
    const stubScript = [
      "#!/bin/sh",
      // Read current YAML and overwrite with in_review status
      `python3 -c "`,
      `import sys, re`,
      `content = open('${taskYamlPath}').read()`,
      `content = re.sub(r'status: in_progress', 'status: in_review', content)`,
      `open('${taskYamlPath}', 'w').write(content)`,
      `"`,
      "exit 0",
    ].join("\n");
    const stubPath = join(binDir, "claude");
    writeFileSync(stubPath, stubScript, "utf-8");
    chmodSync(stubPath, 0o755);

    // ── Run with stub in PATH ─────────────────────────────────────────────────
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    let result;
    try {
      result = await runClaude({
        taskId: "T1",
        featureId: FEATURE_ID,
        workspaceRoot,
        taskRepoRoot,
        agentContext: "stub test context",
        maxTurns: 10,
        maxTokens: 5_000,
        sshKeyPath: undefined,
        gitAuthorEmail: GIT_ENV.GIT_AUTHOR_EMAIL,
        taskBranch: `feature/${FEATURE_ID}-T1`,
        logSinkEnabled: false,
      });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(result.outcome).toBe("in_review");
    const task = readTask(workspaceRoot, "T1");
    expect(task.status).toBe("in_review");
  });

  /**
   * Bootstrap integration: validate agent.yaml, clone watched workspace and
   * workflow repo via real bare git repos (file:// transport, skipGit: false).
   */
  it("bootstrap: clones a fresh workspace and emits bootstrap_ready", async () => {
    const workspaceBareDir = join(tmpDir(), "test-workspace.git");
    const workspaceBareUrl = initBareRepo(workspaceBareDir);
    const expectedWorkspaceName = "test-workspace";

    const workflowBareDir = join(tmpDir(), "agent-workflow.git");
    const workflowBareUrl = initBareRepo(workflowBareDir);

    seedRepo(workspaceBareUrl, {
      "workspace.yaml": yamlStringify({
        workspace_id: "test",
        management_repo: "mgmt",
        repos: [{ id: "mgmt", github: workspaceBareUrl }],
      }),
    });

    seedRepo(workflowBareUrl, {
      "technical_skills/.keep": "",
    });

    const agentYamlDir = tmpDir();
    const agentYamlPath = join(agentYamlDir, "agent.yaml");
    writeFileSync(
      agentYamlPath,
      yamlStringify({
        watches: [workspaceBareUrl],
        enabled: true,
        jitter_max_seconds: 0,
        budget: {
          max_tokens_per_task: 50_000,
          max_iterations: 10,
        },
        log_sink: { enabled: false },
      }),
      "utf-8",
    );

    const workspacesRoot = tmpDir();
    const workflowLocalPath = join(tmpDir(), "workflow-clone");

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

    const clonedWorkspace = join(workspacesRoot, expectedWorkspaceName);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(clonedWorkspace, ".git"))).toBe(true);
    expect(existsSync(join(clonedWorkspace, "workspace.yaml"))).toBe(true);
  });
});
