/**
 * Canonical path constants and builder helpers for the workspace artifact layout.
 *
 * Every workflow-specific file name, directory segment, and path composition
 * MUST be defined here. No source file may hardcode these strings inline.
 *
 * Workspace layout:
 *   <workspaceRoot>/
 *     workspace.yaml
 *     docs/features/<featureId>/
 *       tasks.md
 *       tasks/<taskId>.yaml
 *       logs/<taskId>/<iso>.jsonl
 *
 * Workflow repo layout:
 *   <workflowRoot>/
 *     technical_skills/<slug>/
 *       SKILL.md
 */

import { join } from "node:path";

// ── Segment constants ─────────────────────────────────────────────────────────

/** Root config file in every management workspace. */
export const WORKSPACE_YAML = "workspace.yaml";

/** Narrative task index file at the feature level. */
export const TASKS_MD = "tasks.md";

/** Sub-directory holding per-task YAML state files. */
export const TASKS_DIR = "tasks";

/** Sub-directory holding per-run JSONL log files. */
export const LOGS_DIR = "logs";

/** Directory under the workflow repo holding technical skill definitions. */
export const TECHNICAL_SKILLS_DIR = "technical_skills";

/** Skill definition file inside each technical skill directory. */
export const SKILL_MD = "SKILL.md";

// ── Path builder helpers ──────────────────────────────────────────────────────

/** `<workspaceRoot>/workspace.yaml` */
export function workspaceYamlPath(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_YAML);
}

/** `<workspaceRoot>/docs/features/` */
export function featuresRoot(workspaceRoot: string): string {
  return join(workspaceRoot, "docs", "features");
}

/** `<workspaceRoot>/docs/features/<featureId>/tasks/<taskId>.yaml` */
export function taskYamlAbsPath(
  workspaceRoot: string,
  featureId: string,
  taskId: string,
): string {
  return join(workspaceRoot, "docs", "features", featureId, TASKS_DIR, `${taskId}.yaml`);
}

/** Relative path for git operations: `docs/features/<featureId>/tasks/<taskId>.yaml` */
export function taskYamlRelPath(featureId: string, taskId: string): string {
  return join("docs", "features", featureId, TASKS_DIR, `${taskId}.yaml`);
}

/** `<workspaceRoot>/docs/features/<featureId>/tasks.md` */
export function tasksMdAbsPath(workspaceRoot: string, featureId: string): string {
  return join(workspaceRoot, "docs", "features", featureId, TASKS_MD);
}

/** `<workspaceRoot>/docs/features/<featureId>/logs/<taskId>/` */
export function featureLogsDirPath(workspaceRoot: string, featureId: string, taskId: string): string {
  return join(workspaceRoot, "docs", "features", featureId, LOGS_DIR, taskId);
}

/** Relative path for git operations: `docs/features/<featureId>/logs/<taskId>/<filename>` */
export function logFileRelPath(featureId: string, taskId: string, filename: string): string {
  return join("docs", "features", featureId, LOGS_DIR, taskId, filename);
}

/** `<workflowRoot>/technical_skills/` */
export function technicalSkillsRoot(workflowRoot: string): string {
  return join(workflowRoot, TECHNICAL_SKILLS_DIR);
}

/** `<workflowRoot>/technical_skills/<slug>/` */
export function skillDirPath(workflowRoot: string, slug: string): string {
  return join(workflowRoot, TECHNICAL_SKILLS_DIR, slug);
}

/** `<workflowRoot>/technical_skills/<slug>/SKILL.md` */
export function skillMdAbsPath(workflowRoot: string, slug: string): string {
  return join(workflowRoot, TECHNICAL_SKILLS_DIR, slug, SKILL_MD);
}

/**
 * Canonical task branch name: `feature/<featureId>-<taskId>`
 *
 * Single source of truth for all branch naming across the runtime.
 * Both the management-repo claim branch and the implementation-repo
 * feature branch use this name.
 */
export function taskBranchName(featureId: string, taskId: string): string {
  return `feature/${featureId}-${taskId}`;
}
