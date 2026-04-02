#!/usr/bin/env bash
#
# service.sh — install/uninstall Claude Transcript Viewer as a macOS launchd service.
#
# Usage:
#   ./service.sh install              # Install and start the service
#   ./service.sh uninstall            # Stop and remove the service
#   ./service.sh status               # Show service status
#   ./service.sh logs                 # Tail stderr log
#
# The service runs supervisor.sh, which in turn manages "node server.js"
# and automatically restarts it when the repository is updated.
#
# Options (for install):
#   PORT=8080 ./service.sh install    # Custom port (default: 3939)

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────
LABEL="com.claude-transcript-viewer"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs"
STDOUT_LOG="${LOG_DIR}/claude-transcript-viewer.stdout.log"
STDERR_LOG="${LOG_DIR}/claude-transcript-viewer.stderr.log"

# Resolve the absolute path of the project directory (where this script lives)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUPERVISOR_PATH="${SCRIPT_DIR}/supervisor.sh"
APP_PORT="${PORT:-3939}"

# ── Helpers ────────────────────────────────────────────────────────────
log() { echo "$*"; }

node_path() {
  # Find the directory containing the `node` binary
  local n
  n="$(command -v node 2>/dev/null || true)"
  if [ -n "$n" ]; then
    dirname "$(realpath "$n")"
  fi
}

ensure_dirs() {
  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$LOG_DIR"
}

is_loaded() {
  launchctl list 2>/dev/null | grep -q "$LABEL"
}

get_pid() {
  launchctl list 2>/dev/null | awk -v label="$LABEL" '$3 == label { print ($1 == "-" ? "" : $1) }'
}

# ── Install ────────────────────────────────────────────────────────────
do_install() {
  ensure_dirs

  if [ ! -x "$SUPERVISOR_PATH" ]; then
    echo "Error: supervisor.sh not found at $SUPERVISOR_PATH" >&2
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    echo "Error: node not found in PATH. Install Node.js first." >&2
    exit 1
  fi

  # Build PATH that includes node
  local node_dir
  node_dir="$(node_path)"
  local env_path="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  [ -n "$node_dir" ] && env_path="${node_dir}:${env_path}"

  # Unload existing service if present
  if is_loaded; then
    log "Stopping existing service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  log "Installing Claude Transcript Viewer as macOS service..."
  log "  Working directory: $SCRIPT_DIR"
  log "  Supervisor:        $SUPERVISOR_PATH"
  log "  Port:              $APP_PORT"
  log "  Stdout log:        $STDOUT_LOG"
  log "  Stderr log:        $STDERR_LOG"
  log ""

  # Generate plist
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SUPERVISOR_PATH}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${STDOUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_LOG}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${env_path}</string>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PORT</key>
        <string>${APP_PORT}</string>
    </dict>
</dict>
</plist>
PLIST

  log "1/2 Plist created: $PLIST_PATH"

  # Load the service
  if launchctl load "$PLIST_PATH" 2>/dev/null; then
    log "2/2 Service loaded"
  else
    log "2/2 Warning: launchctl load failed. Try manually:"
    log "    launchctl load $PLIST_PATH"
  fi

  log ""
  log "Done! Claude Transcript Viewer is now running as a background service."
  log ""
  log "  Open:   http://localhost:${APP_PORT}/"
  log "  Status: ./service.sh status"
  log "  Logs:   ./service.sh logs"
  log "  Remove: ./service.sh uninstall"
  log ""
  log "The service starts automatically at login."
}

# ── Uninstall ──────────────────────────────────────────────────────────
do_uninstall() {
  log "Uninstalling Claude Transcript Viewer service..."
  log ""

  if [ -f "$PLIST_PATH" ]; then
    if is_loaded; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      log "1/2 Service stopped"
    else
      log "1/2 Service was not running"
    fi
    rm -f "$PLIST_PATH"
    log "2/2 Plist removed: $PLIST_PATH"
  else
    log "Service is not installed (plist not found)."
    return
  fi

  log ""
  log "Done! Service uninstalled."
  log "Log files are kept at:"
  log "  $STDOUT_LOG"
  log "  $STDERR_LOG"
}

# ── Status ─────────────────────────────────────────────────────────────
do_status() {
  log "Claude Transcript Viewer — Service Status"
  log ""

  if [ -f "$PLIST_PATH" ]; then
    log "  Installed: yes"
  else
    log "  Installed: no"
    log ""
    log "  Run ./service.sh install to install."
    return
  fi

  if is_loaded; then
    local pid
    pid="$(get_pid)"
    if [ -n "$pid" ]; then
      log "  Status:    running (PID $pid)"
    else
      log "  Status:    loaded (not running)"
    fi
  else
    log "  Status:    stopped"
  fi

  # Read port from plist
  local port
  port=$(sed -n '/<key>PORT<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$PLIST_PATH" 2>/dev/null || true)
  if [ -n "$port" ]; then
    log "  Port:      $port"
    log "  Dashboard: http://localhost:${port}/"
  fi

  log ""
  log "  Plist:      $PLIST_PATH"
  log "  Stdout log: $STDOUT_LOG"
  log "  Stderr log: $STDERR_LOG"

  # Try to reach the server
  if [ -n "$port" ]; then
    if curl -s --max-time 2 "http://localhost:${port}/" >/dev/null 2>&1; then
      log ""
      log "  Server is responding on http://localhost:${port}/"
    fi
  fi
}

# ── Logs ───────────────────────────────────────────────────────────────
do_logs() {
  if [ -f "$STDERR_LOG" ]; then
    tail -f "$STDERR_LOG"
  else
    echo "No log file found at $STDERR_LOG"
    echo "Is the service installed? Run: ./service.sh install"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────
case "${1:-}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  status)    do_status ;;
  logs)      do_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|status|logs}"
    echo ""
    echo "Commands:"
    echo "  install    Install as macOS launchd service (starts at login)"
    echo "  uninstall  Stop and remove the service"
    echo "  status     Show current service status"
    echo "  logs       Tail the service stderr log"
    echo ""
    echo "Options (environment variables):"
    echo "  PORT=8080 $0 install   Set custom port (default: 3939)"
    exit 1
    ;;
esac
