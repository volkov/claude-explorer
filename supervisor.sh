#!/usr/bin/env bash
#
# supervisor.sh — watches GitHub for new commits and restarts the app.
#
# Usage:
#   ./supervisor.sh                  # defaults: branch=current, interval=60s
#   ./supervisor.sh -b main -i 30    # explicit branch & interval
#
# The script:
#   1. Starts `node server.js` (or whatever CMD is set to).
#   2. Every INTERVAL seconds runs `git fetch` and compares local HEAD
#      with the remote tracking branch.
#   3. If they differ — pulls changes and restarts the process.
#
# Environment variables (all optional):
#   PORT            — forwarded to the child process (default 3939)
#   SV_BRANCH       — git branch to track (default: current branch)
#   SV_INTERVAL     — poll interval in seconds (default: 60)
#   SV_CMD          — command to run (default: "node server.js")

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
BRANCH="${SV_BRANCH:-}"
INTERVAL="${SV_INTERVAL:-60}"
CMD="${SV_CMD:-node server.js}"

# ── CLI args (override env) ───────────────────────────────────────────
while getopts "b:i:c:" opt; do
  case "$opt" in
    b) BRANCH="$OPTARG" ;;
    i) INTERVAL="$OPTARG" ;;
    c) CMD="$OPTARG" ;;
    *) echo "Usage: $0 [-b branch] [-i interval_sec] [-c command]" >&2; exit 1 ;;
  esac
done

# ── Resolve branch ────────────────────────────────────────────────────
if [ -z "$BRANCH" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
fi
REMOTE="origin"

# ── Helpers ───────────────────────────────────────────────────────────
log() { echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

CHILD_PID=""
APP_PORT="${PORT:-3939}"

start_process() {
  log "Starting: $CMD"
  $CMD &
  CHILD_PID=$!
  log "Process started (PID $CHILD_PID)"
}

stop_process() {
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    log "Stopping process (PID $CHILD_PID)..."
    kill "$CHILD_PID" 2>/dev/null || true
    # Wait up to 5 seconds for graceful shutdown
    for _ in $(seq 1 10); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force-kill if still alive
    if kill -0 "$CHILD_PID" 2>/dev/null; then
      log "Force-killing PID $CHILD_PID"
      kill -9 "$CHILD_PID" 2>/dev/null || true
    fi
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
    log "Process stopped"
  fi
}

# Wait until the port is free (up to 10 seconds)
wait_for_port_free() {
  local port="$1"
  local max_attempts=20
  local attempt=0
  while lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      log "Warning: port $port still in use after ${max_attempts}x0.5s, proceeding anyway"
      return 1
    fi
    sleep 0.5
  done
  return 0
}

restart_process() {
  stop_process
  wait_for_port_free "$APP_PORT" || true
  start_process
}

cleanup() {
  log "Shutting down..."
  stop_process
  exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ── Check prerequisites ──────────────────────────────────────────────
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "Error: not inside a git repository" >&2
  exit 1
fi

# ── Main loop ─────────────────────────────────────────────────────────
log "Supervisor started"
log "  Branch:   $BRANCH"
log "  Remote:   $REMOTE"
log "  Interval: ${INTERVAL}s"
log "  Command:  $CMD"

start_process

while true; do
  sleep "$INTERVAL"

  # Check if child is still alive; restart if crashed
  if [ -n "$CHILD_PID" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
    log "Process (PID $CHILD_PID) exited unexpectedly, restarting..."
    start_process
    continue
  fi

  # Fetch latest from remote
  if ! git fetch "$REMOTE" "$BRANCH" 2>/dev/null; then
    log "Warning: git fetch failed, will retry next cycle"
    continue
  fi

  LOCAL_HEAD=$(git rev-parse HEAD)
  REMOTE_HEAD=$(git rev-parse "$REMOTE/$BRANCH")

  if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
    log "New commits detected (local=$LOCAL_HEAD remote=$REMOTE_HEAD)"
    log "Pulling changes..."

    if git pull --ff-only "$REMOTE" "$BRANCH"; then
      log "Pull successful, restarting process..."
      restart_process
    else
      log "Warning: git pull failed (merge conflict?), skipping restart"
    fi
  fi
done
