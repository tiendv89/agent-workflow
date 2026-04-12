---
name: sync-workspace-rules
description: Synchronize the shared workflow rules from the canonical shared `workflow` root into a project `CLAUDE.md` and verify/repair per-skill shared symlinks.
---

## Task
Update the section between:

<!-- BEGIN SHARED WORKFLOW RULES -->
...
<!-- END SHARED WORKFLOW RULES -->

## Path resolution
This skill requires:
- workspace root path
- project root path

### Workspace root resolution
Resolution order:
1. Read environment and look for `WORKSPACE_ROOT`
2. If present, use it
3. If missing, ask the user for the local workspace root path explicitly

Do not guess the workspace root.

### Project root resolution
Resolution order:
1. Use explicit `project_root` argument if provided
2. Otherwise use the current directory
3. Validate that the selected project root contains:
   - `workspace.yaml`
   - `CLAUDE.md`

If project root cannot be validated, require the user to answer with the project folder path.

## Source
Shared rules source:
- `<WORKSPACE_ROOT>/workflow/CLAUDE.shared.md`

## Must preserve
- project-local context above the shared section
- project-specific additional rules below the shared section

## Symlink verification
After syncing rules, verify that:

```text
<project_root>/.claude/skills/
```

is a real directory and contains per-skill symlinks to:

```text
<WORKSPACE_ROOT>/workflow/workflow_skills/
```

If missing or broken, invoke:

```bash
<WORKSPACE_ROOT>/workflow/scripts/install.sh <project_root>
```

## role_skill_overrides verification

After syncing rules and symlinks, verify that `workspace.yaml` contains `role_skill_overrides`.

For each role listed under `role_skill_overrides`, verify that every skill in `enabled_skills` exists as a directory under:

```text
<WORKSPACE_ROOT>/workflow/technical_skills/
```

If any skill is missing from `technical_skills/`, report it to the user — do not silently skip it.

If `role_skill_overrides` is absent and `technical_skills/` is non-empty, warn the user that it is required.

## Rules
- do not mutate project-specific rules
- do not copy shared skills into the project
- do not replace the entire `workflow_skills` directory with one symlink
- use install.sh as the repair path for per-skill linkage
- if `WORKSPACE_ROOT` is missing, require the user to answer with the local workspace root path
- if `project_root` cannot be validated, require the user to answer with the project folder path
- every skill in `role_skill_overrides.*.enabled_skills` must exist under `workflow/technical_skills/`
