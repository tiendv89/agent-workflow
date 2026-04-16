/**
 * Agent-runtime main entry point.
 *
 * Lifecycle:
 *   bootstrap (once) → polling loop:
 *     pull workspaces → eligibility → claim → run-claude → sleep → repeat
 *
 * idle_sleep_seconds controls the loop behaviour (read from agent.yaml):
 *   0   → single-shot mode: one cycle then exit (for external schedulers)
 *   >0  → continuous: loops indefinitely, sleeping idle_sleep_seconds between cycles
 *
 * Exit codes:
 *   0  normal exit (task ran, idle cycle, or kill-switch off)
 *   2  agent.yaml invalid
 *   3  git clone/pull failed (bootstrap only — per-cycle pull failures never exit)
 *   4  unexpected fatal error
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runBootstrap } from "./bootstrap/bootstrap.js";
import { resolveSSHKey } from "./resolve-ssh-key.js";
import { workspaceYamlPath, featuresRoot, taskYamlAbsPath, taskBranchName } from "./paths.js";
import { findEligibleTasks } from "./eligibility/match.js";
import { claimTask } from "./claim/claim-task.js";
import { openWorkspacePr, parseGitHubCoords } from "./claim/open-workspace-pr.js";
import type { Task } from "./types/task.js";
import { generateAgentContext } from "./bootstrap/agent-context.js";
import { runClaude } from "./loop/run-claude.js";
import { resolveModel } from "./config/resolve-model-policy.js";
import { parseModelOverrides } from "./config/parse-model-overrides.js";
import type { ModelPolicy } from "./config/resolve-model-policy.js";
import { pullWorkspaces } from "./poll/pull-workspaces.js";
import { runAgentLoop, type CycleOutcome } from "./poll/agent-loop.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

/** Extract repo name from SSH or HTTPS URL (strips .git suffix). */
function extractRepoName(url: string): string {
  const match = /\/([^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? url;
}

/** Emit a structured JSON event to stdout. */
function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

/**
 * Given a task's repo ID and the workspace.yaml from the management workspace,
 * resolve the local filesystem path where that repo is cloned.
 *
 * Bootstrap (step 5b) guarantees that process.env[VAR] is set for every
 * local_path: env:<VAR> declaration before main() reaches this call.
 */
function resolveRepoLocalPath(
  workspaceRoot: string,
  repoId: string,
): string {
  type RepoEntry = { id: string; github: string; local_path?: string };
  const yaml = parseYaml(
    readFileSync(workspaceYamlPath(workspaceRoot), "utf-8"),
  ) as { repos: RepoEntry[] };

  const repo = yaml.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error(`Repo "${repoId}" not found in workspace.yaml`);

  if (!repo.local_path?.startsWith("env:")) {
    throw new Error(
      `Repo "${repoId}" has no "local_path: env:<VAR>" declaration in workspace.yaml. ` +
      `Bootstrap is responsible for setting the env var before this point.`,
    );
  }

  const envVar = repo.local_path.slice(4);
  const val = process.env[envVar];
  if (!val) {
    throw new Error(
      `Env var ${envVar} is not set — bootstrap should have populated it for repo "${repoId}".`,
    );
  }
  return val;
}

/**
 * Load the workspace-level model_policy from workspace.yaml.
 * Returns a minimal fallback policy if the field is absent (e.g. older workspaces).
 */
function loadWorkspaceModelPolicy(workspaceRoot: string): ModelPolicy {
  const yaml = parseYaml(
    readFileSync(workspaceYamlPath(workspaceRoot), "utf-8"),
  ) as { model_policy?: ModelPolicy };

  if (yaml.model_policy) return yaml.model_policy;

  // Sensible fallback so the runtime never hard-errors on a missing policy.
  const defaultPhase = {
    allowed: ["claude-sonnet-4-6"],
    default: "claude-sonnet-4-6",
  };
  return {
    implementation: defaultPhase,
    self_review: defaultPhase,
    pr_description: defaultPhase,
    suggested_next_step: { allowed: ["claude-haiku-4-5-20251001"], default: "claude-haiku-4-5-20251001" },
  };
}

/**
 * Find the feature directory that owns a given task ID by scanning
 * docs/features/<featureId>/tasks/<taskId>.yaml.
 */
function findFeatureId(workspaceRoot: string, taskId: string): string | null {
  const featuresDir = featuresRoot(workspaceRoot);
  if (!existsSync(featuresDir)) return null;
  for (const featureId of readdirSync(featuresDir)) {
    if (existsSync(taskYamlAbsPath(workspaceRoot, featureId, taskId))) {
      return featureId;
    }
  }
  return null;
}

/**
 * Parse the GitHub owner/repo and base branch for the management repo declared
 * in workspace.yaml. Used to call openWorkspacePr after a successful claim.
 */
function parseManagementRepoCoords(
  workspaceRoot: string,
): { owner: string; repo: string; baseBranch: string } {
  type RepoEntry = { id: string; github: string; local_path?: string; base_branch?: string };
  const yaml = parseYaml(
    readFileSync(workspaceYamlPath(workspaceRoot), "utf-8"),
  ) as { management_repo: string; repos: RepoEntry[] };

  const mgmtId = yaml.management_repo;
  const mgmtRepo = yaml.repos.find((r) => r.id === mgmtId);
  if (!mgmtRepo) {
    throw new Error(`Management repo "${mgmtId}" not found in workspace.yaml repos`);
  }
  const { owner, repo } = parseGitHubCoords(mgmtRepo.github);
  return { owner, repo, baseBranch: mgmtRepo.base_branch ?? "main" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  // ── 1. Read required environment ─────────────────────────────────────────
  let agentYamlPath: string;
  let workflowLocalPath: string;
  let workspacesRoot: string;
  let gitAuthorEmail: string;

  try {
    agentYamlPath = requireEnv("AGENT_YAML_PATH");
    workflowLocalPath = requireEnv("WORKFLOW_LOCAL_PATH");
    workspacesRoot = requireEnv("WORKSPACES_ROOT");
    gitAuthorEmail = requireEnv("GIT_AUTHOR_EMAIL");
  } catch (e) {
    emit({ type: "fatal_missing_env", details: (e as Error).message });
    return 4;
  }

  const gitAuthorName = process.env.GIT_AUTHOR_NAME ?? gitAuthorEmail;

  // ── SSH key resolution ────────────────────────────────────────────────────
  // Preferred: SSH_PRIVATE_KEY env var (raw PEM) — write to temp file 0400.
  // Fallback:  SSH_KEY_PATH env var pointing to a file already present.
  // Neither:   warn and proceed; SSH-only repos will fail at clone time.
  const sshResolution = resolveSSHKey(process.env);
  const sshKeyPath = sshResolution.sshKeyPath;
  if (sshResolution.warned) {
    emit({ type: "warn_no_ssh_key", note: "Neither SSH_PRIVATE_KEY nor SSH_KEY_PATH is set. SSH-only git operations will fail." });
  }

  // ── 2. Bootstrap (once at container start) ────────────────────────────────
  const bootstrapResult = await runBootstrap({
    agentYamlPath,
    workflowLocalPath,
    workflowUrl: process.env.WORKFLOW_URL,
    workspacesRoot,
    sshKeyPath,
  });

  if (bootstrapResult.exitCode !== 0) return bootstrapResult.exitCode;

  const config = bootstrapResult.config!;

  // Kill switch already handled inside runBootstrap (exits 0).
  // If we get here, config.enabled is true.

  // ── 3. Build the per-cycle scan+claim+run function ────────────────────────
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  if (!githubToken) {
    emit({ type: "warn_no_github_token" });
  }

  async function runOneCycle(): Promise<CycleOutcome> {
    // ── 3a. Pull latest workspace state ──────────────────────────────────────
    const pullResults = pullWorkspaces({
      watchUrls: config.watches,
      sshKeyPath,
      workspacesRoot,
      emit,
    });

    // Build a set of workspaces that failed to pull — skip scanning them.
    const haltedUrls = new Set(
      pullResults
        .filter((r) => r.outcome === "halt" || r.outcome === "warn")
        .map((r) => r.url),
    );

    // ── 3b. Scan remaining workspaces for an eligible task ────────────────────
    for (const watchUrl of config.watches) {
      if (haltedUrls.has(watchUrl)) continue;

      const workspaceLocalPath = join(workspacesRoot, extractRepoName(watchUrl));

      if (!existsSync(workspaceLocalPath)) {
        emit({ type: "workspace_not_found", workspace_url: watchUrl, local_path: workspaceLocalPath });
        continue;
      }

      // Find eligible tasks in this workspace.
      let eligibleTasks;
      try {
        eligibleTasks = findEligibleTasks(config, workspaceLocalPath, workflowLocalPath);
      } catch (e) {
        emit({ type: "eligibility_error", workspace_url: watchUrl, details: String(e) });
        continue;
      }

      if (eligibleTasks.length === 0) {
        emit({ type: "no_eligible_tasks", workspace_url: watchUrl });
        continue;
      }

      // Try each task in order until one is claimed.
      for (const task of eligibleTasks) {
        const featureId = findFeatureId(workspaceLocalPath, task.id);
        if (!featureId) {
          emit({ type: "task_feature_not_found", task_id: task.id });
          continue;
        }

        // ── Claim ─────────────────────────────────────────────────────────────
        const claimResult = await claimTask({
          workspaceRoot: workspaceLocalPath,
          taskId: task.id,
          featureId,
          gitAuthorEmail,
          gitAuthorName,
          sshKeyPath,
          jitterMaxSeconds: config.jitter_max_seconds,
        });

        const taskBranch = taskBranchName(featureId, task.id);

        if (!claimResult.won) {
          if (claimResult.reason !== "branch_blocked_recovery") {
            emit({ type: "claim_lost", task_id: task.id, reason: claimResult.reason });
            continue;
          }
          emit({ type: "task_blocked_recovery_detected", task_id: task.id, feature_id: featureId });
          const _recoveredTask = parseYaml(
            readFileSync(taskYamlAbsPath(workspaceLocalPath, featureId, task.id), "utf-8"),
          ) as Task;
          void _recoveredTask;
        } else {
          emit({ type: "task_claimed", task_id: task.id, feature_id: featureId });
        }

        // ── Open management-repo PR (non-fatal) ───────────────────────────────
        if (githubToken) {
          try {
            const mgmtCoords = parseManagementRepoCoords(workspaceLocalPath);
            await openWorkspacePr({
              workspaceRoot: workspaceLocalPath,
              featureId,
              taskId: task.id,
              branch: taskBranch,
              baseBranch: mgmtCoords.baseBranch,
              githubToken,
              repoOwner: mgmtCoords.owner,
              repoName: mgmtCoords.repo,
              gitAuthorEmail,
              gitAuthorName,
              sshKeyPath,
            });
            emit({ type: "workspace_pr_opened", task_id: task.id });
          } catch (e) {
            emit({ type: "workspace_pr_failed", task_id: task.id, details: String(e) });
          }
        }

        // ── Load model policy + resolve task repo path ────────────────────────
        const workspaceModelPolicy = loadWorkspaceModelPolicy(workspaceLocalPath);
        const taskRepoRoot = resolveRepoLocalPath(workspaceLocalPath, task.repo);

        // ── Resolve implementation model + parse task-level overrides ─────────
        const tasksMdPath = join(workspaceLocalPath, "docs", "features", featureId, "tasks.md");
        let taskModelOverrides = {};
        try {
          const tasksMdContent = readFileSync(tasksMdPath, "utf-8");
          taskModelOverrides = parseModelOverrides(tasksMdContent, task.id);
        } catch {
          // Non-fatal — use workspace defaults if tasks.md is unreadable.
        }
        const implementationModel = resolveModel(
          workspaceModelPolicy,
          taskModelOverrides,
          "implementation",
          task.id,
        );

        // ── Generate agent context ─────────────────────────────────────────────
        const agentContext = generateAgentContext({
          taskId: task.id,
          featureId,
          taskTitle: task.title,
          taskBranch,
          taskRepo: task.repo,
          taskRepoRoot,
          workspaceRoot: workspaceLocalPath,
          gitAuthorEmail,
          gitAuthorName,
          implementationModel,
        });

        // ── Run claude ─────────────────────────────────────────────────────────
        const runResult = await runClaude({
          taskId: task.id,
          featureId,
          workspaceRoot: workspaceLocalPath,
          taskRepoRoot,
          workflowLocalPath,
          agentContext,
          maxTurns: config.budget.max_iterations,
          maxTokens: config.budget.max_tokens_per_task,
          sshKeyPath,
          gitAuthorEmail,
          taskBranch,
          logSinkEnabled: config.log_sink.enabled,
        });

        emit({ type: "task_run_complete", task_id: task.id, outcome: runResult.outcome });
        return "ran_task";
      }
    }

    return "idle";
  }

  // ── 4. Run the polling loop ───────────────────────────────────────────────
  await runAgentLoop({ config, runCycle: runOneCycle, emit });

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    try {
      console.log(
        JSON.stringify({
          type: "fatal_error",
          details: (e as Error).message ?? String(e),
          at: new Date().toISOString(),
        }),
      );
    } catch {
      /* cannot emit — last resort */
    }
    process.exit(4);
  });
