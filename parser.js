const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Simple LRU cache
const cache = new Map();
const CACHE_MAX = 20;
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, value);
}

function humanProjectName(dirName) {
  // -Users-serg-v-some-project -> some-project
  // The home dir is known, so strip it precisely
  const home = require('os').homedir(); // e.g. /Users/serg-v
  const prefix = home.replace(/\//g, '-'); // -Users-serg-v
  if (dirName.startsWith(prefix + '-')) {
    return dirName.slice(prefix.length + 1);
  }
  if (dirName.startsWith(prefix)) {
    return dirName.slice(prefix.length) || dirName;
  }
  return dirName;
}

async function listProjects() {
  const entries = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(PROJECTS_DIR, entry.name);
    const files = await fs.promises.readdir(dirPath);
    const sessions = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));
    if (sessions.length === 0) continue;

    // Get last modified from most recent session file
    let lastModified = 0;
    for (const s of sessions) {
      try {
        const stat = await fs.promises.stat(path.join(dirPath, s));
        if (stat.mtimeMs > lastModified) lastModified = stat.mtimeMs;
      } catch {}
    }

    projects.push({
      dir: entry.name,
      name: humanProjectName(entry.name),
      sessionCount: sessions.length,
      lastModified: new Date(lastModified).toISOString(),
    });
  }

  projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return projects;
}

async function listSessions(projectDir) {
  const dirPath = path.join(PROJECTS_DIR, projectDir);
  const files = await fs.promises.readdir(dirPath);
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));
  const sessions = [];

  for (const file of jsonlFiles) {
    const sessionId = file.replace('.jsonl', '');
    const filePath = path.join(dirPath, file);
    const meta = await getSessionMeta(filePath);

    // Count subagents
    let subagentCount = 0;
    const subagentDir = path.join(dirPath, sessionId, 'subagents');
    try {
      const subFiles = await fs.promises.readdir(subagentDir);
      subagentCount = subFiles.filter(f => f.endsWith('.jsonl')).length;
    } catch {}

    const stat = await fs.promises.stat(filePath);

    sessions.push({
      sessionId,
      slug: meta.slug || sessionId.slice(0, 8),
      timestamp: meta.timestamp || stat.mtime.toISOString(),
      cwd: meta.cwd,
      version: meta.version,
      model: meta.model,
      gitBranch: meta.gitBranch,
      subagentCount,
      fileSize: stat.size,
    });
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

async function getSessionMeta(filePath) {
  return new Promise((resolve) => {
    const meta = {};
    let lineCount = 0;
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      if (lineCount++ > 20) { rl.close(); stream.destroy(); return; }
      try {
        const obj = JSON.parse(line);
        if (!meta.sessionId && obj.sessionId) meta.sessionId = obj.sessionId;
        if (!meta.slug && obj.slug) meta.slug = obj.slug;
        if (!meta.timestamp && obj.timestamp) meta.timestamp = obj.timestamp;
        if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
        if (!meta.version && obj.version) meta.version = obj.version;
        if (!meta.gitBranch && obj.gitBranch) meta.gitBranch = obj.gitBranch;
        if (!meta.model && obj.message?.model) meta.model = obj.message.model;
      } catch {}
    });

    rl.on('close', () => resolve(meta));
    rl.on('error', () => resolve(meta));
  });
}

async function parseTranscript(projectDir, sessionId, agentId) {
  const cacheKey = `${projectDir}/${sessionId}/${agentId || 'main'}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let filePath;
  if (agentId) {
    filePath = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  } else {
    filePath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  }

  try {
    await fs.promises.access(filePath);
  } catch {
    return null;
  }

  const messages = [];
  const toolUseToAgent = new Map(); // tool_use_id -> agentId
  const toolUseBlocks = new Map(); // tool_use_id -> tool_use block reference
  let sessionMeta = {};

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }

      // Skip noise
      if (obj.type === 'progress') return;
      if (obj.type === 'file-history-snapshot') return;
      if (obj.type === 'system') return;

      // Extract session metadata from first meaningful entry
      if (!sessionMeta.sessionId && obj.sessionId) {
        sessionMeta = {
          sessionId: obj.sessionId,
          slug: obj.slug,
          cwd: obj.cwd,
          version: obj.version,
          gitBranch: obj.gitBranch,
        };
      }
      if (obj.slug && !sessionMeta.slug) sessionMeta.slug = obj.slug;

      // Queue operations — track subagent spawning
      if (obj.type === 'queue-operation' && obj.operation === 'enqueue') {
        try {
          const content = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content;
          if (content.task_id && content.tool_use_id) {
            toolUseToAgent.set(content.tool_use_id, content.task_id);
          }
        } catch {}
        return;
      }

      if (obj.type !== 'user' && obj.type !== 'assistant') return;

      const msg = {
        uuid: obj.uuid,
        parentUuid: obj.parentUuid,
        type: obj.type,
        timestamp: obj.timestamp,
        role: obj.message?.role || obj.type,
        model: obj.message?.model,
        isSidechain: obj.isSidechain,
        agentId: obj.agentId,
      };

      // Also check toolUseResult for agentId mapping
      if (obj.toolUseResult && obj.toolUseResult.agentId) {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              toolUseToAgent.set(block.tool_use_id, obj.toolUseResult.agentId);
            }
          }
        }
      }

      const content = obj.message?.content;

      if (msg.type === 'assistant') {
        msg.blocks = [];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'thinking') {
              msg.blocks.push({ type: 'thinking', content: block.thinking });
            } else if (block.type === 'text') {
              msg.blocks.push({ type: 'text', content: block.text });
            } else if (block.type === 'tool_use') {
              const toolBlock = {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
              };
              msg.blocks.push(toolBlock);
              toolUseBlocks.set(block.id, toolBlock);
            }
          }
        } else if (typeof content === 'string') {
          msg.blocks = [{ type: 'text', content }];
        }
        if (obj.message?.usage) {
          msg.usage = obj.message.usage;
        }
      } else if (msg.type === 'user') {
        msg.toolResults = [];
        msg.text = null;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              let resultText = '';
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                resultText = block.content.map(c => c.text || '').join('\n');
              }
              msg.toolResults.push({
                toolUseId: block.tool_use_id,
                content: resultText,
                isError: block.is_error || false,
              });
            } else if (block.type === 'text') {
              msg.text = (msg.text || '') + block.text;
            }
          }
        } else if (typeof content === 'string') {
          msg.text = content;
        }
      }

      messages.push(msg);
    });

    rl.on('close', () => {
      // List available subagents first (needed for link validation)
      const subagentsDir = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents');
      let subagents = [];
      const validAgentIds = new Set();
      try {
        const files = fs.readdirSync(subagentsDir);
        subagents = files
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const match = f.match(/^agent-(.+)\.jsonl$/);
            if (match) { validAgentIds.add(match[1]); return { agentId: match[1], filename: f }; }
            return null;
          })
          .filter(Boolean);
      } catch {}

      // Post-process: attach agentId links to tool_use blocks and tool_results
      // Only create links for agentIds that have corresponding files
      for (const [toolUseId, agId] of toolUseToAgent) {
        if (!validAgentIds.has(agId)) continue;
        const toolBlock = toolUseBlocks.get(toolUseId);
        if (toolBlock) {
          toolBlock.agentId = agId;
          toolBlock.agentLink = `#/subagent/${projectDir}/${sessionId}/${agId}`;
        }
      }

      // Also tag tool results with agent info
      for (const msg of messages) {
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            const agId = toolUseToAgent.get(tr.toolUseId);
            if (agId && validAgentIds.has(agId)) {
              tr.agentId = agId;
              tr.agentLink = `#/subagent/${projectDir}/${sessionId}/${agId}`;
            }
          }
        }
      }

      const result = {
        ...sessionMeta,
        messages,
        subagents,
        agentId: agentId || null,
      };

      cacheSet(cacheKey, result);
      resolve(result);
    });

    rl.on('error', () => resolve(null));
  });
}

module.exports = { listProjects, listSessions, parseTranscript };
