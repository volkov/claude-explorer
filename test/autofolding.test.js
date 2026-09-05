const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the actual inline renderer without adding runtime dependencies.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer() {
  const app = { innerHTML: '', querySelector: () => null };
  const elements = new Map([['app', app]]);
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
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
  return { context, app, elements };
}

const text = content => ({ type: 'text', content });
const thinking = content => ({ type: 'thinking', content });
const tool = (id, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command: 'pwd' } });
const assistant = (...blocks) => ({ type: 'assistant', blocks });
const user = content => ({ type: 'user', text: content });
const result = (id, content = 'ok', isError = false) => ({
  type: 'user', text: null, toolResults: [{ toolUseId: id, content, isError }],
});
const plain = value => JSON.parse(JSON.stringify(value));

test('groups mixed activity across tool results and ignores invisible blocks', () => {
  const { context } = viewer();
  const messages = [
    user('Start'), assistant(thinking('Plan'), tool('first')),
    result('first'), assistant(text(' \n ')),
    { ...assistant(text('Hidden sidechain')), isSidechain: true },
    assistant(tool('second')), result('second'), assistant(text('Finished')),
  ];
  const before = JSON.stringify(messages);
  const groups = context.groupTranscriptEntries({ messages });
  assert.deepEqual(plain(groups.map(g => [g.activity, g.entries.length])), [[false, 1], [true, 3], [false, 1]]);
  assert.deepEqual(plain(groups[1].entries.map(e => e.key)), ['m1-b0', 'm1-b1', 'm5-b0']);
  assert.equal(JSON.stringify(messages), before);
});

test('visible assistant and user text break activity runs, including within a message', () => {
  const { context } = viewer();
  const groups = context.groupTranscriptEntries({ messages: [
    assistant(tool('a'), tool('b'), text('Update'), thinking('Plan'), thinking('Check')),
    { ...result('b'), text: 'Please stop' },
    assistant(tool('c'), tool('d')),
  ] });
  assert.deepEqual(plain(groups.map(g => [g.activity, g.entries.length])), [
    [true, 2], [false, 1], [true, 2], [false, 1], [true, 2],
  ]);
});

test('system context renders collapsed with its own label and preserves the user prompt', () => {
  const { context, app } = viewer();
  const setup = {
    type: 'system', text: 'Available plugins', timestamp: '2026-09-05T01:10:28.000Z',
    _raw: JSON.stringify({ payload: { role: 'user', content: 'Available plugins' } }),
  };
  const data = { isCodex: true, messages: [setup, user('Fix the first message label.')] };
  context.renderTranscriptData(data, null, 'session');
  assert.match(app.innerHTML, /<details class="msg system-msg" id="system-m0-b0">/);
  assert.match(app.innerHTML, /class="role system">System<\/span>/);
  assert.match(app.innerHTML, /Session context/);
  assert.match(app.innerHTML, /Available plugins/);
  assert.match(app.innerHTML, /class="role user">User<\/span>/);
  assert.equal((app.innerHTML.match(/class="msg user-msg"/g) || []).length, 1);
  assert.ok(app.innerHTML.indexOf('Fix the first message label.') > app.innerHTML.indexOf('</details>'));
  assert.equal(JSON.parse(context._rawJsonMap.raw_0).payload.role, 'user');
  data.messages.push(assistant(text('Checking')));
  context.renderTranscriptData(data, null, 'session');
  assert.match(app.innerHTML, /id="system-m0-b0"/);
});

test('system context stays visible between separate activity groups', () => {
  const { context, app } = viewer();
  const data = { messages: [
    assistant(tool('a'), tool('b')),
    { type: 'system', text: 'Updated session context' },
    assistant(tool('c'), tool('d')),
  ] };
  assert.deepEqual(plain(context.groupTranscriptEntries(data).map(g => [g.activity, g.entries.length])), [
    [true, 2], [false, 1], [true, 2],
  ]);
  context.renderTranscriptData(data, null, 'session');
  assert.equal((app.innerHTML.match(/class="activity-group"/g) || []).length, 2);
  assert.ok(app.innerHTML.indexOf('system-m1-b0') > app.innerHTML.indexOf('</details>'));
  assert.ok(app.innerHTML.indexOf('system-m1-b0') < app.innerHTML.indexOf('activity-m2-b0'));
});

test('subagent transcripts include their sidechain activity', () => {
  const { context, app } = viewer();
  const messages = [{ ...assistant(thinking('Plan'), tool('a')), isSidechain: true }];
  context.renderTranscriptData({ messages }, 'project', 'session');
  assert.doesNotMatch(app.innerHTML, /class="activity-group"/);
  context.renderTranscriptData({ messages, agentId: 'agent' }, 'project', 'session');
  assert.match(app.innerHTML, /class="activity-group"/);
});

test('rendering collapses sequences, summarizes errors and keeps results and metadata inside', () => {
  const { context, app } = viewer();
  const msg = {
    ...assistant(thinking('Check <config>'), tool('a'), tool('b'), text('Ready')),
    model: 'test-model', usage: { input_tokens: 1200 }, _raw: '{"message":"original"}',
  };
  context.renderTranscriptData({ messages: [user('Start'), msg, result('a'), result('b', 'failed <build>', true)] }, 'project', 'session');
  assert.match(app.innerHTML, /<details class="activity-group" id="activity-m1-b0">/);
  assert.match(app.innerHTML, /2 tool calls · 1 thinking block/);
  assert.match(app.innerHTML, /Bash ×2/);
  assert.match(app.innerHTML, /1 error/);
  assert.match(app.innerHTML, /failed &lt;build&gt;/);
  assert.match(app.innerHTML, /Check &lt;config&gt;/);
  assert.match(app.innerHTML, /test-model/);
  assert.match(app.innerHTML, /Context used: 1,200 tokens/);
  assert.match(app.innerHTML, /showRawJson\('raw_1'\)/);
  assert.match(context._rawJsonMap.raw_1, /"message": "original"/);
  assert.ok(app.innerHTML.indexOf('Ready') > app.innerHTML.lastIndexOf('</details>'));
});

test('single calls retain their original layout and thinking-only runs get a text preview', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [assistant(text('Before'), tool('a'), text('After')), result('a')] }, null, 'session');
  assert.doesNotMatch(app.innerHTML, /class="activity-group"/);
  assert.equal((app.innerHTML.match(/class="msg assistant-msg"/g) || []).length, 1);
  context.renderTranscriptData({ messages: [assistant(thinking(''), thinking('Review\n <files>'))] }, null, 'session');
  assert.match(app.innerHTML, /2 thinking blocks/);
  assert.match(app.innerHTML, /activity-preview">Review &lt;files&gt;/);
  assert.match(app.innerHTML, /thinking-block-empty/);
});

test('TodoWrite, subagent links and long results survive grouping with stable input IDs', () => {
  const { context, app } = viewer();
  const todo = { type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'Verify', status: 'in_progress' }] } };
  const task = { ...tool('task', 'Task'), input: { prompt: 'Review the change' }, agentLink: '#/subagent/project/session/agent' };
  const data = { messages: [assistant(todo, task), result('task', Array(40).fill('output').join('\n'))] };
  context.renderTranscriptData(data, 'project', 'session');
  assert.match(app.innerHTML, /todo-write-block/);
  assert.match(app.innerHTML, /Verify/);
  assert.match(app.innerHTML, /href="#\/subagent\/project\/session\/agent"/);
  assert.match(app.innerHTML, /Show all 40 lines/);
  const ids = [...app.innerHTML.matchAll(/class="tool-input" id="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, 2);
  data.messages.push(assistant(thinking('More'), tool('next')));
  context.renderTranscriptData(data, 'project', 'session');
  for (const id of ids) assert.ok(app.innerHTML.includes(`id="${id}"`));
  assert.match(app.innerHTML, /id="activity-m0-b0"/);
});

test('live disclosure restoration keeps several groups and nested details open and is scoped', () => {
  const { context, app, elements } = viewer();
  const details = [{ id: 'group-a', open: false }, { id: 'group-b', open: false }, { id: 'thinking', open: false }, { id: 'system-m3-b0', open: false }];
  const input = { id: 'input', style: { display: 'none' } };
  const expandedResult = {
    id: 'result', dataset: {},
    classList: { remove(cls) { assert.equal(cls, 'collapsed'); } },
    parentElement: { querySelector: () => ({ remove() {} }) },
  };
  for (const el of [...details, input, expandedResult]) elements.set(el.id, el);
  const state = { details: details.map(el => el.id), inputs: ['input'], results: ['result'] };
  context.restoreTranscriptDisclosures(state);
  assert.ok(details.every(el => el.open));
  assert.equal(input.style.display, '');
  assert.equal(expandedResult.dataset.expandedResult, 'true');
  app.querySelector = () => ({
    dataset: { transcriptKey: 'session-a' },
    querySelectorAll: selector => selector.startsWith('details') ? details : selector.startsWith('.tool-input') ? [input] : [expandedResult],
  });
  assert.deepEqual(plain(context.captureTranscriptDisclosures('session-a')), state);
  assert.equal(context.captureTranscriptDisclosures('session-b'), null);
});

test('skill loads fold to "Loaded skill <name>" and keep the body, JSON and position', () => {
  const { context, app } = viewer();
  const load = {
    type: 'user', isMeta: true, skill: { name: 'linear:fetch' }, timestamp: '2026-09-05T00:56:44.777Z',
    text: 'Base directory for this skill: /skills/fetch\n\n# Linear <Fetch>\n\nPull everything relevant.',
    _raw: JSON.stringify({ isMeta: true, sourceToolUseID: 'skill' }),
  };
  const data = { messages: [
    user('Load the ticket'), assistant(tool('skill', 'Skill')), result('skill', 'Launching skill: linear:fetch'),
    load, assistant(tool('a'), tool('b')), result('a'), result('b'),
  ] };
  assert.deepEqual(plain(context.groupTranscriptEntries(data).map(g => [g.activity, g.entries.length])), [
    [false, 1], [true, 1], [false, 1], [true, 2],
  ]);
  context.renderTranscriptData(data, 'project', 'session');
  const html = app.innerHTML;
  assert.match(html, /<details class="msg skill-msg" id="skill-m3-b0">/);
  assert.match(html, /class="role skill">Skill<\/span>/);
  assert.match(html, /Loaded skill <strong>linear:fetch<\/strong>/);
  assert.match(html, /Pull everything relevant\./);
  assert.match(html, /showRawJson\('raw_3'\)/);
  assert.equal(JSON.parse(context._rawJsonMap.raw_3).sourceToolUseID, 'skill');
  assert.equal((html.match(/class="msg user-msg"/g) || []).length, 1);
  assert.equal((html.match(/class="activity-group"/g) || []).length, 1);
  assert.ok(html.indexOf('id="skill-m3-b0"') > html.indexOf('Launching skill: linear:fetch'));
  assert.ok(html.indexOf('id="skill-m3-b0"') < html.indexOf('id="activity-m4-b0"'));
  assert.ok(html.indexOf('Pull everything relevant.') < html.indexOf('id="activity-m4-b0"'));
  data.messages.push(assistant(text('Context loaded.')));
  context.renderTranscriptData(data, 'project', 'session');
  assert.match(app.innerHTML, /id="skill-m3-b0"/);
});

test('skill names are escaped and untagged meta prompts still render as User', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    { ...user('Base directory for this skill: /x'), isMeta: true, skill: { name: 'a<b>' } },
    { ...user('<system-reminder>Other agents active.</system-reminder>'), isMeta: true },
  ] }, null, 'session');
  assert.match(app.innerHTML, /Loaded skill <strong>a&lt;b&gt;<\/strong>/);
  assert.equal((app.innerHTML.match(/class="msg skill-msg"/g) || []).length, 1);
  assert.equal((app.innerHTML.match(/class="msg user-msg"/g) || []).length, 1);
});
