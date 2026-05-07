const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Simple LRU cache with mtime tracking
const cache = new Map();
const cacheMtime = new Map(); // key -> mtimeMs at cache time
const CACHE_MAX = 20;
function cacheSet(key, value, mtimeMs) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
    cacheMtime.delete(first);
  }
  cache.set(key, value);
  if (mtimeMs) cacheMtime.set(key, mtimeMs);
}

const ACTIVE_THRESHOLD_MS = 30000; // 30 seconds

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
    // A forked skill writes only to its agent-*.jsonl while the parent stays
    // idle; consider those subagent mtimes when deciding if the session is
    // still actively running.
    const maxMtime = await getMaxMtimeForSession(projectDir, sessionId);
    const isActive = (Date.now() - maxMtime) < ACTIVE_THRESHOLD_MS;

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
      isActive,
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

// Read the first non-empty line of a JSONL file (used to peek at a subagent's
// first message timestamp without parsing the whole file).
function readFirstLine(filePath) {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    let firstLine = null;
    rl.on('line', (line) => {
      if (firstLine !== null) return;
      firstLine = line;
      rl.close();
      stream.destroy();
    });
    rl.on('close', () => resolve(firstLine));
    rl.on('error', () => resolve(null));
  });
}

// Compute the max mtime across the parent transcript file and all subagent
// JSONL files in its subagents/ directory. Used to invalidate cache and for
// active-polling status when forked skills/subagents update their own files
// without touching the parent.
async function getMaxMtimeForSession(projectDir, sessionId) {
  let maxMtime = 0;
  const parentPath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  try {
    const stat = await fs.promises.stat(parentPath);
    if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
  } catch {}
  const subagentsDir = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents');
  try {
    const files = await fs.promises.readdir(subagentsDir);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const stat = await fs.promises.stat(path.join(subagentsDir, f));
        if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
      } catch {}
    }
  } catch {}
  return maxMtime;
}

async function parseTranscript(projectDir, sessionId, agentId) {
  const cacheKey = `${projectDir}/${sessionId}/${agentId || 'main'}`;

  let filePath;
  if (agentId) {
    filePath = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  } else {
    filePath = path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  // For the parent transcript, also consider subagent file mtimes — a forked
  // skill writes to its agent-*.jsonl while the parent stays idle, so we must
  // re-parse to surface fresh subagent links even if the parent didn't change.
  const cacheMtimeRef = agentId ? stat.mtimeMs : await getMaxMtimeForSession(projectDir, sessionId);

  // Use cache only if nothing relevant has been modified since last parse
  if (cache.has(cacheKey) && cacheMtime.has(cacheKey) && cacheMtime.get(cacheKey) >= cacheMtimeRef) {
    return cache.get(cacheKey);
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
      if (obj.type === 'last-prompt') return;

      // Extract session metadata incrementally (field by field)
      // This ensures metadata is captured even when queue-operation
      // entries appear before user/assistant messages
      if (obj.sessionId && !sessionMeta.sessionId) sessionMeta.sessionId = obj.sessionId;
      if (obj.slug && !sessionMeta.slug) sessionMeta.slug = obj.slug;
      if (obj.cwd && !sessionMeta.cwd) sessionMeta.cwd = obj.cwd;
      if (obj.version && !sessionMeta.version) sessionMeta.version = obj.version;
      if (obj.gitBranch && !sessionMeta.gitBranch) sessionMeta.gitBranch = obj.gitBranch;
      if (obj.message?.model && !sessionMeta.model) sessionMeta.model = obj.message.model;

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
        _raw: line,
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
              const tr = {
                toolUseId: block.tool_use_id,
                content: resultText,
                isError: block.is_error || false,
              };
              // Preserve structured tool result data (e.g. TodoWrite oldTodos/newTodos)
              if (obj.toolUseResult && typeof obj.toolUseResult === 'object') {
                if (obj.toolUseResult.oldTodos || obj.toolUseResult.newTodos) {
                  tr.todos = {
                    oldTodos: obj.toolUseResult.oldTodos || [],
                    newTodos: obj.toolUseResult.newTodos || [],
                  };
                }
              }
              msg.toolResults.push(tr);
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

    rl.on('close', async () => {
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

      // Read each subagent's first-message timestamp so we can fall back to
      // timestamp-proximity matching for forked skills that haven't yet
      // produced a tool_result (which is where the agentId normally arrives).
      // Only needed when rendering the parent transcript.
      const subagentFirstTs = new Map(); // agentId -> first message timestamp (ms)
      if (!agentId) {
        await Promise.all(subagents.map(async (sub) => {
          try {
            const subPath = path.join(subagentsDir, sub.filename);
            const firstLine = await readFirstLine(subPath);
            if (!firstLine) return;
            const obj = JSON.parse(firstLine);
            if (obj && obj.timestamp) {
              subagentFirstTs.set(sub.agentId, new Date(obj.timestamp).getTime());
            }
          } catch {}
        }));
      }

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

      // Fallback for in-flight forked skills (and any other context-isolated
      // tool calls): the tool_result with `agentId` only arrives when the
      // skill finishes, so during the run the parent transcript has no link.
      // We can still discover the subagent by matching timestamps — its first
      // message is written milliseconds after the Skill tool_use timestamp.
      if (!agentId && subagentFirstTs.size > 0) {
        const linkedAgentIds = new Set();
        for (const block of toolUseBlocks.values()) {
          if (block.agentId) linkedAgentIds.add(block.agentId);
        }
        // Walk messages in order so we associate each tool_use with the
        // earliest unmatched subagent that started just after it.
        for (const msg of messages) {
          if (msg.type !== 'assistant' || !Array.isArray(msg.blocks)) continue;
          if (!msg.timestamp) continue;
          const blockTime = new Date(msg.timestamp).getTime();
          if (!Number.isFinite(blockTime)) continue;
          for (const block of msg.blocks) {
            if (block.type !== 'tool_use') continue;
            if (block.agentLink) continue;
            const name = (block.name || '').toLowerCase();
            // Only Skill / Task can spawn a subagent transcript.
            if (name !== 'skill' && name !== 'task') continue;
            let bestId = null;
            let bestDelta = Infinity;
            for (const [agId, firstTs] of subagentFirstTs) {
              if (linkedAgentIds.has(agId)) continue;
              if (!validAgentIds.has(agId)) continue;
              const delta = firstTs - blockTime;
              // Subagent must start AFTER the tool_use; allow up to 30 seconds
              // for the skill to spin up before its first message is written.
              if (delta < 0 || delta > 30000) continue;
              if (delta < bestDelta) { bestDelta = delta; bestId = agId; }
            }
            if (bestId) {
              block.agentId = bestId;
              block.agentLink = `#/subagent/${projectDir}/${sessionId}/${bestId}`;
              linkedAgentIds.add(bestId);
            }
          }
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
        filePath,
        messages,
        subagents,
        agentId: agentId || null,
      };

      cacheSet(cacheKey, result, cacheMtimeRef);
      resolve(result);
    });

    rl.on('error', () => resolve(null));
  });
}

async function isSessionActive(projectDir, sessionId, agentId) {
  let mtimeMs = 0;
  if (agentId) {
    const filePath = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    try {
      const stat = await fs.promises.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return false;
    }
  } else {
    // For the parent transcript, also count subagent file activity — a forked
    // skill keeps the session "alive" even when the parent file is idle.
    mtimeMs = await getMaxMtimeForSession(projectDir, sessionId);
    if (!mtimeMs) return false;
  }
  return (Date.now() - mtimeMs) < ACTIVE_THRESHOLD_MS;
}

async function getSessionStatus(projectDir, sessionId, agentId) {
  let mtimeMs = 0;
  if (agentId) {
    const filePath = path.join(PROJECTS_DIR, projectDir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    try {
      const stat = await fs.promises.stat(filePath);
      mtimeMs = stat.mtimeMs;
    } catch {
      return { isActive: false, mtimeMs: 0 };
    }
  } else {
    // Include subagent files: an in-flight forked skill writes to its agent
    // file without touching the parent, so polling must detect that to refresh.
    mtimeMs = await getMaxMtimeForSession(projectDir, sessionId);
    if (!mtimeMs) return { isActive: false, mtimeMs: 0 };
  }
  return {
    isActive: (Date.now() - mtimeMs) < ACTIVE_THRESHOLD_MS,
    mtimeMs,
  };
}

module.exports = { listProjects, listSessions, parseTranscript, isSessionActive, getSessionStatus };
