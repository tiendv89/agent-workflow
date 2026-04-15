# Agent Runtime

TypeScript runtime for workflow agents. Agents are stateless, single-activation
workers that scan workspace repositories for eligible tasks, claim one, execute
it inside a tool-use loop, and exit.

## agent.yaml

Every agent host requires an `agent.yaml` configuration file. The schema is
intentionally minimal — agents are uniform full-stack workers with no per-agent
identity, role, skill, or model configuration.

- **Attribution** is derived from `GIT_AUTHOR_EMAIL` in the host's `.env`.
- **Model selection** is driven by `workspace.yaml` `model_policy` and optional
  per-task `### Model overrides` in `tasks.md`.
- **Skill loading** is driven by `### Required skills` in each task's section of
  `tasks.md`.

### Full example

```yaml
watches:
  - git@github.com:mycompany/workspace.git
enabled: true
jitter_max_seconds: 15
budget:
  max_tokens_per_task: 200000
  max_iterations: 3
  suggested_next_step_max_tokens: 2000
log_sink:
  enabled: true
```

### Minimal example

```yaml
watches:
  - git@github.com:mycompany/workspace.git
enabled: true
jitter_max_seconds: 0
budget:
  max_tokens_per_task: 50000
  max_iterations: 1
  suggested_next_step_max_tokens: 500
log_sink:
  enabled: false
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `watches` | `string[]` | Yes | SSH URLs of workspace repos to scan. At least one. |
| `enabled` | `boolean` | Yes | Kill switch. `false` = exit 0 immediately. |
| `jitter_max_seconds` | `integer >= 0` | Yes | Max random jitter before claim commit. |
| `budget.max_tokens_per_task` | `integer >= 1` | Yes | Max tokens per task activation. |
| `budget.max_iterations` | `integer >= 1` | Yes | Max tool-use loop iterations. |
| `budget.suggested_next_step_max_tokens` | `integer >= 1` | Yes | Token budget for next-step synthesis on block. |
| `log_sink.enabled` | `boolean` | Yes | Write JSONL event log per task run. |

### Why no `skills[]` or `models`?

Agents are identical. Skill requirements are declared per-task in `tasks.md`
(`### Required skills`), and the runtime loads them dynamically from
`workflow/technical_skills/` at execution time.

Model selection is centralized in `workspace.yaml` `model_policy` with optional
per-task overrides in `tasks.md` (`### Model overrides`). This gives the
workspace owner centralized cost control while allowing task-level customization
when reviewed during task approval.

## Development

```bash
npm install
npm run build
npm test
```
