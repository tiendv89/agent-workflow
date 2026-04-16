/**
 * Per-cycle workspace pull — called once per polling iteration before scanning.
 *
 * Pulls each watched management workspace and the implementation repos
 * declared in their workspace.yaml files. Git errors are classified as:
 *
 *   poll_git_halt  — non-transient failure (auth/permission, repository not
 *                    found, non-fast-forward). The affected management workspace
 *                    is skipped this cycle; the loop keeps running.
 *
 *   poll_git_warn  — transient network failure (DNS, timeout). Emitted as a
 *                    warning; the workspace is skipped this cycle and retried
 *                    on the next.
 *
 * Implementation repo pull failures emit poll_git_halt/warn but do NOT skip
 * the management workspace scan — the task may still be runnable.
 *
 * The process NEVER exits on a pull failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { syncRepo, buildGitEnv } from "../bootstrap/bootstrap.js";

export type PullOutcome = "pulled" | "cloned" | "halt" | "warn";

export interface WorkspacePullResult {
  url: string;
  localPath: string;
  /** "pulled" | "cloned" — success; "halt" | "warn" — failure, workspace skipped. */
  outcome: PullOutcome;
  error?: string;
}

type EmitFn = (event: Record<string, unknown>) => void;

function extractRepoName(url: string): string {
  const match = /\/([^/]+?)(?:\.git)?$/.exec(url);
  return match?.[1] ?? url;
}

/**
 * Classify a git error message as halt or warn.
 *   warn  — transient network failures (DNS, timeout, connection refused)
 *   halt  — all other failures (auth, not-found, non-fast-forward)
 */
export function classifyGitError(message: string): "halt" | "warn" {
  const lower = message.toLowerCase();
  if (
    lower.includes("could not resolve host") ||
    lower.includes("connection timed out") ||
    lower.includes("connection refused") ||
    lower.includes("no route to host") ||
    lower.includes("network is unreachable") ||
    lower.includes("temporary failure in name resolution")
  ) {
    return "warn";
  }
  return "halt";
}

function pullOne(
  url: string,
  localPath: string,
  baseBranch: string,
  gitEnv: NodeJS.ProcessEnv,
  emit: EmitFn,
): { outcome: PullOutcome; error?: string } {
  try {
    const action = syncRepo(url, localPath, baseBranch, gitEnv);
    emit({
      type: action === "cloned" ? "poll_workspace_cloned" : "poll_workspace_pulled",
      workspace_url: url,
      local_path: localPath,
    });
    return { outcome: action === "cloned" ? "cloned" : "pulled" };
  } catch (e) {
    const errMsg = (e as Error).message ?? String(e);
    const classification = classifyGitError(errMsg);
    emit({
      type: classification === "warn" ? "poll_git_warn" : "poll_git_halt",
      workspace_url: url,
      local_path: localPath,
      details: errMsg,
    });
    return { outcome: classification, error: errMsg };
  }
}

export interface PullWorkspacesOptions {
  watchUrls: string[];
  sshKeyPath: string | undefined;
  workspacesRoot: string;
  /** Override: SSH URL → explicit local path. Used by tests. */
  workspaceLocalPaths?: Map<string, string>;
  baseBranch?: string;
  emit: EmitFn;
  /** Skip actual git operations (for unit tests). */
  skipGit?: boolean;
}

/**
 * Pull every watched workspace and their declared implementation repos.
 *
 * Returns one result per repository attempted. Failures are classified and
 * emitted as events — never thrown. Management workspace failures cause that
 * workspace's result to have outcome "halt" or "warn"; the caller should skip
 * scanning those workspaces this cycle.
 */
export function pullWorkspaces(opts: PullWorkspacesOptions): WorkspacePullResult[] {
  const {
    watchUrls,
    sshKeyPath,
    workspacesRoot,
    workspaceLocalPaths,
    baseBranch = "main",
    emit,
    skipGit = false,
  } = opts;

  const results: WorkspacePullResult[] = [];
  const gitEnv = buildGitEnv(sshKeyPath);
  const watchUrlSet = new Set(watchUrls);

  for (const watchUrl of watchUrls) {
    const localPath = workspaceLocalPaths?.has(watchUrl)
      ? workspaceLocalPaths.get(watchUrl)!
      : join(workspacesRoot, extractRepoName(watchUrl));

    let mgmtOutcome: PullOutcome;
    let mgmtError: string | undefined;

    if (skipGit) {
      mgmtOutcome = "pulled";
    } else {
      const r = pullOne(watchUrl, localPath, baseBranch, gitEnv, emit);
      mgmtOutcome = r.outcome;
      mgmtError = r.error;
    }

    results.push({ url: watchUrl, localPath, outcome: mgmtOutcome, error: mgmtError });

    // Management workspace failed — skip reading its workspace.yaml.
    if (mgmtOutcome === "halt" || mgmtOutcome === "warn") continue;

    // Pull implementation repos declared in workspace.yaml.
    const wsYamlPath = join(localPath, "workspace.yaml");
    if (!existsSync(wsYamlPath)) continue;

    let repos: Array<{
      id: string;
      github: string;
      base_branch?: string;
      local_path?: string;
    }>;

    try {
      const parsed = parseYaml(readFileSync(wsYamlPath, "utf-8")) as {
        repos?: Array<{
          id: string;
          github: string;
          base_branch?: string;
          local_path?: string;
        }>;
      };
      repos = parsed.repos ?? [];
    } catch {
      continue; // Unreadable workspace.yaml — skip impl repo pull.
    }

    for (const repo of repos) {
      if (!repo.github) continue;
      if (watchUrlSet.has(repo.github)) continue; // already handled as management workspace

      const implLocalPath = join(workspacesRoot, extractRepoName(repo.github));
      const implBranch = repo.base_branch ?? baseBranch;

      let implOutcome: PullOutcome;
      let implError: string | undefined;

      if (skipGit) {
        implOutcome = "pulled";
      } else {
        const r = pullOne(repo.github, implLocalPath, implBranch, gitEnv, emit);
        implOutcome = r.outcome;
        implError = r.error;
      }

      results.push({
        url: repo.github,
        localPath: implLocalPath,
        outcome: implOutcome,
        error: implError,
      });
    }
  }

  return results;
}
