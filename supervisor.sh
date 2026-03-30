#!/usr/bin/env bash
#
# supervisor.sh — watches for HEAD changes and restarts the app.
#
# Usage:
#   ./supervisor.sh                  # defaults: branch=current, interval=60s
#   ./supervisor.sh -b main -i 30    # explicit branch & interval
#
# The script:
#   1. Starts `node server.js` (or whatever CMD is set to).
#   2. Every INTERVAL seconds checks if the local HEAD commit has changed
#      (e.g. because pyphony orchestrator updated the working tree).
#   3. If HEAD changed — restarts the process.
#   4. Fallback: if HEAD hasn't changed for SV_FALLBACK_PULL_AFTER seconds,
#      does a git pull --ff-only to catch any missed updates.
#
# Environment variables (all optional):
#   PORT                  — forwarded to the child process (default 3939)
#   SV_BRANCH             — git branch to track (default: current branch)
#   SV_INTERVAL           — poll interval in seconds (default: 60)
#   SV_CMD                — command to run (default: "node server.js")
#   SV_FALLBACK_PULL_AFTER — seconds without HEAD change before fallback pull (default: 300)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────
BRANCH="${SV_BRANCH:-}"
INTERVAL="${SV_INTERVAL:-60}"
CMD="${SV_CMD:-node server.js}"
FALLBACK_PULL_AFTER="${SV_FALLBACK_PULL_AFTER:-300}"

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

# ── Lockfile — prevent multiple supervisor instances ─────────────────
LOCKFILE="${TMPDIR:-/tmp}/supervisor-${PORT:-3939}.lock"

acquire_lock() {
  if [ -f "$LOCKFILE" ]; then
    local old_pid
    old_pid=$(cat "$LOCKFILE" 2>/dev/null || true)
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Error: another supervisor is already running (PID $old_pid, lockfile $LOCKFILE)" >&2
      exit 1
    fi
    # Stale lockfile — previous supervisor crashed without cleanup
    rm -f "$LOCKFILE"
  fi
  echo $$ > "$LOCKFILE"
}

release_lock() {
  rm -f "$LOCKFILE"
}

acquire_lock

# ── Helpers ───────────────────────────────────────────────────────────
log() { echo "[supervisor $(date '+%Y-%m-%d %H:%M:%S')] $*"; }

CHILD_PID=""
APP_PORT="${PORT:-3939}"

# ── Circuit breaker — prevent infinite rapid restarts ────────────────
MAX_RAPID_RESTARTS=5         # max consecutive crashes before cooldown
RAPID_RESTART_WINDOW=120     # seconds — crashes within this window count as "rapid"
COOLDOWN_SECONDS=60          # how long to wait after hitting the limit
crash_timestamps=""          # space-separated epoch timestamps of recent crashes

record_crash() {
  local now
  now=$(date +%s)
  crash_timestamps="$crash_timestamps $now"

  # Prune old timestamps outside the window
  local cutoff=$((now - RAPID_RESTART_WINDOW))
  local fresh=""
  for ts in $crash_timestamps; do
    if [ "$ts" -ge "$cutoff" ]; then
      fresh="$fresh $ts"
    fi
  done
  crash_timestamps="$fresh"
}

crash_count_in_window() {
  local count=0
  for _ in $crash_timestamps; do
    count=$((count + 1))
  done
  echo "$count"
}

check_circuit_breaker() {
  local count
  count=$(crash_count_in_window)
  if [ "$count" -ge "$MAX_RAPID_RESTARTS" ]; then
    log "Circuit breaker: $count crashes in ${RAPID_RESTART_WINDOW}s (limit: $MAX_RAPID_RESTARTS). Cooling down for ${COOLDOWN_SECONDS}s..."
    sleep "$COOLDOWN_SECONDS"
    crash_timestamps=""  # reset after cooldown
  fi
}

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

# Wait until the port is free (up to 10 seconds), then force-kill if still busy
wait_for_port_free() {
  local port="$1"
  local max_attempts=20
  local attempt=0
  while lsof -iTCP:"$port" -sTCP:LISTEN -t &>/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
      log "Warning: port $port still in use after ${max_attempts}x0.5s, killing holder"
      local pids
      pids=$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
      if [ -n "$pids" ]; then
        log "Killing PIDs holding port $port: $pids"
        echo "$pids" | xargs kill -9 2>/dev/null || true
        sleep 1
      fi
      return 0
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
  release_lock
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
log "  Fallback pull after: ${FALLBACK_PULL_AFTER}s"
log "  Command:  $CMD"

KNOWN_HEAD=$(git rev-parse HEAD)
LAST_CHANGE_TIME=$(date +%s)
log "Initial HEAD: $KNOWN_HEAD"

start_process

while true; do
  sleep "$INTERVAL"

  # Check if child is still alive; restart if crashed
  if [ -n "$CHILD_PID" ] && ! kill -0 "$CHILD_PID" 2>/dev/null; then
    # Try to capture exit code for debugging
    wait "$CHILD_PID" 2>/dev/null
    exit_code=$?
    log "Process (PID $CHILD_PID) exited unexpectedly (exit code: $exit_code), restarting..."
    CHILD_PID=""
    record_crash
    check_circuit_breaker
    restart_process
    continue
  fi

  # Check if HEAD has changed (e.g. pyphony updated the working tree)
  CURRENT_HEAD=$(git rev-parse HEAD 2>/dev/null || true)
  if [ -z "$CURRENT_HEAD" ]; then
    log "Warning: failed to read HEAD, will retry next cycle"
    continue
  fi

  if [ "$CURRENT_HEAD" != "$KNOWN_HEAD" ]; then
    log "HEAD changed: $KNOWN_HEAD -> $CURRENT_HEAD"
    KNOWN_HEAD="$CURRENT_HEAD"
    LAST_CHANGE_TIME=$(date +%s)
    log "Restarting process..."
    restart_process
    continue
  fi

  # Fallback: if HEAD hasn't changed for too long, try git pull
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST_CHANGE_TIME ))
  if [ "$ELAPSED" -ge "$FALLBACK_PULL_AFTER" ]; then
    log "No HEAD change for ${ELAPSED}s (threshold: ${FALLBACK_PULL_AFTER}s), running fallback git pull..."
    if git fetch "$REMOTE" "$BRANCH" 2>/dev/null && \
       git pull --ff-only "$REMOTE" "$BRANCH" 2>/dev/null; then
      NEW_HEAD=$(git rev-parse HEAD)
      if [ "$NEW_HEAD" != "$KNOWN_HEAD" ]; then
        log "Fallback pull found new commits: $KNOWN_HEAD -> $NEW_HEAD"
        KNOWN_HEAD="$NEW_HEAD"
        LAST_CHANGE_TIME=$(date +%s)
        log "Restarting process..."
        restart_process
      else
        # Reset timer even if no new commits, to avoid pulling every cycle
        LAST_CHANGE_TIME=$(date +%s)
        log "Fallback pull: already up to date"
      fi
    else
      log "Warning: fallback git pull failed, will retry next cycle"
      # Reset timer to avoid hammering on every cycle
      LAST_CHANGE_TIME=$(date +%s)
    fi
  fi
done
