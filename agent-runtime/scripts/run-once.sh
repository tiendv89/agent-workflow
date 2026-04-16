#!/bin/bash
# Container entry point.
#
# Name is historical — the process now runs continuously, looping on
# idle_sleep_seconds between activation cycles. Set idle_sleep_seconds: 0
# in agent.yaml for single-shot mode (one cycle then exit).
#
# Executed by tini as PID 1 so that signals are handled correctly.
# All orchestration logic lives in main.ts / dist/main.js.
#
# Exit codes (forwarded from main.js):
#   0  normal exit (task ran, idle cycle, or kill-switch)
#   2  agent.yaml invalid
#   3  git clone / pull failed (bootstrap only)
#   4  unexpected fatal error

set -euo pipefail

exec node /workflow/agent-runtime/dist/main.js "$@"
