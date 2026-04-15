/**
 * T3: GitHub API PR creation and dedup for the management (workspace) repo.
 *
 * Opens a PR from the task branch to baseBranch on the management repo at
 * claim time. If an open PR already exists on the branch, reuses it
 * (idempotent — safe to call on re-claim or after a blocked recovery).
 *
 * HTTP calls use curl via spawnSync (no gh CLI, matching pr-create convention).
 * Authentication: Authorization: token <githubToken>.
 * JSON bodies are passed as array args to spawnSync — no shell interpolation.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { Task } from "../types/task.js";
import { taskYamlAbsPath, taskYamlRelPath } from "../paths.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface OpenWorkspacePrOpts {
  /** Absolute path to the management (workspace) repo root. */
  workspaceRoot: string;
  /** Feature directory ID (e.g. "task-branch-lifecycle"). */
  featureId: string;
  /** Task ID (e.g. "T3"). */
  taskId: string;
  /** Task branch name, e.g. "feature/task-branch-lifecycle-T3". */
  branch: string;
  /** PR target branch, e.g. "main". */
  baseBranch: string;
  /** GitHub personal access token. */
  githubToken: string;
  /** GitHub repo owner, parsed from workspace.yaml management repo SSH URL. */
  repoOwner: string;
  /** GitHub repo name, parsed from workspace.yaml management repo SSH URL. */
  repoName: string;
  /** GIT_AUTHOR_EMAIL for the workspace_pr commit. Defaults to "agent@unknown". */
  gitAuthorEmail?: string;
  /** GIT_AUTHOR_NAME for the workspace_pr commit. Defaults to gitAuthorEmail. */
  gitAuthorName?: string;
  /** SSH private key path for git push. Omit to rely on ambient SSH config. */
  sshKeyPath?: string;
  /**
   * Skip git add/commit/push for the YAML update.
   * The YAML is still written to disk.
   * Intended for unit tests that do not set up a real git repo.
   */
  skipGit?: boolean;
}

export interface OpenWorkspacePrResult {
  prUrl: string;
  prNumber: number;
  /** True if an existing open PR was reused; false if a new PR was created. */
  alreadyExisted: boolean;
}

// ── parseGitHubCoords ─────────────────────────────────────────────────────────

/**
 * Extract GitHub owner and repo name from an SSH remote URL.
 *
 * Accepts:
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 *
 * Throws a descriptive error for non-matching URLs (e.g. HTTPS or malformed).
 */
export function parseGitHubCoords(sshUrl: string): { owner: string; repo: string } {
  const match = /git@github\.com:([^/]+)\/([^.]+)(?:\.git)?$/.exec(sshUrl);
  if (!match) {
    throw new Error(
      `Cannot parse GitHub owner/repo from URL: "${sshUrl}". ` +
        `Expected SSH format: git@github.com:<owner>/<repo>[.git]`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface PrListItem {
  html_url: string;
  number: number;
}

/**
 * Call the GitHub REST API via curl. Arguments are passed as an array to
 * spawnSync to avoid shell injection.
 *
 * Throws if curl fails or the response is not valid JSON.
 */
function curlJson(args: string[]): unknown {
  const result = spawnSync("curl", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    throw new Error(
      `curl returned empty response. stderr: ${result.stderr ?? ""}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`curl response is not valid JSON: ${stdout}`);
  }
}

function buildGitEnv(
  gitAuthorEmail: string,
  gitAuthorName: string,
  sshKeyPath: string | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: gitAuthorName,
    GIT_AUTHOR_EMAIL: gitAuthorEmail,
    GIT_COMMITTER_NAME: gitAuthorName,
    GIT_COMMITTER_EMAIL: gitAuthorEmail,
    ...(sshKeyPath
      ? { GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no` }
      : {}),
  } as NodeJS.ProcessEnv;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Open a PR on the management repo from the task branch to baseBranch.
 *
 * Idempotent: if an open PR already exists on the branch it is reused rather
 * than creating a duplicate.
 *
 * On success, writes `task.workspace_pr = { url, status: "open" }` to the
 * task YAML and commits+pushes the change to the task branch (unless
 * `skipGit` is true).
 */
export async function openWorkspacePr(
  opts: OpenWorkspacePrOpts,
): Promise<OpenWorkspacePrResult> {
  const {
    workspaceRoot,
    featureId,
    taskId,
    branch,
    baseBranch,
    githubToken,
    repoOwner,
    repoName,
    gitAuthorEmail = "agent@unknown",
    gitAuthorName = gitAuthorEmail,
    sshKeyPath,
    skipGit = false,
  } = opts;

  // Read task YAML upfront: title needed for PR subject; object reused for write.
  const taskPath = taskYamlAbsPath(workspaceRoot, featureId, taskId);
  const task = parseYaml(readFileSync(taskPath, "utf-8")) as Task;

  // ── 1. Check for existing open PR ─────────────────────────────────────────
  const encodedHead = encodeURIComponent(`${repoOwner}:${branch}`);
  const listUrl =
    `https://api.github.com/repos/${repoOwner}/${repoName}/pulls` +
    `?head=${encodedHead}&state=open`;

  const pullsList = curlJson([
    "-s",
    "-H",
    `Authorization: token ${githubToken}`,
    "-H",
    "Accept: application/vnd.github+json",
    listUrl,
  ]) as PrListItem[];

  let prUrl: string;
  let prNumber: number;
  let alreadyExisted: boolean;

  if (Array.isArray(pullsList) && pullsList.length > 0) {
    // ── 2a. Reuse existing open PR ─────────────────────────────────────────
    prUrl = pullsList[0].html_url;
    prNumber = pullsList[0].number;
    alreadyExisted = true;
  } else {
    // ── 2b. Create new PR ──────────────────────────────────────────────────
    const prTitle = `feat(${taskId}): ${task.title}`;
    const prBody =
      `Task: ${taskId}\nFeature: ${featureId}\nBranch: \`${branch}\``;
    const createUrl =
      `https://api.github.com/repos/${repoOwner}/${repoName}/pulls`;
    const requestBody = JSON.stringify({
      title: prTitle,
      body: prBody,
      head: branch,
      base: baseBranch,
    });

    const created = curlJson([
      "-s",
      "-X",
      "POST",
      "-H",
      `Authorization: token ${githubToken}`,
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "Content-Type: application/json",
      "-d",
      requestBody,
      createUrl,
    ]) as { html_url?: string; number?: number };

    if (!created.html_url || !created.number) {
      throw new Error(
        `GitHub API PR creation failed. Response: ${JSON.stringify(created)}`,
      );
    }

    prUrl = created.html_url;
    prNumber = created.number;
    alreadyExisted = false;
  }

  // ── 3. Write workspace_pr to task YAML ────────────────────────────────────
  task.workspace_pr = { url: prUrl, status: "open" };
  writeFileSync(taskPath, yamlStringify(task), "utf-8");

  // ── 4. Commit and push YAML update to task branch ─────────────────────────
  if (!skipGit) {
    const env = buildGitEnv(gitAuthorEmail, gitAuthorName, sshKeyPath);
    const relPath = taskYamlRelPath(featureId, taskId);

    execSync(`git -C "${workspaceRoot}" add "${relPath}"`, {
      env,
      stdio: "pipe",
    });
    execSync(
      `git -C "${workspaceRoot}" commit -m "chore(${taskId}): open workspace PR"`,
      { env, stdio: "pipe" },
    );
    execSync(`git -C "${workspaceRoot}" push origin "${branch}"`, {
      env,
      stdio: "pipe",
    });
  }

  return { prUrl, prNumber, alreadyExisted };
}
