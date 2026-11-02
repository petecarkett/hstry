import assert from 'node:assert/strict';

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const handlers = {};
const captureId = '6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
const register = name => ({ addListener: fn => { handlers[name] = fn; } });
const store = {
  settings: { token: 'fixture-token', port: 41770, providers: { chatgpt: true } },
  status: { chatgpt: { state: { pending: { scopes: [
    { accountId: 'fixture-account', sourceId: 'chatgpt-web-fixture', projectId: null },
  ] } } } },
  liveCaptureQueue: {},
};
let writes = 0;
let calls = 0;
const alarmCreates = [];
let mode = {};
const copy = value => structuredClone(value);
globalThis.chrome = {
  runtime: { id: 'fixture-extension', getManifest: () => ({ version: '0.4.42' }),
    onMessage: register('message'), onInstalled: register('installed'),
    onStartup: register('startup') },
  storage: {
    local: {
      get: async key => typeof key === 'string'
        ? { [key]: copy(store[key]) } : copy(store),
      set: async values => {
        if (Object.hasOwn(values, 'liveCaptureQueue')) writes++;
        Object.assign(store, copy(values));
      },
      remove: async key => { delete store[key]; },
    },
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  alarms: { onAlarm: register('alarm'), getAll: async () => [],
    get: async () => null, create: async (name, info) => {
      alarmCreates.push({ name, ...info });
    } },
  action: { onClicked: register('clicked'), setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {} },
  tabs: { onUpdated: register('updated'), onActivated: register('activated'),
    onRemoved: register('removed'), query: async () => [] },
  scripting: { executeScript: async () => [] },
};

globalThis.fetch = async url => {
  const target = new URL(url);
  assert.equal(target.origin, 'http://127.0.0.1:41770', 'test must not reach ChatGPT');
  assert.equal(target.pathname, '/ingest/live');
  calls++;
  if (calls === mode.updateAt) {
    const key = Object.keys(store.liveCaptureQueue)[mode.updateIndex ?? 2];
    const previous = store.liveCaptureQueue[key];
    store.liveCaptureQueue[key] = { ...previous, content: 'newer edit',
      observedAt: previous.observedAt + 1 };
  }
  if (calls === mode.failureAt) return new Response('', { status: 500 });
  if (calls === mode.conflictAt) return new Response('', { status: 409 });
  return Response.json({ source: 'chatgpt-web-fixture' });
};
try {
  await import('../background.js');
  assert.equal(typeof handlers.alarm, 'function');
  handlers.installed();
  handlers.startup();
  await new Promise(resolve => setImmediate(resolve));
  const retries = alarmCreates.filter(a => a.name === 'hstry-live-index');
  assert.equal(retries.length, 2, 'new installs and browser startups schedule recovery');
  assert(retries.every(a => a.periodInMinutes === 5),
    'idle live-index retries every five minutes instead of reading a 4 MB queue every minute');

  const sampleQueue = () => Object.fromEntries(Array.from({ length: 25 }, (_, i) => {
    const messageId = '00000000-0000-0000-0000-' + String(i + 1).padStart(12, '0');
    return [captureId + ':' + messageId, { conversationId: captureId, messageId,
      role: 'user', content: 'message ' + i, projectId: null,
      observedAt: 1000 + i, url: 'https://chatgpt.com/c/' + captureId }];
  }));

  const run = async ({ failureAt, conflictAt, updateAt, updateIndex } = {}) => {
    store.liveCaptureQueue = sampleQueue();
    writes = 0;
    calls = 0;
    mode = { failureAt, conflictAt, updateAt, updateIndex };
    handlers.alarm({ name: 'hstry-live-index' });
    const expectedRequests = failureAt ?? 25;
    const expectedIndexed = failureAt ? failureAt - 1 : conflictAt ? 24 : updateAt ? 24 : 25;
    for (let i = 0; i < 100; i++) {
      const indexed = Object.values(store.liveCaptureQueue).filter(x => x.indexedAt).length;
      if (calls >= expectedRequests && indexed === expectedIndexed) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
    const entries = Object.values(store.liveCaptureQueue);
    assert.equal(calls, expectedRequests, 'bounded local ingest attempts');
    assert.equal(entries.filter(x => x.indexedAt).length, expectedIndexed,
      'acknowledge only successfully indexed, unchanged captures');
    assert.equal(writes, 1,
      'one full-queue storage write per local-ingest batch, not one per message');
    return entries;
  };

  await run();
  const afterError = await run({ failureAt: 4 });
  assert(afterError.slice(3).every(x => !x.indexedAt),
    'a local ingest failure retains later captures for retry');
  const afterConflict = await run({ conflictAt: 3 });
  assert.equal(afterConflict[2].indexedAt, undefined,
    'a 409 remains unresolved for canonical reconciliation');
  const afterEdit = await run({ updateAt: 6, updateIndex: 2 });
  assert.equal(afterEdit[2].content, 'newer edit');
  assert.equal(afterEdit[2].indexedAt, undefined,
    'a concurrent edit cannot be acknowledged using stale content');

  // A new observed turn still indexes immediately, independent of the alarm.
  store.liveCaptureQueue = {};
  mode = {};
  writes = 0;
  calls = 0;
  const id = '00000000-0000-0000-0000-000000000111';
  const capture = { conversationId: captureId, messageId: id,
    role: 'user', content: 'immediate new turn', projectId: null,
    url: 'https://chatgpt.com/c/' + captureId, title: 'Fixture' };
  const accepted = await new Promise(resolve =>
    handlers.message({ type: 'hstryLiveCaptureBatch', captures: [capture] },
      { id: 'fixture-extension', frameId: 0, tab: { url: capture.url } }, resolve));
  assert.equal(accepted.ok, true, 'durable queue accepts the real capture protocol');
  for (let i=0;i<100 && !store.liveCaptureQueue[captureId+':'+id]?.indexedAt;i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls, 1, 'new capture goes to local ingest without waiting five minutes');
  assert(store.liveCaptureQueue[captureId+':'+id].indexedAt);
  console.log('PASS live index: five-minute idle safety poll, immediate new indexing, one durable batch write, 409/failure replay, concurrent edit protection');
} finally {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
}
