/**
 * Zero-token eligibility matcher.
 *
 * Determines which tasks in a workspace are eligible for this agent to claim.
 * Uses only filesystem reads and regex — no LLM calls, zero Anthropic tokens.
 *
 * Eligibility criteria (all must pass):
 *   1. task.status === "ready"
 *   2. All task IDs in depends_on are "done" (within the same feature)
 *   3. task.repo is one of the repos declared in workspace.yaml
 *   4. The workspace's management repo URL is in agent.watches
 *   5. Every slug in ### Required skills exists as a directory under
 *      workflowRoot/technical_skills/<slug>/
 *
 * Tasks that fail criterion 5 emit a `task_skipped_missing_skill` event to
 * stdout and remain "ready" (not blocked) — the issue is a workflow-repo
 * authoring error, not a task-scope error.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentConfig } from "../config/validate-agent-yaml.js";
import type { Task } from "../types/task.js";
import { parseTasksMd } from "./parse-tasks-md.js";

// ---------------------------------------------------------------------------
// Workspace config types (minimal — only what the matcher needs)
// ---------------------------------------------------------------------------

interface WorkspaceRepo {
  id: string;
  github: string;
}

interface WorkspaceConfig {
  management_repo: string;
  repos: WorkspaceRepo[];
}

// ---------------------------------------------------------------------------
// Event types emitted to stdout
// ---------------------------------------------------------------------------

/** Emitted when a task is skipped because a required skill is missing from the workflow repo. */
export interface TaskSkippedMissingSkillEvent {
  type: "task_skipped_missing_skill";
  taskId: string;
  featureId: string;
  missingSkills: string[];
}

function emitSkippedMissingSkill(event: TaskSkippedMissingSkillEvent): void {
  console.log(JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse workspace.yaml from the given workspace root. */
function loadWorkspaceConfig(workspaceRoot: string): WorkspaceConfig {
  const yamlPath = join(workspaceRoot, "workspace.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`workspace.yaml not found at ${yamlPath}`);
  }
  return parseYaml(readFileSync(yamlPath, "utf-8")) as WorkspaceConfig;
}

/** Return true if the directory exists (used for skill availability check). */
function skillDirExists(workflowRoot: string, slug: string): boolean {
  return existsSync(join(workflowRoot, "technical_skills", slug));
}

/** Return the numeric part of a task ID for sorting (T5 → 5). */
function taskNumericId(taskId: string): number {
  return parseInt(taskId.replace(/^T/, ""), 10);
}

// ---------------------------------------------------------------------------
// Feature scanning
// ---------------------------------------------------------------------------

interface FeatureTaskEntry {
  task: Task;
  featureId: string;
  requiredSkills: string[];
}

/**
 * Load all tasks from a single feature directory.
 * Returns one entry per task YAML file found under tasks/.
 */
function loadFeatureTasks(
  featurePath: string,
  featureId: string,
): FeatureTaskEntry[] {
  const tasksDir = join(featurePath, "tasks");
  if (!existsSync(tasksDir)) return [];

  // Parse tasks.md skill map (may be absent — treated as "all tasks have no skills")
  const tasksMdPath = join(featurePath, "tasks.md");
  const skillMap = existsSync(tasksMdPath)
    ? parseTasksMd(readFileSync(tasksMdPath, "utf-8"))
    : {};

  // Load T*.yaml files
  let taskFiles: string[];
  try {
    taskFiles = readdirSync(tasksDir).filter((f) => /^T\d+\.yaml$/.test(f));
  } catch {
    return [];
  }

  return taskFiles.map((fileName) => {
    const task = parseYaml(
      readFileSync(join(tasksDir, fileName), "utf-8"),
    ) as Task;

    const skillEntry = skillMap[task.id];
    // skillEntry undefined → task not in tasks.md (treated as no skills required)
    // skillEntry present → use its requiredSkills
    // Task omitted from map (malformed) → skillEntry is undefined here too, but
    // parseTasksMd already emitted the warning; we treat it as null so the matcher skips it
    const requiredSkills = skillEntry !== undefined ? skillEntry.requiredSkills : [];

    return { task, featureId, requiredSkills };
  });
}

/**
 * Scan all features under workspaceRoot/docs/features/.
 * Returns all task entries found.
 */
function scanAllFeatures(workspaceRoot: string): FeatureTaskEntry[] {
  const docsPath = join(workspaceRoot, "docs", "features");
  if (!existsSync(docsPath)) return [];

  let featureDirs: string[];
  try {
    featureDirs = readdirSync(docsPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const entries: FeatureTaskEntry[] = [];
  for (const featureId of featureDirs) {
    const featurePath = join(docsPath, featureId);
    entries.push(...loadFeatureTasks(featurePath, featureId));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find all tasks in the given workspace that this agent is eligible to claim.
 *
 * @param agentConfig   - Validated agent configuration (watches, budget, etc.).
 * @param workspaceRoot - Local filesystem path to the cloned workspace repo.
 * @param workflowRoot  - Local filesystem path to the cloned workflow repo
 *                        (contains technical_skills/).
 * @returns Eligible tasks sorted by numeric task ID ascending. Empty array if
 *          the workspace is not watched or has no eligible tasks.
 */
export function findEligibleTasks(
  agentConfig: AgentConfig,
  workspaceRoot: string,
  workflowRoot: string,
): Task[] {
  // ── 1. Load workspace config ────────────────────────────────────────────
  const workspaceConfig = loadWorkspaceConfig(workspaceRoot);

  // ── 2. Watches match ────────────────────────────────────────────────────
  // Verify this workspace's management repo is in agent.watches.
  const managementRepoId = workspaceConfig.management_repo;
  const managementRepo = workspaceConfig.repos.find(
    (r) => r.id === managementRepoId,
  );
  if (!managementRepo) {
    throw new Error(
      `management_repo "${managementRepoId}" declared in workspace.yaml but not found in repos[]`,
    );
  }

  const watchedUrls = new Set(agentConfig.watches);
  if (!watchedUrls.has(managementRepo.github)) {
    // This workspace is not watched by this agent — no eligible tasks
    return [];
  }

  // ── 3. Reachable repo IDs ───────────────────────────────────────────────
  // Any repo declared in this workspace can be touched by the agent.
  const reachableRepoIds = new Set(workspaceConfig.repos.map((r) => r.id));

  // ── 4. Scan all features ────────────────────────────────────────────────
  const allEntries = scanAllFeatures(workspaceRoot);

  // Build a per-feature done-set (depends_on uses task IDs within the same feature).
  // Group entries by feature.
  const byFeature = new Map<string, FeatureTaskEntry[]>();
  for (const entry of allEntries) {
    let list = byFeature.get(entry.featureId);
    if (!list) {
      list = [];
      byFeature.set(entry.featureId, list);
    }
    list.push(entry);
  }

  // ── 5. Filter per feature ───────────────────────────────────────────────
  const eligible: Task[] = [];

  for (const [, featureEntries] of byFeature) {
    // Build done-set for this feature
    const doneSet = new Set(
      featureEntries
        .filter((e) => e.task.status === "done")
        .map((e) => e.task.id),
    );

    for (const { task, featureId, requiredSkills } of featureEntries) {
      // Criterion 1: status must be ready
      if (task.status !== "ready") continue;

      // Criterion 2: all depends_on must be done (within this feature)
      if (task.depends_on.some((dep) => !doneSet.has(dep))) continue;

      // Criterion 3 + 4: task.repo must be a repo in this workspace (which is watched)
      if (!reachableRepoIds.has(task.repo)) continue;

      // Criterion 5: all required skills must exist in the workflow repo
      const missing = requiredSkills.filter(
        (slug) => !skillDirExists(workflowRoot, slug),
      );
      if (missing.length > 0) {
        emitSkippedMissingSkill({
          type: "task_skipped_missing_skill",
          taskId: task.id,
          featureId,
          missingSkills: missing,
        });
        continue;
      }

      eligible.push(task);
    }
  }

  // ── 6. Deterministic ordering ───────────────────────────────────────────
  // Sort ascending by numeric task ID (T1 < T5 < T10).
  eligible.sort((a, b) => taskNumericId(a.id) - taskNumericId(b.id));

  return eligible;
}
