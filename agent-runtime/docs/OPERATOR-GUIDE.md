# Operator Guide — agent-runtime

This guide covers everything an operator needs to deploy, configure, and maintain an agent-runtime fleet.

For local development setup see [QUICKSTART.md](../QUICKSTART.md).
For the full environment variable reference see [DOCKER.md](../DOCKER.md).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Deployment targets](#2-deployment-targets)
3. [Environment variables](#3-environment-variables)
4. [agent.yaml reference](#4-agentyaml-reference)
5. [Kill switch](#5-kill-switch)
6. [Log locations](#6-log-locations)
7. [Model policy configuration](#7-model-policy-configuration)
8. [Handling blocked tasks](#8-handling-blocked-tasks)
9. [Escalation triage flow](#9-escalation-triage-flow)
10. [Multi-agent concurrency](#10-multi-agent-concurrency)
11. [Updating the image](#11-updating-the-image)

---

## 1. Prerequisites

| Requirement | Minimum version |
|---|---|
| Docker | 24+ |
| SSH key | Ed25519 or RSA 4096; added to GitHub account |
| Anthropic API key | Any valid `sk-ant-...` key with sufficient quota |
| Git | 2.30+ on any host that builds the image |

The agent-runtime container packages Node 20, Python 3.12, and Go 1.25. No additional runtimes are needed on the host.

---

## 2. Deployment targets

### 2a. Single-command host setup (quickest)

```bash
bash agent-runtime/scripts/bootstrap-agent-host.sh
```

The script installs Docker (if absent), pulls the image, collects credentials interactively, writes a starter `agent.yaml`, and prints Docker Compose commands to start the agent.

See comments at the top of `bootstrap-agent-host.sh` for non-interactive and dry-run options.

### 2b. Kubernetes Deployment

```bash
# 1. Edit the ConfigMap (watches list) and Secret (keys) in the manifest
vim agent-runtime/orchestration/kubernetes/deployment.yaml

# 2. Apply
kubectl apply -f agent-runtime/orchestration/kubernetes/deployment.yaml
```

Key settings in the manifest:
- `replicas: 1` — one long-running pod per Deployment
- `idle_sleep_seconds: 60` in ConfigMap — poll interval between cycles
- Liveness probe — K8s restarts the pod if the node process exits unexpectedly
- PVC (5 Gi ReadWriteOnce) — persists workspace clones across pod restarts

For multiple agents, deploy additional Deployments in separate namespaces with distinct `GIT_AUTHOR_EMAIL` values.

### 2c. Docker Compose — local / self-hosted

```bash
cd agent-runtime/orchestration/local
cp .env.example .env               # fill in ANTHROPIC_API_KEY and GIT_AUTHOR_EMAIL
cp agent.yaml.example agent.yaml   # set watches: to your workspace SSH URL
docker compose up -d
```

Each agent runs a continuous internal polling loop (`idle_sleep_seconds` controls the cadence). `restart: unless-stopped` provides crash recovery only.

To run multiple agents, start compose stacks on multiple hosts or uncomment `agent-2` in `docker-compose.yml`.

### 2d. Scheduled GitHub Actions

See `orchestration/github-actions/scheduled.yml`. Suitable for very small deployments where a dedicated host is not available.

Limitations: GHA scheduled workflows may be delayed under load; minimum cadence is 5 minutes; no persistent volume (workspace clone is cached via `actions/cache`).

---

## 3. Environment variables

Set these in `.env` (Docker Compose) or as Kubernetes Secrets.

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (`sk-ant-...`) |
| `GIT_AUTHOR_EMAIL` | Yes | Recorded in task log entries and claim commits |
| `GIT_AUTHOR_NAME` | No | Display name for commits. Default: `GIT_AUTHOR_EMAIL` |
| `AGENT_YAML_PATH` | Yes | Path to `agent.yaml` inside the container |
| `WORKFLOW_LOCAL_PATH` | Yes | Path to the cloned workflow repo inside the container |
| `WORKSPACES_ROOT` | Yes | Root directory for watched workspace clones |
| `SSH_KEY_PATH` | No | Path to the SSH private key inside the container. Required for private repos. |
| `WORKFLOW_URL` | No | SSH URL for the workflow repo. Required on first run if `WORKFLOW_LOCAL_PATH` doesn't exist. |
| `AGENT_IMAGE` | No | Image to pull (GHA only). Default: `ghcr.io/tiendv89/agent-runtime:latest` |

---

## 4. agent.yaml reference

```yaml
# SSH URLs of workspace management repos to watch.
# One entry per workspace; the agent scans all of them each activation.
watches:
  - git@github.com:your-org/your-workspace.git

# Kill switch — set to false to pause without removing the container.
enabled: true

# Pre-claim jitter: random(50ms, min(500ms, jitter_max_seconds * 1000)).
# Reduces collision rate when multiple agents wake up simultaneously.
jitter_max_seconds: 2

budget:
  # Maximum cumulative tokens (input + output) per task run.
  # Exceeding this blocks the task with blocked_reason: budget_exceeded.
  max_tokens_per_task: 100000

  # Maximum tool-use loop iterations per task run.
  # Exceeding this blocks the task with blocked_reason: iteration_cap_exceeded.
  max_iterations: 30

log_sink:
  # Write a JSONL run log to docs/features/<featureId>/logs/<runId>.jsonl
  # on the task's feature branch.
  enabled: true

# Seconds to sleep between poll cycles when no eligible task is found,
# and after a successful task run. Controls how frequently the agent checks
# for new work.
# Set to 0 for single-shot mode: exit after one cycle (for external schedulers).
# Default when omitted: 60
idle_sleep_seconds: 60
```

---

## 5. Kill switch

To pause all agents without stopping containers:

```bash
# In agent.yaml, set:
enabled: false
```

Agents check `enabled` on every activation. A disabled agent emits `bootstrap_ready` and exits 0 immediately — no tasks are claimed.

To resume, set `enabled: true`. Agents pick it up on the next activation cycle.

For an emergency hard-stop, stop the container/pod:

```bash
# Docker Compose (local)
docker compose stop agent-1

# Kubernetes
kubectl scale deployment agent-runtime -n agent-runtime --replicas=0
# Or delete the Deployment entirely:
kubectl delete deployment agent-runtime -n agent-runtime
```

---

## 6. Log locations

### Structured JSON events (stdout)

Every container run emits JSON lines to stdout. Key event types:

| Event type | Meaning |
|---|---|
| `bootstrap_started` | Config valid, git sync beginning |
| `bootstrap_failed` | Config invalid or git sync failed — check `reason` field |
| `workspace_cloned` | First-time clone of a watched repo |
| `workspace_pulled` | Existing clone reset to origin |
| `skill_reference_audit` | A `### Required skills` slug has no matching `technical_skills/` dir |
| `task_skipped_missing_skill` | Task excluded from eligibility due to missing skill |
| `task_claimed` | This agent won the claim race |
| `claim_lost` | Another agent claimed the task first |
| `no_eligible_tasks` | No ready tasks with satisfied dependencies |
| `task_run_complete` | Task loop finished — check `outcome` field |
| `activation_idle` | Nothing to do this cycle; sleeping `idle_sleep_seconds` |
| `activation_complete` | Task ran this cycle; sleeping `idle_sleep_seconds` before next |
| `poll_git_halt` | Non-transient pull failure; workspace skipped this cycle |
| `poll_git_warn` | Transient pull failure; workspace skipped, retried next cycle |

To stream events:

```bash
# Docker Compose (local)
docker compose logs -f agent-1

# Kubernetes
kubectl logs -n agent-runtime -l app=agent-runtime -f
```

To filter:

```bash
# Docker Compose
docker compose logs -f agent-1 | jq -R 'try fromjson | select(.type == "task_claimed")'

# Kubernetes
kubectl logs -n agent-runtime -l app=agent-runtime -f | jq -R 'try fromjson | select(.type == "task_claimed")'
```

### JSONL run logs (git)

When `log_sink.enabled: true`, the agent writes a per-run JSONL file to:

```
docs/features/<featureId>/logs/<runStartIso>-<taskId>.jsonl
```

This file is committed to the task's feature branch and pushed. It contains `task_work_iteration` events with token counts, model, cache hits, and tool calls for each Anthropic API round-trip.

To inspect the latest log for a task:

```bash
git fetch origin feature/my-feature-T5
git show origin/feature/my-feature-T5:docs/features/my-feature/logs/ | tail -1 | xargs git show HEAD:
```

---

## 7. Model policy configuration

The agent resolves which Claude model to use for each phase of a task run. Resolution is a three-layer merge:

```
workspace.yaml model_policy (base)
  + tasks.md ### Model overrides section (per task)
  = effective model for this task + phase
```

### workspace.yaml model_policy

Defines allowed models and defaults for each phase:

```yaml
model_policy:
  implementation:
    allowed: [claude-sonnet-4-6]
    default: claude-sonnet-4-6
  self_review:
    allowed: [claude-sonnet-4-6]
    default: claude-sonnet-4-6
  pr_description:
    allowed: [claude-haiku-4-5-20251001]
    default: claude-haiku-4-5-20251001
  suggested_next_step:
    allowed: [claude-haiku-4-5-20251001]
    default: claude-haiku-4-5-20251001
```

### tasks.md per-task model override

Inside a `## T<n>` section of `tasks.md`, add a `### Model overrides` subsection:

```markdown
## T7 — Complex refactor

### Model overrides
implementation: claude-opus-4-6
```

The agent reads this at run time and substitutes the override model for the specified phase, provided it is in the workspace's `allowed` list. If the model is not allowed, the task is blocked with `blocked_reason: model_escalation_requested`.

---

## 8. Handling blocked tasks

When a task is blocked, `task.yaml` contains:

```yaml
status: blocked
blocked_reason: <reason>    # budget_exceeded | iteration_cap_exceeded | no_progress |
                             # model_escalation_requested | skill_missing | runtime_error
blocked_details: { ... }    # context (token counts, iteration number, error message, etc.)
execution:
  suggested_next_step: "..."  # Haiku-generated one-sentence triage hint
```

### Budget exhausted (`budget_exceeded`)

Increase `max_tokens_per_task` in `agent.yaml`, then reset the task to `ready`:

```yaml
# In T<n>.yaml
status: ready
blocked_reason: null
```

### Iteration cap hit (`iteration_cap_exceeded`)

Check the run log for `task_work_iteration` events — look for repeated tool calls. Either simplify the task description, increase `max_iterations`, or split the task.

### No-progress loop (`no_progress`)

The agent called identical tools 3 iterations in a row. Check `blocked_details.repeated_calls`. The task description may be ambiguous. Clarify it in `tasks.md`, then reset to `ready`.

### Missing skill (`skill_missing`)

Create the missing skill directory under `workflow/technical_skills/<slug>/` and add a `SKILL.md`. Reset the task to `ready` once the skill exists.

### Runtime error (`runtime_error`)

Check `blocked_details.error` and `blocked_details.stack`. This is an agent bug or environment issue. Fix the underlying cause and reset to `ready`.

---

## 9. Escalation triage flow

When the agent calls the `escalate` tool (indicating the current model is insufficient), the task is blocked with `blocked_reason: model_escalation_requested` and `blocked_details.current_model`.

**Triage steps:**

1. Read `blocked_details.reason` in `task.yaml` to understand what the agent could not accomplish.
2. In `tasks.md`, add (or update) a `### Model overrides` subsection for the task:
   ```markdown
   ## T<n> — Task title

   ### Model overrides
   implementation: claude-opus-4-6
   ```
3. Reset the task to `ready` in `task.yaml`:
   ```yaml
   status: ready
   blocked_reason: null
   ```
4. Commit and push the change to the management repo's main branch.
5. The agent picks it up on the next activation and re-runs with the upgraded model.

If the higher-tier model also escalates, the task likely requires human implementation. Set `execution.actor_type: human` in the task YAML.

---

## 10. Multi-agent concurrency

The git-based claim protocol uses commit-SHA contention: all agents race to push a claim commit; the first fast-forward wins. Losers detect the loss via SHA comparison and move to the next eligible task.

**Recommendations:**

- Run agents with distinct `GIT_AUTHOR_EMAIL` values to make logs readable. The claim protocol works correctly even with shared emails (SHA is the arbiter, not identity).
- Set `jitter_max_seconds: 2` (or higher for large fleets) to desynchronise agents that wake up at the same moment after sleeping.
- For a 2-agent local setup, uncomment `agent-2` in `orchestration/local/docker-compose.yml` and re-run `docker compose up`.
- For N-agent production on Kubernetes, deploy N Deployments in separate namespaces, each with a distinct `GIT_AUTHOR_EMAIL`.

---

## 11. Updating the image

For Docker Compose and Kubernetes deployments:

```bash
# Manual pull (then recreate the container / roll the Deployment)
docker pull ghcr.io/tiendv89/agent-runtime:latest

# Docker Compose — rebuild and restart
docker compose up --build -d

# Kubernetes — trigger a rollout (imagePullPolicy: Always pulls on each pod start)
kubectl rollout restart deployment/agent-runtime -n agent-runtime

# Pin to a specific SHA (recommended for production)
docker pull ghcr.io/tiendv89/agent-runtime@sha256:<digest>
# Update the image field in deployment.yaml and re-apply:
kubectl apply -f agent-runtime/orchestration/kubernetes/deployment.yaml
```

To rebuild locally after a code change:

```bash
# From the workflow/ root
docker build -f agent-runtime/Dockerfile -t agent-runtime:local .
```
