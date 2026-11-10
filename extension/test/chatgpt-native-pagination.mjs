import assert from 'node:assert/strict';
import { nextNativeRecoveryPriority, syncChatGPT } from '../providers/chatgpt.js';

const cid = '11111111-2222-4333-8444-555555555555';
const ids = Array.from({ length: 6 }, (_, i) =>
  `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const ts = Math.floor(Date.now() / 1000) - 800;
const message = (i, role) => ({
  id: ids[i], author: { role }, create_time: ts + i,
  content: { content_type: 'text', parts: [`text-${i}`] },
  metadata: { model_slug: 'gpt-test' }, recipient: 'all',
});
const pages = [
  { title: 'Long chat', create_time: ts, update_time: ts + 6,
    conversation_id: cid, current_node: ids[5],
    messages: [message(4, 'user'), message(5, 'assistant')],
    page_info: { has_previous_page: true, has_next_page: false, start_cursor: ids[4], end_cursor: ids[5] } },
  { conversation_id: cid, messages: [message(2, 'user'), message(3, 'assistant')],
    page_info: { has_previous_page: true, has_next_page: true, start_cursor: ids[2], end_cursor: ids[3] } },
  { conversation_id: cid, messages: [message(0, 'user'), message(1, 'assistant')],
    page_info: { has_previous_page: false, has_next_page: true, start_cursor: ids[0], end_cursor: ids[1] } },
];
const scope = { accountId: 'acct', accountKey: 'acct', sourceId: 'chatgpt-web-fixture',
  projectId: null, projectName: null, projectShortUrl: null };
const initialState = { pending: {
  scopes: [scope], scopeIndex: 0, pageIndex: 0, offset: 0, cursor: '0',
  detected: 0, processed: 0, failures: 0, scopeFailures: 0, runStartedMs: Date.now(),
  cachedPage: { items: [{ id: cid, create_time: ts, update_time: ts + 6 }],
    next: null, scopeIndex: 0, offset: 0, cursor: '0', projectId: null,
    accountKey: scope.accountKey },
} };
const oldFetch = globalThis.fetch;
const oldChrome = globalThis.chrome;
const requests = [];
const ingests = [];
const confirmations = [];
const checkpoints = [];
let ingestionAllowed = true;
let rateLimitOnce = true;
globalThis.chrome = { storage: { session: {
  get: async () => ({ hstryChatGPTAccessToken: { token: 'fixture', expiresAtMs: Date.now() + 3600_000 } }),
} } };
globalThis.fetch = async url => {
  const u = new URL(url);
  requests.push(u.pathname + u.search);
  if (u.pathname === '/backend-api/conversations/' + cid) {
    const before = u.searchParams.get('before');
    assert.equal(u.searchParams.get('include_has_versions'), 'true');
    assert(Number(u.searchParams.get('num_turns')) >= 10);
    if (!before) return Response.json(pages[0]);
    if (before === ids[4] && rateLimitOnce) {
      rateLimitOnce = false;
      return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    }
    if (before === ids[4]) return Response.json(pages[1]);
    if (before === ids[2]) return Response.json(pages[2]);
  }
  throw new Error('Unexpected endpoint ' + u.pathname + u.search);
};
const run = state => syncChatGPT({
  state, pendingLiveConversationIds: [cid],
  register: async () => {}, report: async () => {},
  checkpoint: async snap => checkpoints.push(structuredClone(snap)),
  push: async (_source, _adapter, conversations) => {
    if (!ingestionAllowed) throw new Error('simulated local ingest outage');
    ingests.push(structuredClone(conversations));
    return conversations.length;
  },
  onCanonicalIngest: async detail => confirmations.push(detail),
});
try {
  let state = initialState;
  for (let i = 0; i < 3; i++) {
    const before = requests.length;
    const result = await run(state);
    assert.equal(requests.length - before, 1, 'one remote detail page per scheduled run');
    assert.equal(result.hasMore, true);
    assert.equal(ingests.length, 0, 'partial history must not become canonical');
    assert.equal(result.state.pending.processed, 0, 'list cursor cannot advance before full detail');
    assert.equal(result.state.pending.pageIndex, 0);
    if (i === 1) assert.equal(result.deferredHttpStatus, 429);
    state = result.state;
  }
  const final = await run(state);
  assert.equal(ingests.length, 1, 'a complete selected branch is imported exactly once');
  const [primary, ...forks] = ingests[0];
  assert.equal(primary.externalId, cid);
  assert.deepEqual(primary.messages.map(x => x.content),
    ['text-0', 'text-1', 'text-2', 'text-3', 'text-4', 'text-5']);
  assert.deepEqual(primary.messages.map(x => x.metadata?.messageId), ids);
  assert.equal(primary.metadata.selectedBranchOnly, true,
    'pagination cannot pretend to recover unavailable alternate versions');
  assert.equal(forks.length, 0, 'do not invent alternate branches');
  assert.equal(confirmations.length, 1, 'canonical reconciliation only after successful push');
  assert.deepEqual(Object.keys(confirmations[0].confirmed).sort(), [...ids].sort());
  assert.equal(final.state.pending.nativeDetail, undefined, 'completed detail clears durable partial state');
  assert.equal(final.state.pending.processed, 1, 'list advances only after complete canonical ingest');
  assert.equal(final.state.pending.pageIndex, 1, 'saved source listing moves past complete detail');
  assert.equal(final.failures, 0);
  assert.equal(requests.length, 4);

  // The user's original chat can be prioritized using the same canonical
  // source/checkpoint while its larger 72-scope historic sweep is preserved.
  requests.length = 0;
  ingests.length = 0;
  confirmations.length = 0;
  const priority = structuredClone(initialState);
  priority.pending.priority = { conversationId: cid, sourceId: scope.sourceId, projectId: null };
  const firstPriority = await run(priority);
  assert.equal(requests.length, 1);
  assert.equal(firstPriority.state.pending.pageIndex, 0, 'priority leaves ongoing scan cursor unchanged');
  assert.equal(firstPriority.state.pending.priority.stage.pages, 1);
  assert.equal(ingests.length, 0);
  const secondPriority = await run(firstPriority.state);
  assert.equal(secondPriority.state.pending.priority.stage.pages, 2);
  assert.equal(secondPriority.state.pending.pageIndex, 0);
  const thirdPriority = await run(secondPriority.state);
  assert.equal(thirdPriority.state.pending.priority, undefined);
  assert.equal(thirdPriority.state.pending.pageIndex, 0);
  assert.equal(thirdPriority.state.pending.processed, 0);
  assert.equal(ingests.length, 1);
  assert.equal(requests.length, 3, 'no extra listing or authentication requests');
  assert.deepEqual(ingests[0][0].messages.map(x => x.content),
    ['text-0', 'text-1', 'text-2', 'text-3', 'text-4', 'text-5']);

  // A wrong source must fail closed before issuing any network request.
  const unowned = structuredClone(initialState);
  unowned.pending.priority = { conversationId: cid, sourceId: 'another-account', projectId: null };
  await assert.rejects(run(unowned), /Invalid or unowned ChatGPT targeted recovery checkpoint/);
  assert.equal(requests.length, 3);

  // Invalid API pagination must fail closed, not quietly ingest one page.
  const validFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ...pages[0],
    page_info: { ...pages[0].page_info, start_cursor: 'invalid-cursor' } });
  const badCursor = structuredClone(initialState);
  badCursor.pending.priority = { conversationId: cid, sourceId: scope.sourceId, projectId: null };
  await assert.rejects(run(badCursor), /repeated or invalidated its cursor/);
  assert.equal(ingests.length, 1, 'invalid pagination cannot overwrite an existing canonical record');
  globalThis.fetch = validFetch;

  // A failed local ingest must retain every completed page. The retry should
  // write the staged result, not re-request the ChatGPT conversation.
  const completed = structuredClone(initialState);
  completed.pending.priority = { conversationId: cid, sourceId: scope.sourceId,
    projectId: null, stage: { conversationId: cid, pages: 3, complete: true,
      seenCursors: [ids[4], ids[2]], before: null,
      header: { title: 'Long chat', create_time: ts, update_time: ts + 6 },
      messages: [...pages[2].messages, ...pages[1].messages, ...pages[0].messages] } };
  const priorRequests = requests.length;
  const priorIngests = ingests.length;
  ingestionAllowed = false;
  await assert.rejects(run(completed), /simulated local ingest outage/);
  assert.equal(requests.length, priorRequests);
  assert.equal(ingests.length, priorIngests);
  assert.equal(checkpoints.at(-1).pending.priority.stage.complete, true);
  ingestionAllowed = true;
  const resumed = await run(checkpoints.at(-1));
  assert.equal(resumed.state.pending.priority, undefined);
  assert.equal(ingests.length, priorIngests + 1);
  assert.equal(requests.length, priorRequests,
    'retrying local ingestion cannot produce another remote request');

  // Repeated legacy detail timeouts must reuse the same paginated, durable
  // priority path instead of another single huge conversation fetch.
  const timedOut = structuredClone(initialState);
  timedOut.failureDetails = [{ conversationId: cid, accountKey: scope.accountKey,
    accountId: scope.accountId, sourceId: scope.sourceId, projectId: null,
    errorType: 'TimeoutError', errorDiagnostic: 'signal timed out',
    attempts: 5, lastFailedAtMs: Date.now() - 60_000,
    nextRetryAtMs: Date.now() - 1000, resolvedAtMs: null }];
  assert.equal(nextNativeRecoveryPriority(timedOut)?.kind, 'native-fallback',
    'repeated due TimeoutError should select the existing native pagination');
  const cooling = structuredClone(timedOut);
  cooling.failureDetails[0].nextRetryAtMs = Date.now() + 60_000;
  assert.equal(nextNativeRecoveryPriority(cooling), null,
    'a timed-out history must not bypass the saved retry cooldown');
  const wrongOwner = structuredClone(timedOut);
  wrongOwner.failureDetails[0].accountKey = 'different-account';
  assert.equal(nextNativeRecoveryPriority(wrongOwner), null,
    'the paginated fallback must stay bound to the indexed account');
  requests.length = 0;
  ingests.length = 0;
  confirmations.length = 0;
  rateLimitOnce = false;
  let retryState = timedOut;
  for (let i = 0; i < 3; i++) {
    const next = await run(retryState);
    assert.equal(requests.length, i + 1,
      'one paginated detail request per scheduled retry worker');
    assert(requests[i].startsWith('/backend-api/conversations/' + cid + '?'),
      'timeout fallback must not repeat the monolithic legacy endpoint');
    assert.equal(next.state.pending.pageIndex, 0,
      'a targeted timeout recovery must not advance the main list cursor');
    if (i < 2) assert.equal(ingests.length, 0,
      'partial pages cannot be promoted to canonical history');
    retryState = next.state;
  }
  assert.equal(ingests.length, 1);
  assert.equal(ingests[0][0].metadata.selectedBranchOnly, true);
  assert.equal(confirmations.length, 1);
  assert(Number.isFinite(retryState.failureDetails[0].resolvedAtMs));
  assert.equal(retryState.pending.priority, undefined);

  // A due repeat legacy failure may be blocked by the three-item fairness
  // window. Do not fall through to the huge legacy GET while it is deferred.
  const deferred = structuredClone(initialState);
  deferred.pending.processed = 110;
  deferred.pending.lastPriorityProcessed = 108;
  deferred.failureDetails = [{ conversationId: cid, accountKey: scope.accountKey,
    accountId: scope.accountId, sourceId: scope.sourceId, projectId: null,
    errorType: 'TimeoutError', errorDiagnostic: 'signal timed out',
    attempts: 5, lastFailedAtMs: Date.now() - 6 * 3600_000,
    nextRetryAtMs: Date.now() - 1000, resolvedAtMs: null }];
  requests.length = 0;
  ingests.length = 0;
  assert.equal(nextNativeRecoveryPriority(deferred), null,
    'native fallback cannot bypass the ordinary-scan fairness gate');
  const deferredResult = await run(deferred);
  assert(!requests.some(x => x.startsWith('/backend-api/conversation/' + cid)),
    'while fairness defers native retry, do not send an old monolithic detail GET');
  assert.equal(deferredResult.state.failureDetails[0].attempts, 5,
    'a deferred native retry must not consume an additional failure attempt');
  const after500 = structuredClone(timedOut);
  after500.failureDetails[0].errorType = 'HTTP 500';
  after500.failureDetails[0].errorDiagnostic = 'ChatGPT conversation detail -> 500';
  after500.failureDetails[0].attempts = 6;
  assert.equal(nextNativeRecoveryPriority(after500)?.kind, 'native-fallback',
    'a repeated 500 from legacy detail must retain the paginated recovery route');
  after500.failureDetails[0].nextRetryAtMs = Date.now() + 6 * 3600_000;
  assert.equal(nextNativeRecoveryPriority(after500), null,
    'do not ignore the already-saved six-hour cooldown after a legacy HTTP 500');

  console.log('PASS modern page cursors, 429 checkpoint, strict validation, exact-owner priority, local retry, full-ordering and canonical ingest');
} finally { globalThis.fetch = oldFetch; globalThis.chrome = oldChrome; }
