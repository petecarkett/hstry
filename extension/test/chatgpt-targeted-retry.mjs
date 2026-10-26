import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const accountId = 'acc-workspace-1234';
const originalNow = Date.now;
const start = originalNow();
let now = start;
Date.now = () => now;
const updatedSeconds = Math.floor((start - 3_600_000) / 1000);
let retryResponse = 'timeout';
let failSessionWith429 = false;
let detailCalls = 0;
let projectPageCalls = 0;
let refreshedListItem = false;
const imported = [];
const originalFetch = globalThis.fetch;
const items = [
  { id: 'timed-out', gizmo_id: projectId, update_time: updatedSeconds },
  { id: 'healthy', gizmo_id: projectId, update_time: updatedSeconds },
];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.pathname === '/api/auth/session') {
    if (failSessionWith429) return new Response('', {
      status: 429, headers: { 'retry-after': '120' },
    });
    return Response.json({ accessToken: 'fixture' });
  }
  if (url.pathname.includes('/accounts/check/')) return Response.json({
    accounts: { user: { account: { account_id: accountId, structure: 'workspace' } } },
  });
  if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') return Response.json({
    items: [{ gizmo: { id: projectId, display: { name: '1hood' }, short_url: `${projectId}-1hood` } }],
    cursor: null,
  });
  if (url.pathname === `/backend-api/gizmos/${projectId}/conversations`) {
    projectPageCalls++;
    return Response.json({
      items: refreshedListItem
        ? items.map(item => item.id === 'timed-out'
          ? { ...item, update_time: Math.floor(now / 1000) } : item)
        : items,
      cursor: null,
    });
  }
  if (url.pathname === '/backend-api/conversations') return Response.json({ items: [], total: 0 });
  const match = url.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
  if (match) {
    const id = match[1];
    if (id === 'timed-out') {
      detailCalls++;
      assert.equal(init.headers['chatgpt-project-id'], projectId);
      if (retryResponse === 'timeout') throw new DOMException('signal timed out', 'TimeoutError');
      if (retryResponse === '429') return new Response('', {
        status: 429, headers: { 'retry-after': '1' },
      });
      if (retryResponse === '404') return new Response('', { status: 404 });
    }
    return Response.json({
      title: id, create_time: updatedSeconds, update_time: updatedSeconds,
      current_node: 'm1', mapping: { m1: { id: 'm1', parent: null, message: {
        author: { role: 'user' }, create_time: updatedSeconds,
        content: { content_type: 'text', parts: [id] },
      } } },
    });
  }
  throw new Error(`Unexpected fetch ${url.pathname}`);
};

const run = (state, overrides = {}) => syncChatGPT({
  state, register: async () => {}, report: async () => {},
  checkpoint: async () => {}, log: () => {},
  push: async (_source, _adapter, conversations) => {
    imported.push(conversations[0].externalId);
    return 1;
  },
  ...overrides,
});

try {
  let initial = await run({});
  for (let n = 0; initial.hasMore && n < 8; n++) initial = await run(initial.state);
  assert.equal(initial.hasMore, false);
  assert.deepEqual(imported, ['healthy']);
  assert.equal(initial.state.failureDetails.length, 1);
  const firstFailure = initial.state.failureDetails[0];
  assert.deepEqual([firstFailure.conversationId, firstFailure.projectId, firstFailure.errorType],
    ['timed-out', projectId, 'TimeoutError']);
  assert(firstFailure.sourceId && firstFailure.accountId === accountId);
  assert(firstFailure.nextRetryAtMs - start >= 30 * 60_000);
  assert(Object.values(initial.state.accounts)[0].projects[projectId].lastSyncMs,
    'tracked failed IDs permit advancing the project watermark safely');

  const pagesBeforeRetry = projectPageCalls;
  const detailsBeforeRetry = detailCalls;
  now += 31 * 60_000;
  retryResponse = 'success';
  let interruptedCheckpoint = null;
  await assert.rejects(run(initial.state, {
    checkpoint: async checkpoint => {
      if (checkpoint.failureDetails?.[0]?.attempts === 2) {
        interruptedCheckpoint = structuredClone(checkpoint);
        throw new Error('worker interrupted after durable attempt checkpoint');
      }
    },
  }), /worker interrupted/);
  assert(interruptedCheckpoint?.pending);
  assert.equal(interruptedCheckpoint.pending.pageIndex, 0);
  assert.equal(interruptedCheckpoint.failureDetails[0].attempts, 2);
  assert.equal(detailCalls, detailsBeforeRetry, 'worker death happened before the retry fetch');
  assert.equal(projectPageCalls, pagesBeforeRetry, 'targeted retry does not scan any page');

  now += 60_000;
  refreshedListItem = true;
  const noHammer = await run(interruptedCheckpoint);
  refreshedListItem = false;
  assert.equal(noHammer.hasMore, false);
  assert.equal(noHammer.state.failureDetails[0].attempts, 2);
  assert.equal(detailCalls, detailsBeforeRetry, 'recorded backoff prevents a restart hammer');

  now += 61 * 60_000;
  const pagesBeforeRecovery = projectPageCalls;
  const recovered = await run(noHammer.state);
  assert.equal(recovered.hasMore, true);
  assert.equal(recovered.conversations, 1);
  assert.equal(recovered.state.pending.scopeIndex, 0);
  assert.equal(recovered.state.pending.pageIndex, 0);
  assert.equal(projectPageCalls, pagesBeforeRecovery, 'retry used only the saved conversation ID');
  assert.equal(detailCalls, detailsBeforeRetry + 1);
  assert(Number.isFinite(recovered.state.failureDetails[0].resolvedAtMs));
  assert.equal(recovered.state.failureDetails[0].attempts, 3);
  assert.deepEqual(imported, ['healthy', 'timed-out']);
  const complete = await run(recovered.state);
  assert.equal(complete.hasMore, false);
  assert.equal(complete.failures, 0, 'recovered detail clears unresolved failure status');
  assert.deepEqual(imported, ['healthy', 'timed-out'], 'resolved detail not duplicated by next scan');

  // The exact 429 from a targeted retry must defer rather than advance a
  // page, and its durable attempt cannot be repeated before cooldown.
  now = start + 31 * 60_000;
  retryResponse = '429';
  const before429 = detailCalls;
  let savedCooldown;
  const rateLimited = await run(initial.state, {
    checkpoint: async state => {
      if (state.pending?.rateLimitUntilMs) savedCooldown = structuredClone(state);
    },
  });
  assert.equal(detailCalls, before429 + 1, '429 must not trigger an immediate duplicate request');
  assert(savedCooldown?.pending?.rateLimitUntilMs >= now + 5 * 60_000,
    'rate-limit deadline must be persisted before worker completion');
  assert.equal(rateLimited.deferredHttpStatus, 429);
  assert.equal(rateLimited.state.serverRetryAfterUntilMs, now + 1000,
    'the server hint is saved independently of the longer HSTRY cooldown');
  assert.equal(rateLimited.hasMore, true);
  assert(rateLimited.retryAfterMinutes >= 5);
  assert.equal(rateLimited.state.pending.pageIndex, 0);
  assert.equal(rateLimited.state.failureDetails[0].attempts, 2);
  assert.equal(rateLimited.state.failureDetails[0].resolvedAtMs, null);
  const callsAfterLimit = detailCalls;
  now += 60_000;
  await run(rateLimited.state);
  assert.equal(detailCalls, callsAfterLimit, '429 cooldown prevents immediate retry');

  // When several retry IDs are due, a 429 on one must give the saved
  // conversation-list cursor a turn instead of consuming every cooldown.
  now += 10 * 60_000;
  const contended = structuredClone(rateLimited.state);
  contended.failureDetails.push({
    ...contended.failureDetails[0],
    conversationId: 'second-timeout', attempts: 1,
    nextRetryAtMs: now - 1, resolvedAtMs: null,
  });
  const pagesBeforeScanTurn = projectPageCalls;
  const callsBeforeScanTurn = detailCalls;
  const forward = await run(contended);
  assert(projectPageCalls > pagesBeforeScanTurn,
    'a rate-limited retry must yield to the existing collection scan');
  assert.equal(detailCalls, callsBeforeScanTurn,
    'another due failure cannot monopolise the first scan turn');
  assert(!imported.includes('second-timeout'));
  assert.equal(forward.state.failureDetails.filter(x => !x.resolvedAtMs).length, 2);

  // An existing 0.4.6 checkpoint has no fairness bit. A high 429 streak
  // should migrate to one scan turn without resetting the saved cursor.
  const priorVersion = structuredClone(contended);
  delete priorVersion.pending.retryYieldToScan;
  priorVersion.pending.rateLimitStreak = 5;
  priorVersion.pending.lastDeferredHttpStatus = 429;
  const beforeMigrationScan = projectPageCalls;
  await run(priorVersion);
  assert(projectPageCalls > beforeMigrationScan,
    '0.4.6 repeated-429 checkpoint migrates to one scan turn');

  // A 404 must remain recorded and retryable: absent access today is not
  // proof a conversation was deleted permanently.
  now = start + 31 * 60_000;
  retryResponse = '404';
  const unavailable = await run(initial.state);
  assert.equal(unavailable.state.failureDetails[0].errorType, 'HTTP 404');
  assert.equal(unavailable.state.failureDetails[0].resolvedAtMs, null);
  now += 61 * 60_000;
  retryResponse = 'success';
  const returned = await run(unavailable.state);
  assert(Number.isFinite(returned.state.failureDetails[0].resolvedAtMs),
    'previously inaccessible conversation can recover');

  // If all detail slots contain unresolved IDs, preserve them instead of
  // evicting an unresolved entry and falsely advancing the scope watermark.
  now = start;
  retryResponse = 'timeout';
  const full = Array.from({ length: 100 }, (_, index) => ({
    conversationId: `older-${index}`, projectId, accountKey: 'accworkspace1234',
    errorType: 'TimeoutError', attempts: 1, resolvedAtMs: null,
  }));
  let capped = await run({ failureDetails: full });
  for (let n = 0; capped.hasMore && n < 8; n++) capped = await run(capped.state);
  assert.equal(capped.hasMore, false);
  assert.equal(capped.state.failureDetails.length, 100);
  assert.equal(capped.state.failureDetails[0].conversationId, 'older-0');
  assert.equal(capped.state.failureDetails.find(x => x.conversationId === 'timed-out'), undefined);
  assert.equal(Object.values(capped.state.accounts)[0].projects[projectId].lastSyncMs, null,
    'untracked due to capacity must leave the recovery watermark held');

  // Existing records from 0.4.4 have project IDs and account keys, but
  // not source IDs. Resolve them from the persisted scope inventory.
  now = start + 31 * 60_000;
  retryResponse = 'success';
  const legacyRecord = structuredClone(rateLimited.state);
  const oldDetail = legacyRecord.failureDetails[0];
  delete oldDetail.sourceId;
  delete oldDetail.accountId;
  delete oldDetail.nextRetryAtMs;
  oldDetail.attempts = 1;
  delete legacyRecord.pending.retryYieldToScan;
  const migrated = await run(legacyRecord);
  assert(Number.isFinite(migrated.state.failureDetails[0].resolvedAtMs));
  assert(migrated.state.failureDetails[0].sourceId,
    'existing extension records use the saved scopes, not a second database');

  // Losing local storage or registration must fail closed. These are not
  // ChatGPT conversation errors and must not be silently queued as such.
  now = start + 31 * 60_000;
  let durableBeforePush = null;
  await assert.rejects(run(initial.state, {
    push: async () => { throw new Error('local ingest unavailable'); },
    checkpoint: async checkpoint => { durableBeforePush = structuredClone(checkpoint); },
  }), /local ingest unavailable/);
  assert.equal(durableBeforePush.failureDetails[0].attempts, 2);
  assert.equal(durableBeforePush.failureDetails[0].resolvedAtMs, null);
  assert.equal(durableBeforePush.pending.pageIndex, 0);

  await assert.rejects(run(initial.state, {
    register: async () => { throw new Error('local source registration unavailable'); },
  }), /local source registration unavailable/);

  failSessionWith429 = true;
  const deferredDiscovery = await run({});
  assert.equal(deferredDiscovery.deferredHttpStatus, 429);
  assert.equal(deferredDiscovery.state.serverRetryAfterUntilMs, now + 120_000);
  assert(deferredDiscovery.state.discoveryRateLimitUntilMs >= now + 5 * 60_000,
    'discovery honours HSTRY fallback without discarding the server hint');
  failSessionWith429 = false;
  const discoveryRecovered = await run(deferredDiscovery.state, {
    push: async () => 1,
  });
  assert.equal(discoveryRecovered.state.discoveryRateLimitStreak, undefined);
  assert.equal(discoveryRecovered.state.discoveryRateLimitUntilMs, undefined,
    'successful discovery must not preserve a previous cooldown deadline');
  assert.equal(discoveryRecovered.state.discoveryDeferredHttpStatus, undefined);

  const highStreak = structuredClone(rateLimited.state);
  highStreak.pending.rateLimitStreak = 5;
  highStreak.pending.retryYieldToScan = false;
  now = Math.max(highStreak.failureDetails[0].nextRetryAtMs,
    highStreak.pending.rateLimitUntilMs) + 60_000;
  retryResponse = 'success';
  const targetedRecovered = await run(highStreak, { push: async () => 1 });
  assert.equal(targetedRecovered.hasMore, true);
  assert.equal(targetedRecovered.state.pending.rateLimitStreak, 0,
    'successful targeted conversation retry resets the consecutive 429 streak');

  console.log('PASS targeted detail retry: durable pre-attempt checkpoint, backoff, no list rescan, project routing, 429, recovery, and no unresolved eviction');
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
