#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the workflow repo itself so Claude Code can use its skills immediately.
#
# Run this once after cloning:
#   bash scripts/bootstrap.sh
#
# Effect:
# - creates .claude/skills/ inside the workflow repo
# - symlinks each skill from workflow_skills/ using relative paths
# - technical_skills/ is NOT linked here (those are project-specific)
#
# The generated .claude/ folder is git-ignored. Re-run any time to repair or
# pick up newly added workflow skills.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW_SKILLS_DIR="$WORKFLOW_ROOT/workflow_skills"
TARGET_DIR="$WORKFLOW_ROOT/.claude/skills"

if [[ ! -d "$WORKFLOW_SKILLS_DIR" ]]; then
  echo "Error: workflow_skills directory not found: $WORKFLOW_SKILLS_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

linked=0
skipped=0

while IFS= read -r -d '' skill_dir; do
  skill_name="$(basename "$skill_dir")"
  dest="$TARGET_DIR/$skill_name"

  # Compute a relative path from TARGET_DIR to skill_dir
  rel_src="$(python3 -c "import os; print(os.path.relpath('$skill_dir', '$TARGET_DIR'))")"

  if [[ -L "$dest" ]]; then
    current="$(readlink "$dest")"
    if [[ "$current" == "$rel_src" ]]; then
      echo "OK: $skill_name"
      (( skipped++ )) || true
      continue
    fi
    rm -f "$dest"
  elif [[ -e "$dest" ]]; then
    echo "Preserve: existing entry, not overwriting: $dest" >&2
    (( skipped++ )) || true
    continue
  fi

  ln -s "$rel_src" "$dest"
  echo "Linked: $skill_name"
  (( linked++ )) || true
done < <(find "$WORKFLOW_SKILLS_DIR" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)

echo
echo "Done. $linked linked, $skipped already up-to-date."
echo "Open the workflow/ folder in Claude Code — skills are ready."
