# Shared workflow rules

## Feature lifecycle

Features follow this lifecycle:

- in_design
- in_tdd
- ready_for_implementation
- in_implementation
- in_handoff
- done
- blocked
- cancelled

## Stage review status values

- draft
- awaiting_approval
- approved
- rejected

## Task status values

- todo
- ready
- in_progress
- blocked
- in_review
- done
- cancelled

## Workflow

1. Product owner produces `product-spec.md`
2. Human approves or rejects product spec
3. Tech lead uses `plan-first` to produce `technical-design.md`
4. Human approves or rejects technical design
5. Task breakdown is produced as one YAML file per task under `docs/features/<feature_id>/tasks/`
6. Human approves or rejects tasks
7. Teams execute tasks in their real implementation repos
8. Handoffs are recorded under `handoffs/`
9. Human approves final handoff

## Task structure rules

- Tasks are stored as one YAML file per task under `docs/features/<feature_id>/tasks/`
- Subtasks are recorded inside the parent task file as checklist/log entries
- Subtasks do not have their own lifecycle status
- Task lifecycle status exists only at the task file level
- One task changes one repository only
- `repo` must match `workspace.yaml -> repos[].id`
- Every task must define:
  - `status`
  - `depends_on`
  - `execution.actor_type`
  - `branch`

## Task log rules

- Every task state change should be recorded in the task file `log`
- Both humans and agents append task log entries when they mutate task state
- Marking a task `done` requires a human log entry

## Dependency rules

- Every task must define `depends_on` (use `[]` if none)
- A task can only start when:
  - its status is `ready`
  - all tasks in `depends_on` are `done`
- This rule is enforced by `start-implementation`

## Execution rules

Each task must define:

```yaml
execution:
  actor_type: human | agent | either
```

## Review boundary

- Agents may move work to `in_review`
- Humans review, validate, and decide whether work becomes `done`
- Agents do not approve stages
- Agents do not mark tasks `done`

## Start rule

- Tasks marked `ready` are eligible for execution
- Execution must begin through `start-implementation`

## Reset / rollback rule

- Stage resets preserve artifacts
- Downstream artifacts are marked for revalidation, not deleted

## Environment resolution rules

- Before any repo operation, the operator or agent must read the project `.env` file if it exists.
- Workflow-relevant environment values should be resolved from the project `.env` first.
- If a required value is missing from `.env`, the workflow must ask the user instead of guessing.

## Required environment values

Typical required values:

- `WORKSPACE_ROOT`
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`
- `GITHUB_ACCOUNT`
- `SSH_KEY_PATH`

## Git / SSH rules

- Repository operations must use the SSH key configured in project `.env` through `SSH_KEY_PATH`
- Do not assume the default SSH key is correct
- If `SSH_KEY_PATH` is missing, require the user to provide it
- If a repo requires SSH auth, the workflow should use the resolved `SSH_KEY_PATH` explicitly

## Shared environment resolution rule

- Workflow skills that perform repo, git, PR, or SSH-related work must use `resolve-project-env`
- `resolve-project-env` is the shared contract for reading project `.env`
- Required values must be resolved from project `.env` first
- If required values are missing, the workflow must ask the user explicitly instead of guessing

## SSH rule

- SSH-based git access must use `SSH_KEY_PATH` resolved through `resolve-project-env`
- Do not assume the default SSH key is correct

## Role skill overrides

Each project's `workspace.yaml` must declare `role_skill_overrides` for every role that will run agent-executed tasks.

`role_skill_overrides` maps each role to the specific skills from `technical_skills/` that apply to that project's stack.

Example:

```yaml
role_skill_overrides:
  backend_engineer:
    enabled_skills:
      - go-best-practices
      - postgres-best-practices
  frontend_engineer:
    enabled_skills:
      - nextjs-best-practices
      - typescript-best-practices
      - react-native-mobile-engineer-skill
      - browser-qa-frontend
      - heroui-react
  data_engineer:
    enabled_skills:
      - python-data
      - python-best-practices
      - airflow-3
```

Rules:

- Every skill listed under `enabled_skills` must exist as a directory under `<WORKSPACE_ROOT>/workflow/technical_skills/`
- Roles not listed in `role_skill_overrides` inherit no technical skill context
- `role_skill_overrides` is required whenever `technical_skills/` is non-empty
- Do not list workflow skills here — only technical skills belong in `role_skill_overrides`

## Product-spec phase write boundary

During the `product_spec` stage, agents must not write or modify any file outside the feature's `product-spec.md`.

If workspace-level changes are discovered as needed (e.g. missing repo entries, config typos, new skills, rule updates), the agent must **stop and list them explicitly for the human** instead of applying them. The human decides whether to apply them before or after the product spec is approved.

Examples of changes that must be surfaced, not applied:
- Edits to `workspace.yaml`, `CLAUDE.md`, `.env`, `.env.template`
- Creating or modifying skills under `technical_skills/`
- Registering new repos or roles
- Any file outside `docs/features/<feature_id>/product-spec.md`

## Shell command permission policy

The assistant may run read-only inspection commands without asking first when working inside a project repository or workspace.

Examples of allowed read-only commands:

- `pwd`
- `ls`
- `find`
- `grep`
- `rg`
- `cat`
- `head`
- `tail`
- `git status`
- `git branch`
- `git diff --stat`

The assistant must still ask before running commands that:

- modify files
- delete files
- move files
- change permissions
- push to remote
- create or merge branches
- deploy infrastructure or applications
