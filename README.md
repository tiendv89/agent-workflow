# Shared `workflow` Root

This folder is the canonical shared workflow root for the company.

It combines:
- shared workflow rules
- shared workflow skills (`workflow_skills/`)
- shared technical skills (`technical_skills/`)
- shared templates
- shared schemas
- shared helper scripts

Recommended layout:

```text
/workspace
  /workflow
  /project-A
  /project-B
```

## Getting started (new users)

After cloning, run bootstrap once to make the workflow skills available in Claude Code:

```bash
bash scripts/bootstrap.sh
```

Then open the `workflow/` folder in Claude Code. The `init-workspace` skill and all other workflow skills will be ready to use.

## Project skill installation

Projects consume shared skills through:

```text
/workspace/<project>/.claude/skills
```

Symlinks are installed per-project by running:

```bash
/workspace/workflow/scripts/install.sh <project-root>
```

This links both `workflow_skills/` and `technical_skills/` into the project.
