import assert from 'node:assert/strict';

const original = 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/6add53d9-4c88-83ed-a57d-6a602a257293';
const landing = 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood';
const sourceId = '6add53d9-4c88-83ed-a57d-6a602a257293';
const other = 'https://chatgpt.com/c/cccccccc-1111-4222-8333-444444444444';
const another = 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const local = new Map();
const session = new Map();
const tabs = new Map([
  [1, { id: 1, url: original }],
  [2, { id: 2, url: original }],
  [4, { id: 4, url: other }],
  [5, { id: 5, url: another }],
]);
let listener, updates = 0, creates = 0, failSessionWrite = false, failNavigation = false;
const on = { addListener() {} };

globalThis.chrome = {
  runtime: {
    id: 'test-hstry-extension', getManifest: () => ({ version: '0.4.29' }),
    onInstalled: on, onMessage: { addListener(fn) { listener = fn; } },
  },
  tabs: {
    onUpdated: on, onActivated: on, onRemoved: on,
    query: async () => [],
    async create() { creates++; throw Error('same-tab continuation must never create a tab'); },
    async get(id) {
      if (!tabs.has(id)) throw new Error('No tab with this id');
      return { ...tabs.get(id) };
    },
    async update(id, options) {
      if (failNavigation) throw new Error('simulated navigation failure');
      if (!tabs.has(id)) throw new Error('No tab with this id');
      updates++;
      const tab = { ...tabs.get(id), ...options };
      tabs.set(id, tab);
      return { ...tab };
    },
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
  send(original, 'HSTRY_TAKEOVER_START', 1, true, landing),
  send(original, 'HSTRY_TAKEOVER_START', 2, true),
]);
assert.equal(first.ok, true);
assert.equal(first.tabId, 1, 'destination retains the original tab ID');
assert.equal(same.tabId, first.tabId, 'two requests reuse one handoff');
assert.equal(updates, 1, 'only the source tab navigates');
assert.equal(creates, 0, 'no second tab is ever created');
assert.equal(tabs.get(1).url, landing, 'source tab navigated to same-project landing');
assert.equal(tabs.get(2).url, original, 'unrelated duplicate source tab was left untouched');
assert.ok(session.get('hstryTakeoverTab:1')?.prompt.includes(original));

const invalid = await send('https://chatgpt.com/', 'HSTRY_TAKEOVER_START', 1, true, original);
assert.equal(invalid.ok, false, 'a landing page cannot impersonate the source');
assert.equal(updates, 1);

const repeated = await send(original, 'HSTRY_TAKEOVER_START', 2, false);
assert.equal(repeated.ok, true);
assert.equal(repeated.existing, true);
assert.equal(repeated.tabId, 1);
assert.equal(updates, 1, 'extra click does not navigate another tab');

const stillSource = await send(original, 'HSTRY_TAKEOVER_POLL', 1);
assert.equal(stillSource.found, false, 'original full-chat DOM cannot consume its own prompt');
const wrongProject = await send('https://chatgpt.com/', 'HSTRY_TAKEOVER_POLL', 1);
assert.equal(wrongProject.found, false, 'unrelated landing cannot consume project handoff');

const pending = await send(landing, 'HSTRY_TAKEOVER_POLL', 1);
assert.equal(pending.ok, true);
assert.equal(pending.found, true);
assert.ok(pending.prompt.includes(original));
const projectLanding = await send(landing + '/project', 'HSTRY_TAKEOVER_POLL', 1);
assert.equal(projectLanding.found, true, 'ChatGPT project landing alias is supported');

const newChat = 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
tabs.get(1).url = newChat;
const done = await send(newChat, 'HSTRY_TAKEOVER_DONE', 1);
assert.equal(done.ok, true);
assert.equal(done.completed, true);
assert.equal(session.has('hstryTakeoverTab:1'), false);
assert.equal(local.get('hstryTakeoverSource:' + sourceId)?.status, 'completed');

tabs.delete(1);
await import(new URL('../handoff-background.js?test=restart', import.meta.url));
const afterRestart = await send(original, 'HSTRY_TAKEOVER_START', 2, true);
assert.equal(afterRestart.existing, true);
assert.equal(afterRestart.completed, true);
assert.equal(updates, 1, 'completed handoff cannot navigate again after restart');

const initialUrl = tabs.get(4).url;
failSessionWrite = true;
const failedStorage = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(failedStorage.ok, false);
assert.equal(tabs.get(4).url, initialUrl, 'storage failure must leave original tab open');
assert.equal(session.has('hstryTakeoverTab:4'), false);
assert.equal(updates, 1);
failSessionWrite = false;
const recovered = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(recovered.ok, true);
assert.equal(tabs.get(4).url, 'https://chatgpt.com/');
assert.equal(updates, 2);

failNavigation = true;
const failedNav = await send(another, 'HSTRY_TAKEOVER_START', 5, true);
assert.equal(failedNav.ok, false);
assert.equal(tabs.get(5).url, another, 'navigation failure leaves original chat intact');
assert.equal(session.has('hstryTakeoverTab:5'), false);
assert.equal(local.has('hstryTakeoverSource:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), false);
failNavigation = false;
const retried = await send(another, 'HSTRY_TAKEOVER_START', 5, true);
assert.equal(retried.ok, true);
assert.equal(tabs.get(5).url, 'https://chatgpt.com/');
assert.equal(updates, 3);
assert.equal(creates, 0);

console.log('PASS same-tab project continuation, durable deduplication, source validation and failed navigation recovery');
