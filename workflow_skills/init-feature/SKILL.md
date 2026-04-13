---
name: init-feature
description: Create a new feature folder using the canonical feature templates from the shared `workflow` root.
---

## Environment

### Required
| Variable | Description |
|---|---|
| `WORKSPACE_ROOT` | Path to the root containing `workflow/templates/`; used to locate feature templates |

---

## Task
Create:
- `product-spec.md`
- `technical-design.md`
- `status.yaml`
- `tasks/`
- `handoffs/`

Use:
- `<WORKSPACE_ROOT>/workflow/templates/feature/`

## Rules
- tasks are stored one YAML file per task
- subtasks remain inside the task file as checklist/log entries
- subtasks do not have their own lifecycle status
- do not create `deployment-checklist.md` too early
