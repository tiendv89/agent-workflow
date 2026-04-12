#!/usr/bin/env bash
set -euo pipefail

# Install shared skills into a project by creating per-skill symlinks.
#
# Usage:
#   /workspace/workflow/scripts/install.sh <project-root>
#   /workspace/workflow/scripts/install.sh <project-root> skill-a skill-b
#
# Behavior:
# - keeps <project-root>/.claude/skills as a real directory
# - symlinks each shared skill (workflow_skills + technical_skills) inside it
# - preserves project-specific local skills
# - refuses to overwrite existing non-symlink entries with the same name

SCRIPT_NAME="$(basename "$0")"
PROJECT_ROOT="${1:-}"

if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Usage: $SCRIPT_NAME <project-root> [skill-name ...]" >&2
  exit 1
fi
shift || true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_WORKFLOW_SKILLS_DIR="$SHARED_ROOT/workflow_skills"
SHARED_TECHNICAL_SKILLS_DIR="$SHARED_ROOT/technical_skills"
PROJECT_SKILLS_DIR="$PROJECT_ROOT/.claude/skills"

if [[ ! -d "$SHARED_WORKFLOW_SKILLS_DIR" ]]; then
  echo "Error: shared workflow_skills directory not found: $SHARED_WORKFLOW_SKILLS_DIR" >&2
  exit 1
fi

mkdir -p "$PROJECT_ROOT/.claude"
mkdir -p "$PROJECT_SKILLS_DIR"

link_one() {
  local skill_name="$1"
  local src="$2"
  local dest="$PROJECT_SKILLS_DIR/$skill_name"

  if [[ ! -d "$src" ]]; then
    echo "Skip: shared skill not found: $src" >&2
    return 0
  fi

  if [[ -L "$dest" ]]; then
    local current_target
    current_target="$(readlink "$dest")"
    if [[ "$current_target" == "$src" ]]; then
      echo "OK: already linked -> $skill_name"
      return 0
    fi
    rm -f "$dest"
  elif [[ -e "$dest" ]]; then
    echo "Preserve: existing local skill/folder, not overwriting: $dest" >&2
    return 0
  fi

  ln -s "$src" "$dest"
  echo "Linked: $skill_name"
}

link_skills_from_dir() {
  local skills_dir="$1"
  if [[ ! -d "$skills_dir" ]]; then
    return 0
  fi
  while IFS= read -r -d '' dir; do
    local skill_name
    skill_name="$(basename "$dir")"
    link_one "$skill_name" "$dir"
  done < <(find "$skills_dir" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)
}

if [[ $# -eq 0 ]]; then
  link_skills_from_dir "$SHARED_WORKFLOW_SKILLS_DIR"
  link_skills_from_dir "$SHARED_TECHNICAL_SKILLS_DIR"
else
  for skill_name in "$@"; do
    if [[ -d "$SHARED_WORKFLOW_SKILLS_DIR/$skill_name" ]]; then
      link_one "$skill_name" "$SHARED_WORKFLOW_SKILLS_DIR/$skill_name"
    elif [[ -d "$SHARED_TECHNICAL_SKILLS_DIR/$skill_name" ]]; then
      link_one "$skill_name" "$SHARED_TECHNICAL_SKILLS_DIR/$skill_name"
    else
      echo "Skip: skill not found in workflow_skills or technical_skills: $skill_name" >&2
    fi
  done
fi

echo
echo "Done."
echo "Workflow skills: $SHARED_WORKFLOW_SKILLS_DIR"
echo "Technical skills: $SHARED_TECHNICAL_SKILLS_DIR"
echo "Project skills: $PROJECT_SKILLS_DIR"
