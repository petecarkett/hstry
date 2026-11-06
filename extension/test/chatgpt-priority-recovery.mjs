import assert from 'node:assert/strict';
import { syncChatGPT, nextNativeRecoveryPriority } from '../providers/chatgpt.js';
import { nextContinuationPriority } from '../lib/live-capture.js';

const id = '11111111-2222-4333-8444-555555555555';
const inaccessible = '66666666-7777-4888-8999-000000000000';
const messageId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const project = 'g-p-6818bc97551c8191865a07d09f7b3678';
const personal = { accountId: 'account-1', accountKey: 'acc1', sourceId: 'chatgpt-web-acc1',
  projectId: null, projectName: null, projectShortUrl: null };
const projectOwner = { ...personal, projectId: project, projectName: 'Example', projectShortUrl: project };
const cache = { items: [], next: null, scopeIndex: 0, offset: 0, cursor: '0',
  projectId: null, accountKey: 'acc1' };
const pending = () => ({ scopes: [personal, projectOwner], scopeIndex: 0,
  offset: 0, cursor: '0', pageIndex: 0, detected: 0, processed: 0,
  failures: 0, scopeFailures: 0, runStartedMs: Date.now(), cachedPage: cache });
const queue = { [id + ':' + messageId]: { conversationId: id, messageId, projectId: null,
  indexedSource: personal.sourceId, content: 'known captured message' } };
const receipts = { ['hstryTakeoverSource:' + id]: { status: 'completed', automatic: true,
  originalUrl: 'https://chatgpt.com/c/' + id, completedAt: Date.now() } };

const task = nextContinuationPriority(queue, receipts, { pending: pending() });
assert.deepEqual(task, { conversationId: id, sourceId: personal.sourceId,
  accountKey: personal.accountKey, projectId: null, kind: 'continuation' });
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), priorityDoneIds: [id] } }), null);
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), nativeDetail: { conversationId: id } } }), null);
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), lastPriorityProcessed: 0 } }), null);
assert.equal(nextContinuationPriority(queue, receipts, { pending: pending(),
  ignoredFailures: [{ conversationId: id, accountKey: personal.accountKey, projectId: null }] }),
  null, 'user exclusion must remain authoritative');
assert.equal(nextContinuationPriority({ ...queue, duplicate: {
  conversationId: id, projectId: null, indexedSource: 'other-source' } },
  receipts, { pending: pending() }), null, 'ambiguous ownership must fail closed');
assert.equal(nextContinuationPriority(queue,
  { ...receipts, ['hstryTakeoverSource:' + id]: { ...receipts['hstryTakeoverSource:' + id],
    originalUrl: 'https://evil.example/c/' + id } }, { pending: pending() }), null);

const previousFetch = globalThis.fetch;
const previousChrome = globalThis.chrome;
let mode = 'healthy';
let requests = [];
let ingests = [];
let confirmations = [];
let saved = [];
globalThis.chrome = { storage: { session: {
  get: async () => ({ hstryChatGPTAccessToken: { token: 'fixture',
    expiresAtMs: Date.now() + 3_600_000 } }),
} } };
const detail = cid => ({
  conversation_id: cid, title: 'Recovered', create_time: Date.now() / 1000 - 300,
  update_time: Date.now() / 1000 - 250,
  messages: [{ id: messageId, author: { role: 'user' }, create_time: Date.now() / 1000 - 250,
    content: { content_type: 'text', parts: ['known captured message'] } }],
  page_info: { has_previous_page: false, has_next_page: false },
});
globalThis.fetch = async (input) => {
  const url = new URL(input);
  requests.push(url.pathname);
  if (url.pathname === '/backend-api/conversations/' + id)
    return Response.json(detail(id));
  if (url.pathname === '/backend-api/gizmos/' + project + '/conversations')
    return Response.json({ items: [], cursor: null });
  if (url.pathname === '/backend-api/conversations/' + inaccessible) {
    if (mode === 'native-inaccessible')
      return Response.json({ detail: { code: 'conversation_inaccessible', can_retry: false } },
        { status: 404 });
    if (mode === 'native-rate-limit')
      return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    if (mode === 'native-empty')
      return Response.json({ ...detail(inaccessible), messages: [], project_id: project });
    if (mode === 'native-unidentified-empty')
      return Response.json({ ...detail(inaccessible), conversation_id: undefined,
        messages: [], project_id: project });
    if (mode === 'native-nonuser')
      return Response.json({ ...detail(inaccessible), project_id: project,
        messages: [{ id: messageId, author: { role: 'tool' },
          content: { content_type: 'text', parts: ['unrecognized data'] } }] });
    return Response.json({ ...detail(inaccessible), project_id: project });
  }
  throw new Error('Unexpected remote request: ' + url.pathname);
};
const run = (state, pendingLiveConversationIds = []) => syncChatGPT({
  state, pendingLiveConversationIds, push: async (_source, _adapter, convs) => {
  ingests.push(convs); return convs.length;
}, register: async () => {}, report: async () => {},
checkpoint: async next => saved.push(structuredClone(next)),
onCanonicalIngest: async confirmed => confirmations.push(confirmed) });

try {
  // A completed handoff is eligible even before the old 72-scope listing sees it.
  let state = { pending: { ...pending(), priority: task } };
  const result = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + id],
    'exactly one canonical remote request; no list rewind');
  assert.equal(ingests.length, 1);
  assert.equal(confirmations.length, 1);
  assert.equal(result.state.pending.priority, undefined);
  assert.deepEqual(result.state.pending.priorityDoneIds, [id]);
  assert.equal(result.state.pending.pageIndex, 0);
  assert.equal(result.state.pending.processed, 0);

  // Six duplicated terminal entries in personal/project scopes are one source
  // conversation. The existing native endpoint gets one bounded chance.
  requests = []; ingests = []; confirmations = []; saved = [];
  const failure = (owner) => ({ conversationId: inaccessible, projectId: owner.projectId,
    accountId: owner.accountId, accountKey: owner.accountKey, sourceId: owner.sourceId,
    errorType: 'HTTP 404', attempts: 1, lastFailedAtMs: Date.now() - 120_000,
    accessVerification: { code: 'conversation_inaccessible', canRetry: false },
    resolvedAtMs: null });
  state = { pending: pending(), failureDetails: [failure(projectOwner), failure(personal)] };
  const nativeFirst = nextNativeRecoveryPriority(state);
  assert.deepEqual(nativeFirst, { conversationId: inaccessible,
    sourceId: projectOwner.sourceId, accountKey: projectOwner.accountKey,
    projectId: project, kind: 'native-404' },
  'verified terminal 404 must outrank completed automatic handoff receipts');
  assert.deepEqual(nextContinuationPriority(queue, receipts, state), task,
    'the competing automatic handoff remains independently eligible');
  assert.equal(nextNativeRecoveryPriority({ ...state,
    pending: { ...pending(), lastPriorityProcessed: 0 } }), null,
  'three ordinary scan items must separate priorities');
  assert.equal(nextNativeRecoveryPriority({ ...state,
    ignoredFailures: [{ conversationId: inaccessible,
      accountKey: projectOwner.accountKey, projectId: project }] })?.projectId,
    null, 'ignored project must not be selected');
  assert.equal(nextNativeRecoveryPriority({ ...state,
    failureDetails: [ { ...failure(projectOwner), accessVerification: {
      code: 'conversation_inaccessible', canRetry: false, nativeCheckedAtMs: Date.now() } } ] }),
    null, 'already checked native terminal access must not be retried');
  const recovered = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 1);
  assert.equal(recovered.state.failureDetails.filter(f => !f.resolvedAtMs).length, 0,
    'canonical success resolves duplicates from the same account');
  assert.equal(recovered.state.pending.scopeIndex, 0, 'original scan still intact');

  // A second explicit 404 must not kill scheduled sync, erase provenance,
  // falsely mark success, or make duplicate requests in future runs.
  requests = []; ingests = []; confirmations = []; saved = [];
  mode = 'native-inaccessible';
  state = { pending: pending(), failureDetails: [failure(projectOwner), failure(personal)] };
  const unavailable = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 0);
  assert.equal(unavailable.hasMore, true);
  assert.equal(unavailable.state.pending.priority, undefined);
  assert.equal(unavailable.state.failureDetails.filter(f =>
    f.accessVerification?.nativeCheckedAtMs).length, 2);
  assert.equal(unavailable.state.failureDetails.filter(f => !f.resolvedAtMs).length, 2);
  requests = [];
  const next = await run(unavailable.state);
  assert.deepEqual(requests, ['/backend-api/gizmos/' + project + '/conversations'],
    'resume the normal scan, not another alternate GET');
  assert.equal(next.failures, 2);

  // A 429 on the alternative route yields to a normal scan after cooldown.
  requests = []; mode = 'native-rate-limit';
  state = { pending: pending(), failureDetails: [failure(projectOwner)] };
  const deferred = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(deferred.deferredHttpStatus, 429);
  assert.equal(deferred.state.pending.retryYieldToScan, true);
  requests = []; mode = 'healthy';
  await run(deferred.state);
  assert.deepEqual(requests, ['/backend-api/gizmos/' + project + '/conversations'],
    'retry cooldown must yield a scan turn, not immediately retry native detail');

  // Repeated legacy detail with no readable messages must switch to the
  // already-supported native endpoint on a future paced turn, not fetch twice.
  const unreadable = { ...failure(projectOwner), errorType: 'GenericError',
    errorDiagnostic: 'Conversation has no readable messages', attempts: 7,
    nextRetryAtMs: Date.now() - 1, accessVerification: null };
  state = { pending: pending(), failureDetails: [unreadable] };
  const nativeUnreadable = nextNativeRecoveryPriority(state);
  assert.deepEqual(nativeUnreadable, { conversationId: inaccessible,
    sourceId: projectOwner.sourceId, accountKey: projectOwner.accountKey,
    projectId: project, kind: 'native-fallback' });
  assert.equal(nextNativeRecoveryPriority({ ...state, failureDetails: [{ ...unreadable,
    nextRetryAtMs: Date.now() + 600_000 }] }), null, 'respect saved retry window');
  assert.equal(nextNativeRecoveryPriority({ ...state, failureDetails: [{ ...unreadable,
    errorDiagnostic: null, errorType: 'UnknownError', attempts: 6 }] })?.kind,
    'native-fallback', 'legacy UnknownError records also get one native check');
  assert.equal(nextNativeRecoveryPriority({ ...state, failureDetails: [{ ...unreadable,
    errorDiagnostic: null, errorType: 'UnknownError', attempts: 1 }] }), null,
  'a first unclassified failure does not trigger the fallback');
  assert.equal(nextNativeRecoveryPriority({ ...state,
    pending: { ...pending(), lastPriorityProcessed: 0 } }), null,
  'three normal scan items still separate native fallback attempts');
  assert.equal(nextNativeRecoveryPriority({ ...state, failureDetails: [{ ...unreadable,
    accessVerification: { nativeCheckedAtMs: Date.now() } }] }), null,
  'one native verification per missing history');
  requests = []; ingests = []; confirmations = []; mode = 'healthy';
  const nativeSuccess = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 1);
  assert.equal(confirmations.length, 1);
  assert(nativeSuccess.state.failureDetails[0].resolvedAtMs,
    'canonical native content resolves the missing history');
  assert.equal(nativeSuccess.state.pending.pageIndex, 0);

  // A rate-limited native fallback must yield one scan turn before retrying.
  requests = []; mode = 'native-rate-limit';
  const deferredFallback = await run({ pending: pending(), failureDetails: [unreadable] });
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(deferredFallback.deferredHttpStatus, 429);
  assert.equal(deferredFallback.state.pending.priority?.kind, 'native-fallback');
  assert.equal(deferredFallback.state.pending.retryYieldToScan, true);
  requests = []; mode = 'healthy';
  const afterFallback429 = await run(deferredFallback.state);
  assert.deepEqual(requests, ['/backend-api/gizmos/' + project + '/conversations'],
    'a native-fallback 429 must yield to the scan instead of immediately retrying');
  assert.equal(afterFallback429.state.pending.priority?.kind, 'native-fallback',
    'a scan turn must retain the recoverable priority and cursor');

  // A complete native 200 with zero server messages is an empty chat shell,
  // not lost history. It must not be permanently ignored or called recovered.
  requests = []; ingests = []; mode = 'native-empty';
  const nativeEmpty = await run({ pending: pending(), failureDetails: [unreadable] });
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 0);
  assert.equal(nativeEmpty.state.failureDetails[0].resolution, 'empty-shell');
  assert(nativeEmpty.state.failureDetails[0].resolvedAtMs);
  assert.equal(nativeEmpty.state.failureDetails[0].recoveredVia, undefined);
  assert.equal(nativeEmpty.state.ignoredFailures?.length ?? 0, 0);
  assert.equal(nativeEmpty.failures, 0);
  requests = []; mode = 'healthy';
  await run(nativeEmpty.state);
  assert.deepEqual(requests, ['/backend-api/gizmos/' + project + '/conversations'],
    'no repeated native GET after a verified empty result');

  // A first message arriving later makes the former empty shell a real chat.
  requests = []; ingests = [];
  const populatedAfterEmpty = await run({ pending: { ...pending(), priority: {
    conversationId: inaccessible, sourceId: projectOwner.sourceId,
    accountKey: projectOwner.accountKey, projectId: project, kind: 'continuation' } },
  failureDetails: nativeEmpty.state.failureDetails });
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 1);
  assert.equal(populatedAfterEmpty.state.failureDetails[0].resolution, undefined,
    'a newly populated chat must no longer display the empty-shell label');

  // Unconfirmed browser captures prevent an empty native route from erasing
  // the evidence of a newly populated chat in another project or session.
  requests = []; ingests = []; mode = 'native-empty';
  const hasLiveMessages = await run({ pending: pending(),
    failureDetails: [unreadable] }, [inaccessible]);
  assert.equal(hasLiveMessages.state.failureDetails[0].resolvedAtMs, null);
  assert.equal(hasLiveMessages.state.failureDetails[0].resolution, undefined);
  assert.equal(ingests.length, 0);

  // No matched conversation identity is not proof of a real empty chat.
  requests = []; mode = 'native-unidentified-empty';
  const unidentified = await run({ pending: pending(), failureDetails: [unreadable] });
  assert.equal(unidentified.state.failureDetails[0].resolvedAtMs, null);
  assert.equal(unidentified.state.failureDetails[0].resolution, undefined);

  // Non-user payloads are not proof of an empty server response.
  requests = []; ingests = []; mode = 'native-nonuser';
  const unsupported = await run({ pending: pending(), failureDetails: [unreadable] });
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(ingests.length, 0);
  assert.equal(unsupported.state.failureDetails[0].resolvedAtMs, null);
  assert.equal(unsupported.state.failureDetails[0].resolution, undefined);
  assert.equal(unsupported.state.failureDetails[0].accessVerification.nativeStatus, 200);
  requests = []; mode = 'healthy';
  await run(unsupported.state);
  assert.deepEqual(requests, ['/backend-api/gizmos/' + project + '/conversations'],
    'unreadable nonempty content stays unresolved without repeated native GET');

  requests = []; mode = 'native-inaccessible';
  const native404 = await run({ pending: pending(), failureDetails: [unreadable] });
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(native404.state.failureDetails[0].resolvedAtMs, null);
  assert.equal(native404.state.failureDetails[0].accessVerification.nativeStatus, 404);

  console.log('PASS native recovery of unreadable legacy history, bounded empty/404 verification, original fairness and rate limit');
} finally {
  globalThis.fetch = previousFetch;
  globalThis.chrome = previousChrome;
}
