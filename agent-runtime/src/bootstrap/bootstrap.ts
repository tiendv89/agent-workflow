/**
 * T8: Container-start workspace pull with fail-fast validation
 * and skill_reference_audit event.
 *
 * Every container start performs three things:
 *   1. Load and validate agent.yaml via T2's validator — fail-fast on invalid config.
 *   2. Clone or pull each watched workspace and the workflow repo.
 *   3. Audit skill references across all tasks.md files — informational, non-fatal.
 *
 * Clone-vs-pull logic:
 *   - Local path missing or not a git repo  → git clone
 *   - Local path present and is a git repo  → git fetch + git reset --hard origin/<base>
 *
 * Exit codes:
 *   0  success
 *   2  agent.yaml validation failed
 *   3  git clone / pull failed
 *   4  unexpected bootstrap error
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadAgentYaml, type AgentConfig } from "../config/validate-agent-yaml.js";
import { parseTasksMd } from "../eligibility/parse-tasks-md.js";

// ── Exit codes ────────────────────────────────────────────────────────────────

export const EXIT_SUCCESS = 0 as const;
export const EXIT_VALIDATION_FAILED = 2 as const;
export const EXIT_GIT_FAILED = 3 as const;
export const EXIT_UNEXPECTED = 4 as const;

export type ExitCode = 0 | 2 | 3 | 4;

// ── Bootstrap event types ─────────────────────────────────────────────────────

export interface BootstrapStartedEvent {
  type: "bootstrap_started";
  agent_yaml_path: string;
  watches: string[];
  at: string;
}

export interface WorkspaceClonedEvent {
  type: "workspace_cloned";
  workspace_url: string;
  local_path: string;
  at: string;
}

export interface WorkspacePulledEvent {
  type: "workspace_pulled";
  workspace_url: string;
  local_path: string;
  at: string;
}

export interface BootstrapFailedEvent {
  type: "bootstrap_failed";
  reason: string;
  details: string;
  at: string;
}

export interface SkillReferenceAuditEvent {
  type: "skill_reference_audit";
  workspace_id: string;
  feature_id: string;
  task_id: string;
  missing_slug: string;
  at: string;
}

export interface BootstrapReadyEvent {
  type: "bootstrap_ready";
  at: string;
}

export type BootstrapEvent =
  | BootstrapStartedEvent
  | WorkspaceClonedEvent
  | WorkspacePulledEvent
  | BootstrapFailedEvent
  | SkillReferenceAuditEvent
  | BootstrapReadyEvent;

// ── Public options ────────────────────────────────────────────────────────────

export interface BootstrapOptions {
  /** Absolute path to the agent.yaml file to validate. */
  agentYamlPath: string;
  /**
   * Absolute local path to the workflow repo (contains technical_skills/).
   * If the path doesn't exist and workflowUrl is provided, the repo is cloned here.
   */
  workflowLocalPath: string;
  /** SSH URL of the workflow repo — required if workflowLocalPath doesn't exist yet. */
  workflowUrl?: string;
  /** Base branch for the workflow repo. Default: "main". */
  workflowBaseBranch?: string;
  /**
   * Root directory under which watched workspaces are cloned.
   * Derived local path: <workspacesRoot>/<repo-name-from-ssh-url>
   * (e.g. git@github.com:org/project.git → <workspacesRoot>/project)
   */
  workspacesRoot: string;
  /**
   * Explicit SSH-URL → local-path overrides.
   * When a URL is present here, it takes precedence over the auto-derived path.
   * Intended for tests and for container environments that pre-mount repos.
   */
  workspaceLocalPaths?: Map<string, string>;
  /** Base branch for every watched workspace. Default: "main". */
  workspaceBaseBranch?: string;
  /** SSH private key path for all git operations. */
  sshKeyPath?: string;
  /**
   * Override the event emitter (default: write JSON to stdout via console.log).
   * Inject a no-op or recording emitter in tests.
   */
  emit?: (event: BootstrapEvent) => void;
  /**
   * Skip all real git operations (clone / fetch / reset).
   * The filesystem is still inspected for the skill audit.
   * Intended for unit tests that seed the filesystem directly.
   */
  skipGit?: boolean;
}

export interface BootstrapResult {
  exitCode: ExitCode;
  /** Parsed and validated agent config — present only on exit code 0. */
  config?: AgentConfig;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function defaultEmit(event: BootstrapEvent): void {
  console.log(JSON.stringify(event));
}

function buildGitEnv(sshKeyPath: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(sshKeyPath
      ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
      : {}),
  } as NodeJS.ProcessEnv;
}

/** Return true if localPath contains a .git directory. */
function isGitRepo(localPath: string): boolean {
  return existsSync(localPath) && existsSync(join(localPath, ".git"));
}

/**
 * Extract the repository name from an SSH or HTTPS URL.
 *   git@github.com:org/repo-name.git  →  repo-name
 *   https://github.com/org/repo.git   →  repo
 */
function extractRepoName(url: string): string {
  const match = /\/([^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? url;
}

/** Resolve the local filesystem path for a watched workspace URL. */
function resolveLocalPath(
  watchUrl: string,
  workspacesRoot: string,
  overrides: Map<string, string> | undefined,
): string {
  if (overrides?.has(watchUrl)) {
    return overrides.get(watchUrl)!;
  }
  return join(workspacesRoot, extractRepoName(watchUrl));
}

/**
 * Clone or pull a single git repository.
 * Clone if the local path has no .git directory; fetch+reset otherwise.
 * Returns "cloned" | "pulled".
 */
function syncRepo(
  url: string,
  localPath: string,
  baseBranch: string,
  gitEnv: NodeJS.ProcessEnv,
): "cloned" | "pulled" {
  if (isGitRepo(localPath)) {
    execSync(`git -C "${localPath}" fetch origin`, { env: gitEnv, stdio: "pipe" });
    execSync(
      `git -C "${localPath}" reset --hard "origin/${baseBranch}"`,
      { env: gitEnv, stdio: "pipe" },
    );
    return "pulled";
  }

  mkdirSync(localPath, { recursive: true });
  execSync(`git clone "${url}" "${localPath}"`, { env: gitEnv, stdio: "pipe" });
  return "cloned";
}

/**
 * Return the set of skill slugs that exist as directories under
 * <workflowLocalPath>/technical_skills/. An absent or unreadable directory
 * returns an empty set (causing all referenced slugs to be flagged).
 */
function loadExistingSkills(workflowLocalPath: string): Set<string> {
  const skillsRoot = join(workflowLocalPath, "technical_skills");
  if (!existsSync(skillsRoot)) return new Set();
  try {
    return new Set(readdirSync(skillsRoot));
  } catch {
    return new Set();
  }
}

/**
 * Enumerate every tasks.md under <workspaceLocalPath>/docs/features/<featureId>/
 * and return an iterable of { featureId, content } pairs.
 */
function* findTasksMd(
  workspaceLocalPath: string,
): Generator<{ featureId: string; content: string }> {
  const featuresRoot = join(workspaceLocalPath, "docs", "features");
  if (!existsSync(featuresRoot)) return;

  let entries: string[];
  try {
    entries = readdirSync(featuresRoot);
  } catch {
    return;
  }

  for (const featureId of entries) {
    const tasksMdPath = join(featuresRoot, featureId, "tasks.md");
    if (!existsSync(tasksMdPath)) continue;
    try {
      const content = readFileSync(tasksMdPath, "utf-8");
      yield { featureId, content };
    } catch {
      // Unreadable file — skip silently.
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the container-start bootstrap sequence.
 *
 * @returns A BootstrapResult whose exitCode maps to the process exit code.
 *          The caller is responsible for calling process.exit(result.exitCode).
 */
export async function runBootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const {
    agentYamlPath,
    workflowLocalPath,
    workflowUrl,
    workflowBaseBranch = "main",
    workspacesRoot,
    workspaceLocalPaths,
    workspaceBaseBranch = "main",
    sshKeyPath,
    emit = defaultEmit,
    skipGit = false,
  } = opts;

  try {
    // ── 1. Load and validate agent.yaml ──────────────────────────────────────
    let validationResult;
    try {
      validationResult = loadAgentYaml(agentYamlPath);
    } catch (e) {
      emit({
        type: "bootstrap_failed",
        reason: "agent_yaml_unreadable",
        details: `Cannot read ${agentYamlPath}: ${(e as Error).message}`,
        at: new Date().toISOString(),
      });
      return { exitCode: EXIT_VALIDATION_FAILED };
    }

    if (!validationResult.valid) {
      const details = validationResult.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      emit({
        type: "bootstrap_failed",
        reason: "agent_yaml_invalid",
        details,
        at: new Date().toISOString(),
      });
      return { exitCode: EXIT_VALIDATION_FAILED };
    }

    const config = validationResult.config;

    // ── 2. Kill switch ────────────────────────────────────────────────────────
    if (!config.enabled) {
      emit({ type: "bootstrap_ready", at: new Date().toISOString() });
      return { exitCode: EXIT_SUCCESS, config };
    }

    // ── 3. Emit bootstrap_started ─────────────────────────────────────────────
    emit({
      type: "bootstrap_started",
      agent_yaml_path: agentYamlPath,
      watches: config.watches,
      at: new Date().toISOString(),
    });

    const gitEnv = buildGitEnv(sshKeyPath);

    // ── 4. Clone or pull the workflow repo ────────────────────────────────────
    if (!skipGit && workflowUrl) {
      try {
        const action = syncRepo(workflowUrl, workflowLocalPath, workflowBaseBranch, gitEnv);
        emit({
          type: action === "cloned" ? "workspace_cloned" : "workspace_pulled",
          workspace_url: workflowUrl,
          local_path: workflowLocalPath,
          at: new Date().toISOString(),
        });
      } catch (e) {
        emit({
          type: "bootstrap_failed",
          reason: "git_workflow_sync_failed",
          details: `Failed to sync workflow repo ${workflowUrl}: ${(e as Error).message}`,
          at: new Date().toISOString(),
        });
        return { exitCode: EXIT_GIT_FAILED };
      }
    }

    // ── 5. Clone or pull each watched workspace ───────────────────────────────
    for (const watchUrl of config.watches) {
      const localPath = resolveLocalPath(watchUrl, workspacesRoot, workspaceLocalPaths);

      if (!skipGit) {
        try {
          const action = syncRepo(watchUrl, localPath, workspaceBaseBranch, gitEnv);
          emit({
            type: action === "cloned" ? "workspace_cloned" : "workspace_pulled",
            workspace_url: watchUrl,
            local_path: localPath,
            at: new Date().toISOString(),
          });
        } catch (e) {
          emit({
            type: "bootstrap_failed",
            reason: "git_workspace_sync_failed",
            details: `Failed to sync workspace ${watchUrl}: ${(e as Error).message}`,
            at: new Date().toISOString(),
          });
          return { exitCode: EXIT_GIT_FAILED };
        }
      }
    }

    // ── 5b. Clone / pull implementation repos from workspace.yaml ────────────
    // For each watched management workspace, read workspace.yaml and clone every
    // repo that is NOT itself a management repo (i.e. not already in watches[]).
    // Also sets process.env[VAR] for every local_path: env:<VAR> declaration so
    // that resolveRepoLocalPath in main.ts can do a simple env-var lookup.
    //
    // Non-fatal if workspace.yaml is absent or has no repos[] — management-only
    // workspaces are valid.
    {
      type WorkspaceRepoEntry = {
        id: string;
        github: string;
        local_path?: string;
        base_branch?: string;
      };

      const watchUrlSet = new Set(config.watches);

      for (const watchUrl of config.watches) {
        const mgmtLocalPath = resolveLocalPath(watchUrl, workspacesRoot, workspaceLocalPaths);
        const workspaceYamlPath = join(mgmtLocalPath, "workspace.yaml");

        if (!existsSync(workspaceYamlPath)) continue;

        let repos: WorkspaceRepoEntry[];
        try {
          const parsed = parseYaml(readFileSync(workspaceYamlPath, "utf-8")) as {
            repos?: WorkspaceRepoEntry[];
          };
          repos = parsed.repos ?? [];
        } catch {
          continue; // Unreadable or malformed workspace.yaml — skip silently.
        }

        for (const repo of repos) {
          // Skip management repos — already handled in step 5.
          if (watchUrlSet.has(repo.github)) continue;

          const localPath = join(workspacesRoot, extractRepoName(repo.github));
          const branch = repo.base_branch ?? workspaceBaseBranch;

          if (!skipGit) {
            try {
              const action = syncRepo(repo.github, localPath, branch, gitEnv);
              emit({
                type: action === "cloned" ? "workspace_cloned" : "workspace_pulled",
                workspace_url: repo.github,
                local_path: localPath,
                at: new Date().toISOString(),
              });
            } catch (e) {
              emit({
                type: "bootstrap_failed",
                reason: "git_impl_repo_sync_failed",
                details: `Failed to sync impl repo ${repo.github}: ${(e as Error).message}`,
                at: new Date().toISOString(),
              });
              return { exitCode: EXIT_GIT_FAILED };
            }
          }

          // Populate env var so resolveRepoLocalPath can do a plain env lookup.
          if (repo.local_path?.startsWith("env:")) {
            const varName = repo.local_path.slice(4);
            process.env[varName] = localPath;
          }
        }
      }
    }

    // ── 6. Skill reference audit ──────────────────────────────────────────────
    // Informational only — never fatal. Bootstrap continues even when slugs are missing.
    const existingSkills = loadExistingSkills(workflowLocalPath);

    for (const watchUrl of config.watches) {
      const localPath = resolveLocalPath(watchUrl, workspacesRoot, workspaceLocalPaths);
      const workspaceId = extractRepoName(watchUrl);

      for (const { featureId, content } of findTasksMd(localPath)) {
        const taskSkills = parseTasksMd(content);
        for (const [taskId, { requiredSkills }] of Object.entries(taskSkills)) {
          for (const slug of requiredSkills) {
            if (!existingSkills.has(slug)) {
              emit({
                type: "skill_reference_audit",
                workspace_id: workspaceId,
                feature_id: featureId,
                task_id: taskId,
                missing_slug: slug,
                at: new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    // ── 7. Success ────────────────────────────────────────────────────────────
    emit({ type: "bootstrap_ready", at: new Date().toISOString() });
    return { exitCode: EXIT_SUCCESS, config };
  } catch (e) {
    try {
      emit({
        type: "bootstrap_failed",
        reason: "unexpected_error",
        details: (e as Error).message ?? String(e),
        at: new Date().toISOString(),
      });
    } catch {
      // Last resort — cannot even emit the failure event.
    }
    return { exitCode: EXIT_UNEXPECTED };
  }
}
