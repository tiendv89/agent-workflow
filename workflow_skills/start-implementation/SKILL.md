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
- task status is `ready`
- all tasks in `depends_on` are `done`
- repo matches `workspace.yaml -> repos[].id`
- repo local path resolves correctly
- working tree is clean

## Git / SSH rule

When repo access requires SSH:

- use the SSH key resolved from project `.env` via `SSH_KEY_PATH`
- do not assume the default SSH key is correct

## Must then

- resolve the base branch from `workspace.yaml -> repos[].base_branch` for the task's repo (required; unset is an error)
- checkout latest `<base_branch>`
- create branch `feature/<feature_id>-<work_id>`

## Must append task log

- action: started
- actor
- timestamp

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

1. **Update the branch** — check out the existing feature branch and pull latest:
   ```
   git checkout feature/<feature_id>-<work_id>
   git pull origin feature/<feature_id>-<work_id>
   ```

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
- actor
- timestamp
