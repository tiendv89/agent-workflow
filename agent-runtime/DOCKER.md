# Agent-runtime Docker contract

## Build

Build context is the `workflow/` root (one level up from `agent-runtime/`):

```bash
# From workflow/ root:
docker build -f agent-runtime/Dockerfile -t agent-runtime:local .

# Override Go version (e.g. if 1.25 not yet released):
docker build -f agent-runtime/Dockerfile --build-arg GO_VERSION=1.24.2 -t agent-runtime:local .

# Multi-platform:
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f agent-runtime/Dockerfile \
  -t ghcr.io/tiendv89/agent-runtime:latest \
  --push .
```

## Runtimes included

| Runtime   | Version | Purpose                          |
|-----------|---------|----------------------------------|
| Node.js   | 20      | agent-runtime TypeScript         |
| Python    | 3.12    | Airflow 3.1.3 compatibility      |
| Go        | 1.25    | Go services in operator stack    |

## Required environment variables

| Variable             | Description                                                   |
|----------------------|---------------------------------------------------------------|
| `ANTHROPIC_API_KEY`  | Anthropic API key for the SDK loop                           |
| `GIT_AUTHOR_NAME`    | Git commit identity — shown in task log entries              |
| `GIT_AUTHOR_EMAIL`   | Git commit identity — used as the `by` field in log events   |
| `AGENT_YAML_PATH`    | Path to `agent.yaml` inside the container (default: `/agent/agent.yaml`) |
| `WORKFLOW_LOCAL_PATH`| Path to the workflow repo clone (default: `/workflow`)        |
| `WORKSPACES_ROOT`    | Root under which watched workspaces are cloned (default: `/agent/data`) |

## Optional environment variables

| Variable           | Default | Description                                                                                             |
|--------------------|---------|----------------------------------------------------------------------------------------------------------|
| `SSH_PRIVATE_KEY`  | —       | Raw PEM content of the SSH private key. Written to `/tmp/agent_id_rsa` (0400) at startup. **Preferred** for K8s, GitHub Actions, and CI environments where secrets are env vars. |
| `SSH_KEY_PATH`     | —       | Path to an SSH private key file already present in the container. Used as fallback when `SSH_PRIVATE_KEY` is not set. Suitable for Docker Compose with `~/.ssh` volume mount. |
| `WORKFLOW_URL`     | —       | SSH URL of the workflow repo — cloned on first run if `WORKFLOW_LOCAL_PATH` is empty.                   |

## Volume mounts

| Mount path        | Mode | Description                                                                 |
|-------------------|------|-----------------------------------------------------------------------------|
| `/agent/agent.yaml` | ro | Agent configuration file                                                   |
| `/agent/data/`    | rw   | Workspace clone root — bootstrap writes here                                |
| `/agent/ssh/`     | ro   | SSH key directory — only needed when using `SSH_KEY_PATH` (file-mount mode) |

Typical `docker run` (SSH key via env var — preferred):

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GIT_AUTHOR_NAME="Agent Bot" \
  -e GIT_AUTHOR_EMAIL="agent@example.com" \
  -e SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)" \
  -v /path/to/agent.yaml:/agent/agent.yaml:ro \
  -v /path/to/workspaces:/agent/data \
  ghcr.io/tiendv89/agent-runtime:latest
```

Alternative — SSH key via file mount (Docker Compose / local use):

```bash
docker run --rm \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GIT_AUTHOR_NAME="Agent Bot" \
  -e GIT_AUTHOR_EMAIL="agent@example.com" \
  -e SSH_KEY_PATH="/agent/ssh/id_rsa" \
  -v /path/to/agent.yaml:/agent/agent.yaml:ro \
  -v /path/to/workspaces:/agent/data \
  -v ~/.ssh:/agent/ssh:ro \
  ghcr.io/tiendv89/agent-runtime:latest
```

## Exit codes

| Code | Meaning                              |
|------|--------------------------------------|
| `0`  | Normal exit (task ran, idle, or kill-switch active) |
| `2`  | `agent.yaml` failed validation       |
| `3`  | Git clone / pull failed              |
| `4`  | Unexpected fatal error               |

## Single-run semantics

The container performs **one activation cycle** and exits. Scheduling (cron, k8s CronJob, systemd timer) is external — see `orchestration/` for templates.

Sequence per run:

1. Bootstrap: validate `agent.yaml`, clone/pull watched workspaces and workflow repo.
2. Eligibility: scan all watched workspaces for `ready` tasks whose dependencies are met, required skills exist, and repo is reachable.
3. Claim: atomically claim the first eligible task via git commit + push (SHA-based contention).
4. Run: execute the task via the Anthropic tool-use loop with budget enforcement.
5. Flush logs: write the JSONL event log and push to the task's feature branch.
6. Exit.

If no eligible task is found, the container exits `0` (idle cycle).

## Kill switch

Set `enabled: false` in `agent.yaml` to disable the agent. The container will exit `0` within ~1 second without performing any git operations.

## Log destinations

- **Structured bootstrap/eligibility events**: stdout (one JSON object per line).
- **Task run telemetry**: `docs/features/<feature_id>/logs/<task_id>_<ISO>.jsonl` on the task's feature branch in the management workspace repo (when `log_sink.enabled: true` in `agent.yaml`).

## Image size

The image is a fat multi-runtime image. Approximate sizes:

| Layer          | Approximate size |
|----------------|------------------|
| Python 3.12 base | ~125 MB       |
| Node 20        | ~80 MB           |
| Go 1.25        | ~500 MB          |
| git + tools    | ~30 MB           |
| app (dist + modules) | ~60 MB   |
| **Total**      | **~800 MB**      |

To reduce size, strip Go's bundled test files (`go clean -cache`) or use a separate slim image per language task if image size is a constraint.
