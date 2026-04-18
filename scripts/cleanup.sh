#!/usr/bin/env bash
# Wipe every transient artifact Healix writes during local testing.
#
# Usage:
#   scripts/cleanup.sh                 # dry run, prints what would be removed
#   scripts/cleanup.sh --yes           # actually remove
#   scripts/cleanup.sh --yes /path/to/customer-project   # also clean that project's healix-reports/.healix
#
# Safe to run while the webapp is live. Does NOT touch your .env.local,
# node_modules, or database.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLY=""
EXTRA_PATHS=()

for arg in "$@"; do
  case "$arg" in
    --yes|-y) APPLY=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) EXTRA_PATHS+=("$arg") ;;
  esac
done

TARGETS=(
  # Claude Code's per-task background log dir for this session
  "/tmp/claude-501"
  # Integration test scratch (inside testbot-mcp/test/tmp)
  "$ROOT/testbot-mcp/test/tmp"
  # Any healix-reports / .healix left at repo root
  "$ROOT/healix-reports"
  "$ROOT/.healix"
  "$ROOT/webapp/healix-reports"
  "$ROOT/testbot-mcp/healix-reports"
)

for p in "${EXTRA_PATHS[@]+"${EXTRA_PATHS[@]}"}"; do
  TARGETS+=("$p/healix-reports" "$p/.healix")
done

total=0
for t in "${TARGETS[@]}"; do
  [[ -e "$t" ]] || continue
  size=$(du -sh "$t" 2>/dev/null | awk '{print $1}')
  total=$((total + 1))
  if [[ -n "$APPLY" ]]; then
    echo "  rm -rf  $t  ($size)"
    rm -rf "$t"
  else
    echo "  would remove  $t  ($size)"
  fi
done

if [[ $total -eq 0 ]]; then
  echo "nothing to clean."
  exit 0
fi

if [[ -z "$APPLY" ]]; then
  echo ""
  echo "re-run with --yes to actually delete."
fi
