#!/usr/bin/env bash
set -euo pipefail

# repair-skills.sh <project-root>
#
# Repairs .claude/skills/ for a workspace project:
#   1. Removes broken symlinks (target directory gone)
#   2. Runs install.sh to add/update shared skill symlinks
#   3. Untracks any symlinks previously committed to git
#
# The .gitignore that prevents future commits is written by the
# sync-workspace-rules skill (Write tool) — not this script.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PROJECT_ROOT="${1:-}"
if [[ -z "$PROJECT_ROOT" ]]; then
  echo "Usage: repair-skills.sh <project-root>" >&2
  exit 1
fi

SKILLS_DIR="$PROJECT_ROOT/.claude/skills"

if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "Error: skills directory not found: $SKILLS_DIR" >&2
  exit 1
fi

# ── Step 1: Remove broken symlinks ──────────────────────────────────────────
echo "=== Step 1: Removing broken symlinks ==="
broken=0
while IFS= read -r -d '' link; do
  echo "  Removing broken: $(basename "$link")"
  rm -f "$link"
  ((broken++)) || true
done < <(find "$SKILLS_DIR" -maxdepth 1 -type l ! -exec test -e {} \; -print0)
echo "  Removed: $broken broken symlink(s)"

# ── Step 2: Run install.sh ───────────────────────────────────────────────────
echo ""
echo "=== Step 2: Running install.sh ==="
"$SCRIPT_DIR/install.sh" "$PROJECT_ROOT"

# ── Step 3: Untrack committed symlinks from git ──────────────────────────────
echo ""
echo "=== Step 3: Untracking committed symlinks from git ==="
tracked=$(git -C "$PROJECT_ROOT" ls-files .claude/skills/ | awk -F'/' 'NF==3 && $3!=".gitignore"')
if [[ -n "$tracked" ]]; then
  echo "$tracked" | xargs git -C "$PROJECT_ROOT" rm --cached
  count=$(echo "$tracked" | wc -l | tr -d ' ')
  echo "  Untracked: $count entry/entries (not committed — leave that to the user)"
else
  echo "  No tracked symlinks found."
fi

echo ""
echo "Done. Remember to commit the resulting git index changes."
