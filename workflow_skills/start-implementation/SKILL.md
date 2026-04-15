---
name: start-implementation
description: Safely begin implementation of a task stored as a single YAML task file, using shared environment resolution.
---

## Environment

### Required (resolved via `resolve-project-env`)
| Variable | Description |
|---|---|
| `SSH_KEY_PATH` | SSH private key for git clone/fetch/push |
| `GIT_AUTHOR_NAME` | Actor recorded in task log |
| `GIT_AUTHOR_EMAIL` | Actor recorded in task log |
| `<REPO_ID_UPPER>_LOCAL_PATH` | Local path to each repo used by tasks in this workspace |

---

## Must resolve environment first

Before any git or repo operation, invoke:

- `resolve-project-env`

Required outputs:

- validated `project_root`
- resolved `SSH_KEY_PATH`
- resolved git identity values
- resolved repo local path values

If required values are missing, require the user to provide them. Do not guess.

## Must verify

- task file exists
- task status is `ready` — **hard stop** if status is anything else (including `todo`, `in_progress`, `blocked`). Print the current status and stop. Do not proceed.
- all tasks in `depends_on` are `done`
- repo matches `workspace.yaml -> repos[].id`
- repo local path resolves correctly
- working tree is clean

## Git / SSH rule

When repo access requires SSH:

- use the SSH key resolved from project `.env` via `SSH_KEY_PATH`
- do not assume the default SSH key is correct

## Must then

Resolve the base branch from `workspace.yaml -> repos[].base_branch` for the task's repo (required; unset is an error). Then, for **both** the implementation repo and the management repo:

1. **Fetch from remote** — never skip this; a stale local branch is not acceptable:
   ```
   git fetch origin
   ```
   **Hard stop** if this fails — set `status: blocked`, set `blocked_reason` to the git error message, append a log entry (action: `blocked`, note: the git error message, timestamp: real UTC), and stop. Do not proceed.

2. **Checkout and hard-reset to the remote base branch** — this is the only safe starting point:
   ```
   git checkout <base_branch>
   git reset --hard origin/<base_branch>
   ```
   **Hard stop** if either command fails (e.g. base branch does not exist on remote, dirty working tree) — set `status: blocked`, set `blocked_reason` to the git error message, append a log entry (action: `blocked`, note: the git error message, timestamp: real UTC), and stop. Do not proceed.

3. **Create the feature branch**:
   ```
   git checkout -b feature/<feature_id>-<work_id>
   ```
   **Hard stop** if this fails — set `status: blocked`, set `blocked_reason` to the git error message, append a log entry (action: `blocked`, note: the git error message, timestamp: real UTC), and stop. Do not proceed.

If the feature branch already exists locally (e.g. from a previous aborted attempt), delete it first:
```
git branch -D feature/<feature_id>-<work_id>
```
then repeat steps 2–3.

## Must append task log

- action: started
- actor: resolved `GIT_AUTHOR_EMAIL`
- timestamp: real UTC time via `date -u +%Y-%m-%dT%H:%M:%SZ` — never hardcode

---

## Must then implement, self-review, and open the PR

After the branch is created and the `started` log entry is written, proceed directly through the full execution contract **without pausing for human confirmation**:

### Step 1 — Implement

Read the task description and subtasks from `tasks.md` (under `## T<n> — <title>`) and the technical design at `docs/features/<feature_id>/technical-design.md`. Make all required code and documentation changes in the implementation repo. Commit incrementally as logical units. Push each commit to the feature branch.

Update `task.execution.last_updated_by` and `task.execution.last_updated_at` in the task YAML as work progresses.

### Step 2 — Self-review

Invoke `pr-self-review` on the completed branch. Fix any blocking issues found. Re-commit and re-push. Repeat until no blocking issues remain.

### Step 3 — Execute the test plan

Read the test plan from the PR description template or from `tasks.md` under `## T<n>`. Execute every item in the test plan:

- For items that can be run (compile checks, unit tests, linters): run them and record actual output.
- For items that require code inspection (config file verification, logic traces): read the relevant files and verify each claim explicitly.
- If a test plan item fails: fix the issue, re-commit, re-push, then re-run the full test plan from scratch.
- **Hard stop** if a test plan item cannot be made to pass after 3 attempts — set `status: blocked`, write `blocked_reason`, append a log entry, and stop. Do not open a PR for failing tests.

After all items pass, record the results (pass/fail per item, test suite counts if applicable) to post as a PR comment in Step 4.

### Step 4 — Create PR

Invoke `pr-create` to push the final branch state and open the pull request. The task status will be set to `in_review` by `pr-create`. Immediately after the PR is created, post the test plan results as a comment on the PR.

### Autonomous execution rules

- Do not ask for confirmation between steps.
- Do not stop after branch setup and wait.
- If a blocking issue arises during implementation that cannot be resolved (ambiguous spec, missing dependency, repeated test failure after 3 attempts), set `status: blocked`, write a `blocked_reason` and `suggested_next_step`, append a log entry, and exit — do not open a PR for broken work.
- All four steps (implement → self-review → test plan → PR) are part of a single `/start-implementation` invocation.

---

## Re-do mode

Triggered when the task status is `in_review` and the PR has been rejected or has review comments to address.

### When to use

Use re-do mode instead of the normal flow when:
- the task status is `in_review` (not `ready`)
- the user explicitly asks to fix review comments or re-do the task

### Must verify (re-do)

- task file exists
- task status is `in_review`
- task has a PR field with a valid PR reference
- repo local path resolves correctly

### Must then (re-do)

1. **Update the branch** — fetch remote state first, then check out and fast-forward the feature branch:
   ```
   git fetch origin
   git checkout feature/<feature_id>-<work_id>
   git reset --hard origin/feature/<feature_id>-<work_id>
   ```
   **Hard stop** if any of these commands fail (e.g. branch does not exist on remote) — append a log entry to the task file (action: `blocked`, note: the git error message) and stop. Do not proceed.

2. **Check existing changes** — review what is already on the branch vs the repo's base branch (resolved from `workspace.yaml -> repos[].base_branch` for the task's repo):
   ```
   git diff <base_branch>...HEAD --stat
   git log <base_branch>..HEAD --oneline
   ```

3. **Fetch PR review comments** — retrieve all review comments from the PR using the GitHub API with `GITHUB_TOKEN` from project `.env`:
   ```
   GET /repos/{owner}/{repo}/pulls/{pull_number}/comments
   GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews
   ```
   Read and understand every comment before making any changes.

4. **Fix the comments** — apply all required changes to resolve the review feedback.

5. **Commit and push** — commit the fixes and push to the existing branch:
   ```
   git add <changed files>
   git commit -m "fix: address PR review comments (<summary>)"
   git push origin feature/<feature_id>-<work_id>
   ```

6. **Mark in_review again** — update the task log with the fix action and ensure status remains `in_review`.

### Must append task log (re-do)

- action: fixed review comments
- PR comments addressed (brief summary)
- actor: resolved `GIT_AUTHOR_EMAIL`
- timestamp: real UTC time via `date -u +%Y-%m-%dT%H:%M:%SZ` — never hardcode
