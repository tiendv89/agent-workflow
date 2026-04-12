---
name: pr-create
description: Create PR from current task branch and update task PR metadata, using shared environment resolution.
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
- create PR against explicit base branch
- update task PR metadata
- append task log entry
- avoid duplicate PR creation
