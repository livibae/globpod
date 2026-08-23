#!/usr/bin/env bash
# One-shot morning pipeline run (for `at`, launchd, or manual use).
set -euo pipefail
cd "$(dirname "$0")/.."
export TZ="${TZ:-Europe/Amsterdam}"
LOG="${GLOBPOD_LOG:-./globpod-run.log}"
echo "===== GlobPod run-once $(date -Iseconds) =====" >> "$LOG"
npm run run-once >> "$LOG" 2>&1
echo "===== finished $(date -Iseconds) =====" >> "$LOG"
