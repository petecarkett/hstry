import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const baseTime = Date.now();
const oldTime = Math.floor(baseTime / 1000) - 3600;
const rows = Array.from({ length: 25 }, (_, i) => ({
  id: `history-${i}`, update_time: oldTime, gizmo_id: projectId,
}));
let listCalls = 0;
let details = 0;
let sessionCalls = 0;
let newDetailStatus = 200;
const ingested = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.pathname === '/api/auth/session') {
    sessionCalls++;
    return Response.json({ accessToken: 'fixture-only' });
  }
  if (url.pathname.includes('/accounts/check/')) {
    return Response.json({ accounts: {
      one: { account: { account_id: 'acc-project', structure: 'workspace' } },
    } });
  }
  if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
    return Response.json({ items: [{ gizmo: { gizmo: { id: projectId,
      display: { name: '1hood' }, short_url: `${projectId}-1hood`,
    } } }], cursor: null });
  }
  if (url.pathname === `/backend-api/gizmos/${projectId}/conversations`) {
    listCalls++;
    return Response.json({ items: rows, cursor: null });
  }
  if (url.pathname === '/backend-api/conversations') {
    return Response.json({ items: [], total: 0 });
  }
  if (url.pathname.startsWith('/backend-api/conversation/')) {
    const id = url.pathname.split('/').at(-1);
    details++;
    assert.equal(init.headers['chatgpt-project-id'], projectId);
    if (id.startsWith('fresh') && newDetailStatus !== 200) {
      return new Response('', { status: newDetailStatus,
        headers: newDetailStatus === 429 ? { 'retry-after': '60' } : {},
      });
    }
    return Response.json({
      id, title: id, create_time: oldTime, update_time: oldTime,
      current_node: 'msg', mapping: { msg: { id: 'msg', parent: null,
        message: { author: { role: 'user' }, create_time: oldTime,
          content: { content_type: 'text', parts: [id] },
        },
      } },
    });
  }
  throw new Error(`Unexpected URL ${url.pathname}`);
};

const sync = state => syncChatGPT({
  state, register: async () => {}, report: async () => {},
  checkpoint: async () => {}, log: () => {},
  push: async (_source, _adapter, conversations) => {
    ingested.push(conversations[0].externalId);
    return 1;
  },
});

try {
  let state = {};
  let last;
  let runs = 0;
  do {
    const before = details;
    last = await sync(state);
    runs++;
    assert(details - before <= 1, 'never burst more than one conversation detail per run');
    if (last.hasMore && details > before) {
      assert(last.retryAfterMinutes >= 0.5, 'continuation must be paced');
    }
    state = last.state;
    assert(runs <= 30, '25 conversations must finish in bounded runs');
  } while (last.hasMore);

  assert.equal(ingested.length, 25);
  assert.equal(new Set(ingested).size, 25);
  assert.equal(listCalls, 1, 'one project listing reused through all 25 worker runs');
  assert.equal(state.paceMs, 48_000, '24 successful conversations gently increase pace');
  assert.equal(state.healthyReads, 1);
  assert.equal(state.pending, undefined);
  assert(sessionCalls >= 25, 'authentication is still refreshed; no token saved persistently');

  // New conversation after the saved watermark, proving the reduced pacing
  // is persistent across separate full sync cycles.
  rows.push({ id: 'fresh', update_time: Math.floor(baseTime / 1000), gizmo_id: projectId });
  newDetailStatus = 429;
  const rateLimited = await sync(state);
  assert.equal(rateLimited.deferredHttpStatus, 429);
  assert.equal(rateLimited.state.lastRateLimitEndpoint, 'conversation-detail');
  assert.equal(rateLimited.state.paceMs, 96_000, 'one 429 halves the send rate');
  assert.equal(rateLimited.state.healthyReads, 0);
  assert(rateLimited.retryAfterMinutes >= 5);
  assert.equal(rateLimited.state.pending.pageIndex, 25);
  assert(rateLimited.state.pending.cachedPage?.items.length === 26);
  const pagesBefore429Retry = listCalls;

  const second429 = await sync(rateLimited.state);
  assert.equal(second429.state.paceMs, 192_000, 'repeated 429 slows down again');
  assert.equal(listCalls, pagesBefore429Retry, '429 retry reuses the same saved page');
  assert.equal(second429.state.pending.pageIndex, 25);

  newDetailStatus = 200;
  const success = await sync(second429.state);
  assert.equal(success.state.paceMs, 192_000,
    'one success does not prematurely restore the higher request rate');
  assert.equal(success.retryAfterMinutes, 3.2);
  assert.equal(success.state.healthyReads, 1);
  assert.equal(success.state.pending.rateLimitStreak, 0);
  assert.deepEqual(ingested.slice(-1), ['fresh']);
  assert.equal(listCalls, pagesBefore429Retry);

  const finished = await sync(success.state);
  assert.equal(finished.hasMore, false);
  assert.equal(ingested.filter(id => id === 'fresh').length, 1);
  assert.equal(finished.state.paceMs, 192_000);
  assert.equal(finished.state.pending, undefined);

  // A server 503 is transient overload, not evidence that this client is
  // exceeding a per-account request limit. Keep the last learned pace.
  rows.push({ id: 'fresh-2', update_time: Math.floor(baseTime / 1000), gizmo_id: projectId });
  newDetailStatus = 503;
  const overloaded = await sync(finished.state);
  assert.equal(overloaded.deferredHttpStatus, 503);
  assert.equal(overloaded.state.paceMs, 192_000,
    'temporary server overload must not trigger a 429-specific rate reduction');
  assert.equal(overloaded.state.lastRateLimitEndpoint, 'conversation-detail');
  console.log('PASS adaptive pacing: 1 detail per batch, saved page reuse, 24-success increase, 429 slowdown, 503 isolation, durable resume');
} finally {
  globalThis.fetch = realFetch;
}
