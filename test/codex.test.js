const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-test-'));
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const rolloutDir = path.join(fixtureHome, '.codex/sessions/2026/09/05');
fs.mkdirSync(rolloutDir, { recursive: true });

// Load the real parser against an isolated home without changing CODEX_HOME
// or reading the developer's sessions.
const parserModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../parser.js'), 'utf8'), {
  module: parserModule,
  process: { env: {} },
  require: name => name === 'os' ? { homedir: () => fixtureHome } : require(name),
});
const { parseCodexRollout } = parserModule.exports;
const timestamp = '2026-09-05T01:10:28.000Z';
const item = payload => ({ timestamp, type: 'response_item', payload });
const message = (role, text) => item({ type: 'message', role, content: [{ type: 'input_text', text }] });
const plugins = '<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n- Example plugin\n</recommended_plugins>';
const instructions = '# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>\nRun npm test.\n</INSTRUCTIONS>';
const environment = '<environment_context>\n<cwd>/workspace</cwd>\n</environment_context>';

async function parse(entries) {
  const sessionId = randomUUID();
  const filePath = path.join(rolloutDir, `rollout-2026-09-05T01-10-28-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return parseCodexRollout(sessionId);
}

test('Codex plugin/setup preamble is System and the actual request stays User', async () => {
  const preamble = message('user', `${plugins}\n${instructions}\n${environment}`);
  const data = await parse([
    preamble,
    message('user', 'Fix the first message label.'),
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Fix the first message label.' } },
    message('assistant', 'I will check the parser.'),
  ]);
  assert.deepEqual(Array.from(data.messages, msg => msg.type), ['system', 'user', 'assistant']);
  assert.equal(data.messages[0].role, 'system');
  assert.equal(data.messages[0].timestamp, timestamp);
  assert.equal(data.messages[0].text, preamble.payload.content[0].text);
  assert.equal(JSON.parse(data.messages[0]._raw).payload.role, 'user');
  assert.equal(data.messages[1].text, 'Fix the first message label.');
});

test('known setup wrappers and explicit system/developer roles remain inspectable', async () => {
  const contexts = [
    plugins, environment, instructions,
    '# AGENTS.md instructions\r\n\r\n<INSTRUCTIONS>Keep commits small.</INSTRUCTIONS>',
    ' \n<user_instructions>Run tests.</user_instructions>\n ',
  ];
  const data = await parse([
    message('developer', 'Permission settings'),
    message('system', 'System instructions'),
    ...contexts.map(text => message('user', text)),
  ]);
  assert.equal(data.messages.length, contexts.length + 2);
  assert.ok(data.messages.every(msg => msg.type === 'system' && msg.role === 'system'));
  assert.deepEqual(Array.from(data.messages, msg => msg.text), ['Permission settings', 'System instructions', ...contexts]);
});

test('ordinary first prompts and prompts quoting or following setup markers stay User', async () => {
  const prompts = [
    'Here is a list of plugins that are available but not installed.',
    'Please explain <recommended_plugins>example</recommended_plugins>.',
    '```xml\n' + plugins + '\n```',
    plugins + '\nWhich plugin should I use?',
    environment + '\nFix this project.',
    instructions + '\nNow implement the feature.',
    '<recommended_plugins_extra>Example</recommended_plugins_extra>',
    '<recommended_plugins>Missing closing tag',
    '# AGENTS.md instructions\nPlease update this file.',
  ];
  const data = await parse(prompts.map(text => message('user', text)));
  assert.equal(data.messages.length, prompts.length);
  assert.ok(data.messages.every(msg => msg.type === 'user'));
  assert.deepEqual(Array.from(data.messages, msg => msg.text), prompts);
});

test('setup messages separate assistant responses without disrupting tool results', async () => {
  const data = await parse([
    message('assistant', 'Before'),
    message('user', plugins),
    message('assistant', 'After'),
    item({ type: 'function_call', call_id: 'check', name: 'exec_command', arguments: '{"cmd":"pwd"}' }),
    item({ type: 'function_call_output', call_id: 'check', output: '/workspace' }),
    message('assistant', 'Done'),
  ]);
  assert.deepEqual(Array.from(data.messages, msg => msg.type), ['assistant', 'system', 'assistant', 'user', 'assistant']);
  assert.equal(data.messages[0].blocks.length, 1);
  assert.equal(data.messages[2].blocks[0].content, 'After');
  assert.equal(data.messages[2].blocks[1].id, 'check');
  assert.equal(data.messages[3].text, null);
  assert.equal(data.messages[3].toolResults[0].toolUseId, 'check');
  assert.equal(data.messages[3].toolResults[0].content, '/workspace');
});
