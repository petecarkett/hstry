import assert from 'node:assert/strict';
import { recordedContinuations } from '../handoff-core.js';

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
let listener, onUpdated, injected = [], updates = 0, creates = 0, focusCount = 0, permitReopenLookup = false, failSessionWrite = false, failNavigation = false;
const on = { addListener() {} };

globalThis.chrome = {
  runtime: {
    id: 'test-hstry-extension', getManifest: () => ({ version: '0.4.29' }),
    onInstalled: on, onMessage: { addListener(fn) { listener = fn; } },
  },
  tabs: {
    onUpdated: { addListener(fn) { onUpdated = fn; } }, onActivated: on, onRemoved: on,
    query: async () => permitReopenLookup ? [...tabs.values()] : [],
    async create(options) {
      assert.equal(options.openerTabId, 2, 'explicit reopen must use the original tab as opener');
      assert(options.url.startsWith('https://chatgpt.com/'));
      creates++;
      const tab = { id: 100 + creates, url: options.url, windowId: 99 };
      tabs.set(tab.id, tab);
      return tab;
    },
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
  windows: { async update(id, options) { assert.equal(options.focused, true); focusCount++; } },
  scripting: { async executeScript(options) { injected.push(options); } },
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
onUpdated(4, { status: 'loading' }, { id: 4, url: other });
await new Promise(resolve => setImmediate(resolve));
assert.equal(injected.length, 0, 'the observer must not reinject during incomplete loads');
onUpdated(4, { status: 'complete' }, { id: 4, url: other });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(injected.map(x => [x.target.tabId, x.world, x.files[0]]),
  [[4, 'MAIN', 'handoff-network.js']],
  'a completed ChatGPT navigation must restore the main-world fetch observer');
onUpdated(4, { status: 'complete' }, { id: 4, url: 'https://example.com/' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(injected.length, 1, 'unrelated websites must never be injected');

const send = (url, type, tabId, automatic = false, frameUrl = url, extra = {}) => new Promise(resolve => {
  const sender = { id: chrome.runtime.id, frameId: 0, url: frameUrl, tab: { id: tabId, url } };
  const keepOpen = listener({ type, automatic, pagePath: new URL(url).pathname,
    ...(['HSTRY_TAKEOVER_START', 'HSTRY_TAKEOVER_STATUS', 'HSTRY_TAKEOVER_OPEN'].includes(type)
      ? { sourceUrl: url } : {}), ...extra }, sender, resolve);
  assert.equal(keepOpen, true);
});

local.set('liveCaptureQueue', {
  indexedProvisional: { conversationId: sourceId, indexedAt: 1234 },
  waitingLocalIngest: { conversationId: sourceId },
  unrelated: { conversationId: '11111111-1111-4111-8111-111111111111', indexedAt: 1234 },
});
const [first, same, sameTab] = await Promise.all([
  send(original, 'HSTRY_TAKEOVER_START', 1, true, landing,
    { failedMessage: 'now?', missingAttachments: true }),
  send(original, 'HSTRY_TAKEOVER_START', 2, true),
  send(original, 'HSTRY_TAKEOVER_START', 1, true),
]);
assert.equal(first.ok, true);
assert.equal(first.pendingCaptures, 2,
  'locally indexed provisional messages remain unverified until canonical history');
assert.match(session.get('hstryTakeoverTab:1').prompt, /2 live capture\(s\).*canonical history/i,
  'handoff warns that provisional content is not the complete canonical transcript');
assert.equal(first.tabId, 1, 'destination retains the original tab ID');
assert.equal(same.tabId, first.tabId, 'two requests reuse one handoff');
assert.equal(updates, 0, 'background must not navigate before replying');
assert.equal(creates, 0, 'no second tab is ever created');
assert.equal(first.landingUrl, landing, 'source receives the same-project landing after persistence');
assert.equal(same.existing, true, 'duplicate requester cannot navigate on the first request');
assert.equal(sameTab.existing, false, 'repeat request from owning tab stays navigable');
assert.equal(sameTab.landingUrl, landing, 'same-tab retry retains destination');
assert.equal(tabs.get(1).url, original, 'source remains until it receives the handoff response');
assert.equal(tabs.get(2).url, original, 'unrelated duplicate source tab was left untouched');
assert.ok(session.get('hstryTakeoverTab:1')?.prompt.includes(original));
assert.equal(session.get('hstryTakeoverTab:1')?.automatic,true,'automatic classification survives session navigation');
assert.equal(local.get('hstryTakeoverSource:'+sourceId)?.automatic,true,'automatic start is durable');

assert.ok(session.get('hstryTakeoverTab:1')?.prompt.includes('now?'),
  'failed user message must survive same-tab navigation');
assert.match(session.get('hstryTakeoverTab:1')?.prompt, /reattach them/,
  'failed attachment cannot be silently treated as restored');

const invalid = await send('https://chatgpt.com/', 'HSTRY_TAKEOVER_START', 1, true, original);
assert.equal(invalid.ok, false, 'a landing page cannot impersonate the source');
assert.equal(updates, 0);

tabs.get(1).url = first.landingUrl; // The source page navigates after receiving the reply.
const repeated = await send(original, 'HSTRY_TAKEOVER_START', 2, false);
assert.equal(repeated.ok, true);
assert.equal(repeated.existing, true);
assert.equal(repeated.tabId, 1);
assert.equal(updates, 0, 'extra click never navigates from background');

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
const prematureDone = await send(landing, 'HSTRY_TAKEOVER_DONE', 1);
assert.equal(prematureDone.ok, false,
  'a blank project landing is not proof that ChatGPT created a new conversation');
assert.equal(local.get('hstryTakeoverSource:' + sourceId).status, 'started',
  'unsaved continuation must keep its durable pending receipt');

const newChat = 'https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
const foreignChat = 'https://chatgpt.com/g/g-p-6a81a59c80e48191a14c2f7c5ccdd387-krar-vst/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
const foreignDone = await send(foreignChat, 'HSTRY_TAKEOVER_DONE', 1);
assert.equal(foreignDone.ok, false, 'a different project cannot complete this handoff');
assert.equal(session.has('hstryTakeoverTab:1'), true,
  'rejected completion must leave the original handoff pending');
assert.equal(local.get('hstryTakeoverSource:' + sourceId).status, 'started');
const falseStart = await send(foreignChat, 'HSTRY_TAKEOVER_START', 1, true,
  foreignChat, { sourceUrl: original });
assert.equal(falseStart.ok, false,
  'tab and current page must agree on the exact source conversation and project');
tabs.get(1).url = newChat;
const done = await send(newChat, 'HSTRY_TAKEOVER_DONE', 1);
assert.equal(done.ok, true);
assert.equal(done.completed, true);
assert.equal(session.has('hstryTakeoverTab:1'), false);
assert.equal(local.get('hstryTakeoverSource:' + sourceId)?.status, 'completed');
assert.equal(local.get('hstryTakeoverSource:'+sourceId)?.automatic,true,'automatic completion keeps its origin');
assert.equal(local.get('hstryTakeoverSource:'+sourceId)?.originalUrl,original);
assert.equal(local.get('hstryTakeoverSource:'+sourceId)?.destinationUrl,newChat,
  'completion durably records the verified target chat URL');
assert(Number.isFinite(local.get('hstryTakeoverSource:'+sourceId)?.startedAt));


tabs.delete(1);
await import(new URL('../handoff-background.js?test=restart', import.meta.url));
const afterRestart = await send(original, 'HSTRY_TAKEOVER_START', 2, true);
assert.equal(afterRestart.existing, true);
assert.equal(afterRestart.completed, true);
assert.equal(updates, 0, 'completed handoff cannot navigate again after restart');

const invalidMessage = await send(another, 'HSTRY_TAKEOVER_START', 5,
  true, another, { failedMessage: 'x'.repeat(8001) });
assert.equal(invalidMessage.ok, false, 'oversized rejected text is not truncated');
assert.equal(tabs.get(5).url, another, 'invalid payload cannot navigate source');

const initialUrl = tabs.get(4).url;
failSessionWrite = true;
const failedStorage = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(failedStorage.ok, false);
assert.equal(tabs.get(4).url, initialUrl, 'storage failure must leave original tab open');
assert.equal(session.has('hstryTakeoverTab:4'), false);
assert.equal(updates, 0);
failSessionWrite = false;
const recovered = await send(other, 'HSTRY_TAKEOVER_START', 4, true);
assert.equal(recovered.ok, true);
assert.equal(tabs.get(4).url, initialUrl, 'successful START does not navigate before the reply');
assert.equal(recovered.landingUrl, 'https://chatgpt.com/');
assert.equal(updates, 0);

const waiting = await send(another, 'HSTRY_TAKEOVER_START', 5, true);
assert.equal(waiting.ok, true);
assert.equal(tabs.get(5).url, another, 'acknowledged START leaves the page in place for navigation');
assert.equal(session.has('hstryTakeoverTab:5'), true);
const retried = await send(another, 'HSTRY_TAKEOVER_START', 5, false);
assert.equal(retried.ok, true, 'same original tab can recover without starting a new tab');
assert.equal(retried.landingUrl, 'https://chatgpt.com/');
assert.equal(tabs.get(5).url, another, 'repeat acknowledgments never navigate the worker');
assert.equal(updates, 0);
assert.equal(creates, 0);
assert.equal(local.get('hstryTakeoverSource:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')?.automatic,false,
  'manual continuation is not mislabelled automatic');
tabs.get(5).url = 'https://chatgpt.com/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
const manualDone = await send(tabs.get(5).url, 'HSTRY_TAKEOVER_DONE', 5);
assert.equal(manualDone.ok,true);
const history = recordedContinuations(Object.fromEntries(local));
assert.equal(history.automatic.length,1,'one successful auto continuation is recorded');
assert.equal(history.manualCount,1,'manual continuation is excluded from auto count');
assert.equal(history.legacyCount,0);
assert.equal(history.automatic[0].id,sourceId);
assert.equal(history.automatic[0].url,original);
const legacy = recordedContinuations({'hstryTakeoverSource:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee':
  {status:'completed',completedAt:Date.now()}});
assert.equal(legacy.legacyCount,1,'older receipts must not be incorrectly labelled auto');
assert(Number.isFinite(legacy.legacyLastAt), 'older completion time remains available');
assert.equal(legacy.automatic.length,0);


// Four independent near-simultaneous continuations must never share a tab,
// project landing, prompt, or receipt, including a root chat among projects.
const starts = [
  ['https://chatgpt.com/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/11111111-1111-4111-8111-111111111111', 6],
  ['https://chatgpt.com/g/g-p-6a81a59c80e48191a14c2f7c5ccdd387-krar-vst/c/22222222-2222-4222-8222-222222222222', 7],
  ['https://chatgpt.com/c/33333333-3333-4333-8333-333333333333', 8],
  ['https://chatgpt.com/g/g-p-6a7cf18195e08191afa988505b092577-system-optimisation/c/44444444-4444-4444-8444-444444444444', 9],
];
for (const [url, tabId] of starts) tabs.set(tabId, { id: tabId, url });
const started = await Promise.all(starts.map(([url, tabId]) =>
  send(url, 'HSTRY_TAKEOVER_START', tabId, true)));
assert(started.every((r, i) => r.ok && r.tabId === starts[i][1]));
for (const [url, tabId] of starts) {
  const id = url.split('/').at(-1);
  const stored = session.get('hstryTakeoverTab:' + tabId);
  assert(stored?.original === url, 'the tab must retain its own exact source');
  assert(stored.prompt.includes(url), 'the prompt must reference its own source');
  const source = new URL(url);
  const landing = source.pathname.replace(/\/c\/[0-9a-f-]{36}$/i, '');
  assert.equal(started.find(r => r.tabId === tabId)?.landingUrl, source.origin + (landing || '/'),
    'each tab receives its own source-project landing');
  assert.equal(tabs.get(tabId).url, url, 'background must never navigate the source tab');
  tabs.get(tabId).url = source.origin + (landing || '/');
  const pending = await send(tabs.get(tabId).url, 'HSTRY_TAKEOVER_POLL', tabId);
  assert.equal(pending.ok, true);
  assert.equal(pending.found, true);
  assert(pending.prompt.includes(url));
  assert.equal(pending.landingPath, new URL(tabs.get(tabId).url).pathname);
  assert.equal(local.get('hstryTakeoverSource:' + id).tabId, tabId);
}
const crossTab = await send(tabs.get(7).url, 'HSTRY_TAKEOVER_POLL', 6);
assert.equal(crossTab.found, false, 'another project cannot consume the first tab handoff');
assert(starts.every(([,tabId]) => session.has('hstryTakeoverTab:' + tabId)));

// Reopening uses the durable completed receipt, even after its original tab closes.
permitReopenLookup = true;
const visibleStatus = await send(original, 'HSTRY_TAKEOVER_STATUS', 2);
assert.equal(visibleStatus.status, 'completed');
assert.equal(visibleStatus.hasDestination, true);
tabs.set(35, { id: 35, url: newChat, windowId: 44 });
const focused = await send(original, 'HSTRY_TAKEOVER_OPEN', 2);
assert.equal(focused.ok, true);
assert.equal(focused.reused, true);
assert.equal(focused.tabId, 35, 'first click focuses the exact existing continuation tab');
assert.equal(creates, 0, 'existing continuation must not create another tab');
assert.equal(focusCount, 1);
tabs.delete(35); // Simulate closing the continuation tab/window.
await import(new URL('../handoff-background.js?test=browser-restart', import.meta.url));
const reopened = await send(original, 'HSTRY_TAKEOVER_OPEN', 2);
assert.equal(reopened.ok, true);
assert.equal(reopened.reused, false);
assert.equal(reopened.destinationUrl, newChat);
assert.equal(tabs.get(reopened.tabId).url, newChat);
assert.equal(creates, 1, 'a new adjacent tab is created only on explicit reopen');

// Old receipts survive as visible status, but cannot invent a destination.
const missingKey = 'hstryTakeoverSource:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const manualReceipt = local.get(missingKey);
local.set(missingKey, { ...manualReceipt, destinationUrl: undefined });
tabs.set(5, { id: 5, url: another });
const legacyStatus = await send(another, 'HSTRY_TAKEOVER_STATUS', 5);
assert.equal(legacyStatus.status, 'completed');
assert.equal(legacyStatus.hasDestination, false);
const legacyOpen = await send(another, 'HSTRY_TAKEOVER_OPEN', 5);
assert.equal(legacyOpen.ok, false, 'old incomplete links cannot open a guessed conversation');
assert.equal(creates, 1);
local.set(missingKey, { status: 'completed', completedAt: Date.now(), tabId: 5 });
const unlabelledLegacy = await send(another, 'HSTRY_TAKEOVER_STATUS', 5);
assert.equal(unlabelledLegacy.status, 'completed',
  'pre-URL receipts remain visible even when their source URL was not recorded');
assert.equal(unlabelledLegacy.hasDestination, false);
local.set(missingKey, manualReceipt);
const hostile = local.get('hstryTakeoverSource:' + sourceId);
local.set('hstryTakeoverSource:' + sourceId, {
  ...hostile, destinationUrl: 'https://chatgpt.com/c/99999999-aaaa-4bbb-8ccc-dddddddddddd',
});
const crossProjectOpen = await send(original, 'HSTRY_TAKEOVER_OPEN', 2);
assert.equal(crossProjectOpen.ok, false, 'cross-project stored URLs must never open');
assert.equal(creates, 1);
local.set('hstryTakeoverSource:' + sourceId, hostile);

console.log('PASS concurrent four-project continuation isolation, source and destination routing, durable receipts');
