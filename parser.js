const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CLAUDE_DIR = path.join(require('os').homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Codex stores each session as a JSONL "rollout" under ~/.codex/sessions,
// bucketed by start date: sessions/YYYY/MM/DD/rollout-<ts>-<session_id>.jsonl.
// Honor CODEX_HOME if set (matches codex CLI behavior); default to ~/.codex.
const CODEX_HOME = process.env.CODEX_HOME || path.join(require('os').homedir(), '.codex');
const CODEX_DIR = path.join(CODEX_HOME, 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Cache resolved session_id -> rollout path so status polling doesn't re-walk
// the whole tree every 5s. Rollout paths are stable once created.
const codexPathCache = new Map();

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

const ACTIVE_THRESHOLD_MS = 120000; // 2 minutes — long operations (model
// thinking, long Bash/build/test runs, web fetches, subagents not writing to
// the parent) can go a while without touching the transcript file; a wider
// window keeps the "actively working" indicator from flapping off mid-task.

// Images reach a transcript in two shapes: claude writes API content blocks
// ({type:'image', source:{type:'base64', media_type, data}} or source
// {type:'url', url}) both for pasted screenshots and for image tool results
// (Read on a PNG, browser screenshots, ...); codex writes Responses-API items
// ({type:'input_image', image_url:'data:image/png;base64,...'}). Normalize
// them to { src, mediaType } so the renderer can drop `src` straight into an
// <img>. Only image data URIs and http(s) URLs are accepted — transcript
// content must not be able to smuggle other schemes into the page.
function normalizeImage(block) {
  if (!block || typeof block !== 'object') return null;
  let src = null;
  let mediaType = null;
  const source = block.source;
  if (source && typeof source === 'object') {
    if (source.type === 'base64' && typeof source.data === 'string' && source.data) {
      mediaType = source.media_type || 'image/png';
      src = `data:${mediaType};base64,${source.data}`;
    } else if (source.type === 'url' && typeof source.url === 'string') {
      src = source.url;
    }
  } else if (typeof block.image_url === 'string') {
    src = block.image_url;
  }
  if (!src) return null;
  const dataUri = src.match(/^data:(image\/[^;,]+)[;,]/i);
  if (dataUri) mediaType = mediaType || dataUri[1];
  else if (!/^https?:\/\//i.test(src)) return null;
  return { src, mediaType };
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

// Loading a skill (a Skill tool call or a user-typed /skill command) appends the
// whole skill body to the transcript as a meta user message. Tag those so the
// viewer can fold them to "Loaded skill <name>" instead of rendering pages of
// instructions as a User prompt. Detection is deliberately narrow: only meta
// messages that reference a Skill tool_use or start with the skill preamble
// qualify — other meta messages (reminders, caveats, images) stay as they are.
const SKILL_BODY_RE = /^\s*Base directory for this skill:\s*(\S+)/;
const SLASH_COMMAND_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

function tagSkillLoads(messages, toolUseBlocks) {
  // Name of the nearest preceding trigger (Skill call or /command). Older
  // transcripts lack sourceToolUseID, and /commands never have one.
  let lastSkillName = null;
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.blocks || []) {
        if (block.type === 'tool_use' && (block.name || '').toLowerCase() === 'skill') {
          lastSkillName = (block.input && block.input.skill) || null;
        }
      }
      continue;
    }
    if (msg.type !== 'user' || !msg.text) continue;
    if (!msg.isMeta) {
      const command = msg.text.match(SLASH_COMMAND_RE);
      if (command) lastSkillName = command[1];
      continue;
    }
    const source = msg.sourceToolUseId ? toolUseBlocks.get(msg.sourceToolUseId) : null;
    const fromSkillTool = !!source && (source.name || '').toLowerCase() === 'skill';
    const body = msg.text.match(SKILL_BODY_RE);
    if (!fromSkillTool && !body) continue;
    const name = (fromSkillTool && source.input && source.input.skill)
      || lastSkillName
      || (body && path.basename(body[1]))
      || 'skill';
    msg.skill = { name };
  }
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
  // Context tracking: the last assistant usage tells how full the context
  // window currently is (input + cache read + cache creation = what was sent
  // to the API on that request). Post-compaction requests reflect the smaller
  // context automatically, so no compact-marker handling is needed.
  let lastUsage = null;
  let lastUsageModel = null;

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
          // Track the freshest usage on this transcript's own context chain.
          // In the parent transcript, sidechain messages belong to subagent
          // contexts — skip them; in a subagent file every line is its own.
          if (agentId || !obj.isSidechain) {
            const u = obj.message.usage;
            const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            if (total > 0) {
              lastUsage = u;
              lastUsageModel = obj.message.model || null;
            }
          }
        }
      } else if (msg.type === 'user') {
        msg.toolResults = [];
        msg.text = null;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              let resultText = '';
              const images = [];
              if (typeof block.content === 'string') {
                resultText = block.content;
              } else if (Array.isArray(block.content)) {
                const parts = [];
                for (const c of block.content) {
                  if (c && c.type === 'image') {
                    const img = normalizeImage(c);
                    if (img) images.push(img);
                  } else {
                    parts.push((c && c.text) || '');
                  }
                }
                resultText = parts.join('\n');
              }
              const tr = {
                toolUseId: block.tool_use_id,
                content: resultText,
                isError: block.is_error || false,
              };
              if (images.length) tr.images = images;
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
            } else if (block.type === 'image') {
              // Pasted screenshot; may be the whole prompt (no text at all).
              const img = normalizeImage(block);
              if (img) (msg.images = msg.images || []).push(img);
            }
          }
        } else if (typeof content === 'string') {
          msg.text = content;
        }
        // Claude Code marks injected context (skill bodies, caveats, reminders)
        // as meta; an injected skill body also points back at its Skill call.
        if (obj.isMeta) msg.isMeta = true;
        if (obj.sourceToolUseID) msg.sourceToolUseId = obj.sourceToolUseID;
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

      tagSkillLoads(messages, toolUseBlocks);

      const result = {
        ...sessionMeta,
        filePath,
        messages,
        subagents,
        agentId: agentId || null,
        context: lastUsage ? {
          inputTokens: lastUsage.input_tokens || 0,
          cacheCreationTokens: lastUsage.cache_creation_input_tokens || 0,
          cacheReadTokens: lastUsage.cache_read_input_tokens || 0,
          outputTokens: lastUsage.output_tokens || 0,
          total: (lastUsage.input_tokens || 0) + (lastUsage.cache_creation_input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0),
          model: lastUsageModel,
        } : null,
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

// ── Codex rollout support ──────────────────────────────────────────────
//
// Codex (unlike claude) does not write project-scoped transcripts; a session is
// addressed by a single session_id (== thread_id == the UUID suffix of the
// rollout filename). We locate the rollout by that id and parse its canonical
// `response_item` stream into the SAME shape the claude renderer expects, so the
// existing front-end (messages/blocks/toolResults) is reused verbatim.

// Find the rollout file for a session id: ~/.codex/sessions/**/rollout-*-<id>.jsonl
async function findRolloutBySessionId(sessionId) {
  if (!sessionId || !UUID_RE.test(sessionId)) return null;

  const cached = codexPathCache.get(sessionId);
  if (cached) {
    try { await fs.promises.stat(cached); return cached; } catch { codexPathCache.delete(sessionId); }
  }

  const suffix = `-${sessionId.toLowerCase()}.jsonl`;

  // Walk the tree, newest date buckets first (names sort lexicographically, and
  // YYYY/MM/DD sorts chronologically), so recent sessions resolve fastest.
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return null; }
    const names = entries.map(e => e.name).sort().reverse();
    const byName = new Map(entries.map(e => [e.name, e]));
    // Files first (leaf level), then descend into subdirectories.
    for (const name of names) {
      const e = byName.get(name);
      if (e.isFile() && name.startsWith('rollout-') && name.toLowerCase().endsWith(suffix)) {
        return path.join(dir, name);
      }
    }
    for (const name of names) {
      const e = byName.get(name);
      if (e.isDirectory()) {
        const found = await walk(path.join(dir, name));
        if (found) return found;
      }
    }
    return null;
  }

  const found = await walk(CODEX_DIR);
  if (found) codexPathCache.set(sessionId, found);
  return found;
}

// Map codex tool payloads to a claude-like tool_use input object so the shared
// front-end tool renderer produces readable output.
function codexToolInput(payload) {
  const name = payload.name || 'tool';
  if (payload.type === 'function_call') {
    let args;
    try { args = JSON.parse(payload.arguments || '{}'); }
    catch { args = { arguments: payload.arguments || '' }; }
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      // exec_command uses `cmd`; expose it as `command` for the Bash-style view.
      if (args.cmd && !args.command) args.command = args.cmd;
      return args;
    }
    return { value: args };
  }
  // custom_tool_call: freeform string input (apply_patch, exec, ...)
  const raw = typeof payload.input === 'string' ? payload.input : '';
  if (name === 'apply_patch') return { patch: raw };
  return { command: raw };
}

// Normalize a tool output payload to { content, isError, images? }.
function codexToolOutput(payload) {
  const out = payload.output;
  if (Array.isArray(out)) {
    // Responses-API content list: input_text parts interleaved with
    // input_image screenshots. Never stringify the latter — that dumps
    // megabytes of base64 into the transcript as text.
    const parts = [];
    const images = [];
    for (const item of out) {
      if (item && item.type === 'input_image') {
        const img = normalizeImage(item);
        if (img) images.push(img);
      } else if (item && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item != null) {
        parts.push(JSON.stringify(item));
      }
    }
    const result = { content: parts.join('\n'), isError: false };
    if (images.length) result.images = images;
    return result;
  }
  if (typeof out !== 'string') return { content: out == null ? '' : JSON.stringify(out), isError: false };
  if (payload.type === 'custom_tool_call_output') {
    try {
      const parsed = JSON.parse(out);
      const content = typeof parsed.output === 'string' ? parsed.output : out;
      const exit = parsed.metadata && parsed.metadata.exit_code;
      return { content, isError: typeof exit === 'number' && exit !== 0 };
    } catch { return { content: out, isError: false }; }
  }
  return { content: out, isError: false };
}

// Codex records setup context as user-role messages. Only classify complete,
// known wrappers so prompts that mention these tags (or follow them) stay User.
function isCodexSetupMessage(text) {
  let remaining = text.trim();
  if (!remaining) return false;
  while (remaining) {
    const block = remaining.match(/^(?:<(recommended_plugins|environment_context|user_instructions)>[\s\S]*?<\/\1>|# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)/);
    if (!block) return false;
    remaining = remaining.slice(block[0].length).trimStart();
  }
  return true;
}

async function parseCodexRollout(sessionId) {
  const filePath = await findRolloutBySessionId(sessionId);
  if (!filePath) return null;

  let stat;
  try { stat = await fs.promises.stat(filePath); } catch { return null; }

  const cacheKey = `codex/${sessionId}`;
  if (cache.has(cacheKey) && cacheMtime.has(cacheKey) && cacheMtime.get(cacheKey) >= stat.mtimeMs) {
    return cache.get(cacheKey);
  }

  const messages = [];
  const sessionMeta = { sessionId };
  let model = null;
  let currentAssistant = null; // open assistant "response" bubble
  // Codex rollouts report context usage (and the model's context window!) in
  // event_msg/token_count entries; keep the latest one for the header gauge.
  let lastTokenInfo = null;

  function closeAssistant() { currentAssistant = null; }
  function ensureAssistant(ts) {
    if (!currentAssistant) {
      currentAssistant = { type: 'assistant', role: 'assistant', timestamp: ts, model, blocks: [] };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  }

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    rl.on('line', (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const ts = obj.timestamp;
      const p = obj.payload || {};

      if (obj.type === 'session_meta') {
        sessionMeta.sessionId = p.id || p.session_id || sessionId;
        if (p.cwd) sessionMeta.cwd = p.cwd;
        if (p.cli_version) sessionMeta.version = `codex ${p.cli_version}`;
        sessionMeta.slug = `codex ${String(sessionMeta.sessionId).slice(0, 8)}`;
        return;
      }
      if (obj.type === 'turn_context') {
        if (p.model) { model = p.model; if (!sessionMeta.model) sessionMeta.model = p.model; }
        return;
      }
      // event_msg duplicates response_item content in a lossy form — ignore it
      // for rendering, except token_count which carries context usage and the
      // model context window (not present anywhere in the response_item stream).
      if (obj.type === 'event_msg' && p.type === 'token_count' && p.info) {
        lastTokenInfo = p.info;
        return;
      }
      if (obj.type !== 'response_item') return;

      const pt = p.type;

      if (pt === 'message') {
        const blocks = Array.isArray(p.content) ? p.content : [];
        const text = blocks.map(b => b.text || '').join('');
        if (p.role === 'assistant') {
          const a = ensureAssistant(ts);
          if (text) a.blocks.push({ type: 'text', content: text });
        } else if (['user', 'developer', 'system'].includes(p.role)) {
          const type = p.role !== 'user' || isCodexSetupMessage(text) ? 'system' : 'user';
          closeAssistant();
          const msg = { type, role: type, timestamp: ts, text, toolResults: [], _raw: line };
          const images = blocks.filter(b => b && b.type === 'input_image').map(normalizeImage).filter(Boolean);
          if (images.length) msg.images = images;
          messages.push(msg);
        }
        return;
      }

      if (pt === 'reasoning') {
        const a = ensureAssistant(ts);
        const summary = Array.isArray(p.summary)
          ? p.summary.map(s => (typeof s === 'string' ? s : (s && s.text) || '')).join('\n').trim()
          : '';
        a.blocks.push({
          type: 'thinking',
          content: summary || '🔒 Reasoning is encrypted by Codex and not available in plaintext.',
        });
        return;
      }

      if (pt === 'function_call' || pt === 'custom_tool_call') {
        const a = ensureAssistant(ts);
        a.blocks.push({ type: 'tool_use', id: p.call_id, name: p.name || 'tool', input: codexToolInput(p) });
        return;
      }

      if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
        closeAssistant();
        messages.push({
          type: 'user', role: 'user', timestamp: ts, text: null,
          toolResults: [{ toolUseId: p.call_id, ...codexToolOutput(p) }],
        });
        return;
      }
    });

    rl.on('close', () => {
      let context = null;
      if (lastTokenInfo) {
        // last_token_usage describes the most recent request — its input size
        // is the current context; total_token_usage is cumulative across the
        // session and only serves as a fallback.
        const u = lastTokenInfo.last_token_usage || lastTokenInfo.total_token_usage || {};
        const total = (u.input_tokens || 0) + (u.output_tokens || 0);
        if (total > 0) {
          context = {
            total,
            window: lastTokenInfo.model_context_window || null,
            model: sessionMeta.model || model || null,
          };
        }
      }
      const result = { ...sessionMeta, filePath, messages, subagents: [], agentId: null, isCodex: true, context };
      cacheSet(cacheKey, result, stat.mtimeMs);
      resolve(result);
    });

    rl.on('error', () => resolve(null));
  });
}

async function getCodexStatus(sessionId) {
  const filePath = await findRolloutBySessionId(sessionId);
  if (!filePath) return { isActive: false, mtimeMs: 0 };
  try {
    const stat = await fs.promises.stat(filePath);
    return { isActive: (Date.now() - stat.mtimeMs) < ACTIVE_THRESHOLD_MS, mtimeMs: stat.mtimeMs };
  } catch {
    return { isActive: false, mtimeMs: 0 };
  }
}

module.exports = { listProjects, listSessions, parseTranscript, isSessionActive, getSessionStatus, parseCodexRollout, getCodexStatus };
