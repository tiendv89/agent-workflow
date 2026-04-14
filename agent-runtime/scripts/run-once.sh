#!/bin/bash
# Container entry point — one agent activation cycle.
#
# Executed by tini as PID 1 so that signals are handled correctly.
# All orchestration logic lives in main.ts / dist/main.js.
#
# Exit codes (forwarded from main.js):
#   0  normal exit (task ran, idle cycle, or kill-switch)
#   2  agent.yaml invalid
#   3  git clone / pull failed
#   4  unexpected fatal error

set -euo pipefail

exec node /workflow/agent-runtime/dist/main.js "$@"
