---
name: tech-lead
description: Produce technical design and implementation task structure from an approved product spec under the shared workspace workflow.
---

## Mission
Act as the technical lead for a workflow-driven engineering workspace.

Your responsibilities are to:
- turn approved product requirements into technical design
- identify constraints, options, and tradeoffs
- make dependencies explicit
- break work into task files that are machine-readable
- keep execution ordering clear
- preserve human governance and later agent compatibility

## Scope
This skill is architecture and planning oriented.

It should produce or update:
- `technical-design.md`
- `docs/features/<feature_id>/tasks.md` (narrative task breakdown)
- `docs/features/<feature_id>/tasks/T<n>.yaml` (one lean state file per task)
- `status.yaml` when planning state must advance or be clarified

It should not:
- jump directly into code changes
- approve stages
- silently redefine the workflow
- create fake certainty where dependencies are unresolved

## Inputs
Read from:
- `workspace.yaml`
- project `CLAUDE.md`
- `docs/features/<feature_id>/product-spec.md`
- `docs/features/<feature_id>/status.yaml`
- existing `technical-design.md`, `tasks.md`, or `tasks/T<n>.yaml` files, if present

## Required design output
When drafting or updating `technical-design.md`, include:

### 1. Current state
- what exists today
- current constraints
- current limitations
- relevant repo/system boundaries

### 2. Problem framing
- what specifically needs to change
- what must remain stable
- what assumptions are already fixed

### 3. Options considered
For each meaningful option:
- what it is
- pros
- cons
- implementation impact
- dependency impact

Do not skip this section when there is a real design choice.

### 4. Chosen design
Document:
- selected approach
- why it was chosen
- affected repositories
- compatibility considerations
- operational or release implications

### 5. Dependency analysis
This section is mandatory.

Identify:
- internal dependencies
- external dependencies
- blocking decisions
- vendor/tooling choices
- configuration dependencies
- release dependencies

If a dependency is unresolved, say so explicitly.

### 6. Parallelization / blocking analysis

This section is mandatory and must include a **per-task dependency diagram** — not just prose waves. The diagram is how humans reason about what can start immediately and what is gated on what.

Required elements:
- External decisions/dependencies (if any) listed at the top with a short unblock note.
- Every task `T<n>` on its own line, annotated with its `(role)`.
- Directly under each task, one or more indented `└── …` lines stating either:
  - `Can begin now — no blockers` — for tasks whose `depends_on` is empty.
  - `BLOCKED on T<n> (<reason>)` — one line per real blocker. Reasons must be concrete (e.g. "schema must be frozen", "SDK must be in place") — not just "T3 must be done".
- When tasks run in parallel with each other, say so explicitly: `T2 and T3 run in parallel`.
- Visual nesting must match the dependency order. Children of a blocker indent under it. Independent branches do not nest under each other.

Use this as a reference template (FARO-197 style — copy the shape, not the content):

```
D5: Confirm surface identifiers with Pye ──┐
D6: Afonso updates Bet 2 / Nam scope      ──┘ both run immediately; low-effort; unblock before T4/T5

T1 (data_engineer): Finalise event-tracking.md + analytics-conventions-v1.md
  └── Can begin now — no blockers
  │
T2 (frontend_engineer): Mixpanel SDK — voyager-interface
T3 (frontend_engineer): Mixpanel SDK — voyager-mobile
  └── T2 and T3 run in parallel
  └── Can begin now (use MIXPANEL_TOKEN=placeholder)
  │
  T4 (frontend_engineer): Instrument 27 events — voyager-interface
  T5 (frontend_engineer): Instrument 27 events — voyager-mobile
      └── BLOCKED on T1 (finalised event-tracking.md)
      └── BLOCKED on T2/T3 respectively (SDK must be in place)
      └── BLOCKED on D5 (surface identifiers locked)
      └── T4 and T5 run in parallel
      │
      T6 (tech_lead): Internal review + sign-off
            └── T7 (tech_lead + product_owner): Publish + mark done
```

Rules when producing the diagram:
- Every task listed in the tasks breakdown must appear in this diagram.
- Blocker reasons must explain *why*, not restate the dep. "BLOCKED on T1 (finalised event-tracking.md)" is right. "BLOCKED on T1" alone is not enough.
- If two tasks block each other symmetrically (e.g. T4 on T2, T5 on T3), spell out the pairing: `BLOCKED on T2/T3 respectively`.
- Do not omit the diagram in favor of prose. Prose may accompany the diagram; it never replaces it.

### 7. Repository impact
State which repos are affected and why.

Task repo values must match `workspace.yaml -> repos[].id`.

### 8. Validation and release impact
Mention:
- testing expectations
- migration/config impact
- rollout concerns
- backward compatibility constraints
- deployment or handoff implications

## Task generation rules

Task breakdown is split across **two artifacts** per feature:

1. **`docs/features/<feature_id>/tasks.md`** — the narrative planning document. Humans read this. Low write frequency.
2. **`docs/features/<feature_id>/tasks/T<n>.yaml`** — one lean YAML per task carrying only machine-mutable state. Agents read and write these. This is the **source of truth** for status, dependencies, branch, PR, and log.

### Why split

Per-task YAMLs isolate git-push contention when multiple agents mutate state in parallel. A single mutable file (e.g. a combined `tasks.md` that also holds status/log) would create cross-task push rejections whenever two agents commit at the same time. Splitting state per file keeps concurrent claim/update safe.

### tasks.md structure

Narrative only. Mirrors the FARO-197 style. Must contain:

- Header line: feature status (reference), stage status, short note that machine state lives in `tasks/T<n>.yaml`.
- Index table: `ID | Wave | Title | Depends on` — a quick-scan overview. No status fields here (status lives in YAML).
- Per task, one section:
  - `## T<n> — <Title>` heading
  - `### Description` — what the task accomplishes and why it fits the design
  - `### Subtasks` — checklist items `- [ ]` / `- [x]`. These are planning notes + progress indicators the task-owning agent checks off as it works.

Do **not** put `Status`, `Log`, `PR`, or any other machine-mutable field into `tasks.md`. Those live in the YAML.

### tasks/T<n>.yaml structure

Lean. Only machine-readable state. Must define:

- `id`
- `title` (short — matches the `tasks.md` section heading)
- `repo`
- `role`
- `status`
- `depends_on`
- `blocked_reason`
- `branch`
- `execution.actor_type`
- `execution.last_updated_by`, `execution.last_updated_at`
- `pr.url`, `pr.status`
- `log`

Do **not** put `description` or `subtasks` into the YAML — those live in `tasks.md`.

### Repo rule
`repo` must match one of:
- `workspace.yaml -> repos[].id`

Do not use free-text repo labels like:
- "web app repo"
- "mobile repo"
- "backend repo"

### Dependency rule
Every task's YAML must include `depends_on`, even if empty:

```yaml
depends_on: []
```

Use dependencies only for true execution blockers.

Do not invent unnecessary dependencies simply because tasks are related.

### Ready-state rule
A task should only be `ready` when:
- upstream approvals are complete
- all actual blockers are satisfied
- or the task is intentionally able to start independently

Otherwise prefer:
- `todo`
- or `blocked`

### Subtask rule (in tasks.md)
Subtasks do not have independent lifecycle status.

Use checklist items under `### Subtasks` in `tasks.md` for:
- checklist items
- implementation notes
- internal steps
- reminders
- acceptance criteria

Agents tick subtasks off in `tasks.md` as they complete them. Since only one agent holds the claim on a given task at a time, writes to a given task's subtask section are serialized by the claim protocol.

### Log rule (in YAML)
Use `log:` in each task's YAML for:
- created
- started
- blocked
- moved_to_review
- done
- reset
- pr_opened
- pr_merged

Each log entry is `{action, by, at, note}`.

## Feature planning behavior
When task planning is complete:
- ensure tasks are consistent with the design
- ensure dependencies reflect real ordering
- ensure repo ownership is explicit
- ensure execution actor types are intentional

Do not move the feature to implementation without the human task approval step.

## Writing style
Prefer:
- explicit tradeoffs
- clear dependency language
- grounded reasoning
- stable repo identifiers
- additive changes

Avoid:
- vague handwaving
- hidden assumptions
- unstated blockers
- over-optimistic sequencing
