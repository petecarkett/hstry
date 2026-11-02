import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const oldChrome = globalThis.chrome;
const oldFetch = globalThis.fetch;
const now = Date.now();
const oldSeconds = Math.floor((now - 86_400_000) / 1000);
const scope = { accountId: 'account-fixture', accountKey: 'fixture',
  sourceId: 'chatgpt-web-fixture', projectId: null, projectName: null, projectShortUrl: null };
const pending = () => ({
  scopes: [scope], scopeIndex: 0, offset: 0, cursor: '0', pageIndex: 0,
  failures: 0, scopeFailures: 0, detected: 0, processed: 0, runStartedMs: now,
});
const state = () => ({
  paceMs: 720_000, healthyReads: 5,
  accounts: { fixture: { lastSyncMs: now - 60 * 60_000, projects: {} } },
  pending: pending(),
});
const requests = [];
let responseKind = 'list';
let cachedToken = true;
globalThis.chrome = { storage: { session: {
  get: async () => ({ hstryChatGPTAccessToken: cachedToken
    ? { token: 'fixture-only', expiresAtMs: now + 60 * 60_000 } : undefined }),
  set: async () => {},
} } };
globalThis.fetch = async url => {
  const u = new URL(url);
  requests.push(u.pathname);
  if (u.pathname === '/api/auth/session') {
    return Response.json({ accessToken: 'fixture-only' });
  }
  if (u.pathname === '/backend-api/conversations') {
    return responseKind === '429'
      ? new Response('', { status: 429, headers: { 'retry-after': '120' } })
      : Response.json({ items: [], total: 0 });
  }
  if (u.pathname === '/backend-api/conversation/fresh-id') {
    return Response.json({ id: 'fresh-id', title: 'Fixture',
      create_time: oldSeconds, update_time: Math.floor(now / 1000),
      current_node: 'one', mapping: { one: { id: 'one', parent: null,
        message: { author: { role: 'user' }, create_time: oldSeconds,
          content: { content_type: 'text', parts: ['fixture'] } },
      } } });
  }
  throw Error('Unrecognized fixture endpoint ' + u.pathname);
};
const run = async source => {
  requests.length = 0;
  const result = await syncChatGPT({ state: source, report: async () => {},
    checkpoint: async () => {}, register: async () => {},
    push: async () => 1 });
  assert(requests.length <= 1, 'one remote request per service-worker run');
  return result;
};
try {
  // A successful list fetch must not inherit the conversation-detail delay.
  const listing = await run(state());
  assert.deepEqual(requests, ['/backend-api/conversations']);
  assert.equal(listing.hasMore, true);
  assert.equal(listing.retryAfterMinutes, 1, 'list-page fetch uses bounded metadata delay');

  // A cached page of already-old rows needs no detail request.
  const skipState = state();
  skipState.pending.cachedPage = {
    items: [{ id: 'old-id', update_time: oldSeconds }], next: 50,
    scopeIndex: 0, offset: 0, cursor: '0', projectId: null, accountKey: 'fixture',
  };
  const skipped = await run(skipState);
  assert.equal(requests.length, 0, 'no remote request for cache-only page advancement');
  assert.equal(skipped.retryAfterMinutes, 1, 'cache-only advancement does not incur detail delay');
  assert.equal(skipped.state.pending.offset, 50);

  // Detail requests remain deliberately paced, including after a listing.
  const detailState = state();
  detailState.pending.cachedPage = {
    items: [{ id: 'fresh-id', update_time: Math.floor(now / 1000) }],
    next: null, scopeIndex: 0, offset: 0, cursor: '0',
    projectId: null, accountKey: 'fixture',
  };
  const detail = await run(detailState);
  assert.deepEqual(requests, ['/backend-api/conversation/fresh-id']);
  assert.equal(detail.retryAfterMinutes, 12, 'detail request retains 12-minute pace');

  // Refreshing only the browser session token must not stall the importer.
  cachedToken = false;
  const auth = await run(state());
  assert.deepEqual(requests, ['/api/auth/session']);
  assert.equal(auth.retryAfterMinutes, 1, 'auth-only turn uses metadata delay');

  // Server rate limits retain the original durable cooldown and pacing.
  cachedToken = true;
  responseKind = '429';
  const limited = await run(state());
  assert.equal(limited.deferredHttpStatus, 429);
  assert(limited.retryAfterMinutes >= 5, '429 server backoff remains active');
  assert.equal(limited.state.paceMs, 900_000, 'rate limit increases detail pace');
  console.log('PASS metadata request pacing without weakening detail/429 limits');
} finally {
  globalThis.fetch = oldFetch;
  if (oldChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = oldChrome;
}
