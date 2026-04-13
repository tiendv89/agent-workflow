---
name: pr-create
description: Create PR from current task branch and update task PR metadata, using shared environment resolution.
---

## Environment

### Required (resolved via `resolve-project-env`)
| Variable | Description |
|---|---|
| `GITHUB_ACCOUNT` | GitHub username or org; used to construct PR target and remote URL |
| `SSH_KEY_PATH` | SSH private key for git push operations |
| `GIT_AUTHOR_NAME` | Actor recorded in task log |
| `GIT_AUTHOR_EMAIL` | Actor recorded in task log |

---

## Must resolve environment first

Before any git push or PR operation, invoke:

- `resolve-project-env`

Required outputs:

- validated `project_root`
- resolved `SSH_KEY_PATH`
- resolved git identity values
- resolved `GITHUB_ACCOUNT`

If required values are missing, require the user to provide them. Do not guess.

## Git / SSH rule

When repo access requires SSH:

- use the SSH key resolved from project `.env` via `SSH_KEY_PATH`
- do not assume the default SSH key is correct

## Must

- push branch if needed
- resolve the base branch from `workspace.yaml -> repos[].base_branch` for the task's repo (required; unset is an error)
- create PR against that explicit base branch
- update task PR metadata
- append task log entry
- avoid duplicate PR creation
