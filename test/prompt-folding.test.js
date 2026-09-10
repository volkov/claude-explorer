const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Exercise the actual inline renderer (same harness as autofolding.test.js),
// with control over what the post-render fit pass sees on the page.
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer(collapsedPrompts = []) {
  const app = { innerHTML: '', querySelector: () => null };
  const elements = new Map([['app', app]]);
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll: selector => selector === '.prompt-body.collapsed' ? collapsedPrompts : [],
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

const user = (text, extra = {}) => ({ type: 'user', text, ...extra });
const numbered = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const count = (s, re) => (s.match(re) || []).length;

test('prompts longer than ten lines fold to a preview with a "Show full prompt" button', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    user(numbered(12), { images: [{ src: 'data:image/png;base64,AAAA', mediaType: 'image/png' }] }),
    user(numbered(10)),
    user('x'.repeat(1200)),
  ] }, 'project', 'session');
  const out = app.innerHTML;
  assert.equal(count(out, /class="msg user-msg"/g), 3);
  assert.equal(count(out, /prompt-body collapsed/g), 2, 'ten lines under 1000 chars is not long');
  assert.match(out, /<div class="md-content prompt-body collapsed" id="prompt-m0-b0"><p>line 1\n[\s\S]*line 12<\/p><\/div>/,
    'the whole prompt is rendered — the cut is visual');
  assert.match(out, /onclick="expandResult\('prompt-m0-b0', this\)">Show full prompt \(12 lines\)<\/button>/);
  assert.match(out, /id="prompt-m2-b0"[\s\S]*Show full prompt \(1200 chars\)/, 'one huge paragraph wraps past ten lines too');
  assert.match(out, /<div class="md-content"><p>line 1\n/, 'short prompts keep the plain body');
  assert.ok(out.indexOf('id="prompt-m0-b0"') < out.indexOf('Show full prompt (12 lines)'), 'button sits under the text');
  assert.ok(out.indexOf('Show full prompt (12 lines)') < out.indexOf('<img class="msg-image"'), 'pasted images stay visible below');
  assert.equal(count(out, /<img class="msg-image"/g), 1);
});

test('system context and skill loads keep their own fold and are not truncated', () => {
  const { context, app } = viewer();
  context.renderTranscriptData({ messages: [
    { type: 'system', text: numbered(20), images: [{ src: 'data:image/png;base64,AAAA', mediaType: 'image/png' }] },
    user(numbered(20), { isMeta: true, skill: { name: 'linear:fetch' } }),
  ] }, null, 'session');
  const out = app.innerHTML;
  assert.doesNotMatch(out, /prompt-body/);
  assert.doesNotMatch(out, /expand-btn/);
  assert.equal(count(out, /line 20/g), 2, 'both bodies are complete');
  assert.match(out, /<details class="msg system-msg"[\s\S]*<img class="msg-image"[\s\S]*<\/details>/, 'system images still render inside its fold');
});

test('an opened prompt stays open across live refreshes', () => {
  const { context, app, elements } = viewer();
  const removed = [];
  const button = { remove: () => removed.push('button') };
  const prompt = {
    id: 'prompt-m0-b0', dataset: {},
    classList: { remove: cls => removed.push(cls) },
    parentElement: { querySelector: selector => selector === '.expand-btn' ? button : null },
  };
  elements.set(prompt.id, prompt);
  context.expandResult(prompt.id, button);
  assert.deepEqual(removed, ['collapsed', 'button']);
  assert.equal(prompt.dataset.expandedResult, 'true');
  app.querySelector = () => ({
    dataset: { transcriptKey: 'key' },
    querySelectorAll: selector => selector === '[data-expanded-result]' ? [prompt] : [],
  });
  const state = JSON.parse(JSON.stringify(context.captureTranscriptDisclosures('key')));
  assert.deepEqual(state.results, ['prompt-m0-b0']);
  context.restoreTranscriptDisclosures(state);
  assert.deepEqual(removed, ['collapsed', 'button', 'collapsed', 'button'], 'restore re-opens it via the same path');
});

test('the fit pass lifts the fold when the rendered text fits the preview box', () => {
  const box = (id, clientHeight, scrollHeight) => {
    const el = {
      id, clientHeight, scrollHeight, collapsed: true, hasButton: true,
      classList: { remove(cls) { assert.equal(cls, 'collapsed'); el.collapsed = false; } },
      parentElement: { querySelector: () => ({ remove() { el.hasButton = false; } }) },
    };
    return el;
  };
  const fits = box('fits', 231, 231);
  const sliver = box('sliver', 231, 250);
  const overflows = box('overflows', 231, 900);
  const hidden = box('hidden', 0, 0);
  const { context } = viewer([fits, sliver, overflows, hidden]);
  context.renderTranscriptData({ messages: [user('hi')] }, 'project', 'session');
  assert.deepEqual([fits, sliver, overflows, hidden].map(el => [el.collapsed, el.hasButton]), [
    [false, false], [false, false], [true, true], [true, true],
  ]);
});

test('the preview box is a fixed-height clip with a fade, not a text slice', () => {
  assert.match(html, /\.prompt-body\.collapsed\s*\{[^}]*max-height:\s*calc\(10 \* 1\.65em\)[^}]*overflow:\s*hidden/);
  assert.match(html, /\.md-content\s*\{\s*line-height:\s*1\.65;?\s*\}/, 'preview height assumes this line-height');
  assert.match(html, /\.prompt-body\.collapsed::after\s*\{[^}]*linear-gradient\(transparent, var\(--bg-user\)\)/);
});
