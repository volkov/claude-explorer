const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

// ── Parser under an isolated home (same approach as codex.test.js) ──────────
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-transcript-test-'));
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const projectDir = '-Users-tester-project';
const claudeDir = path.join(fixtureHome, '.claude/projects', projectDir);
const rolloutDir = path.join(fixtureHome, '.codex/sessions/2026/09/05');
fs.mkdirSync(claudeDir, { recursive: true });
fs.mkdirSync(rolloutDir, { recursive: true });

const parserModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../parser.js'), 'utf8'), {
  module: parserModule,
  process: { env: {} },
  require: name => name === 'os' ? { homedir: () => fixtureHome } : require(name),
});
const { parseTranscript, parseCodexRollout } = parserModule.exports;

const timestamp = '2026-09-05T01:10:28.000Z';
async function parseClaude(entries) {
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return parseTranscript(projectDir, sessionId);
}
const claudeAssistant = (text, extra = {}) => ({
  type: 'assistant', uuid: randomUUID(), timestamp,
  message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text }] }, ...extra,
});

async function parseCodex(entries) {
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(rolloutDir, `rollout-2026-09-05T01-10-28-${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return parseCodexRollout(sessionId);
}
const turn = payload => ({ timestamp, type: 'turn_context', payload: { model: 'gpt-test', ...payload } });
const reply = text => ({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const prompt = text => ({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

test('claude: each assistant message carries its effort; the latest one is the session effort', async () => {
  const data = await parseClaude([
    claudeAssistant('legacy', { effort: 'xhigh' }),
    claudeAssistant('per turn wins', { effort: 'xhigh', perTurnEffort: 'max' }),
    claudeAssistant('subagent chatter', { isSidechain: true, effort: 'low', perTurnEffort: 'low' }),
    claudeAssistant('unknown'),
  ]);
  assert.deepEqual(Array.from(data.messages, m => m.effort), ['xhigh', 'max', 'low', undefined]);
  assert.equal(data.effort, 'max', 'sidechain and effort-less entries do not override the session effort');
});

test('claude: transcripts without any effort report none', async () => {
  const data = await parseClaude([claudeAssistant('hi')]);
  assert.equal(data.effort, null);
});

test('codex: effort comes from turn_context, including the collaboration_mode fallback', async () => {
  const data = await parseCodex([
    turn({ effort: 'medium' }),
    prompt('one'), reply('first'),
    turn({ collaboration_mode: { settings: { reasoning_effort: 'xhigh' } } }),
    prompt('two'), reply('second'),
    turn({}),
    prompt('three'), reply('third'),
  ]);
  const replies = data.messages.filter(m => m.type === 'assistant');
  assert.deepEqual(Array.from(replies, m => m.effort), ['medium', 'xhigh', null]);
  assert.equal(data.effort, null, 'the session effort follows the latest turn');
});

// ── Rendering ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer() {
  const app = { innerHTML: '', querySelector: () => null };
  const context = vm.createContext({
    document: {
      getElementById: id => (id === 'app' ? app : null),
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
    },
    localStorage: { getItem: () => 'dark' },
    requestAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    marked: { setOptions() {}, parse: text => `<p>${text}</p>` },
  });
  context.window = context;
  vm.runInContext(script, context);
  return { context, app };
}
const assistant = (text, extra = {}) => ({ type: 'assistant', model: 'claude-test', blocks: [{ type: 'text', content: text }], ...extra });
const effortTag = level => `<span class="effort-level" title="Reasoning effort">${level} effort</span>`;

test('message headers show the effort next to the model, only when known', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    assistant('a', { effort: 'xhigh' }),
    { type: 'user', text: 'next' },
    assistant('b'),
  ] }, 'project', 'session');
  const headers = app.innerHTML.match(/<div class="msg-header"><span class="role assistant">[\s\S]*?<\/div>/g);
  assert.equal(headers.length, 2);
  assert.ok(headers[0].includes(`claude-test &middot; ${effortTag('xhigh')}`));
  assert.ok(!headers[1].includes('effort-level'));
});

test('session meta shows the effort with the model, or on its own without context usage', () => {
  let { context, app } = viewer();
  context.renderTranscriptData({
    effort: 'max',
    context: { total: 1000, inputTokens: 1000, model: 'claude-test' },
    messages: [],
  }, 'project', 'session');
  assert.match(app.innerHTML, new RegExp(`<strong>Model:</strong> claude-test &middot; ${effortTag('max')} &middot; <span class="ctx-usage`));

  ({ context, app } = viewer());
  context.renderTranscriptData({ effort: '<low>', messages: [] }, 'project', 'session');
  assert.ok(app.innerHTML.includes(`<strong>Effort:</strong> ${effortTag('&lt;low&gt;')}`), 'effort is escaped');

  ({ context, app } = viewer());
  context.renderTranscriptData({ messages: [] }, 'project', 'session');
  assert.ok(!app.innerHTML.includes('Effort'));
});
