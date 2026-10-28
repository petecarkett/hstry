import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../handoff-content.js', import.meta.url), 'utf8');
const warning = "You've reached the maximum length for this conversation. You can keep talking by starting a new chat.";
const path = '/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/6add53d9-4c88-83ed-a57d-6a602a257293';

function mount(initialWarning, previous = null) {
  let reachedLimit = initialWarning;
  let button = null;
  let clickButton = null;
  const sent = [];
  const events = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let observer;
  const panel = { get textContent() { return warning; }, parentElement: null };
  const native = {
    textContent: 'Start new chat',
    parentElement: panel,
    insertAdjacentElement(_position, element) { button = element; },
  };
  const document = {
    body: { get textContent() { return reachedLimit ? warning : ''; }, append() {} },
    getElementById(id) { return id === 'hstry-continue-chat' ? button : null; },
    querySelectorAll(query) { return query === 'button, a' ? [native] : []; },
    createElement() {
      return {
        style: {}, disabled: false,
        addEventListener(type, handler) { if (type === 'click') clickButton = handler; },
      };
    },
    addEventListener(type, handler) { events.set(type, handler); },
  };
  const location = { pathname: path, reload() { throw Error('reload unexpected'); } };
  const context = {
    document, location,
    chrome: {
      runtime: {
        id: 'hstry-extension',
        getManifest: () => ({ version: '0.4.26' }),
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage(message, done) {
          sent.push(message);
          queueMicrotask(() => done({ ok: true, tabId: 600 }));
        },
      },
    },
    sessionStorage: { getItem: () => null, removeItem() {} },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {} disconnect() {}
    },
  };
  context.window = context;
  context.window.top = context;
  if (previous) context.window.__hstryOneclickInstalled = previous;
  vm.runInNewContext(script, context, { filename: 'handoff-content.js' });
  const flush = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(callback => callback());
  };
  return {
    sent,
    get button() { return button; },
    flush, mutate() { observer(); },
    setLimited(value = true) { reachedLimit = value; },
    setPath(value) { location.pathname = value; },
    submitByClick() {
      events.get('click')({ target: { closest: selector =>
        selector.includes('send-button') ? {} : null } });
    },
    submitByEnter() {
      events.get('keydown')({
        key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false,
        altKey: false, isComposing: false,
        target: { closest: selector => selector.includes('contenteditable') ? {} : null },
      });
    },
    manualClick() { clickButton({ preventDefault() {} }); },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

const existing = mount(true);
existing.flush();
await tick();
assert.ok(existing.button, 'old expired chat retains a button');
assert.equal(existing.sent.length, 0, 'opening old expired chat must not create a new chat');
existing.manualClick();
await tick();
assert.equal(existing.sent.length, 1);
assert.equal(existing.sent[0].automatic, false);

const current = mount(false);
current.flush();
current.submitByClick();
current.setLimited();
current.mutate();
current.flush();
await tick();
assert.ok(current.button);
assert.equal(current.sent.length, 1, 'one new warning launches one continuation');
assert.equal(current.sent[0].automatic, true);
current.mutate();
current.flush();
await tick();
assert.equal(current.sent.length, 1, 'mutation storm must not open duplicate chat');

const keyboard = mount(false);
keyboard.flush();
keyboard.submitByEnter();
keyboard.setLimited();
keyboard.mutate();
keyboard.flush();
await tick();
assert.equal(keyboard.sent.length, 1, 'Enter submission triggers automatic handoff');
assert.equal(keyboard.sent[0].automatic, true);

const changedChat = mount(false);
changedChat.flush();
changedChat.submitByClick();
changedChat.setPath('/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
changedChat.setLimited();
changedChat.mutate();
changedChat.flush();
await tick();
assert.equal(changedChat.sent.length, 0, 'activity in another conversation is not a trigger');

const obsolete = mount(true, { version: '0.4.26', isLive: () => false });
obsolete.flush();
assert.ok(obsolete.button, 'stale same-version context must be replaced');
const live = mount(true, { version: '0.4.26', isLive: () => true });
live.flush();
assert.equal(live.button, null, 'healthy same-version handler remains installed');

console.log('PASS automatic continuation is event-driven, scoped and nonduplicating');
