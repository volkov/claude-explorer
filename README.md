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

## Requirements

Node.js 18+, zero npm dependencies.
