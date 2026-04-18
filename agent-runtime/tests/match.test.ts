import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as toYaml } from "yaml";
import { findEligibleTasks } from "../src/eligibility/match.js";
import type { AgentConfig } from "../src/config/validate-agent-yaml.js";
import type { Task } from "../src/types/task.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `t5-match-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Minimal valid AgentConfig. */
function makeAgentConfig(watches: string[]): AgentConfig {
  return {
    watches,
    enabled: true,
    jitter_max_seconds: 0,
    budget: {
      max_tokens_per_task: 200000,
      max_iterations: 3,
    },
    log_sink: { enabled: false },
  };
}

/** Build a workspace directory tree for testing. */
function buildWorkspace(opts: {
  workspaceRoot: string;
  managementRepoId?: string;
  managementGithub?: string;
  extraRepos?: Array<{ id: string; github: string }>;
  features: Array<{
    featureId: string;
    tasksMd?: string;
    tasks: Partial<Task>[];
  }>;
}): void {
  const {
    workspaceRoot,
    managementRepoId = "mgmt-repo",
    managementGithub = "git@github.com:myorg/workspace.git",
    extraRepos = [],
    features,
  } = opts;

  // workspace.yaml
  const workspaceYaml = {
    workspace_id: "test",
    management_repo: managementRepoId,
    repos: [
      { id: managementRepoId, github: managementGithub, base_branch: "main" },
      { id: "impl-repo", github: "git@github.com:myorg/impl.git", base_branch: "main" },
      ...extraRepos,
    ],
  };
  writeFileSync(join(workspaceRoot, "workspace.yaml"), toYaml(workspaceYaml));

  // Features
  for (const feature of features) {
    const featurePath = join(workspaceRoot, "docs", "features", feature.featureId);
    const tasksDir = join(featurePath, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    if (feature.tasksMd !== undefined) {
      writeFileSync(join(featurePath, "tasks.md"), feature.tasksMd);
    }

    for (const partialTask of feature.tasks) {
      const task: Task = {
        id: "T1",
        title: "Default task",
        repo: "impl-repo",
        status: "ready",
        depends_on: [],
        blocked_reason: null,
        branch: "feature/test-T1",
        execution: {
          actor_type: "agent",
          last_updated_by: null,
          last_updated_at: null,
        },
        pr: { url: "", status: "not_created" },
        log: [],
        ...partialTask,
      };
      writeFileSync(join(tasksDir, `${task.id}.yaml`), toYaml(task));
    }
  }
}

/** Build a workflow root with the given skill slugs available. */
function buildWorkflowRoot(workflowRoot: string, skillSlugs: string[]): void {
  for (const slug of skillSlugs) {
    const skillDir = join(workflowRoot, "technical_skills", slug);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `# Skill: ${slug}\n`);
  }
}

/** Minimal tasks.md with ### Required skills for a given task. */
function tasksMdWithSkills(taskId: string, skills: string[]): string {
  const bulletList = skills.length > 0 ? skills.map((s) => `- ${s}`).join("\n") : "";
  return `## ${taskId} — Test task\n\n### Required skills\n${bulletList}\n`;
}

/** Capture stdout lines. */
function captureStdout(fn: () => unknown): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
    lines.push(msg);
  });
  fn();
  spy.mockRestore();
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findEligibleTasks", () => {
  describe("watches match", () => {
    it("returns empty array when workspace is not in agent.watches", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:DIFFERENT/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toEqual([]);
    });

    it("returns tasks when workspace IS in agent.watches", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      buildWorkflowRoot(workflowRoot, ["typescript-best-practices"]);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd: tasksMdWithSkills("T1", ["typescript-best-practices"]),
            tasks: [{ id: "T1", status: "ready", repo: "impl-repo" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
      expect(result[0]!.task.id).toBe("T1");
    });
  });

  describe("status filtering", () => {
    it("excludes tasks with status other than ready", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "todo" },
              { id: "T2", status: "in_progress" },
              { id: "T3", status: "done" },
              { id: "T4", status: "blocked" },
              { id: "T5", status: "in_review" },
              { id: "T6", status: "cancelled" },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(0);
    });

    it("includes only ready tasks", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "done" },
              { id: "T2", status: "ready" },
              { id: "T3", status: "in_progress" },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
      expect(result[0]!.task.id).toBe("T2");
    });
  });

  describe("dependency resolution", () => {
    it("excludes ready tasks whose depends_on are not all done", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "in_progress" },          // not done
              { id: "T2", status: "ready", depends_on: ["T1"] }, // blocked by T1
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(0);
    });

    it("includes ready task when all depends_on are done", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "done" },
              { id: "T2", status: "done" },
              { id: "T3", status: "ready", depends_on: ["T1", "T2"] },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
      expect(result[0]!.task.id).toBe("T3");
    });

    it("includes task with empty depends_on", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [{ id: "T1", status: "ready", depends_on: [] }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
    });

    it("handles partial dependency satisfaction correctly", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "done" },
              { id: "T2", status: "in_progress" }, // not done yet
              { id: "T3", status: "ready", depends_on: ["T1"] }, // T1 done ✓
              { id: "T4", status: "ready", depends_on: ["T1", "T2"] }, // T2 not done ✗
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
      expect(result[0]!.task.id).toBe("T3");
    });
  });

  describe("repo mismatch", () => {
    it("excludes tasks whose repo is not in the workspace repos list", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "ready", repo: "some-other-repo-not-in-workspace" },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(0);
    });

    it("includes tasks whose repo is in the workspace repos list", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T1", status: "ready", repo: "impl-repo" }, // impl-repo is in workspace
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
    });
  });

  describe("skill availability", () => {
    it("excludes tasks with missing required skills and emits task_skipped_missing_skill", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      // Create workflow root but NOT the missing skill
      mkdirSync(join(workflowRoot, "technical_skills"), { recursive: true });

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd: tasksMdWithSkills("T1", ["typescript-best-practices"]),
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const lines = captureStdout(() => {
        const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
        expect(result).toHaveLength(0);
      });

      const events = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "task_skipped_missing_skill");
      expect(events).toHaveLength(1);
      expect(events[0].taskId).toBe("T1");
      expect(events[0].featureId).toBe("feat-a");
      expect(events[0].missingSkills).toContain("typescript-best-practices");
    });

    it("includes tasks when all required skills are available", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      buildWorkflowRoot(workflowRoot, ["typescript-best-practices", "go-best-practices"]);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd:
              `## T1 — Task\n\n### Required skills\n- typescript-best-practices\n- go-best-practices\n`,
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
    });

    it("emits missing-skill for each skill that is absent", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      // Only provide one of two required skills
      buildWorkflowRoot(workflowRoot, ["typescript-best-practices"]);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd: `## T1 — Task\n\n### Required skills\n- typescript-best-practices\n- go-best-practices\n`,
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const lines = captureStdout(() => {
        const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
        expect(result).toHaveLength(0);
      });

      const events = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "task_skipped_missing_skill");
      expect(events).toHaveLength(1);
      expect(events[0].missingSkills).toEqual(["go-best-practices"]);
    });

    it("includes tasks with no required skills (empty section)", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(join(workflowRoot, "technical_skills"), { recursive: true });

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd: `## T1 — Task\n\n### Required skills\n\n### Subtasks\n`,
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
    });

    it("includes tasks not mentioned in tasks.md (treated as no skills required)", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(join(workflowRoot, "technical_skills"), { recursive: true });

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            // No tasks.md
            tasks: [{ id: "T1", status: "ready" }],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toHaveLength(1);
    });
  });

  describe("deterministic ordering", () => {
    it("returns tasks sorted by numeric task ID ascending", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasks: [
              { id: "T10", status: "ready" },
              { id: "T2", status: "ready" },
              { id: "T1", status: "ready" },
              { id: "T20", status: "ready" },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result.map((t) => t.task.id)).toEqual(["T1", "T2", "T10", "T20"]);
    });
  });

  describe("multi-feature workspace", () => {
    it("returns eligible tasks from multiple features independently", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feature-alpha",
            tasks: [
              { id: "T1", status: "done" },
              { id: "T2", status: "ready", depends_on: ["T1"] },
            ],
          },
          {
            featureId: "feature-beta",
            tasks: [
              { id: "T1", status: "in_progress" }, // same ID, different feature
              { id: "T2", status: "ready", depends_on: ["T1"] }, // T1 not done in this feature
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      // Only feature-alpha's T2 is eligible (feature-beta's T1 is in_progress)
      expect(result).toHaveLength(1);
      expect(result[0]!.task.id).toBe("T2");
    });

    it("uses per-feature done-set (T1 done in alpha does not satisfy T1 dep in beta)", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "alpha",
            tasks: [{ id: "T1", status: "done" }],
          },
          {
            featureId: "beta",
            tasks: [
              // T1 not done in beta; T2 depends on it → not eligible
              { id: "T1", status: "ready" },
              { id: "T2", status: "ready", depends_on: ["T1"] },
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);

      const ids = result.map((t) => t.task.id);
      // beta/T1 is eligible (no deps), beta/T2 is not (T1 not done in beta)
      // alpha/T1 is done, not ready → excluded
      expect(ids).toContain("T1"); // beta's T1
      expect(result).toHaveLength(1);
    });
  });

  describe("combined filter correctness", () => {
    it("applies all filters together — only task passing all criteria is returned", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      buildWorkflowRoot(workflowRoot, ["typescript-best-practices"]);

      const tasksMd = [
        `## T1 — Has missing skill\n\n### Required skills\n- missing-skill\n`,
        `## T2 — Wrong repo\n\n### Required skills\n- typescript-best-practices\n`,
        `## T3 — Unmet dep\n\n### Required skills\n- typescript-best-practices\n`,
        `## T4 — All good\n\n### Required skills\n- typescript-best-practices\n`,
      ].join("\n");

      buildWorkspace({
        workspaceRoot,
        managementGithub: "git@github.com:myorg/workspace.git",
        features: [
          {
            featureId: "feat-a",
            tasksMd,
            tasks: [
              { id: "T1", status: "ready", repo: "impl-repo" },                     // missing skill
              { id: "T2", status: "ready", repo: "not-in-workspace" },              // wrong repo
              { id: "T3", status: "ready", repo: "impl-repo", depends_on: ["T99"] }, // unmet dep
              { id: "T4", status: "ready", repo: "impl-repo", depends_on: [] },     // all good
            ],
          },
        ],
      });

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const lines = captureStdout(() => {
        const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
        expect(result).toHaveLength(1);
        expect(result[0]!.task.id).toBe("T4");
      });

      // T1 should produce a missing-skill event
      const skipEvents = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.type === "task_skipped_missing_skill");
      expect(skipEvents).toHaveLength(1);
      expect(skipEvents[0].taskId).toBe("T1");
    });
  });

  describe("workspace missing workspace.yaml", () => {
    it("throws when workspace.yaml is absent", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot); // no workspace.yaml

      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      expect(() => findEligibleTasks(agentConfig, workspaceRoot, workflowRoot)).toThrow(
        /workspace\.yaml not found/,
      );
    });
  });

  describe("workspace with no docs/features directory", () => {
    it("returns empty array when docs/features does not exist", () => {
      const workspaceRoot = join(testDir, "workspace");
      mkdirSync(workspaceRoot);
      const workflowRoot = join(testDir, "workflow");
      mkdirSync(workflowRoot);

      // Only write workspace.yaml, no docs/
      const workspaceYaml = {
        workspace_id: "test",
        management_repo: "mgmt-repo",
        repos: [
          { id: "mgmt-repo", github: "git@github.com:myorg/workspace.git", base_branch: "main" },
        ],
      };
      writeFileSync(join(workspaceRoot, "workspace.yaml"), toYaml(workspaceYaml));

      const agentConfig = makeAgentConfig(["git@github.com:myorg/workspace.git"]);
      const result = findEligibleTasks(agentConfig, workspaceRoot, workflowRoot);
      expect(result).toEqual([]);
    });
  });
});
