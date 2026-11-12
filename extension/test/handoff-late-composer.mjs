import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A destination tab may receive the HSTRY wake before ChatGPT mounts the editor.
// Later DOM insertion must resume the same handoff, without a new chat or duplicate send.
let ready = false;
let observerCallback;
let pollTick;
let pollCancelled = false;
let nextTimerId = 1;
const timers = new Map();
const sent = [];
let composerSends = 0;
let finished = false;
let bannerCount = 0;
let editorValue = '';
let releaseFirstPoll;

// ChatGPT uses a ProseMirror div[contenteditable][data-composer-markdown].
const editor = {
  get textContent() { return editorValue; },
  set textContent(value) { editorValue = value; },
  focus() {},
  getBoundingClientRect: () => ({ width: 360, height: 48 }),
  hasAttribute: () => false,
};
const sendButton = {
  disabled: false,
  getBoundingClientRect: () => ({ width: 42, height: 42 }),
  click: () => {
    composerSends++;
    editorValue = '';
    context.location.pathname = '/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
  },
};
const context = {
  document: {
    body: { textContent: '' },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: selector => {
      if (selector.startsWith('#prompt-textarea') && selector.includes('[contenteditable="true"][data-composer-markdown]')) return ready ? [editor] : [];
      if (selector.startsWith('button[data-testid="send-button"]')) {
        return editorValue ? [sendButton] : [];
      }
      return [];
    },
    createElement: () => { bannerCount++; return {}; },
    addEventListener() {},
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (cmd, _ui, text) => {
      assert.equal(cmd, 'insertText');
      editorValue = text;
      return true;
    },
  },
  location: { pathname: '/' },
  addEventListener() {},
  sessionStorage: { getItem: () => null, removeItem: () => {} },
  HTMLTextAreaElement: class TextArea {},
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  Event: class { constructor(type) { this.type = type; } },
  setTimeout: callback => {
    const id = nextTimerId++;
    timers.set(id, callback);
    return id;
  },
  clearTimeout: id => timers.delete(id),
  setInterval: callback => { pollTick = callback; return 99; },
  clearInterval: id => { if (id === 99) pollCancelled = true; },
  MutationObserver: class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  },
  chrome: {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.4.25' }),
      onMessage: { addListener() {} },
      lastError: null,
      sendMessage: (message, callback) => {
        if (message.type === 'HSTRY_TAKEOVER_STATUS') {
          queueMicrotask(() => callback({ ok: true, found: false }));
          return;
        }
        sent.push(message.type);
        const response = () => callback(message.type === 'HSTRY_TAKEOVER_POLL'
          ? { ok: true, found: true, prompt: 'HSTRY recovery fixture prompt', landingPath: '/' }
          : { ok: true, completed: true });
        // A congested Chrome worker can hold the FIRST storage response for
        // minutes; this must not exhaust the landing retry window.
        if (message.type === 'HSTRY_TAKEOVER_POLL' && !releaseFirstPoll) {
          releaseFirstPoll = response;
        } else {
          queueMicrotask(response);
        }
        if (message.type === 'HSTRY_TAKEOVER_DONE') finished = true;
      },
    },
  },
};
context.window = context;
context.window.top = context;
const script = readFileSync(new URL('../handoff-content.js', import.meta.url), 'utf8');
vm.runInNewContext(script, context, { filename: 'handoff-content.js' });
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const flushTimers = () => {
  const batch = [...timers.values()];
  timers.clear();
  batch.forEach(cb => cb());
};

await settle();
assert.deepEqual(sent, ['HSTRY_TAKEOVER_POLL']);
assert.equal(composerSends, 0, 'must not send before composer exists');
assert.equal(finished, false, 'pending handoff must not be acknowledged prematurely');
assert.equal(bannerCount, 0, 'missing editor is recoverable, not a terminal error');

// Even if the first storage response is delayed for four minutes, the
// in-flight poll is still pending and must not exhaust the 24-second limit.
assert.equal(typeof releaseFirstPoll, 'function');
for (let n = 0; n < 300; n++) {
  observerCallback(); // Frequent React changes starve the DOM debounce.
  pollTick();
}
assert.equal(pollCancelled, false, 'in-flight HSTRY response must keep its landing timer alive');
assert.equal(composerSends, 0);
assert.deepEqual(sent, ['HSTRY_TAKEOVER_POLL'], 'do not dispatch duplicate storage polls');
releaseFirstPoll();
await settle();
pollTick();
assert.equal(pollCancelled, false, 'composer readiness must outlive 4 minutes of DOM changes');
flushTimers(); // No composer yet.
assert.equal(sent.length, 1);
ready = true;
context.location.pathname = '/g/g-p-6a81a59c80e48191a14c2f7c5ccdd387-krar-vst';
observerCallback();
await settle();
assert.equal(composerSends, 0,
  'a delayed source-A handoff must not write or send in project B');
assert.equal(finished, false, 'cross-project page must not receive a completion receipt');
context.location.pathname = '/';
observerCallback(); // Returning to the intended landing may resume the handoff.
await settle(); // No timer ticks: the DOM change itself must resume the handoff.
assert.equal(editorValue, '', 'native submit clears the input');
assert.equal(composerSends, 1);
assert.equal(finished, true);
assert.deepEqual(sent, ['HSTRY_TAKEOVER_POLL', 'HSTRY_TAKEOVER_POLL',
  'HSTRY_TAKEOVER_POLL', 'HSTRY_TAKEOVER_DONE'],
  'one additional check is required after the tab returns from the wrong project');
assert.equal(bannerCount, 0);

observerCallback();
flushTimers();
await settle();
assert.equal(composerSends, 1, 'subsequent mutations must not submit twice');
console.log('PASS late composer recovers the original pending handoff exactly once');
