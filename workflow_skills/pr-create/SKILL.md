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

## GitHub API rule

Do NOT use the `gh` CLI to create pull requests. Use the GitHub REST API via `curl` instead. This avoids requiring `gh` to be installed on the host or in agent containers.

Use `GITHUB_TOKEN` from the project `.env` for authentication. If `GITHUB_TOKEN` is not set, fall back to reading `~/.config/gh/hosts.yml` for the `oauth_token` under `github.com`.

Example:
```bash
curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/pulls \
  -d '{"title":"...","body":"...","head":"<branch>","base":"<base_branch>"}'
```

## Must

- push branch if needed
- resolve the base branch from `workspace.yaml -> repos[].base_branch` for the task's repo (required; unset is an error)
- create PR against that explicit base branch using the GitHub REST API (not `gh` CLI)
- update task PR metadata
- append task log entry
- avoid duplicate PR creation
