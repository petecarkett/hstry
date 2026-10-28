import assert from 'node:assert/strict';

const original = 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/6add53d9-4c88-83ed-a57d-6a602a257293';
const other = 'https://chatgpt.com/c/cccccccc-1111-4222-8333-444444444444';
const local = new Map();
const session = new Map();
const tabs = new Map();
let listener, createCount = 0, nextTab = 80, failSessionWrite = false;
const on = { addListener() {} };

globalThis.chrome = {
  runtime: {
    id: 'test-hstry-extension', getManifest: () => ({ version: '0.4.28' }),
    onInstalled: on, onMessage: { addListener(fn) { listener = fn; } },
  },
  tabs: {
    onUpdated: on, onActivated: on, onRemoved: on,
    query: async () => [],
    async create(options) {
      const id = ++nextTab;
      createCount++;
      tabs.set(id, { id, url: options.url });
      return { id, url: options.url };
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error('No tab with this id');
      return tabs.get(id);
    },
    async remove(id) { tabs.delete(id); },
    async sendMessage() {},
  },
  scripting: { async executeScript() {} },
  storage: {
    local: {
      async get(key) { return { [key]: local.get(key) }; },
      async set(values) { for (const [k, v] of Object.entries(values)) local.set(k, v); },
      async remove(key) { local.delete(key); },
    },
    session: {
      async get(key) { return { [key]: session.get(key) }; },
      async set(values) {
        if (failSessionWrite) throw new Error('simulated storage failure');
        for (const [k, v] of Object.entries(values)) session.set(k, v);
      },
      async remove(key) { session.delete(key); },
    },
  },
};
await import(new URL('../handoff-background.js?test=first', import.meta.url));

const send = (url, type, tabId, automatic = false, frameUrl = url) => new Promise(resolve => {
  const sender = { id: chrome.runtime.id, frameId: 0, url: frameUrl, tab: { id: tabId, url } };
  const keepOpen = listener({ type, automatic }, sender, resolve);
  assert.equal(keepOpen, true);
});

const [first, same] = await Promise.all([
  send(original, 'HSTRY_TAKEOVER_START', 1, true, 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood'),
  send(original, 'HSTRY_TAKEOVER_START', 2, true),
]);
assert.equal(first.ok, true);
assert.equal(first.tabId, same.tabId);
assert.equal(createCount, 1, 'SPA frame URL must not reject a valid current tab or create duplicates');
assert.ok(first.tabId > 0);
assert.equal(tabs.get(first.tabId).url,
  'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood');

const invalid = await send('https://chatgpt.com/', 'HSTRY_TAKEOVER_START', 1, true, original);
assert.equal(invalid.ok, false, 'landing tab cannot impersonate a source conversation');
assert.equal(createCount, 1);

const repeated = await send(original, 'HSTRY_TAKEOVER_START', 1, false);
assert.equal(repeated.ok, true);
assert.equal(repeated.existing, true);
assert.equal(createCount, 1, 'retry or extra click must reuse the existing destination');

const destinationUrl = 'https://chatgpt.com/';
const pending = await send(destinationUrl, 'HSTRY_TAKEOVER_POLL', first.tabId);
assert.equal(pending.ok, true);
assert.equal(pending.found, true);
assert.ok(pending.prompt.includes(original));

const done = await send(destinationUrl, 'HSTRY_TAKEOVER_DONE', first.tabId);
assert.equal(done.ok, true);
assert.equal(done.completed, true);
const afterDone = await send(destinationUrl, 'HSTRY_TAKEOVER_POLL', first.tabId);
assert.equal(afterDone.found, false);

tabs.delete(first.tabId);
await import(new URL('../handoff-background.js?test=restart', import.meta.url));
const afterRestart = await send(original, 'HSTRY_TAKEOVER_START', 1, true);
assert.equal(afterRestart.existing, true);
assert.equal(afterRestart.completed, true);
assert.equal(createCount, 1, 'completed handoff cannot reopen after browser worker restart');

failSessionWrite = true;
const failed = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(failed.ok, false);
assert.equal(tabs.size, 0, 'failed setup must not leave orphaned destination tabs');
failSessionWrite = false;
const recovered = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(recovered.ok, true);
assert.equal(createCount, 3, 'failed setup must be retryable once storage recovers');

console.log('PASS one continuation per source, persists across restarts, retries failed setup');
