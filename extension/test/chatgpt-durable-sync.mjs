import assert from 'node:assert/strict';
import { failureType, syncChatGPT } from '../providers/chatgpt.js';
import { progressDetail } from '../ui.js';

const old = Math.floor(Date.now() / 1000) - 3600;
const data = {
  'acc-personal': Array.from({ length: 11 }, (_, i) => ({ id: `personal-${i}`, update_time: old - i })),
  'acc-team': Array.from({ length: 3 }, (_, i) => ({ id: `team-${i}`, update_time: old - i })),
};
let slowId = null;
let missingId = null;
let timeoutId = null;
let rateLimitedList = false;
let accountEndpointStatus = null;
let listCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/api/auth/session') return Response.json({ accessToken: 'fixture-only' });
  if (u.pathname.includes('/accounts/check/')) {
    if (accountEndpointStatus) return new Response('', { status: accountEndpointStatus });
    return Response.json({ accounts: {
      one: { account: { account_id: 'acc-personal', structure: 'personal' } },
      two: { account: { account_id: 'acc-team', organization_name: 'Team', structure: 'workspace' } },
    } });
  }
  const acc = init.headers?.['chatgpt-account-id'];
  if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') return Response.json({ items: [], cursor: null });
  if (u.pathname === '/backend-api/conversations') {
    listCalls++;
    if (rateLimitedList) return new Response('', { status: 429, headers: { 'retry-after': '180' } });
    const rows = data[acc] ?? [];
    const start = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    return Response.json({ total: rows.length, items: rows.slice(start, start + limit) });
  }
  const id = u.pathname.split('/backend-api/conversation/')[1];
  if (id) {
    if (id === slowId) return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    if (id === missingId) return new Response('missing', { status: 404 });
    if (id === timeoutId) throw new DOMException('signal timed out', 'TimeoutError');
    return Response.json({
      id, title: id, create_time: old, update_time: old,
      current_node: 'm1',
      mapping: { m1: {
        id: 'm1', parent: null,
        message: { author: { role: 'user' }, create_time: old, content: { content_type: 'text', parts: [id] } },
      } },
    });
  }
  throw new Error(`Unexpected URL ${u.pathname}`);
};

const register = async () => {};
const report = async () => {};
const log = () => {};
const received = [];
const push = async (source, adapter, conversations) => {
  assert.equal(adapter, 'chatgpt-web');
  assert.equal(conversations.length, 1, 'each conversation must be committed immediately');
  received.push([source, conversations[0].externalId]);
  return 1;
};
let lastCheckpoint = null;
const checkpoint = async state => { lastCheckpoint = structuredClone(state); };
const run = async (state, overrides = {}) =>
  syncChatGPT({ state, register, report, log, push, checkpoint, ...overrides });

try {
  let state = {};
  let chunks = 0;
  let last;
  do {
    last = await run(state);
    state = last.state;
    chunks++;
    assert(chunks <= 30, 'bounded import must terminate');
    if (last.hasMore) assert(Number.isInteger(state.pending.pageIndex));
  } while (last.hasMore);
  assert(chunks > 1);
  assert.equal(received.length, 14);
  assert.equal(new Set(received.map(row => row.join(':'))).size, 14);
  assert.equal(received.filter(row => row[0] === 'chatgpt-web').length, 11);
  assert.equal(received.filter(row => row[0].startsWith('chatgpt-web-')).length, 3);
  assert(!state.pending, 'cursor removed after complete import');
  assert(state.accounts.accpersonal?.lastSyncMs || Object.values(state.accounts).some(a => a.lastSyncMs));
  const repeat = await run(state);
  assert.equal(repeat.conversations, 0, 'clean watermark excludes unchanged history');
  assert.equal(repeat.hasMore, false);

  // Simulate the browser worker being killed after three acknowledged writes.
  const seen = [];
  let durable = null;
  const interruptedPush = async (_source, _adapter, conversations) => {
    seen.push(conversations[0].externalId);
    return 1;
  };
  let beforeInterruption = {};
  let interrupted = false;
  for (let i = 0; i < 10; i++) {
    try {
      const next = await run(beforeInterruption, {
        push: interruptedPush,
        checkpoint: async state => {
          durable = structuredClone(state);
          if (seen.length === 3) throw new Error('simulated service worker termination');
        },
      });
      beforeInterruption = next.state;
    } catch (error) {
      assert.match(error.message, /simulated service worker termination/);
      interrupted = true;
      break;
    }
  }
  assert(interrupted, 'worker interruption must happen after three durable writes');
  assert.equal(durable.pending.pageIndex, 3);
  let recovered = durable;
  let more = true;
  for (let n = 0; more && n < 30; n++) {
    const result = await run(recovered, {
      push: interruptedPush,
      checkpoint: async state => { durable = structuredClone(state); },
    });
    recovered = result.state;
    more = result.hasMore;
  }
  assert(!more, 'recovered run must finish');
  assert.equal(seen.length, 14, 'recovery must not repeat already checkpointed entries');
  assert.equal(new Set(seen).size, 14);

  slowId = 'personal-0';
  const rateLimited = await run({});
  assert.equal(rateLimited.conversations, 0);
  assert.equal(rateLimited.hasMore, true);
  assert.equal(rateLimited.state.pending.pageIndex, 0, 'rate-limited item must be retried');
  assert(rateLimited.retryAfterMinutes >= 1);
  slowId = null;

  // A 429 from the conversation-list endpoint must never become a failed
  // worker or clear the durable cursor. Repeated 429s back off further.
  rateLimitedList = true;
  const firstList429 = await run({});
  assert.equal(firstList429.hasMore, true);
  assert(firstList429.retryAfterMinutes >= 5);
  assert.equal(firstList429.state.pending.pageIndex, 0);
  const secondList429 = await run(firstList429.state);
  assert.equal(secondList429.hasMore, true);
  assert(secondList429.retryAfterMinutes >= 10);
  assert.equal(secondList429.state.pending.rateLimitStreak, 2);
  rateLimitedList = false;
  const firstSuccessfulRead = await run(secondList429.state);
  assert.equal(firstSuccessfulRead.state.pending.rateLimitStreak, 0,
    'a successful conversation read resets consecutive 429 backoff before the scope completes');
  let resumedState = firstSuccessfulRead.state;
  let resumed = firstSuccessfulRead;
  for (let attempt = 0; resumed.hasMore && attempt < 30; attempt++) {
    resumed = await run(resumedState);
    resumedState = resumed.state;
    if (!resumed.hasMore) break;
  }
  assert(resumed && !resumed.hasMore, 'rate-limited list must resume from saved cursor');

  missingId = 'personal-1';
  let partial = await run({});
  for (let i = 0; i < 5 && partial.failures === 0 && partial.hasMore; i++) {
    partial = await run(partial.state);
  }
  assert.equal(partial.failures, 1);
  assert.equal(partial.state.pending.scopeFailures, 1);
  assert.equal(partial.state.pending.failureReasons['HTTP 404'], 1, 'unavailable detail status remains visible in checkpoint');
  assert.deepEqual(partial.state.failureDetails.map(({ conversationId, projectId, errorType, attempts, resolvedAtMs }) =>
    ({ conversationId, projectId, errorType, attempts, resolvedAtMs })), [
    { conversationId: 'personal-1', projectId: null, errorType: 'HTTP 404', attempts: 1, resolvedAtMs: null },
  ], 'failed conversation ID and category persist outside the pending cursor');
  assert(Number.isFinite(partial.state.failureDetails[0].lastFailedAtMs));
  missingId = null;

  assert.equal(failureType(new DOMException('signal timed out', 'TimeoutError')), 'TimeoutError');
  assert.equal(failureType(new Error('signal timed out')), 'TimeoutError');
  assert.equal(failureType(new DOMException('The operation was aborted', 'AbortError')), 'AbortError');
  assert.equal(failureType(new TypeError('Failed to fetch')), 'NetworkError');
  assert.equal(failureType(new SyntaxError('Unexpected JSON')), 'SyntaxError');
  assert.equal(failureType({ status: 503, name: 'Error' }), 'HTTP 503');
  assert.equal(failureType({ name: 'UnexpectedIllegalName', message: 'failed' }), 'UnknownError');

  timeoutId = 'personal-2';
  const oldFailures = Array.from({ length: 100 }, (_, i) => ({
    conversationId: `old-${i}`, projectId: null, accountKey: 'accpersonal',
    errorType: 'HTTP 500', attempts: 1, resolvedAtMs: null,
  }));
  oldFailures[0].resolvedAtMs = Date.now();
  let timeout = await run({ failureDetails: oldFailures });
  for (let i = 0; i < 8 && !timeout.state.pending?.failureReasons?.TimeoutError && timeout.hasMore; i++) {
    timeout = await run(timeout.state);
  }
  assert.equal(timeout.state.pending.failureReasons.TimeoutError, 1);
  assert.equal(timeout.state.failureDetails.length, 100, 'failure list is bounded at 100');
  assert.equal(timeout.state.failureDetails[0].conversationId, 'old-1', 'oldest entry evicted');
  assert.equal(timeout.state.failureDetails.at(-1).conversationId, 'personal-2');
  assert.equal(timeout.state.failureDetails.at(-1).errorType, 'TimeoutError');
  timeoutId = null;

  let retried = timeout;
  for (let i = 0; retried.hasMore && i < 30; i++) retried = await run(retried.state);
  assert.equal(retried.hasMore, false);
  assert.equal(retried.state.failureDetails.at(-1).resolvedAtMs, null);
  // Recovery must respect the 30-minute retry cooldown rather than
  // immediately re-request a conversation that just timed out.
  const realNow = Date.now;
  Date.now = () => realNow() + 65 * 60_000;
  let resolved = retried;
  try {
    for (let i = 0; i < 30; i++) {
      resolved = await run(resolved.state);
      if (!resolved.hasMore) break;
    }
  } finally {
    Date.now = realNow;
  }
  assert.equal(resolved.hasMore, false);
  assert(Number.isFinite(resolved.state.failureDetails.at(-1).resolvedAtMs),
    'a later successful targeted retry marks the prior failure as recovered');

  // A transient account enumeration failure must not silently fall back to
  // one account and omit workspace project scopes.
  accountEndpointStatus = 500;
  await assert.rejects(run({}), /500/);
  accountEndpointStatus = 404;
  const legacyAccounts = await run({});
  assert.equal(legacyAccounts.hasMore, false, 'known 404 may use the documented default account');
  assert.equal(legacyAccounts.failures, 0);
  accountEndpointStatus = null;

  // A storage/API failure must stop immediately and must not advance the cursor.
  const failed = await assert.rejects(run({}, {
    push: async () => { throw new Error('local ingestion unavailable'); },
  }), /local ingestion unavailable/);
  assert.equal(failed, undefined);

  assert(progressDetail({ detected: 2, processed: 2, failed: 1 }).includes('1 failed'));
  console.log('PASS durable ChatGPT sync: 14 conversations, cross-account chunks, interruption resume, rate-limit deferral, failed reads, fatal ingestion errors');
} finally {
  globalThis.fetch = realFetch;
}
