# Agent-runtime local quickstart

Run two agents locally against your workspace in under 10 minutes.

## Prerequisites

- Docker 24+ with Buildx (`docker buildx version`)
- Docker Compose v2 (`docker compose version`)
- An SSH key with read/write access to your workspace repo(s)
- An Anthropic API key
- A GitHub personal access token (`GITHUB_TOKEN`) with `repo` scope — needed by the `pr-create` skill

## 1. Build the image

Run from the **`workflow/` root** (one level above `agent-runtime/`):

```bash
# Standard build (amd64)
docker build -f agent-runtime/Dockerfile -t agent-runtime:local .

# If Go 1.25 is not yet published on go.dev/dl, override the version:
docker build -f agent-runtime/Dockerfile \
  --build-arg GO_VERSION=1.24.2 \
  -t agent-runtime:local .

# Apple Silicon (arm64):
docker buildx build \
  --platform linux/arm64 \
  -f agent-runtime/Dockerfile \
  -t agent-runtime:local \
  --load .
```

The image includes Node 20, Python 3.12, and Go 1.25. Expect a ~800 MB image and a 3–5 minute build on first run (cached on subsequent builds).

## 2. Configure

```bash
cd agent-runtime/orchestration

# Create the env file
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY and GIT_AUTHOR_EMAIL

# Create your agent config
cp agent.yaml.example agent.yaml
# Edit agent.yaml — set watches: to your workspace repo SSH URL
```

**Minimal `agent.yaml`:**

```yaml
watches:
  - git@github.com:your-org/your-workspace.git
enabled: true
jitter_max_seconds: 2
budget:
  max_tokens_per_task: 100000
  max_iterations: 30
log_sink:
  enabled: true
```

**Minimal `.env`:**

```env
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...        # GitHub PAT with repo scope — required by pr-create skill
GIT_AUTHOR_EMAIL=you@example.com
GIT_AUTHOR_NAME=Agent Bot

# SSH key — paste the raw PEM content (preferred):
SSH_PRIVATE_KEY=-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----

# Or point to a key file inside the container (file-mount mode):
# SSH_KEY_DIR=~/.ssh
```

## 3. Run two agents

From **`agent-runtime/orchestration/`**:

```bash
docker compose --profile dev up
```

Or from the **`workflow/` root**:

```bash
docker compose -f agent-runtime/orchestration/docker-compose.yml --profile dev up
```

Both agents share the same workspace clone volume. They will:
1. Bootstrap — clone your watched workspace and validate `agent.yaml`.
2. Scan for `ready` tasks whose dependencies are met.
3. Race to claim a task via git push (SHA-based contention — one wins, one retries).
4. Run the claimed task through the Anthropic tool-use loop.
5. Exit. (Each container is a single activation cycle.)

## 4. Watch the output

Events are emitted as JSON lines to stdout. Useful patterns to watch:

```bash
# Follow both agents, pretty-print JSON
docker compose --profile dev logs -f \
  | jq -R 'try fromjson catch .'

# See only claim events
docker compose --profile dev logs | grep '"type":"task_claimed\|claim_lost"'
```

Key event types:

| Event | Meaning |
|---|---|
| `bootstrap_started` | Agent pulled repos, config valid |
| `skill_reference_audit` | A skill slug in `tasks.md` has no matching `technical_skills/` dir |
| `task_claimed` | This agent won the claim race |
| `claim_lost` | Another agent claimed first; this agent idles |
| `no_eligible_tasks` | No ready tasks found (all done, blocked, or skill-missing) |
| `task_run_complete` | Task finished (check `outcome` field) |
| `activation_idle` | Nothing to do this cycle |

## 5. Rebuild after code changes

```bash
docker compose --profile dev up --build
```

Or build separately then run:

```bash
# From workflow/ root:
docker build -f agent-runtime/Dockerfile -t agent-runtime:local .

# Then from orchestration/:
docker compose --profile dev up
```

## 6. Reset workspace clones

The `workspaces` Docker volume persists between runs (so re-cloning is fast). To force a full re-clone:

```bash
docker compose --profile dev down -v
```

## Production supervisor

To run a persistent 5-minute-cadence supervisor loop using the published GHCR image:

```bash
docker compose --profile prod up -d
```

See `orchestration/docker-compose.yml` for the full supervisor configuration, and `orchestration/kubernetes/`, `orchestration/systemd/`, and `orchestration/github-actions/` for other deployment targets.

## Troubleshooting

**`bootstrap_failed` with `reason: agent_yaml_invalid`**
Check your `agent.yaml` against `agent.yaml.example` — a missing field (e.g. `jitter_max_seconds`) will cause exit code 2.

**`pr-create` skill fails or PRs are not created**
The `pr-create` skill requires a GitHub personal access token with `repo` scope.
Verify:
- `GITHUB_TOKEN` is set in `.env` (not empty)
- The token has `repo` scope — the built-in GHA `GITHUB_TOKEN` may lack write access to your target repo; use a dedicated PAT
- The token has not expired

**`bootstrap_failed` with `reason: git_workspace_sync_failed`**
The SSH key can't reach your workspace repo. Verify:
- `SSH_PRIVATE_KEY` in `.env` contains the full PEM key (including `-----BEGIN` / `-----END` lines)
- Or `SSH_KEY_DIR` points to a directory containing `id_rsa` (file-mount mode)
- The key is added to your GitHub account
- The URL in `agent.yaml` `watches:` is an SSH URL (`git@github.com:...`)

**Both agents show `no_eligible_tasks`**
All tasks in your workspace are either `todo` (deps not met), `in_progress`, `done`, or blocked on a missing skill. Check `list-features` in your workspace for current state.

**`skill_reference_audit` warnings**
A `### Required skills` entry in `tasks.md` doesn't match any directory under `workflow/technical_skills/`. The agent skips that task (non-fatal). Fix the slug or create the skill directory.

**Go 1.25 download fails during build**
Go 1.25 may not yet be published. Override: `--build-arg GO_VERSION=1.24.2`.

See [DOCKER.md](./DOCKER.md) for the full environment variable reference.
