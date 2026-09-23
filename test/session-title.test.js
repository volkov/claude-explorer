const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

// ── Parser under an isolated home (same approach as effort.test.js) ─────────
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-test-'));
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const projectDir = '-Users-tester-project';
const claudeDir = path.join(fixtureHome, '.claude/projects', projectDir);
fs.mkdirSync(claudeDir, { recursive: true });

const parserModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../parser.js'), 'utf8'), {
  module: parserModule,
  process: { env: {} },
  Buffer,
  require: name => name === 'os' ? { homedir: () => fixtureHome } : require(name),
});
const { parseTranscript, listSessions } = parserModule.exports;

const timestamp = '2026-09-05T01:10:28.000Z';
const user = text => ({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content: text } });
const custom = name => ({ type: 'custom-title', customTitle: name, sessionId: 'x' });
const ai = name => ({ type: 'ai-title', aiTitle: name, sessionId: 'x' });
const agentName = name => ({ type: 'agent-name', agentName: name, sessionId: 'x' });
const toJsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

function writeSession(content) {
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), content);
  return sessionId;
}
const parseClaude = entries => parseTranscript(projectDir, writeSession(toJsonl(entries)));
async function listed(sessionId) {
  return (await listSessions(projectDir)).find(s => s.sessionId === sessionId);
}

// A user entry padded to exactly `bytes` bytes, newline included (ASCII only).
function fillerLine(bytes) {
  const shell = JSON.stringify({ type: 'user', message: { role: 'user', content: '' } }).length + 1;
  return JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(bytes - shell) } }) + '\n';
}
function filler(totalBytes) {
  let out = '';
  let remaining = totalBytes;
  while (remaining > 2000) { out += fillerLine(1000); remaining -= 1000; }
  out += fillerLine(remaining);
  assert.equal(out.length, totalBytes);
  return out;
}

test('parseTranscript: the /rename title wins over the generated one; the latest entry of each kind counts', async () => {
  const data = await parseClaude([
    ai('Generated from the first prompt'),
    user('hi'),
    custom('old name'), agentName('old name'),
    custom('new name'), ai('Generated from the first prompt'), agentName('new name'),
  ]);
  assert.deepEqual([data.title, data.titleSource], ['new name', 'custom']);
  assert.equal(data.messages.length, 1, 'title entries are not rendered as messages');
});

test('parseTranscript: the generated title shows when nothing was renamed, or the rename was cleared', async () => {
  let data = await parseClaude([user('hi'), ai('Generated title')]);
  assert.deepEqual([data.title, data.titleSource], ['Generated title', 'ai']);
  data = await parseClaude([ai('Generated title'), custom('typed'), custom('   ')]);
  assert.deepEqual([data.title, data.titleSource], ['Generated title', 'ai']);
  data = await parseClaude([user('hi')]);
  assert.deepEqual([data.title, data.titleSource], [null, null]);
});

test('listSessions: the title comes from the tail of the file, however far back it was last written', async () => {
  // Burst deep in the file with ~300 KB after it: the tail window must widen
  // twice (64 KB → 256 KB → 1 MB) before it sees the title.
  const deep = writeSession(toJsonl([user('hi'), custom('Deep title'), ai('Generated')]) + filler(300 * 1024));
  const near = writeSession(filler(100 * 1024) + toJsonl([ai('Near the end')]));
  const none = writeSession(filler(100 * 1024));

  let s = await listed(deep);
  assert.deepEqual([s.title, s.titleSource], ['Deep title', 'custom']);
  s = await listed(near);
  assert.deepEqual([s.title, s.titleSource], ['Near the end', 'ai']);
  s = await listed(none);
  assert.deepEqual([s.title, s.titleSource], [null, null]);

  // A /rename mid-session appends to the file; the next listing must pick it up.
  fs.appendFileSync(path.join(claudeDir, `${near}.jsonl`), toJsonl([custom('Renamed later'), agentName('Renamed later')]));
  s = await listed(near);
  assert.deepEqual([s.title, s.titleSource], ['Renamed later', 'custom']);
});

test('listSessions: a rename burst cut by the tail window is not misread as the generated title', async () => {
  const TAIL = 64 * 1024;
  const before = toJsonl([user('hi'), ai('Generated')]);
  const customLine = JSON.stringify(custom('Renamed')) + '\n';
  const rest = toJsonl([ai('Generated'), agentName('Renamed')]);
  // Size the remainder so the 64 KB cut lands in the middle of the custom-title line.
  const content = before + customLine + rest + filler(TAIL - Math.floor(customLine.length / 2) - rest.length);
  const cut = content.length - TAIL;
  assert.ok(cut > before.length && cut < before.length + customLine.length, 'fixture: the cut splits the custom-title line');

  const s = await listed(writeSession(content));
  assert.deepEqual([s.title, s.titleSource], ['Renamed', 'custom']);
});

// ── Rendering ───────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer(sessions = []) {
  const element = () => ({ innerHTML: '', textContent: '', style: {}, hidden: false, addEventListener() {}, querySelector: () => null });
  const elements = {};
  const context = vm.createContext({
    document: {
      getElementById: id => (elements[id] ||= element()),
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
    },
    location: { hash: '' },
    localStorage: { getItem: () => 'dark' },
    requestAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    fetch: async () => ({ ok: true, json: async () => sessions }),
    marked: { setOptions() {}, parse: text => `<p>${text}</p>` },
  });
  context.window = context;
  vm.runInContext(script, context);
  return { context, app: elements.app, elements };
}
const session = extra => ({ sessionId: '0123456789abcdef', slug: '01234567', timestamp, fileSize: 2048, subagentCount: 0, isActive: false, ...extra });

test('session list: the name is the row label, escaped, with the short id dimmed beside it', async () => {
  const { context, app } = viewer([
    session({ title: 'Fix <login>', titleSource: 'custom' }),
    session({ title: 'Generated', titleSource: 'ai' }),
    session({ title: null, titleSource: null }),
  ]);
  await context.renderSessionList('project');
  const rows = app.innerHTML.split('<div class="session-row"').slice(1);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('<span class="slug"><span class="session-name" title="Name set with /rename">Fix &lt;login&gt;</span><span class="session-id">01234567</span> </span>'));
  assert.ok(rows[1].includes('<span class="session-name" title="Name generated automatically by Claude Code">Generated</span><span class="session-id">01234567</span>'));
  assert.ok(rows[2].includes('<span class="slug">01234567 </span>'), 'an unnamed session shows its id as before');
  assert.ok(!rows[2].includes('session-name'));
});

test('transcript header: the name is the last breadcrumb segment, on the same line, tagged with how it was set', () => {
  let { context, app, elements } = viewer();
  context.renderSessionData({ title: 'Fix <login>', titleSource: 'custom', messages: [] }, 'project', '0123456789abcdef');
  const crumb = elements.breadcrumb.innerHTML;
  assert.ok(crumb.includes('<span>/</span><span class="crumb-session" title="Fix &lt;login&gt; · 0123456789abcdef">Fix &lt;login&gt;</span><span class="title-source" title="Name set with /rename">renamed</span>'), crumb);
  assert.ok(!crumb.includes('Session'), 'no generic "Session" crumb');
  assert.ok(!app.innerHTML.includes('Fix &lt;login&gt;'), 'no separate heading in the transcript body');

  ({ context, elements } = viewer());
  context.renderSessionData({ title: 'Generated', titleSource: 'ai', messages: [] }, 'project', '0123456789abcdef');
  assert.ok(elements.breadcrumb.innerHTML.endsWith('>Generated</span><span class="title-source" title="Name generated automatically by Claude Code">auto</span>'));

  ({ context, elements } = viewer());
  context.renderSessionData({ messages: [] }, 'project', '0123456789abcdef');
  assert.ok(elements.breadcrumb.innerHTML.endsWith('<span>/</span><span class="crumb-session crumb-id" title="0123456789abcdef">01234567</span>'), 'unnamed: the short id');
  assert.ok(!elements.breadcrumb.innerHTML.includes('title-source'));
});
