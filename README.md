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

## Requirements

Node.js 18+, zero npm dependencies.
