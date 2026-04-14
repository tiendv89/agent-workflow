/**
 * Tests for T8: Container-start bootstrap (bootstrap.ts).
 *
 * Test structure:
 *   1. Unit tests (skipGit: true) — logic without real git
 *      a. Broken agent.yaml → exit 2 + actionable bootstrap_failed event
 *      b. Kill switch disabled → exit 0, bootstrap_ready, no git ops
 *      c. Valid config → bootstrap_started, workspace events, bootstrap_ready
 *      d. Skill reference audit — missing slug emits skill_reference_audit, succeeds
 *      e. All referenced skills present → no audit events
 *   2. Integration tests (real local git repos with file:// remote)
 *      a. Fresh container (empty dir) → clones cleanly, exits 0
 *      b. Pre-populated dirty workspace → reset to origin, exits 0
 *      c. Broken remote URL → exits 3 + bootstrap_failed event
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  runBootstrap,
  EXIT_SUCCESS,
  EXIT_VALIDATION_FAILED,
  EXIT_GIT_FAILED,
  type BootstrapEvent,
  type BootstrapOptions,
} from "../src/bootstrap/bootstrap.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_AGENT_YAML = `
watches:
  - git@github.com:org/workspace.git
enabled: true
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

const INVALID_AGENT_YAML = `
watches: []
enabled: true
# missing: jitter_max_seconds, budget, log_sink
`.trim();

const DISABLED_AGENT_YAML = `
watches:
  - git@github.com:org/workspace.git
enabled: false
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function trackDir(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

function makeTempDir(): string {
  return trackDir(mkdtempSync(join(tmpdir(), "bootstrap-test-")));
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

/** Write an agent.yaml file and return its path. */
function writeAgentYaml(dir: string, content: string): string {
  const path = join(dir, "agent.yaml");
  writeFileSync(path, content, "utf-8");
  return path;
}

/** Collect all events emitted during a bootstrap run. */
function collectEvents(): {
  events: BootstrapEvent[];
  emit: (e: BootstrapEvent) => void;
} {
  const events: BootstrapEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

/** Write a tasks.md with a given required skills block for task T1. */
function writeTasksMd(dir: string, featureId: string, skills: string[]): void {
  const featureDir = join(dir, "docs", "features", featureId);
  mkdirSync(featureDir, { recursive: true });
  const skillLines = skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "(empty — no skills)";
  const content = `# Tasks\n\n## T1 — Example task\n\n### Required skills\n${skillLines}\n`;
  writeFileSync(join(featureDir, "tasks.md"), content, "utf-8");
}

/** Create a minimal technical_skills directory with the given slug directories. */
function writeTechnicalSkills(workflowDir: string, slugs: string[]): void {
  for (const slug of slugs) {
    mkdirSync(join(workflowDir, "technical_skills", slug), { recursive: true });
    writeFileSync(join(workflowDir, "technical_skills", slug, "SKILL.md"), `# ${slug}\n`, "utf-8");
  }
}

// ── Unit tests (skipGit: true) ────────────────────────────────────────────────

describe("bootstrap — unit tests (skipGit)", () => {
  describe("agent.yaml validation", () => {
    it("exits 2 and emits bootstrap_failed when agent.yaml is invalid", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, INVALID_AGENT_YAML);
      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: join(tmpDir, "workflow"),
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_VALIDATION_FAILED);
      expect(result.config).toBeUndefined();

      const failedEvent = events.find((e) => e.type === "bootstrap_failed");
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.type).toBe("bootstrap_failed");
      // Should point at offending fields
      expect((failedEvent as { type: string; details: string }).details).toMatch(/jitter_max_seconds|budget|log_sink/);
    });

    it("exits 2 and emits bootstrap_failed when agent.yaml file is missing", async () => {
      const tmpDir = makeTempDir();
      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath: join(tmpDir, "nonexistent-agent.yaml"),
        workflowLocalPath: join(tmpDir, "workflow"),
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_VALIDATION_FAILED);
      const failedEvent = events.find((e) => e.type === "bootstrap_failed");
      expect(failedEvent).toBeDefined();
    });

    it("exits 2 and emits bootstrap_failed when agent.yaml is malformed YAML", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, "{ not: valid: yaml: !!!");
      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: join(tmpDir, "workflow"),
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_VALIDATION_FAILED);
      const failedEvent = events.find((e) => e.type === "bootstrap_failed");
      expect(failedEvent).toBeDefined();
    });
  });

  describe("kill switch", () => {
    it("exits 0 and emits bootstrap_ready immediately when enabled: false", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, DISABLED_AGENT_YAML);
      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: join(tmpDir, "workflow"),
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.config?.enabled).toBe(false);

      // Should emit bootstrap_ready but NOT bootstrap_started (no git ops happened)
      const types = events.map((e) => e.type);
      expect(types).toContain("bootstrap_ready");
      expect(types).not.toContain("bootstrap_started");
      expect(types).not.toContain("workspace_cloned");
      expect(types).not.toContain("workspace_pulled");
    });
  });

  describe("happy path (skipGit)", () => {
    it("emits bootstrap_started and bootstrap_ready, exits 0", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);
      const workflowDir = join(tmpDir, "workflow");
      mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });
      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(result.config?.watches).toEqual(["git@github.com:org/workspace.git"]);

      const types = events.map((e) => e.type);
      expect(types).toContain("bootstrap_started");
      expect(types).toContain("bootstrap_ready");
      expect(types).not.toContain("bootstrap_failed");
    });

    it("bootstrap_started event includes watches and agent_yaml_path", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);
      const workflowDir = join(tmpDir, "workflow");
      mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });
      const { events, emit } = collectEvents();

      await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        skipGit: true,
        emit,
      });

      const started = events.find((e) => e.type === "bootstrap_started") as {
        type: string;
        agent_yaml_path: string;
        watches: string[];
      } | undefined;

      expect(started).toBeDefined();
      expect(started!.agent_yaml_path).toBe(agentYamlPath);
      expect(started!.watches).toEqual(["git@github.com:org/workspace.git"]);
    });
  });

  describe("skill reference audit", () => {
    it("emits skill_reference_audit for missing slugs and still exits 0", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);

      // Workspace seeded with a feature that requires a skill that doesn't exist
      const workspaceDir = join(tmpDir, "workspaces", "workspace");
      writeTasksMd(workspaceDir, "my-feature", ["typescript-best-practices", "nonexistent-skill"]);

      // Workflow repo has only typescript-best-practices
      const workflowDir = join(tmpDir, "workflow");
      writeTechnicalSkills(workflowDir, ["typescript-best-practices"]);

      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        workspaceLocalPaths: new Map([
          ["git@github.com:org/workspace.git", workspaceDir],
        ]),
        skipGit: true,
        emit,
      });

      // Non-fatal — bootstrap still succeeds
      expect(result.exitCode).toBe(EXIT_SUCCESS);

      const auditEvents = events.filter((e) => e.type === "skill_reference_audit") as Array<{
        type: string;
        workspace_id: string;
        feature_id: string;
        task_id: string;
        missing_slug: string;
      }>;

      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]!.missing_slug).toBe("nonexistent-skill");
      expect(auditEvents[0]!.feature_id).toBe("my-feature");
      expect(auditEvents[0]!.task_id).toBe("T1");
      // workspace_id is derived from the SSH URL's repo name
      expect(auditEvents[0]!.workspace_id).toBe("workspace");
    });

    it("emits no skill_reference_audit events when all referenced skills exist", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);

      const workspaceDir = join(tmpDir, "workspaces", "workspace");
      writeTasksMd(workspaceDir, "my-feature", ["typescript-best-practices"]);

      const workflowDir = join(tmpDir, "workflow");
      writeTechnicalSkills(workflowDir, ["typescript-best-practices"]);

      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        workspaceLocalPaths: new Map([
          ["git@github.com:org/workspace.git", workspaceDir],
        ]),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      const auditEvents = events.filter((e) => e.type === "skill_reference_audit");
      expect(auditEvents).toHaveLength(0);
    });

    it("emits multiple audit events when multiple tasks have missing skills", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);

      const workspaceDir = join(tmpDir, "workspaces", "workspace");
      // Two features, each with a missing skill
      writeTasksMd(workspaceDir, "feature-a", ["missing-skill-a"]);
      writeTasksMd(workspaceDir, "feature-b", ["missing-skill-b"]);

      const workflowDir = join(tmpDir, "workflow");
      mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        workspaceLocalPaths: new Map([
          ["git@github.com:org/workspace.git", workspaceDir],
        ]),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      const auditEvents = events.filter((e) => e.type === "skill_reference_audit");
      expect(auditEvents).toHaveLength(2);
    });

    it("handles workspace with no docs/features directory gracefully", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);

      // Workspace with no docs/features at all
      const workspaceDir = join(tmpDir, "workspaces", "workspace");
      mkdirSync(workspaceDir, { recursive: true });

      const workflowDir = join(tmpDir, "workflow");
      mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        workspaceLocalPaths: new Map([
          ["git@github.com:org/workspace.git", workspaceDir],
        ]),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      const auditEvents = events.filter((e) => e.type === "skill_reference_audit");
      expect(auditEvents).toHaveLength(0);
    });

    it("handles tasks.md with no required skills without audit events", async () => {
      const tmpDir = makeTempDir();
      const agentYamlPath = writeAgentYaml(tmpDir, VALID_AGENT_YAML);

      const workspaceDir = join(tmpDir, "workspaces", "workspace");
      writeTasksMd(workspaceDir, "my-feature", []); // no required skills

      const workflowDir = join(tmpDir, "workflow");
      mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

      const { events, emit } = collectEvents();

      const result = await runBootstrap({
        agentYamlPath,
        workflowLocalPath: workflowDir,
        workspacesRoot: join(tmpDir, "workspaces"),
        workspaceLocalPaths: new Map([
          ["git@github.com:org/workspace.git", workspaceDir],
        ]),
        skipGit: true,
        emit,
      });

      expect(result.exitCode).toBe(EXIT_SUCCESS);
      const auditEvents = events.filter((e) => e.type === "skill_reference_audit");
      expect(auditEvents).toHaveLength(0);
    });
  });
});

// ── Integration tests (real git repos) ───────────────────────────────────────

describe("bootstrap — integration tests (real git)", () => {
  const GIT_ENV = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };

  /** Create a local bare repo with main as default branch. Returns file:// URL. */
  function createBareRepo(dir: string, name: string): { bareUrl: string; barePath: string } {
    const barePath = join(dir, `${name}.git`);
    mkdirSync(barePath, { recursive: true });
    execSync(`git -c init.defaultBranch=main init --bare "${barePath}"`, { stdio: "pipe" });
    return { bareUrl: `file://${barePath}`, barePath };
  }

  /** Seed a bare repo with a single commit containing the given files. */
  function seedRepo(
    dir: string,
    bareUrl: string,
    files: Record<string, string>,
  ): void {
    const workDir = join(dir, "seed-work");
    mkdirSync(workDir, { recursive: true });
    execSync(`git clone "${bareUrl}" "${workDir}"`, { stdio: "pipe" });
    execSync(`git -C "${workDir}" config user.email "seed@test.com"`, { stdio: "pipe" });
    execSync(`git -C "${workDir}" config user.name "Seed"`, { stdio: "pipe" });
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(workDir, relPath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }
    execSync(`git -C "${workDir}" add .`, { stdio: "pipe" });
    execSync(
      `git -C "${workDir}" commit -m "seed"`,
      { stdio: "pipe", env: { ...process.env, ...GIT_ENV } },
    );
    execSync(`git -C "${workDir}" push -u origin main`, { stdio: "pipe" });
    rmSync(workDir, { recursive: true, force: true });
  }

  it("clones fresh workspace using file:// URL and exits 0", async () => {
    const tmpDir = makeTempDir();

    const { bareUrl } = createBareRepo(tmpDir, "workspace");
    seedRepo(tmpDir, bareUrl, {
      "README.md": "# test workspace\n",
    });

    const agentYaml = `
watches:
  - ${bareUrl}
enabled: true
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

    const workflowDir = join(tmpDir, "workflow");
    mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

    const agentYamlPath = writeAgentYaml(tmpDir, agentYaml);
    const workspacesRoot = join(tmpDir, "workspaces");
    mkdirSync(workspacesRoot, { recursive: true });
    // Bootstrap derives local path as <workspacesRoot>/<repo-name> where repo-name
    // strips the .git suffix: file:///path/workspace.git → "workspace"
    const cloneTarget = join(workspacesRoot, "workspace");

    const { events, emit } = collectEvents();

    const result = await runBootstrap({
      agentYamlPath,
      workflowLocalPath: workflowDir,
      workspacesRoot,
      emit,
    });

    expect(result.exitCode).toBe(EXIT_SUCCESS);
    const types = events.map((e) => e.type);
    expect(types).toContain("workspace_cloned");
    expect(types).toContain("bootstrap_ready");

    // Verify the clone actually happened at the derived path
    const readmeExists = existsSync(join(cloneTarget, "README.md"));
    expect(readmeExists).toBe(true);
  }, 15_000);

  it("resets a dirty workspace to origin state", async () => {
    const tmpDir = makeTempDir();

    const { bareUrl } = createBareRepo(tmpDir, "workspace");
    seedRepo(tmpDir, bareUrl, { "README.md": "# original\n" });

    // Pre-clone the workspace to the path bootstrap will derive from the URL.
    // file:///path/workspace.git → repo-name "workspace" → cloneTarget
    const workspacesRoot = join(tmpDir, "workspaces");
    mkdirSync(workspacesRoot, { recursive: true });
    const cloneTarget = join(workspacesRoot, "workspace");
    execSync(`git clone "${bareUrl}" "${cloneTarget}"`, { stdio: "pipe" });
    execSync(`git -C "${cloneTarget}" config user.email "test@test.com"`, { stdio: "pipe" });
    execSync(`git -C "${cloneTarget}" config user.name "Test"`, { stdio: "pipe" });

    // Dirty the workspace: commit a local change that isn't on origin
    writeFileSync(join(cloneTarget, "dirty.txt"), "dirty content\n", "utf-8");
    execSync(`git -C "${cloneTarget}" add dirty.txt`, { stdio: "pipe" });
    execSync(
      `git -C "${cloneTarget}" commit -m "dirty local commit"`,
      { stdio: "pipe", env: { ...process.env, ...GIT_ENV } },
    );

    const agentYaml = `
watches:
  - ${bareUrl}
enabled: true
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

    const workflowDir = join(tmpDir, "workflow");
    mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

    const agentYamlPath = writeAgentYaml(tmpDir, agentYaml);

    const { events, emit } = collectEvents();

    const result = await runBootstrap({
      agentYamlPath,
      workflowLocalPath: workflowDir,
      workspacesRoot,
      emit,
    });

    expect(result.exitCode).toBe(EXIT_SUCCESS);

    const types = events.map((e) => e.type);
    expect(types).toContain("workspace_pulled");
    expect(types).toContain("bootstrap_ready");

    // Dirty file should be gone — reset --hard origin/main removed it
    const dirtyExists = existsSync(join(cloneTarget, "dirty.txt"));
    expect(dirtyExists).toBe(false);

    // Original file should still be present
    const readmeExists = existsSync(join(cloneTarget, "README.md"));
    expect(readmeExists).toBe(true);
  }, 15_000);

  it("exits 3 and emits bootstrap_failed when git clone fails", async () => {
    const tmpDir = makeTempDir();

    const agentYaml = `
watches:
  - file:///nonexistent-repo-that-does-not-exist.git
enabled: true
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

    const workflowDir = join(tmpDir, "workflow");
    mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

    const agentYamlPath = writeAgentYaml(tmpDir, agentYaml);

    const { events, emit } = collectEvents();

    const result = await runBootstrap({
      agentYamlPath,
      workflowLocalPath: workflowDir,
      workspacesRoot: join(tmpDir, "workspaces"),
      emit,
    });

    expect(result.exitCode).toBe(EXIT_GIT_FAILED);

    const failedEvent = events.find((e) => e.type === "bootstrap_failed") as {
      type: string;
      reason: string;
    } | undefined;

    expect(failedEvent).toBeDefined();
    expect(failedEvent!.reason).toBe("git_workspace_sync_failed");
  }, 15_000);

  it("skill reference audit with real filesystem after clone", async () => {
    const tmpDir = makeTempDir();

    // Workspace contains a tasks.md with a missing skill
    const { bareUrl } = createBareRepo(tmpDir, "workspace");
    const tasksContent = `# Tasks\n\n## T1 — Example task\n\n### Required skills\n- nonexistent-skill\n`;
    seedRepo(tmpDir, bareUrl, {
      "docs/features/my-feature/tasks.md": tasksContent,
    });

    const agentYaml = `
watches:
  - ${bareUrl}
enabled: true
jitter_max_seconds: 1
budget:
  max_tokens_per_task: 50000
  max_iterations: 20
  suggested_next_step_max_tokens: 1000
log_sink:
  enabled: true
`.trim();

    // Workflow has NO technical_skills directories
    const workflowDir = join(tmpDir, "workflow");
    mkdirSync(join(workflowDir, "technical_skills"), { recursive: true });

    const agentYamlPath = writeAgentYaml(tmpDir, agentYaml);

    const { events, emit } = collectEvents();

    const result = await runBootstrap({
      agentYamlPath,
      workflowLocalPath: workflowDir,
      workspacesRoot: join(tmpDir, "workspaces"),
      emit,
    });

    // Audit is non-fatal — bootstrap succeeds
    expect(result.exitCode).toBe(EXIT_SUCCESS);

    const auditEvents = events.filter((e) => e.type === "skill_reference_audit") as Array<{
      type: string;
      missing_slug: string;
      feature_id: string;
      task_id: string;
    }>;

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.missing_slug).toBe("nonexistent-skill");
    expect(auditEvents[0]!.feature_id).toBe("my-feature");
    expect(auditEvents[0]!.task_id).toBe("T1");
  }, 15_000);
});
