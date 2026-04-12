---
name: resolve-project-env
description: Resolve workflow-relevant environment values from the project `.env` file before any repo, git, or SSH operation.
---

## Purpose
Provide one shared environment-resolution contract for all workflow skills.

## Inputs
Optional:
- `project_root`

## Path resolution
1. If `project_root` is provided, use it
2. Otherwise use the current directory
3. Validate project root contains:
   - `workspace.yaml`
   - `CLAUDE.md`

If project root cannot be validated, require the user to provide the project folder path.

## Environment resolution
Read `<project_root>/.env` if it exists.

Resolve workflow-relevant values from `.env`, especially:
- `WORKSPACE_ROOT`
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`
- `GITHUB_ACCOUNT`
- `SSH_KEY_PATH`

Also resolve any repo local path env references used by `workspace.yaml`, for example:
- `PROJECT_A_API_LOCAL_PATH`
- `PROJECT_A_WEB_LOCAL_PATH`
- `PROJECT_A_DATA_LOCAL_PATH`

## Rules
- Do not guess missing required values
- If a required value is missing, ask the user explicitly
- Prefer project `.env` over assumptions
- Treat `SSH_KEY_PATH` as required for SSH-based repo access
- Do not assume the default SSH key is correct

## Output
Return a resolved environment summary suitable for downstream workflow skills:
- validated `project_root`
- resolved `WORKSPACE_ROOT`
- resolved git identity values
- resolved `SSH_KEY_PATH`
- resolved repo local path values
