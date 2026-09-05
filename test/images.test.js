const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { test, after } = require('node:test');

// ── Parser under an isolated home (same approach as codex.test.js) ──────────
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'images-transcript-test-'));
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
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDASIAAhEBAxEB/9k=';
const base64Image = (data = PNG, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data } });

async function parseClaude(entries) {
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return parseTranscript(projectDir, sessionId);
}
const claudeUser = (content, extra = {}) => ({ type: 'user', uuid: randomUUID(), timestamp, message: { role: 'user', content }, ...extra });
const claudeAssistant = content => ({ type: 'assistant', uuid: randomUUID(), timestamp, message: { role: 'assistant', model: 'claude-test', content } });

async function parseCodex(entries) {
  const sessionId = randomUUID();
  fs.writeFileSync(path.join(rolloutDir, `rollout-2026-09-05T01-10-28-${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return parseCodexRollout(sessionId);
}
const item = payload => ({ timestamp, type: 'response_item', payload });
// Values built inside the vm realm have foreign prototypes; compare by shape.
const plain = value => JSON.parse(JSON.stringify(value));

test('claude: pasted screenshots become msg.images, even when the prompt is image-only', async () => {
  const data = await parseClaude([
    claudeUser([{ type: 'text', text: '[Image #1]\n\ni see following' }, base64Image(JPEG, 'image/jpeg')]),
    claudeUser([base64Image(), base64Image(JPEG, 'image/jpeg')]),
    claudeUser('plain text prompt'),
  ]);
  const [withText, imageOnly, textOnly] = data.messages;
  assert.equal(withText.text, '[Image #1]\n\ni see following');
  assert.deepEqual(plain(withText.images), [{ src: `data:image/jpeg;base64,${JPEG}`, mediaType: 'image/jpeg' }]);
  assert.equal(imageOnly.text, null);
  assert.deepEqual(plain(imageOnly.images.map(i => i.mediaType)), ['image/png', 'image/jpeg']);
  assert.equal(textOnly.text, 'plain text prompt');
  assert.equal(textOnly.images, undefined);
});

test('claude: image tool results (Read on a screenshot) keep the image and any text', async () => {
  const data = await parseClaude([
    claudeAssistant([{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/shot.jpg' } }]),
    claudeUser([{ type: 'tool_result', tool_use_id: 'read-1', content: [base64Image(JPEG, 'image/jpeg')] }],
      { toolUseResult: { type: 'image', file: { base64: JPEG, type: 'image/jpeg' } } }),
    claudeAssistant([{ type: 'tool_use', id: 'shot-2', name: 'mcp__browser__screenshot', input: {} }]),
    claudeUser([{ type: 'tool_result', tool_use_id: 'shot-2', content: [
      { type: 'text', text: 'Captured page' }, base64Image(), { type: 'text', text: 'Done' },
    ] }]),
    claudeAssistant([{ type: 'tool_use', id: 'ls-3', name: 'Bash', input: { command: 'ls' } }]),
    claudeUser([{ type: 'tool_result', tool_use_id: 'ls-3', content: [{ type: 'text', text: 'a\nb' }] }]),
  ]);
  const results = data.messages.filter(m => m.toolResults && m.toolResults.length).map(m => m.toolResults[0]);
  assert.equal(results[0].toolUseId, 'read-1');
  assert.equal(results[0].content, '');
  assert.deepEqual(plain(results[0].images), [{ src: `data:image/jpeg;base64,${JPEG}`, mediaType: 'image/jpeg' }]);
  assert.equal(results[1].content, 'Captured page\nDone');
  assert.equal(results[1].images.length, 1);
  assert.equal(results[2].content, 'a\nb');
  assert.equal(results[2].images, undefined);
});

test('claude: url sources are kept, unsupported or unsafe sources are dropped', async () => {
  const data = await parseClaude([
    claudeUser([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
      { type: 'image', source: { type: 'url', url: 'javascript:alert(1)' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      { type: 'image', source: { type: 'file', file_id: 'file_123' } },
      { type: 'image' },
    ]),
  ]);
  assert.deepEqual(plain(data.messages[0].images), [{ src: 'https://example.com/shot.png', mediaType: null }]);
});

test('codex: input_image tool outputs and pasted images are not dumped as base64 text', async () => {
  const dataUri = `data:image/png;base64,${PNG}`;
  const data = await parseCodex([
    item({ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'What is on this screenshot?' },
      { type: 'input_image', image_url: dataUri, detail: 'high' },
    ] }),
    item({ type: 'custom_tool_call', call_id: 'shot', name: 'exec', input: 'screenshot' }),
    item({ type: 'custom_tool_call_output', call_id: 'shot', output: [
      { type: 'input_text', text: 'Script completed\nOutput:' },
      { type: 'input_image', image_url: dataUri, detail: 'high' },
      { type: 'input_image', image_url: 'https://example.com/a.png' },
      { type: 'input_text', text: '{"i":1}' },
    ] }),
    item({ type: 'function_call', call_id: 'pwd', name: 'exec_command', arguments: '{"cmd":"pwd"}' }),
    item({ type: 'function_call_output', call_id: 'pwd', output: '/workspace' }),
  ]);
  const [prompt, assistant, shot, , pwd] = data.messages;
  assert.equal(prompt.type, 'user');
  assert.equal(prompt.text, 'What is on this screenshot?');
  assert.deepEqual(plain(prompt.images), [{ src: dataUri, mediaType: 'image/png' }]);
  assert.equal(assistant.type, 'assistant');
  assert.equal(shot.toolResults[0].content, 'Script completed\nOutput:\n{"i":1}');
  assert.deepEqual(plain(shot.toolResults[0].images.map(i => i.src)), [dataUri, 'https://example.com/a.png']);
  assert.ok(!JSON.stringify(shot.toolResults[0].content).includes(PNG));
  assert.equal(pwd.toolResults[0].content, '/workspace');
  assert.equal(pwd.toolResults[0].images, undefined);
});

// ── Renderer (the inline script, as in autofolding.test.js) ────────────────
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer() {
  const app = { innerHTML: '', querySelector: () => null };
  const elements = new Map([['app', app]]);
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const listeners = new Map();
  const createElement = tag => ({
    tag, children: [],
    appendChild(el) { this.children.push(el); },
    remove() { body.children = body.children.filter(c => c !== this); },
  });
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll: () => [],
      documentElement: { setAttribute() {} },
      createElement,
      body,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: type => listeners.delete(type),
    },
    localStorage: { getItem: () => 'dark' },
    requestAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    marked: { setOptions() {}, parse: text => `<p>${text}</p>` },
  });
  context.window = context;
  vm.runInContext(script, context);
  return { context, app, body, listeners };
}

const image = (src = 'data:image/png;base64,AAAA', mediaType = 'image/png') => ({ src, mediaType });
const assistant = (...blocks) => ({ type: 'assistant', blocks });
const tool = (id, name = 'Read') => ({ type: 'tool_use', id, name, input: { file_path: '/tmp/shot.png' } });
const result = (id, content = '', images) => ({ type: 'user', text: null, toolResults: [{ toolUseId: id, content, isError: false, images }] });
const count = (s, re) => (s.match(re) || []).length;

test('renders pasted images in user messages, including image-only prompts', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    { type: 'user', text: 'see <this>', images: [image()], _raw: '{}' },
    { type: 'user', text: null, images: [image('data:image/jpeg;base64,BBBB', 'image/jpeg'), image()] },
    { type: 'user', text: null },
    assistant({ type: 'text', content: 'Looks fine' }),
  ] }, 'project', 'session');
  const out = app.innerHTML;
  assert.equal(count(out, /class="msg user-msg"/g), 2, 'text-less, image-less user entries stay hidden');
  assert.equal(count(out, /<img class="msg-image"/g), 3);
  assert.match(out, /<p>see <this><\/p>[\s\S]*?<img class="msg-image" src="data:image\/png;base64,AAAA" alt="Image 1 \(image\/png\)"/);
  assert.match(out, /src="data:image\/jpeg;base64,BBBB" alt="Image 1 \(image\/jpeg\)"/);
  assert.match(out, /loading="lazy"[^>]*onclick="showImage\(this\.src\)"/);
  assert.ok(context._rawJsonMap.raw_0, 'raw JSON stays available for image messages');
  assert.equal(count(out, /class="md-content"/g), 2, 'image-only prompt has no empty text body');
});

test('image tool results show the image instead of "(empty)" and keep text results intact', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    assistant(tool('read-1')), result('read-1', '', [image()]),
    assistant(tool('shot-2', 'Screenshot')), result('shot-2', 'Captured', [image(), image()]),
    assistant(tool('ls-3', 'Bash')), result('ls-3', ''),
  ] }, 'project', 'session');
  const out = app.innerHTML;
  assert.equal(count(out, /<div class="msg-images tool-result-images">/g), 2);
  assert.equal(count(out, /<img class="msg-image"/g), 3);
  assert.equal(count(out, /\(empty\)/g), 1, 'only the truly empty Bash result says (empty)');
  const readBlock = out.slice(out.indexOf('id="tool-read-1"'), out.indexOf('id="tool-shot-2"'));
  assert.ok(!readBlock.includes('class="tool-result'), 'no empty text box above the image');
  const shotBlock = out.slice(out.indexOf('id="tool-shot-2"'), out.indexOf('id="tool-ls-3"'));
  assert.ok(shotBlock.indexOf('Captured') < shotBlock.indexOf('<img'), 'text result precedes its images');
});

test('image tool results are grouped and folded like other activity', () => {
  const { context, app } = viewer();
  const groups = context.groupTranscriptEntries({ messages: [
    { type: 'user', text: null, images: [image()] },
    assistant(tool('a')), result('a', '', [image()]), assistant(tool('b')), result('b', '', [image()]),
  ] });
  assert.deepEqual(plain(groups.map(g => [g.activity, g.entries.length])), [[false, 1], [true, 2]]);
  context.renderTranscriptData({ messages: [
    assistant(tool('a')), result('a', '', [image()]), assistant(tool('b')), result('b', '', [image()]),
  ] }, 'project', 'session');
  assert.match(app.innerHTML, /<details class="activity-group"[\s\S]*<img class="msg-image"[\s\S]*<img class="msg-image"[\s\S]*<\/details>/);
});

test('the lightbox opens the full-size image and closes on click or Escape', () => {
  const { context, body, listeners } = viewer();
  context.showImage('');
  assert.equal(body.children.length, 0);
  context.showImage('data:image/png;base64,AAAA');
  assert.equal(body.children.length, 1);
  const overlay = body.children[0];
  assert.equal(overlay.className, 'image-modal-overlay');
  assert.equal(overlay.children[0].tag, 'img');
  assert.equal(overlay.children[0].src, 'data:image/png;base64,AAAA');
  listeners.get('keydown')({ key: 'Enter' });
  assert.equal(body.children.length, 1);
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal(body.children.length, 0);
  assert.ok(!listeners.has('keydown'), 'key listener removed on close');
  context.showImage('https://example.com/a.png');
  body.children[0].onclick();
  assert.equal(body.children.length, 0);
});
