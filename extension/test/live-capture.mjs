import assert from 'node:assert/strict';
import vm from 'node:vm';
import { appendLiveCapture, appendLiveCaptures, canonicalMessages, confirmLiveCapture, conversationFromUrl, validLiveCapture, resolveLiveOwner, resolveLiveProjectName } from '../lib/live-capture.js';

const conversationId = '6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const messageId = 'f9085be9-bc56-4ba8-826b-a6e3d4b4b883';
const url = `https://chatgpt.com/g/${projectId}-1hood/c/${conversationId}`;
const raw = { conversationId, projectId, messageId, role: 'user', content: '  hello live  ', title: '1hood' };
const discovered = { chatgpt: { state: { pending: { scopes: [
  { accountId: 'account-1', sourceId: 'chatgpt-web-owner1', projectId, projectName: '1hood' },
  { accountId: 'account-1', sourceId: 'chatgpt-web-owner1', projectId: null, projectName: null },
] } } } };
assert.equal(resolveLiveOwner({ projectId }, discovered).sourceId, 'chatgpt-web-owner1');
assert.equal(resolveLiveOwner({ projectId: null }, discovered).projectId, null);
assert.equal(resolveLiveOwner({ projectId: 'g-p-11111111111111111111111111111111' }, discovered), null);
const ambiguous = structuredClone(discovered);
ambiguous.chatgpt.state.pending.scopes.push({
  accountId: 'account-2', sourceId: 'chatgpt-web-owner2', projectId, projectName: 'other',
});
assert.equal(resolveLiveOwner({ projectId }, ambiguous), null, 'ambiguous workspace must not be guessed');
assert.equal(resolveLiveProjectName({ projectId }, discovered), '1hood');
assert.equal(resolveLiveProjectName({ projectId: null }, discovered), null);
assert.equal(resolveLiveProjectName({ projectId }, ambiguous), null, 'conflicting project names must not be guessed');
ambiguous.chatgpt.state.pending.scopes[2].projectName = '1hood';
assert.equal(resolveLiveProjectName({ projectId }, ambiguous), '1hood',
  'same project name across accounts is verified even when source owner is ambiguous');
assert.deepEqual(conversationFromUrl(url), { conversationId, projectId, url });
assert.equal(conversationFromUrl(`https://chatgpt.com/c/${conversationId}?foo=bar`)?.projectId, null);
assert.equal(conversationFromUrl(`https://evil.chatgpt.com/c/${conversationId}`), null);
assert.equal(conversationFromUrl('https://chatgpt.com/'), null);
assert.equal(conversationFromUrl(`https://chatgpt.com/c/bad`), null);
const value = validLiveCapture(raw, url);
assert(value && value.content === 'hello live');
assert.equal(validLiveCapture(raw, `https://other.site/c/${conversationId}`), null);
assert.equal(validLiveCapture({ ...raw, role: 'tool' }, url), null);
assert.equal(validLiveCapture({ ...raw, content: ' ' }, url), null);
assert.equal(validLiveCapture({ ...raw, content: 'x'.repeat(500_001) }, url), null);
assert.equal(validLiveCapture({ ...raw, conversationId: 'other' }, url), null);
assert.equal(validLiveCapture({ ...raw, projectId: null }, url), null);
assert.equal(validLiveCapture({ ...raw, url }, `https://chatgpt.com/c/00000000-0000-0000-0000-000000000123`)?.conversationId,
  conversationId, 'queued capture survives a same-origin chat navigation');
assert.equal(validLiveCapture({ ...raw, url }, 'https://evil.example/c/other'), null);
assert.equal(validLiveCapture({ ...raw, url: 'https://evil.example/c/other' }, url), null);
const initial = appendLiveCapture({}, value);
assert.strictEqual(appendLiveCapture(initial, value), initial, 'dedupe identical content');
assert.strictEqual(appendLiveCaptures(initial, [value, value]), initial,
  'an unchanged batch does not rewrite the durable queue');
const edit = appendLiveCapture(initial, { ...value, content: 'hello live again' });
assert.equal(Object.keys(edit).length, 1);
assert.notStrictEqual(edit, initial);
assert.strictEqual(confirmLiveCapture(edit, { conversationId, confirmed: { [messageId]: 'hello live' } }), edit, 'no premature partial clearing');
assert.equal(Object.keys(confirmLiveCapture(edit, { conversationId, confirmed: { [messageId]: 'hello   live   again' } })).length, 0);
assert.equal(Object.keys(initial).length, 1, 'immutable updates');
assert.equal(canonicalMessages({ mapping: { m: { id: messageId, message: { content: { content_type: 'text', parts: ['hello live'] } } } } })[messageId], 'hello live');
assert.equal(Object.keys(canonicalMessages({ mapping: { m: { id: messageId, message: { content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'private' }] } } } } })).length, 0);

// Content script simulation: no ChatGPT API requests, only local extension
// messages after DOM changes. The existing page's older turns are baseline.
const captured = [];
const sentBatches = [];
const events = new Map();
const timers = [];
let observer;
const makeTurn = (id, role, content) => ({
  getAttribute: name => name === 'data-chatgpt-search-message-ids' ? id : null,
  querySelector: selector => {
    if (selector === '[data-user-message-bubble="true"]') return role === 'user' ? { innerText: content } : null;
    if (selector === '[data-conversation-role="assistant"]') return role === 'assistant' ? { nextElementSibling: { innerText: content } } : null;
    return null;
  },
});
const elements = [
  makeTurn('00000000-0000-0000-0000-000000000001', 'user', 'old 1'),
  makeTurn('00000000-0000-0000-0000-000000000002', 'assistant', 'old 2'),
  makeTurn(messageId, 'user', 'hello live'),
  makeTurn('00000000-0000-0000-0000-000000000004', 'assistant', 'reply'),
];
let runtimeVersion = '0.4.45';
const disconnected = [];
const fake = {
  location: { pathname: `/g/${projectId}-1hood/c/${conversationId}` },
  document: { documentElement: {}, title: 'Test chat', querySelectorAll: () => elements },
  addEventListener: (type, callback) => events.set(type, callback),
  removeEventListener: (type, callback) => { if (events.get(type) === callback) events.delete(type); },
  chrome: { runtime: { id: 'test-extension', getManifest: () => ({ version: runtimeVersion }),
    sendMessage: async msg => {
      sentBatches.push(msg);
      for (const capture of msg.captures ?? [msg.capture]) {
        captured.push({ type: msg.type, capture });
      }
      return { ok: true };
    } } },
  setTimeout: fn => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  MutationObserver: class { constructor(callback) { observer = callback; } observe() {} disconnect() { disconnected.push(this); } },
};
fake.globalThis = fake;
const { readFileSync } = await import('node:fs');
const script = readFileSync(new URL('../live-content.js', import.meta.url), 'utf8');
vm.runInNewContext(script, fake);
assert(fake.__hstryLiveCaptureInitialized);
const trigger = async () => {
  const callback = timers.splice(0, 1)[0];
  assert(callback, 'scheduled observer scan');
  callback();
  await new Promise(resolve => setImmediate(resolve));
};
await trigger();
assert.deepEqual(captured.map(item => item.capture.messageId), [messageId, '00000000-0000-0000-0000-000000000004']);
assert(captured.every(x => x.type === 'hstryLiveCaptureBatch'));
assert.equal(sentBatches.length, 1, 'initial live observations use one batch');
assert.equal(sentBatches[0].captures.length, 2);
observer([]);
await trigger();
assert.equal(captured.length, 2, 'unchanged content never re-sent');
elements[3] = makeTurn('00000000-0000-0000-0000-000000000004', 'assistant', 'completed reply');
observer([]);
await trigger();
assert.equal(captured.length, 3);
assert.equal(captured[2].capture.content, 'completed reply');
const nativeListener = events.get('hstry:native-conversation-page');
assert.equal(typeof nativeListener, 'function', 'native history pages must be observed');
nativeListener({ detail: { conversationId, turns: [
  { messageId: '00000000-0000-0000-0000-000000000001', role: 'user', content: 'old 1' },
  { messageId: '00000000-0000-0000-0000-000000000005', role: 'user', content: 'older history' },
  { messageId, role: 'user', content: 'hello live' },
] } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(captured.length, 5, 'native pages recover unseen history and initially skipped DOM messages');
assert.equal(captured.at(-1).capture.content, 'older history');
nativeListener({ detail: { conversationId, turns: [
  { messageId: '00000000-0000-0000-0000-000000000005', role: 'user', content: 'older history' },
] } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(captured.length, 5, 'the same native page cannot duplicate captures');
const batchStart = sentBatches.length;
const burst = Array.from({ length: 53 }, (_, i) => ({
  messageId: '00000000-0000-0000-0000-' + String(i + 100).padStart(12, '0'),
  role: 'user', content: 'historical turn ' + i,
}));
nativeListener({ detail: { conversationId, turns: burst } });
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.equal(captured.length, 58, 'every observed native message is retained');
assert.deepEqual(sentBatches.slice(batchStart).map(b => b.captures.length), [25, 25, 3],
  '53 native observations use only three bounded durable batches');

const largeStart = sentBatches.length;
const largeTurns = Array.from({ length: 2 }, (_, i) => ({
  messageId: '00000000-0000-0000-0000-' + String(i + 200).padStart(12, '0'),
  role: 'user', content: 'x'.repeat(300_000) + i,
}));
nativeListener({ detail: { conversationId, turns: largeTurns } });
await new Promise(resolve => setImmediate(resolve));
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(sentBatches.slice(largeStart).map(b => b.captures.length), [1, 1],
  'large captures remain valid individually instead of exceeding batch byte budget');
assert.equal(captured.length, 60);
const installed = fake.__hstryLiveCaptureInitialized;
vm.runInNewContext(script, fake);
assert.equal(fake.__hstryLiveCaptureInitialized, installed, 'same-version reinjection is idempotent');
assert.equal(timers.length, 0, 'double injection is blocked');
const pendingId='00000000-0000-0000-0000-000000000333';
installed.pending.set(conversationId+':'+pendingId, {...value, messageId:pendingId,
  content:'interrupted capture remains durable until ACK'});
runtimeVersion='0.4.46';
vm.runInNewContext(script, fake);
assert.notEqual(fake.__hstryLiveCaptureInitialized, installed,
  'new manifest version replaces the prior content observer');
assert(disconnected.length >= 1, 'old observer is disconnected');
assert.equal(fake.__hstryLiveCaptureInitialized.pending, installed.pending,
  'unacknowledged captures survive an extension content-script upgrade');
await new Promise(resolve => setImmediate(resolve));
assert.equal(installed.pending.has(conversationId+':'+pendingId), false,
  'new observer replays the inherited capture and ACKs it');
const restarted = fake.__hstryLiveCaptureInitialized;
vm.runInNewContext(script, fake);
assert.equal(fake.__hstryLiveCaptureInitialized, restarted);
restarted.stop();
fake.__hstryLiveCaptureInitialized = true; // v0.4.44 used a legacy Boolean flag.
runtimeVersion = '0.4.47';
vm.runInNewContext(script, fake);
assert.equal(fake.__hstryLiveCaptureInitialized.version, '0.4.47',
  'new version upgrades old Boolean observer flag in already-open tabs');
console.log('PASS live capture: bounded batches, versioned reinjection and pending recovery, URL validation, durable dedupe, canonical reconciliation, DOM observer');
console.log('PASS live capture: URL/security/size validation, durable dedupe, canonical reconciliation, DOM observer, no duplicate injection');
