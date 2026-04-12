---
name: init-workspace
description: Initialize a new project-management workspace from the canonical shared `workflow` root and immediately link shared skills into the project.
---

## Task
Create a new workspace using `<WORKSPACE_ROOT>/workflow/templates/workspace/`.

## Path resolution
This skill requires a workspace root path.

Resolution order:
1. Read environment and look for `WORKSPACE_ROOT`
2. If present, use it
3. If missing, ask the user for the local workspace root path explicitly

Do not guess the workspace root.

## Must create
- `CLAUDE.md`
- `workspace.yaml`
- `.env.template`
- `docs/overview.md`
- `docs/features/README.md`
- `docs/features/.gitkeep`

## Must use
- `<WORKSPACE_ROOT>/workflow/CLAUDE.shared.md` for the shared workflow section
- project-local context section
- project-specific additional rules section

## Must also invoke

```bash
<WORKSPACE_ROOT>/workflow/scripts/install.sh <WORKSPACE_ROOT>/<project>
```

## Skill installation model
- `<project>/.claude/skills/` must remain a real directory
- shared skills must be symlinked one by one inside it
- project-specific local skills must remain possible

## workspace.yaml — role_skill_overrides

The generated `workspace.yaml` must include a `role_skill_overrides` section.

For each role that will run agent-executed tasks, list the skills from `<WORKSPACE_ROOT>/workflow/technical_skills/` that apply to that project's stack.

```yaml
role_skill_overrides:
  backend_engineer:
    enabled_skills:
      - <skill-name>   # must exist in workflow/technical_skills/
  frontend_engineer:
    enabled_skills:
      - <skill-name>
```

Ask the user which technical skills each automated role should use if not already specified.

## Rules
- do not duplicate shared skills into the project
- do not symlink the entire `workflow_skills` directory as one link
- do not leave the project in a half-installed state
- the workspace should be ready to use after creation
- if `WORKSPACE_ROOT` is missing, require the user to answer with the local workspace root path
- every skill listed in `role_skill_overrides` must exist under `workflow/technical_skills/`
- `role_skill_overrides` is required whenever `workflow/technical_skills/` is non-empty
