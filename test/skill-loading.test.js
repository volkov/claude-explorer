const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-loading-test-'));
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const projectDir = '-Users-test-workspace';
fs.mkdirSync(path.join(fixtureHome, '.claude/projects', projectDir), { recursive: true });

// Load the real parser against an isolated home so the developer's own
// transcripts are never read.
const parserModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../parser.js'), 'utf8'), {
  module: parserModule,
  process: { env: {} },
  require: name => name === 'os' ? { homedir: () => fixtureHome } : require(name),
});
const { parseTranscript } = parserModule.exports;
// The parser runs in its own realm, so strip prototypes before deep comparisons.
const plain = value => JSON.parse(JSON.stringify(value === undefined ? null : value));

const timestamp = '2026-09-05T00:56:44.751Z';
const line = (type, message, extra = {}) => ({ type, uuid: randomUUID(), timestamp, message, ...extra });
const assistant = (...content) => line('assistant', { role: 'assistant', model: 'test-model', content });
const skillCall = (id, skill) => ({ type: 'tool_use', id, name: 'Skill', input: { skill, args: 'SER-873' } });
const launched = (id, skill) => line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Launching skill: ${skill}` }] },
  { toolUseResult: { success: true, commandName: skill } });
const user = text => line('user', { role: 'user', content: text });
const meta = (text, extra = {}) => line('user', { role: 'user', content: [{ type: 'text', text }] }, { isMeta: true, ...extra });
const body = dir => `Base directory for this skill: ${dir}\n\n# Linear Fetch\n\nPull everything relevant about a Linear issue.`;
const fetchDir = '/Users/test/pyphony/plugins/linear/skills/fetch';

async function parse(entries) {
  const sessionId = randomUUID();
  const filePath = path.join(fixtureHome, '.claude/projects', projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return parseTranscript(projectDir, sessionId);
}

test('a Skill call tags the injected body with the skill name and keeps it inspectable', async () => {
  const data = await parse([
    user('Load the ticket'),
    assistant(skillCall('toolu_1', 'linear:fetch')),
    launched('toolu_1', 'linear:fetch'),
    meta(body(fetchDir), { sourceToolUseID: 'toolu_1', turnCompanion: true }),
    assistant({ type: 'text', text: 'Context loaded.' }),
  ]);
  assert.deepEqual(plain(data.messages.map(msg => msg.skill || null)), [null, null, null, { name: 'linear:fetch' }, null]);
  const load = data.messages[3];
  assert.equal(load.type, 'user');
  assert.equal(load.isMeta, true);
  assert.equal(load.sourceToolUseId, 'toolu_1');
  assert.equal(load.text, body(fetchDir));
  assert.equal(JSON.parse(load._raw).isMeta, true);
  assert.equal(data.messages[0].isMeta, undefined);
  assert.equal(data.messages[2].toolResults[0].content, 'Launching skill: linear:fetch');
});

test('bodies without a source id (older transcripts, string content) use the preceding Skill call', async () => {
  const data = await parse([
    user('<command-name>/clear</command-name><command-message>clear</command-message>'),
    assistant(skillCall('toolu_1', 'linear:handoff')),
    launched('toolu_1', 'linear:handoff'),
    line('user', { role: 'user', content: body(fetchDir) }, { isMeta: true }),
    assistant(skillCall('toolu_2', 'reply')),
    launched('toolu_2', 'reply'),
    meta(body('/Users/test/skills/reply'), { sourceToolUseID: 'toolu_missing' }),
  ]);
  assert.deepEqual(plain(data.messages[3].skill), { name: 'linear:handoff' });
  assert.deepEqual(plain(data.messages[6].skill), { name: 'reply' });
  assert.equal(data.messages[0].skill, undefined);
});

test('a user-typed /skill command names the body it triggers, whatever the tag order', async () => {
  const data = await parse([
    user('<command-message>linear:fetch</command-message> <command-name>/linear:fetch</command-name> <command-args>827</command-args>'),
    meta(body(fetchDir)),
    assistant({ type: 'text', text: 'Fetching SER-827.' }),
  ]);
  assert.equal(data.messages[0].skill, undefined);
  assert.equal(data.messages[0].text.includes('<command-name>'), true);
  assert.deepEqual(plain(data.messages[1].skill), { name: 'linear:fetch' });
});

test('a body with no visible trigger falls back to the skill directory name', async () => {
  const data = await parse([
    meta(body('/private/tmp/claude-501/bundled-skills/2.1.258/41a8aaaddbc7f4492e010cd4e82e2691/claude-api')),
  ]);
  assert.deepEqual(plain(data.messages[0].skill), { name: 'claude-api' });
});

test('other meta messages and ordinary prompts are left alone', async () => {
  const data = await parse([
    meta('<system-reminder>Other agents active in this session.</system-reminder>'),
    line('user', { role: 'user', content: '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>' }, { isMeta: true }),
    user(body(fetchDir)),
    assistant({ type: 'tool_use', id: 'task_1', name: 'Task', input: { prompt: 'Review' } }),
    line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task_1', content: 'done' }] }),
    meta('Approach this as the design lead at a small studio.', { sourceToolUseID: 'task_1' }),
    meta('[Image: source: /tmp/shot.png]', { turnCompanion: true }),
  ]);
  assert.ok(data.messages.every(msg => msg.skill === undefined));
  assert.equal(data.messages[2].text, body(fetchDir));
  assert.equal(data.messages[2].isMeta, undefined);
});
