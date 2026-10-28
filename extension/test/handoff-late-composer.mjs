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

// ChatGPT currently uses a ProseMirror div[contenteditable][role=textbox].
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
  click: () => { composerSends++; editorValue = ''; },
};
const context = {
  document: {
    body: { textContent: '' },
    getElementById: () => null,
    querySelectorAll: selector => {
      if (selector.startsWith('#prompt-textarea') && selector.includes('[contenteditable="true"][role="textbox"]')) return ready ? [editor] : [];
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
        sent.push(message.type);
        queueMicrotask(() => callback(message.type === 'HSTRY_TAKEOVER_POLL'
          ? { ok: true, found: true, prompt: 'HSTRY recovery fixture prompt' }
          : { ok: true, completed: true }));
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

pollTick(); // Existing timer must stop once DOM readiness owns the wait.
assert.equal(pollCancelled, true);
assert.equal(sent.length, 1);
flushTimers(); // No editor yet.
assert.equal(sent.length, 1);

ready = true;
observerCallback(); // The React composer arrives after the initial page load.
flushTimers();
await settle();
assert.equal(editorValue, '', 'native submit clears the input');
assert.equal(composerSends, 1);
assert.equal(finished, true);
assert.deepEqual(sent, ['HSTRY_TAKEOVER_POLL', 'HSTRY_TAKEOVER_POLL', 'HSTRY_TAKEOVER_DONE']);
assert.equal(bannerCount, 0);

observerCallback();
flushTimers();
await settle();
assert.equal(composerSends, 1, 'subsequent mutations must not submit twice');
console.log('PASS late composer recovers the original pending handoff exactly once');
