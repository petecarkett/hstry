import assert from 'node:assert/strict';

const realFetch = globalThis.fetch;
const realChrome = globalThis.chrome;
const events = { addListener() {} };
const handlers = {};
const recent = Math.floor(Date.now() / 1000) - 7200;
let statusWrites = 0;
const calls = [];
const scheduledAlarms = [];
let alarmDuringRecheckWrite = false;
const stored = {
  settings: { token: 'local-fixture', port: 41770, intervalMinutes: 15, providers: { chatgpt: true } },
  liveCaptureQueue: {},
  status: { chatgpt: {
    running: false, continuationPending: true,
    state: { accounts: {}, pending: {
      scopes: [{ accountId: null, accountKey: 'default', sourceId: 'chatgpt-web', projectId: null, archived: false }],
      scopeIndex: 0, pageIndex: 0, offset: 0, cursor: '0',
      runStartedMs: Date.now() - 1000, detected: 0, processed: 0, failures: 0,
      scopeFailures: 0, scopeTrackedFailures: 0,
      inventory: { ids: ['fixture-chat'], completeFromStart: true },
      cachedPage: { items: [{ id: 'fixture-chat', update_time: recent }],
        next: null, scopeIndex: 0, accountKey: 'default', offset: 0, cursor: '0', projectId: null },
    } },
  } },
};
const clone = v => structuredClone(v);
const sessionStore = { hstryChatGPTAccessToken: {
  token: 'fake-session', expiresAtMs: Date.now() + 30 * 60_000,
} };
globalThis.chrome = {
  runtime: { id: 'fixture', getManifest: () => ({ version: '0.4.43' }),
    onMessage: { addListener(fn) { handlers.message = fn; } },
    onInstalled: events, onStartup: events },
  storage: {
    local: {
      async getKeys() { return Object.keys(stored); },
      async get(key) {
        if (typeof key === 'string') return { [key]: clone(stored[key]) };
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, clone(stored[k])]));
        return clone(stored);
      },
      async set(values) {
        if (alarmDuringRecheckWrite && values.status?.chatgpt?.state?.failureDetails?.some(f =>
          f.conversationId === '66666666-7777-4888-8999-000000000000' &&
          !f.manualReviewPending) && !values.status.chatgpt.running) {
          alarmDuringRecheckWrite = false;
          handlers.alarm({ name: 'hstry-sync-continue-chatgpt' });
          await new Promise(resolve => setTimeout(resolve, 12));
        }
        if (Object.hasOwn(values, 'status')) statusWrites++;
        Object.assign(stored, clone(values));
      },
    },
    session: { async get(key) { return { [key]: clone(sessionStore[key]) }; },
      async set(values) { Object.assign(sessionStore, clone(values)); },
      async remove(key) { delete sessionStore[key]; } },
  },
  alarms: { create: async (name, config) => scheduledAlarms.push({ name, config }), get: async () => null,
    getAll: async () => [], onAlarm: { addListener(fn) { handlers.alarm = fn; } } },
  action: { onClicked: events, setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
  tabs: { onUpdated: events, onActivated: events, onRemoved: events,
    query: async () => [] },
  scripting: { executeScript: async () => {} },
};
globalThis.fetch = async (url, options) => {
  const u = new URL(url);
  calls.push(u.pathname);
  if (u.origin === 'http://127.0.0.1:41770') {
    if (u.pathname === '/sources') return Response.json({});
    if (u.pathname === '/ingest') return Response.json({ conversations: 1, created: 1, updated: 0 });
    throw Error('Unexpected local path: ' + u.pathname);
  }
  assert.equal(u.origin, 'https://chatgpt.com');
  assert.equal(u.pathname, '/backend-api/conversation/fixture-chat');
  return Response.json({
    id: 'fixture-chat', title: 'Fixture', update_time: recent,
    mapping: { user: { id: 'user', parent: null,
      message: { author: { role: 'user' }, create_time: recent,
        content: { content_type: 'text', parts: ['test record'] } } } },
    current_node: 'user',
  });
};
try {
  await import('../background.js');
  assert.equal(typeof handlers.alarm, 'function');
  handlers.alarm({ name: 'hstry-sync-continue-chatgpt' });
  for (let i = 0; i < 300; i++) {
    if (stored.status.chatgpt?.progress?.phase === 'queued' &&
        stored.status.chatgpt?.running === false &&
        stored.status.chatgpt?.state?.pending?.processed === 1) break;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const result = stored.status.chatgpt;
  assert.equal(result?.progress?.phase, 'queued', 'bounded one-detail worker must finish queued');
  assert.equal(result.state.pending.pageIndex, 1, 'acknowledged cursor is durable');
  assert.equal(result.progress.created, 1, 'local ingest acknowledged');
  assert.equal(calls.filter(x => x.startsWith('/backend-api/')).length, 1,
    'no duplicate ChatGPT request');
  console.log('STATUS_WRITE_BASELINE ' + JSON.stringify({
    writes: statusWrites, remoteRequests: calls.filter(x => x.startsWith('/backend-api/')).length,
    localRequests: calls.filter(x => x === '/ingest' || x === '/sources').length,
    result: result.progress, cursor: result.state.pending.pageIndex,
  }));
  // A full pending status is multi-megabytes in a real browser.
  assert(statusWrites <= 5,
    'avoid rewriting the entire status for transient progress ticks; persist at checkpoint and completion');
  // Explicit manual recheck is scoped, single-click and alarm-paced; it
  // must neither reset the archive scan nor trigger an immediate network read.
  const qaId = '66666666-7777-4888-8999-000000000000';
  const identity = { conversationId: qaId, sourceId: 'chatgpt-web',
    accountKey: 'default', projectId: null };
  const review = { ...identity, manualReviewPending: true, resolvedAtMs: null,
    errorType: 'HTTP 404', attempts: 19 };
  delete stored.status.chatgpt.state.pending;
  stored.status.chatgpt.state.failureDetails = [review];
  delete stored.status.chatgpt.nextAllowedAtMs;
  delete stored.status.chatgpt.state.lastRateLimitAtMs;
  const send = (identity, sender = { id: 'fixture' }) => new Promise(resolve =>
    handlers.message({ type: 'recheckManualReview', identity }, sender, resolve));
  assert.equal((await send({ ...identity, accountKey: 'wrong' })).ok, false);
  assert.equal((await send(identity, { id: 'fixture', tab: { id: 1 } })).ok, false,
    'content scripts cannot invoke the popup-only manual retry');
  assert.equal(stored.status.chatgpt.state.failureDetails[0].manualReviewPending, true);
  const beforeManualReads = calls.length;
  const beforeAlarms = scheduledAlarms.length;
  alarmDuringRecheckWrite = true;
  assert.equal((await send(identity)).ok, true,
    'exact user-selected history can re-enter the paced sync route');
  assert.equal(stored.status.chatgpt.state.failureDetails[0].manualReviewPending, undefined);
  assert.equal(stored.status.chatgpt.state.pending, undefined,
    'manual recheck does not invent or rewind a historical scan cursor');
  assert.equal(stored.status.chatgpt.continuationPending, true);
  assert.equal(alarmDuringRecheckWrite, false,
    'the conflicting continuation alarm ran during the checkpoint write');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, beforeManualReads,
    'a racing continuation alarm must not start a sync during manual recheck');
  assert.equal(stored.status.chatgpt.state.failureDetails[0].manualReviewPending, undefined,
    'a racing worker must not overwrite the manual recheck state');
  assert(scheduledAlarms.length >= beforeAlarms + 1);
  assert.equal(scheduledAlarms.at(-1).name, 'hstry-sync-continue-chatgpt');
  assert(scheduledAlarms.at(-1).config.delayInMinutes >= 0.5);
  assert.equal((await send(identity)).ok, false, 'repeated clicks cannot enqueue duplicate work');
} finally {
  globalThis.fetch = realFetch;
  globalThis.chrome = realChrome;
}
