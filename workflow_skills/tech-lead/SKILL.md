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
- task files under `docs/features/<feature_id>/tasks/`
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
- existing `technical-design.md` or task files, if present

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
Explain:
- what can proceed in parallel
- what must wait
- which tasks are hard blockers
- which work can begin with placeholders or temporary assumptions

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
Task files live at:

`docs/features/<feature_id>/tasks/`

Each task must be one YAML file.

### Required task fields
Every task file must define:
- `id`
- `title`
- `repo`
- `role`
- `status`
- `depends_on`
- `blocked_reason`
- `branch`
- `execution.actor_type`
- `subtasks`
- `log`

### Repo rule
`repo` must match one of:
- `workspace.yaml -> repos[].id`

Do not use free-text repo labels like:
- "web app repo"
- "mobile repo"
- "backend repo"

### Dependency rule
Every task must include `depends_on`, even if empty:

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

### Subtask rule
Subtasks do not have independent lifecycle status.

Use `subtasks:` for:
- checklist items
- implementation notes
- internal steps
- reminders

### Log rule
Use `log:` for:
- created
- started
- blocked
- moved_to_review
- done
- reset
- pr_opened
- pr_merged

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
