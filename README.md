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

Projects consume shared skills through:

```text
/workspace/<project>/.claude/skills
```

which should be symlinked from:

```text
/workspace/workflow/workflow_skills
/workspace/workflow/technical_skills
```
