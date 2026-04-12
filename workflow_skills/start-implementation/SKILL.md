---
name: start-implementation
description: Safely begin implementation of a task stored as a single YAML task file, using shared environment resolution.
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

- checkout latest `main`
- create branch `feature/<feature_id>-<work_id>`

## Must append task log

- action: started
- actor
- timestamp
