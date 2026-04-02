# Claude Transcript Viewer

Local web viewer for Claude Code transcripts from `~/.claude/projects/`.

## Features

- Browse all projects and sessions
- Full transcript rendering (messages, thinking, tool calls, results)
- Navigate from parent session into subagent transcripts (Task/Skill)
- Search/filter projects and sessions
- Dark theme

## Usage

```
node server.js
```

Open http://localhost:3939

Set custom port: `PORT=8080 node server.js`

## Supervisor (auto-restart on GitHub changes)

The `supervisor.sh` script monitors the repository for new commits and automatically restarts the server when changes are detected.

```bash
# Default: checks current branch every 60 seconds
./supervisor.sh

# Custom branch and interval
./supervisor.sh -b main -i 30

# Via npm
npm run supervisor
```

Environment variables: `SV_BRANCH`, `SV_INTERVAL`, `SV_CMD`.

The supervisor also restarts the process if it crashes unexpectedly.

## Install as macOS Service (launchd)

Run the viewer as a background service that starts automatically at login.

### Install

```bash
./service.sh install
```

After installation:
- The service starts immediately and will auto-start on every login
- Open http://localhost:3939 in your browser
- The supervisor monitors the repo for updates and restarts the server automatically

Custom port:

```bash
PORT=8080 ./service.sh install
```

### Status

```bash
./service.sh status
```

Shows whether the service is running, its PID, port, and log file locations.

### Logs

```bash
./service.sh logs
```

Tails the service stderr log. Log files are stored at:
- `~/Library/Logs/claude-transcript-viewer.stdout.log`
- `~/Library/Logs/claude-transcript-viewer.stderr.log`

### Uninstall

```bash
./service.sh uninstall
```

Stops the service and removes the launchd plist. Log files are preserved.

### How it works

`service.sh install` creates a launchd plist at `~/Library/LaunchAgents/com.claude-transcript-viewer.plist` that runs `supervisor.sh` as a background daemon.

Key properties:
- **RunAtLoad** — starts at login
- **KeepAlive (SuccessfulExit: false)** — launchd restarts the supervisor if it crashes (exit code != 0)
- **ThrottleInterval: 10** — minimum 10 seconds between restarts
- Logs go to `~/Library/Logs/`

The chain is: **launchd** -> `supervisor.sh` -> `node server.js`. The supervisor handles code updates and graceful restarts, while launchd ensures the supervisor itself stays alive.

### Manual launchctl commands

```bash
# Stop the service
launchctl unload ~/Library/LaunchAgents/com.claude-transcript-viewer.plist

# Start the service
launchctl load ~/Library/LaunchAgents/com.claude-transcript-viewer.plist

# Check if loaded
launchctl list | grep claude-transcript-viewer
```

## Requirements

- **Node.js 18+**, zero npm dependencies
- **macOS** for launchd service installation (the viewer itself works on any OS)
