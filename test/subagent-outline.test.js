const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

// --- Viewer: run the real inline script against a minimal DOM stub ---------

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

const tool = (id, name, input = {}, extra = {}) => ({ type: 'tool_use', id, name, input, ...extra });
const assistant = (...blocks) => ({ type: 'assistant', blocks });
const results = (...items) => ({ type: 'user', text: null, toolResults: items.map(([toolUseId, content, isError = false]) => ({ toolUseId, content, isError })) });
const summaryOf = markup => markup.match(/<summary>([\s\S]*?)<\/summary>/)[1];

test('subagent runs get their own chips on the collapsed summary line', () => {
  const { context, app } = viewer();
  const link = id => `#/subagent/project/session/${id}`;
  const messages = [
    assistant(
      tool('bash', 'Bash', { command: 'pwd' }),
      tool('agent', 'Agent', { description: 'Sweep <logs>', subagent_type: 'general-purpose', prompt: 'Look' }, { agentLink: link('a1') }),
      tool('task', 'Task', { prompt: 'Review\n  the change' }),
      tool('fork', 'Skill', { skill: 'linear:fetch' }, { agentLink: link('a2') }),
      tool('inline', 'Skill', { skill: 'reply' }),
    ),
    results(['bash', 'ok'], ['agent', 'Async agent launched'], ['task', 'boom', true], ['fork', 'done'], ['inline', 'Launching skill: reply']),
  ];
  context.renderTranscriptData({ messages }, 'project', 'session');
  const summary = summaryOf(app.innerHTML);

  // One chip per subagent run, in call order; the inline Skill and Bash get none.
  const chips = [...summary.matchAll(/class="subagent-chip(?: [^"]*)?"/g)].map(m => m[0]);
  assert.deepEqual(chips, ['class="subagent-chip"', 'class="subagent-chip error unlinked"', 'class="subagent-chip"']);
  assert.match(summary, /<span class="activity-agents">/);
  assert.match(summary, /href="#\/subagent\/project\/session\/a1"/);
  assert.match(summary, /href="#\/subagent\/project\/session\/a2"/);
  assert.match(summary, /subagent-chip-label">Sweep &lt;logs&gt;<\/span><span class="subagent-chip-kind">general-purpose</);
  assert.match(summary, /subagent-chip-label">Review the change<\/span>/);
  assert.match(summary, /subagent-chip-label">linear:fetch<\/span><span class="subagent-chip-kind">skill</);
  assert.doesNotMatch(summary, /subagent-chip-label">reply</);
  assert.match(summary, /title="Task: Review the change — failed"/);
  // The tally and the folded group itself are unchanged.
  assert.match(summary, /5 tool calls/);
  assert.match(summary, /Bash, Agent, Task, Skill ×2/);
  assert.match(app.innerHTML, /<details class="activity-group" id="activity-m0-b0">/);
});

test('subagent tool blocks stay inside the folded group and are marked there', () => {
  const { context, app } = viewer();
  const messages = [
    assistant(
      tool('bash', 'Bash', { command: 'pwd' }),
      tool('agent', 'Agent', { description: 'Critique the diff', prompt: 'Full brief' }, { agentLink: '#/subagent/p/s/a1' }),
    ),
    results(['bash', 'ok'], ['agent', 'Looks fine']),
    { type: 'assistant', blocks: [{ type: 'text', content: 'Done' }] },
  ];
  context.renderTranscriptData({ messages }, 'p', 's');
  const markup = app.innerHTML;
  const groupEnd = markup.indexOf('</details>');
  const block = markup.indexOf('<div class="tool-block subagent-run" id="tool-agent">');
  assert.ok(block > markup.indexOf('</summary>') && block < groupEnd);
  assert.match(markup, /<div class="tool-block" id="tool-bash">/);
  // Agent renders like Task: its own icon, name style and description.
  assert.match(markup, /tool-name task">Agent<\/span>\s*<span class="tool-desc">Critique the diff<\/span>/);
  assert.ok(markup.indexOf('Done') > groupEnd);
});

test('groups without subagent runs keep the plain summary', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    assistant(tool('a', 'Bash', { command: 'ls' }), tool('b', 'Read', { file_path: '/x' })),
    results(['a', 'ok'], ['b', 'ok']),
  ] }, 'p', 's');
  assert.doesNotMatch(app.innerHTML, /activity-agents|subagent-chip|subagent-run/);
});

// --- Parser: link an Agent run that has not returned yet --------------------

const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-outline-test-'));
after(() => fs.rmSync(fixtureHome, { recursive: true, force: true }));
const projectDir = '-Users-test-workspace';

const parserModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../parser.js'), 'utf8'), {
  module: parserModule,
  process: { env: {} },
  require: name => name === 'os' ? { homedir: () => fixtureHome } : require(name),
});
const { parseTranscript } = parserModule.exports;

test('an in-flight Agent call is linked to the subagent transcript it started', async () => {
  const sessionId = randomUUID();
  const dir = path.join(fixtureHome, '.claude/projects', projectDir);
  fs.mkdirSync(path.join(dir, sessionId, 'subagents'), { recursive: true });
  const call = {
    type: 'assistant', uuid: randomUUID(), timestamp: '2026-10-28T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Sweep logs', prompt: 'Go' } }] },
  };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(call) + '\n');
  const first = { type: 'user', uuid: randomUUID(), timestamp: '2026-10-28T10:00:00.400Z', isSidechain: true, message: { role: 'user', content: 'Go' } };
  fs.writeFileSync(path.join(dir, sessionId, 'subagents', 'agent-abc123.jsonl'), JSON.stringify(first) + '\n');

  const data = await parseTranscript(projectDir, sessionId);
  const block = data.messages[0].blocks[0];
  assert.equal(block.agentId, 'abc123');
  assert.equal(block.agentLink, `#/subagent/${projectDir}/${sessionId}/abc123`);
});
