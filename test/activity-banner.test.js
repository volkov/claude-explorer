const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function viewer() {
  const banner = { hidden: true };
  const age = { textContent: '' };
  const elements = new Map([['activeBanner', banner], ['lastMessageAge', age]]);
  const timers = new Map();
  let nextTimer = 1;
  let now = 1_000_000;
  const context = vm.createContext({
    document: {
      getElementById: id => elements.get(id) || null,
      documentElement: { setAttribute() {} },
    },
    localStorage: { getItem: () => 'dark' },
    requestAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    marked: { setOptions() {} },
    Date: class extends Date { static now() { return now; } },
    setInterval(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval: id => timers.delete(id),
    location: { hash: '#/session/project/session-a' },
  });
  context.window = context;
  vm.runInContext(script, context);
  return {
    context, banner, age, timers,
    advance(ms) { now += ms; },
    tick(delay) {
      for (const timer of [...timers.values()]) {
        if (timer.delay === delay) timer.callback();
      }
    },
  };
}

test('message age changes from seconds to minutes and clamps clock skew', () => {
  const { context } = viewer();
  for (const [elapsed, expected] of [
    [-1000, '0 seconds ago'], [999, '0 seconds ago'], [1000, '1 second ago'],
    [59_999, '59 seconds ago'], [60_000, '1 minute ago'],
    [119_999, '1 minute ago'], [120_000, '2 minutes ago'],
  ]) {
    assert.equal(context.formatMessageAge(1_000_000, 1_000_000 + elapsed), expected);
  }
});

test('counter ticks between polls, resets on new output, and stops when hidden', () => {
  const { context, banner, age, timers, advance, tick } = viewer();
  context.setActiveBanner(true, 999_000);
  assert.equal(banner.hidden, false);
  assert.equal(age.textContent, 'Last message 1 second ago');
  advance(1000);
  tick(1000);
  assert.equal(age.textContent, 'Last message 2 seconds ago');

  context.setActiveBanner(true, 999_000);
  assert.equal(timers.size, 1, 'status polling must reuse the age timer');
  context.setActiveBanner(true, 1_001_000);
  assert.equal(age.textContent, 'Last message 0 seconds ago');
  context.setActiveBanner(false, 1_001_000);
  assert.equal(banner.hidden, true);
  assert.equal(age.textContent, '');
  assert.equal(timers.size, 0);

  context.setActiveBanner(true, 1_001_000);
  assert.equal(timers.size, 1, 'resuming activity restarts the counter');
  context.stopActivePolling();
  assert.equal(banner.hidden, true);
  assert.equal(age.textContent, '');
  assert.equal(timers.size, 0);
});

test('missing or invalid activity timestamps do not show a bogus age', () => {
  const { context, age } = viewer();
  for (const timestamp of [undefined, null, 0, NaN, Infinity, 'invalid']) {
    context.setActiveBanner(true, timestamp);
    assert.equal(age.textContent, '');
  }
});

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Claude and Codex polls pass the activity timestamp to the banner', async () => {
  for (const codex of [false, true]) {
    const { context, banner, age, timers } = viewer();
    context.location.hash = codex ? '#/codex/session-a' : '#/session/project/session-a';
    const calls = [];
    let status = { isActive: true, mtimeMs: 940_000 };
    context.api = async url => {
      calls.push(url);
      return url.includes('/status/') ? status : { messages: [] };
    };
    context.renderTranscriptData = () => {};
    context.scrollToBottom = () => {};
    if (codex) context.startCodexPolling('session-a');
    else context.startActivePolling('project', 'session-a');
    await settle();
    assert.equal(banner.hidden, false);
    assert.equal(age.textContent, 'Last message 1 minute ago');
    assert.equal(calls[0], codex ? '/api/codex/status/session-a' : '/api/status/project/session-a');
    assert.equal(timers.size, 2);

    status = { isActive: false, mtimeMs: 940_000 };
    await [...timers.values()].find(timer => timer.delay === 5000).callback();
    assert.equal(banner.hidden, true);
    assert.equal(timers.size, 1, 'keep polling so resumed activity is detected');
    context.stopActivePolling();
    assert.equal(timers.size, 0);
  }
});

test('late status responses cannot restore the banner after leaving a session', async () => {
  const { context, banner, age, timers } = viewer();
  let resolveStatus;
  context.api = () => new Promise(resolve => { resolveStatus = resolve; });
  context.startActivePolling('project', 'session-a');
  context.stopActivePolling();
  // Returning to the same route must not revive its previous polling lifecycle.
  resolveStatus({ isActive: true, mtimeMs: 999_000 });
  await settle();
  assert.equal(banner.hidden, true);
  assert.equal(age.textContent, '');
  assert.equal(timers.size, 0);
});

test('late transcript responses cannot replace the next session', async () => {
  const { context } = viewer();
  let resolveTranscript;
  let renders = 0;
  context.api = url => url.includes('/status/')
    ? Promise.resolve({ isActive: true, mtimeMs: 999_000 })
    : new Promise(resolve => { resolveTranscript = resolve; });
  context.renderTranscriptData = () => { renders++; };
  context.startActivePolling('project', 'session-a');
  await settle();
  context.stopActivePolling();
  context.location.hash = '#/session/project/session-b';
  resolveTranscript({ messages: [] });
  await settle();
  assert.equal(renders, 0);
});
