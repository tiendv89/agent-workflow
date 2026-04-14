# Troubleshooting — agent-runtime

Quick-reference for diagnosing common agent-runtime failures. Each section starts with the observable symptom, followed by diagnostic steps and the fix.

---

## Contents

- [Task stuck in `in_progress` (stale claim)](#task-stuck-in-in_progress-stale-claim)
- [Missing skill — task never claimed](#missing-skill--task-never-claimed)
- [Skill missing during execution](#skill-missing-during-execution)
- [Budget exhausted](#budget-exhausted)
- [Iteration cap exceeded](#iteration-cap-exceeded)
- [No-progress loop](#no-progress-loop)
- [Runtime error](#runtime-error)
- [Model escalation requested](#model-escalation-requested)
- [Model fallback events](#model-fallback-events)
- [SSH key misconfiguration](#ssh-key-misconfiguration)
- [GIT_AUTHOR_EMAIL conflicts](#git_author_email-conflicts)
- [Bootstrap failed — git sync](#bootstrap-failed--git-sync)
- [Image pull failures](#image-pull-failures)
- [Docker socket permission denied](#docker-socket-permission-denied)
- [Task YAML parse error](#task-yaml-parse-error)
- [Log sink not writing](#log-sink-not-writing)

---

## Task stuck in `in_progress` (stale claim)

**Symptom:** A task has `status: in_progress` but no agent is actively working on it. The task is invisible to the eligibility filter because `status !== "ready"`.

**Cause:** The agent container was killed mid-run (OOM, timeout, node killed, k8s pod eviction) after the claim commit was pushed but before the task was marked `blocked` or `in_review`.

**Diagnosis:**

```bash
# Check the task's last log entry
cat docs/features/<featureId>/tasks/T<n>.yaml | grep -A5 'log:'

# Check for a matching feature branch
git log origin/feature/<featureId>-T<n> --oneline | head
```

If the last log action is `started` and the branch has no implementation commits, the agent died during or immediately after claiming.

**Fix:**

```yaml
# In T<n>.yaml, reset to ready:
status: ready
blocked_reason: null
```

Commit and push to main. The task re-enters the eligibility pool on the next activation.

---

## Missing skill — task never claimed

**Symptom:** `task_skipped_missing_skill` events in the logs; the task remains `ready` indefinitely.

**Diagnosis:**

```bash
# Check what skill is referenced
grep -A5 "### Required skills" docs/features/<featureId>/tasks.md

# Check what skill dirs exist
ls workflow/technical_skills/
```

**Fix:**

Create the missing skill directory and a `SKILL.md` file:

```bash
mkdir -p workflow/technical_skills/<slug>
cat > workflow/technical_skills/<slug>/SKILL.md <<'EOF'
# <slug>

<Description of what this skill enables the agent to do.>
EOF

git add workflow/technical_skills/<slug>/
git commit -m "feat: add <slug> skill"
git push
```

The agent picks up the new skill on the next bootstrap (no task reset needed).

---

## Skill missing during execution

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: skill_missing`. This is distinct from the pre-claim `task_skipped_missing_skill` event — the task was claimed but the skill directory was not found on the filesystem at run time.

**Cause:** The skill slug declared in `tasks.md → ### Required skills` exists in the eligibility index but the corresponding directory under `workflow/technical_skills/<slug>/` is absent from the cloned workflow repo (e.g. the skill was added to the index but the directory was never committed).

**Diagnosis:**

```bash
# Check what skill the task requires
grep -A5 "### Required skills" docs/features/<featureId>/tasks.md

# Check what skill dirs are present in the cloned workflow repo
ls workflow/technical_skills/
```

**Fix:**

Create the missing skill directory and `SKILL.md`, commit and push:

```bash
mkdir -p workflow/technical_skills/<slug>
echo "# <slug>" > workflow/technical_skills/<slug>/SKILL.md
git add workflow/technical_skills/<slug>/
git commit -m "feat: add <slug> skill"
git push
```

Reset the task:

```yaml
status: ready
blocked_reason: null
```

---

## Budget exhausted

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: budget_exceeded`. `blocked_details` contains `{ totalTokens, max_tokens_per_task }`.

**Diagnosis:**

```bash
# Check how many tokens were used
cat docs/features/<featureId>/tasks/T<n>.yaml | grep -A3 blocked_details
```

Compare `totalTokens` against `max_tokens_per_task` in `agent.yaml`.

For a detailed breakdown, inspect the run log:

```bash
git show origin/feature/<featureId>-T<n>:docs/features/<featureId>/logs/ \
  | tail -1 \
  | xargs -I{} git show origin/feature/<featureId>-T<n>:docs/features/<featureId>/logs/{}
```

**Fix options:**

1. Increase `max_tokens_per_task` in `agent.yaml` (if the task is legitimately large).
2. Split the task into smaller subtasks (preferred for tasks > ~100 k tokens).
3. Add more context in the task description so the agent converges faster.

After adjusting, reset the task:

```yaml
status: ready
blocked_reason: null
```

---

## Iteration cap exceeded

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: iteration_cap_exceeded`. `blocked_details` contains `{ iterations, max_iterations }`.

**Cause:** The agent reached `max_iterations` in `agent.yaml` without completing the task.

**Diagnosis:**

```bash
# Check iteration count vs cap
cat docs/features/<featureId>/tasks/T<n>.yaml | grep -A3 blocked_details

# Inspect the run log for repeated tool calls
git show origin/feature/<featureId>-T<n>:docs/features/<featureId>/logs/ \
  | tail -1 \
  | xargs -I{} git show origin/feature/<featureId>-T<n>:docs/features/<featureId>/logs/{}
```

**Fix options:**

1. Increase `max_iterations` in `agent.yaml` if the task is legitimately long-running.
2. Split the task into smaller subtasks.
3. Clarify the task description in `tasks.md` to help the agent converge faster.

After adjusting, reset:

```yaml
status: ready
blocked_reason: null
```

---

## No-progress loop

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: no_progress`. `blocked_details` contains `{ repeated_calls }`.

**Cause:** The agent called identical tools with identical arguments 3 iterations in a row — a sign the task description is ambiguous or the agent is stuck in a loop.

**Diagnosis:**

Inspect `blocked_details.repeated_calls` in the task YAML for the repeated tool+args pattern. Review the task description in `tasks.md` for ambiguity.

**Fix:**

1. Clarify the task description or acceptance criteria in `tasks.md`.
2. If the task requires a capability the current model lacks, add a `### Model overrides` entry.

Reset the task:

```yaml
status: ready
blocked_reason: null
```

---

## Runtime error

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: runtime_error`. `blocked_details` contains `{ error, stack }`.

**Cause:** An unhandled exception occurred during task execution (agent bug or environment issue). The runtime catches it and sets `blocked` so the task is never left in `in_progress`.

**Diagnosis:**

```bash
# Read the error from the task YAML
cat docs/features/<featureId>/tasks/T<n>.yaml | grep -A5 blocked_details

# Cross-reference with agent logs
journalctl -u agent-runtime.service --output=cat | jq 'select(.type == "task_blocked")'
```

**Fix:** Address the root cause from `blocked_details.error`. This may require a runtime update. Once fixed, reset:

```yaml
status: ready
blocked_reason: null
```

---

## Model escalation requested

**Symptom:** Task YAML has `status: blocked`, `blocked_reason: model_escalation_requested`. `blocked_details` contains `{ reason, current_model, iterations }`.

**Diagnosis:** The agent explicitly called the `escalate` tool. Read `blocked_details.reason` — it is the agent's explanation of why it is blocked by model capability.

**Fix:**

1. In `tasks.md`, add a `### Model overrides` subsection:
   ```markdown
   ## T<n> — Task title

   ### Model overrides
   implementation: claude-opus-4-6
   ```
2. Ensure `claude-opus-4-6` is in the `allowed` list in `workspace.yaml → model_policy.implementation`.
3. Reset the task to `ready`:
   ```yaml
   status: ready
   blocked_reason: null
   ```

If the Opus-tier model also escalates, consider human implementation (`execution.actor_type: human`).

---

## Model fallback events

**Symptom:** Logs contain `model_fallback` events; the agent ran with a different model than expected.

**Cause:** The requested model (from a `### Model overrides` entry in `tasks.md`) is not in the workspace's `allowed` list. The runtime falls back to the workspace default.

**Diagnosis:**

```bash
# Check effective model policy
cat <workspace>/workspace.yaml | grep -A20 model_policy:
```

Compare against the override in `tasks.md`.

**Fix:** Either add the model to `allowed` in `workspace.yaml`, or remove the per-task override.

---

## SSH key misconfiguration

**Symptom:** `bootstrap_failed` event with `reason: git_workspace_sync_failed` or `reason: git_workflow_sync_failed`. The error message contains `Permission denied (publickey)` or `Host key verification failed`.

**Diagnosis:**

```bash
# Test SSH connectivity from the host
GIT_SSH_COMMAND="ssh -i /path/to/id_rsa -o StrictHostKeyChecking=no" \
  git ls-remote git@github.com:your-org/your-workspace.git

# Inside the container
docker run --rm \
  -e SSH_KEY_PATH=/agent/ssh/id_rsa \
  -v /path/to/ssh-dir:/agent/ssh:ro \
  ghcr.io/tiendv89/agent-runtime:latest \
  ssh -i /agent/ssh/id_rsa -T git@github.com
```

Common causes:

| Cause | Diagnostic sign |
|---|---|
| Public key not added to GitHub | `Permission denied (publickey)` |
| Key has a passphrase | `Enter passphrase for key ...` |
| Wrong key file mounted | Key fingerprint doesn't match any GitHub key |
| Key permissions too open | `Permissions ... are too open` |
| `StrictHostKeyChecking` blocks | `Host key verification failed` |

**Fix:**

- Add `SSH_KEY_PATH.pub` content to GitHub → Settings → SSH and GPG keys.
- Remove passphrase: `ssh-keygen -p -f ~/.ssh/id_rsa` (leave new passphrase empty).
- Set correct permissions: `chmod 400 /etc/agent-runtime/ssh/id_rsa`.
- The runtime sets `StrictHostKeyChecking=no` automatically — this should not normally occur unless a custom `GIT_SSH_COMMAND` overrides it.

---

## GIT_AUTHOR_EMAIL conflicts

**Symptom:** Two agents commit with the same `GIT_AUTHOR_EMAIL`. This is not an error — the claim protocol uses commit SHAs, not identities. However, run logs and task history become harder to attribute.

**Fix:** Set a distinct `GIT_AUTHOR_EMAIL` per agent host (e.g. `agent-host-1@your-domain.com`, `agent-host-2@your-domain.com`). The claim protocol continues to work correctly regardless.

---

## Bootstrap failed — git sync

**Symptom:** `bootstrap_failed` event with `reason: git_workspace_sync_failed`.

The agent exits with code 3 (`EXIT_GIT_FAILED`).

**Diagnosis:**

```bash
# Check the details field of the event
journalctl -u agent-runtime.service --output=cat | jq 'select(.type == "bootstrap_failed")'
```

Common causes beyond SSH (see above):

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not resolve host` | Network issue / DNS | Check connectivity from the host |
| `not a git repository` | Workspace dir exists but is not a clone | Delete the dir or fix `WORKSPACES_ROOT` |
| `reference is not a tree` | Branch doesn't exist on remote | Verify `workspaceBaseBranch` (default: `main`) |
| `repository not found` | Wrong URL in `agent.yaml` `watches:` | Correct the SSH URL |

---

## Image pull failures

**Symptom:** `docker pull ghcr.io/tiendv89/agent-runtime:latest` fails.

| Error message | Cause | Fix |
|---|---|---|
| `denied: access forbidden` | Not logged in to GHCR | `docker login ghcr.io -u <github-username> -p <personal-access-token>` |
| `manifest unknown` | Tag doesn't exist | Use `:latest` or check the GitHub Packages page for available tags |
| `no space left on device` | Host disk full | `docker system prune -f` to remove unused images/containers |
| `toomanyrequests` | Rate limit | Wait and retry, or use a personal access token |

---

## Docker socket permission denied

**Symptom:** Supervisor container fails with `Got permission denied while trying to connect to the Docker daemon socket`.

**Cause:** The `supervisor` service mounts `/var/run/docker.sock` but the container user doesn't have access.

**Fix:**

```bash
# Add the docker group to the container user (or run supervisor as root)
# In docker-compose.yml, add:
services:
  supervisor:
    user: root   # or use group_add: [docker] if the image supports it
```

Or set correct socket permissions on the host:

```bash
sudo chmod 666 /var/run/docker.sock   # less secure — prefer group membership
```

---

## Task YAML parse error

**Symptom:** Agent logs contain `eligibility_error` with a YAML parse message.

**Cause:** A task YAML file is malformed — missing required fields, bad indentation, or invalid status value.

**Diagnosis:**

```bash
# Validate the YAML
python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)" < docs/features/<featureId>/tasks/T<n>.yaml
```

**Fix:** Correct the YAML. Required fields: `id`, `title`, `repo`, `status`, `depends_on`, `execution.actor_type`, `branch`, `pr`.

---

## Log sink not writing

**Symptom:** `log_sink.enabled: true` in `agent.yaml` but no JSONL files appear under `docs/features/<featureId>/logs/`.

**Cause:** The log sink writes to the task's feature branch via git commit + push. If the push fails (SSH issue, branch protection, detached HEAD), the file is silently not written.

**Diagnosis:**

```bash
# Check for log sink errors in the agent output
journalctl -u agent-runtime.service --output=cat | jq 'select(.type | startswith("log_sink"))'
```

**Fix:** Ensure the SSH key has push access to the implementation repo and that the feature branch is not protected against direct pushes.
