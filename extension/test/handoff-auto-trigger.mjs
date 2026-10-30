import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../handoff-content.js', import.meta.url), 'utf8');
const warning = "You've reached the maximum length for this conversation. You can keep talking by starting a new chat.";
const path = '/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/6add53d9-4c88-83ed-a57d-6a602a257293';

function mount(initialWarning, previous = null, active = false, draft = '', screenText = warning) {
  let visible = active;
  let focused = active;
  let reachedLimit = initialWarning;
  let button = null;
  let clickButton = null;
  const sent = [];
  const events = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let observer;
  let observing = false;
  const panel = { get textContent() { return screenText; }, parentElement: null };
  const native = {
    textContent: 'Start new chat',
    parentElement: panel,
    insertAdjacentElement(_position, element) { button = element; },
  };
  const document = {
    body: { get textContent() { return reachedLimit ? screenText : ''; }, append() {} },
    get visibilityState() { return visible ? 'visible' : 'hidden'; },
    hasFocus: () => focused,
    getElementById(id) { return id === 'hstry-continue-chat' ? button : null; },
    querySelectorAll(query) {
      if (query === 'button, a') return [native];
      if (draft && query.startsWith('#prompt-textarea')) return [{
        textContent: draft, hasAttribute: () => false,
        getBoundingClientRect: () => ({ width: 350, height: 45 }),
      }];
      return [];
    },
    createElement() {
      return {
        style: {}, disabled: false, setAttribute() {},
        addEventListener(type, handler) { if (type === 'click') clickButton = handler; },
      };
    },
    addEventListener(type, handler) { events.set(type, handler); },
  };
  const location = { pathname: path, reload() { throw Error('reload unexpected'); } };
  const context = {
    document, location,
    addEventListener(type, handler) { events.set(`window:${type}`, handler); },
    chrome: {
      runtime: {
        id: 'hstry-extension',
        getManifest: () => ({ version: '0.4.32' }),
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
      observe() { observing = true; }
      disconnect() { observing = false; }
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
    flush, mutate() { if (observing) observer(); },
    redrawPanel() { button = null; if (observing) observer(); },
    focus() { visible = true; focused = true; events.get('window:focus')?.(); },
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

const terminal = mount(true, null, true, '', 'Unknown error Start new chat');
terminal.flush();
await tick();
assert.ok(terminal.button, 'native Unknown error panel must offer HSTRY recovery');
assert.equal(terminal.sent.length, 0, 'generic errors must not auto-open a new chat');
terminal.manualClick();
await tick();
assert.equal(terminal.sent.length, 1, 'manual recovery uses existing HSTRY takeover');
assert.equal(terminal.sent[0].automatic, false, 'error takeover requires an explicit click');
terminal.redrawPanel();
terminal.flush();
await tick();
assert.equal(terminal.sent.length, 1, 're-render cannot auto-repeat error takeover');

const strayError = mount(true, null, true, '', 'Unknown error');
strayError.flush();
await tick();
assert.equal(strayError.button, null, 'unrelated errors without a paired new-chat panel are ignored');

const withDraft = mount(true, null, true, 'A message I have not sent');
withDraft.flush();
await tick();
assert.equal(withDraft.sent.length, 0, 'unsent text must not be lost to same-tab navigation');
assert.equal(withDraft.button.disabled, false, 'manual retry remains possible after saving draft');

const alreadyFull = mount(true, null, true);
alreadyFull.flush();
await tick();
assert.equal(alreadyFull.sent.length, 1, 'focused, already-full chat must automatically continue');
assert.equal(alreadyFull.sent[0].automatic, true);
alreadyFull.redrawPanel();
alreadyFull.flush();
await tick();
assert.ok(alreadyFull.button, 'React redraw must restore the takeover button');
assert.equal(alreadyFull.sent.length, 1, 'React redraw must not create a second continuation');

const asleep = mount(true);
asleep.flush();
await tick();
assert.equal(asleep.sent.length, 0, 'inactive expired tab must not auto-open');
asleep.focus();
asleep.flush();
await tick();
assert.equal(asleep.sent.length, 1, 'returning to expired tab triggers one continuation');

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

const obsolete = mount(true, { version: '0.4.32', isLive: () => false });
obsolete.flush();
assert.ok(obsolete.button, 'stale same-version context must be replaced');
const live = mount(true, { version: '0.4.32', isLive: () => true });
live.flush();
assert.equal(live.button, null, 'healthy same-version handler remains installed');

console.log('PASS automatic continuation handles already-full focused chats, SPA and DOM redraws without duplicates');
