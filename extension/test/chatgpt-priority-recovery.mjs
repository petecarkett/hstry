import assert from 'node:assert/strict';
import { syncChatGPT, nextNativeRecoveryPriority } from '../providers/chatgpt.js';
import { nextContinuationPriority, recheckManualReview } from '../lib/live-capture.js';

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
const ordinary = nextContinuationPriority(queue, {}, { pending: pending() });
assert.deepEqual(ordinary, task,
  'indexed ordinary live captures must receive one canonical paced recovery');
assert.equal(nextContinuationPriority({ [id + ':' + messageId]: {
  ...queue[id + ':' + messageId], indexedSource: undefined,
} }, {}, { pending: pending() }), null,
'captures without verified indexed source must not be targeted');
assert.deepEqual(nextContinuationPriority({ [id + ':' + messageId]: {
  ...queue[id + ':' + messageId], projectId: project,
} }, {}, { pending: pending() }), {
  conversationId: id, sourceId: personal.sourceId, accountKey: personal.accountKey,
  projectId: project, kind: 'continuation',
}, 'a project capture requires an exact matching project-scoped owner');
assert.equal(nextContinuationPriority({ [id + ':' + messageId]: {
  ...queue[id + ':' + messageId], indexedSource: 'chatgpt-web-other-account',
} }, {}, { pending: pending() }), null,
'unknown account/source must fail closed');
assert.equal(nextContinuationPriority(queue, {}, { pending: { ...pending(), scopes: [
  { ...personal, accountId: 'account-2', accountKey: 'acc2' }, personal,
] } }), null, 'same source/project shared across two accounts is ambiguous');
assert.equal(nextContinuationPriority(queue, {}, { pending: {
  ...pending(), scopes: [{ ...personal, archived: true }],
} }), null, 'archived-only scope must not route an ordinary live capture');
assert.equal(nextContinuationPriority(queue, {}, { pending: {
  ...pending(), retryYieldToScan: true,
} }), null, 'rate-limit scan turn must take precedence over queued live recovery');
assert.equal(nextContinuationPriority(queue, {}, { pending: {
  ...pending(), lastPriorityProcessed: 0,
} }), null, 'ordinary scan must advance between priority recoveries');
assert.equal(nextContinuationPriority({ ...queue, conflictingProject: {
  conversationId: id, projectId: project, indexedSource: personal.sourceId,
} }, {}, { pending: pending() }), null,
'conflicting project ownership for one native chat must fail closed');
assert.equal(nextContinuationPriority(queue, {}, { pending: pending(),
  ignoredFailures: [{ conversationId: id, accountKey: personal.accountKey,
    projectId: null }] }), null,
'ignored histories remain excluded even from ordinary live recovery');
const manyCaptures = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
  `capture-${i}`, { ...queue[id + ':' + messageId], messageId: String(i) },
]));
assert.deepEqual(nextContinuationPriority(manyCaptures, {}, { pending: pending() }), task,
'30 message captures from the same conversation create only one priority request');
const legacyDefaultScope = { ...personal, accountId: null, accountKey: 'default',
  sourceId: 'chatgpt-web' };
const defaultQueue = { [id + ':' + messageId]: {
  ...queue[id + ':' + messageId], indexedSource: 'chatgpt-web',
} };
assert.deepEqual(nextContinuationPriority(defaultQueue, receipts, {
  pending: { ...pending(), scopes: [legacyDefaultScope] },
}), { ...task, sourceId: 'chatgpt-web', accountKey: 'default' },
'completed handoff in a legacy default account must still work');
assert.equal(nextContinuationPriority(defaultQueue, {}, {
  pending: { ...pending(), scopes: [legacyDefaultScope] },
}), null, 'ordinary fallback requires verified account identity');
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), priorityDoneIds: [id] } }), null);
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), nativeDetail: { conversationId: id } } }), null);
assert.equal(nextContinuationPriority(queue, receipts,
  { pending: { ...pending(), lastPriorityProcessed: 0 } }), null);
assert.equal(nextContinuationPriority(queue, receipts, { pending: pending(),
  ignoredFailures: [{ conversationId: id, accountKey: personal.accountKey, projectId: null }] }),
  null, 'user exclusion must remain authoritative');
assert.equal(nextContinuationPriority(queue, receipts, { pending: pending(),
  failureDetails: [{ conversationId: id, accountKey: personal.accountKey, projectId: null,
    resolvedAtMs: null, accessVerification: { code: 'conversation_deleted', canRetry: false } }] }),
  null, 'deleted conversation must not regenerate a continuation task');
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
    if (mode === 'native-generic-404')
      return Response.json({ detail: 'Not found' }, { status: 404 });
    if (mode === 'native-timeout')
      throw Object.assign(new Error('transient timeout'), { name: 'TimeoutError' });
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

  // An ordinary captured chat uses the existing native route, not a new
  // importer or a separate mutable recovery queue.
  requests = []; ingests = []; confirmations = []; saved = [];
  state = { pending: { ...pending(), priority: ordinary } };
  const ordinaryRecovered = await run(state);
  assert.deepEqual(requests, ['/backend-api/conversations/' + id],
    'one paced remote request for an ordinary captured conversation');
  assert.equal(ingests.length, 1);
  assert.equal(confirmations.length, 1);
  assert.equal(ordinaryRecovered.state.pending.priority, undefined);
  assert.deepEqual(ordinaryRecovered.state.pending.priorityDoneIds, [id]);
  assert.equal(ordinaryRecovered.state.pending.pageIndex, 0);
  assert.equal(ordinaryRecovered.state.pending.processed, 0);

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
  const deletedFailure = { ...failure(projectOwner), accessVerification: {
    code: 'conversation_deleted', canRetry: false } };
  assert.deepEqual(nextNativeRecoveryPriority({ pending: pending(), failureDetails: [deletedFailure] }),
    nativeFirst, 'deleted conversation gets one canonical alternate-endpoint verification');
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

  // A cooling user continuation must not lock out eleven due recovery cases.
  // Its exact source, owner, attempt count and cooldown stay in the canonical
  // checkpoint while an independent native-fallback uses the single active slot.
  requests = []; ingests = []; confirmations = [];
  mode = 'healthy';
  const future = Date.now() + 3_600_000;
  const parked = { conversationId: inaccessible, sourceId: personal.sourceId,
    accountKey: personal.accountKey, projectId: null, kind: 'continuation',
    attempts: 9, nextRetryAtMs: future };
  const due = { conversationId: id, sourceId: personal.sourceId,
    accountKey: personal.accountKey, accountId: personal.accountId,
    projectId: null, errorType: 'TimeoutError', attempts: 8,
    lastFailedAtMs: Date.now() - 7_200_000,
    nextRetryAtMs: Date.now() - 1, resolvedAtMs: null };
  const earlierDueSameChat = { ...due, conversationId: inaccessible,
    errorType: 'HTTP 404', attempts: 9,
    nextRetryAtMs: Date.now() - 60_000 };
  const coolingState = { pending: { ...pending(), processed: 6,
    lastPriorityProcessed: 2, priority: parked },
    failureDetails: [earlierDueSameChat, due] };
  const recoveredOther = await run(coolingState);
  assert.deepEqual(requests, ['/backend-api/conversations/' + id],
    'cooling continuation must not starve a different due native recovery');
  assert.equal(ingests.length, 1);
  assert.equal(recoveredOther.state.pending.priority, undefined);
  assert.deepEqual(recoveredOther.state.pending.parkedPriority, parked,
    'the cooling continuation survives unchanged in the same checkpoint');
  assert(recoveredOther.state.failureDetails.find(f => f.conversationId === id).resolvedAtMs);
  assert(!recoveredOther.state.failureDetails.find(f =>
    f.conversationId === inaccessible).resolvedAtMs);
  assert.equal(nextContinuationPriority(queue, receipts, recoveredOther.state), null,
    'saved live capture must not reissue the parked continuation');
  assert.equal(nextNativeRecoveryPriority({ ...coolingState,
    pending: { ...pending(), processed: 6, lastPriorityProcessed: 2,
      parkedPriority: parked } })?.conversationId, id,
    'parked chat with earlier failure due time must not bypass its own cooldown');

  // Finishing the last list scope cannot erase a cooling recovery checkpoint.
  requests = [];
  const finishedScan = structuredClone(recoveredOther.state);
  finishedScan.pending.scopeIndex = finishedScan.pending.scopes.length;
  const stillCooling = await run(finishedScan);
  assert.equal(stillCooling.hasMore, true);
  assert.deepEqual(stillCooling.state.pending.parkedPriority, parked);
  assert.equal(requests.length, 0);
  requests = []; ingests = []; confirmations = [];
  const nowDue = structuredClone(stillCooling.state);
  nowDue.pending.parkedPriority.nextRetryAtMs = Date.now() - 1;
  const resumedContinuation = await run(nowDue);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible],
    'when due, resume the same continuation without losing its identity');
  assert.equal(resumedContinuation.state.pending.priority, undefined);
  assert.equal(resumedContinuation.state.pending.parkedPriority, undefined);
  assert.deepEqual(resumedContinuation.state.pending.priorityDoneIds, [inaccessible]);
  assert.equal(ingests.length, 1);

  // An old parked continuation is retired for a matching terminal 404.
  // The existing once-only native recovery path remains available.
  requests = []; ingests = []; confirmations = [];
  mode = 'native-inaccessible';
  const terminalParked = { ...parked, sourceId: projectOwner.sourceId,
    accountKey: projectOwner.accountKey, projectId: project };
  const terminalFailure = { ...failure(projectOwner),
    nextRetryAtMs: Date.now() + 3_600_000,
    accessVerification: { code: 'conversation_deleted', canRetry: false } };
  const retired = await run({ pending: { ...pending(), parkedPriority: terminalParked },
    failureDetails: [terminalFailure] });
  assert.equal(retired.state.pending.parkedPriority, undefined);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  assert.equal(retired.state.failureDetails[0].accessVerification.nativeStatus, 404);
  assert.equal(retired.state.failureDetails[0].nextRetryAtMs, undefined);
  assert.equal(retired.state.failureDetails[0].resolvedAtMs, null);
  mode = 'healthy';

  // A full diagnostic store cannot erase 18 failed recovery attempts or
  // keep retrying an explicitly terminal captured chat indefinitely.
  requests = []; ingests = []; mode = 'native-inaccessible';
  const staleResolved = Array.from({ length: 99 }, (_, i) => ({
    ...failure(personal), conversationId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    resolvedAtMs: Date.now() - 60_000,
  }));
  const unrelatedUnresolved = { ...failure(personal), conversationId: id,
    accessVerification: undefined };
  const saturated = { pending: { ...pending(), scopeIndex: 2,
    parkedPriority: { ...parked, attempts: 18, nextRetryAtMs: Date.now() - 1 },
    untrackedFailures: 18 },
    failureDetails: [unrelatedUnresolved, ...staleResolved] };
  const terminalRecorded = await run(saturated);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  const finalFailure = terminalRecorded.state.failureDetails.find(x =>
    x.conversationId === inaccessible && x.projectId === null && !x.resolvedAtMs);
  assert.equal(finalFailure?.accessVerification?.code, 'conversation_inaccessible',
    'evict a resolved diagnostic and retain the exact verified terminal failure');
  assert.equal(finalFailure?.accessVerification?.canRetry, false);
  assert.equal(terminalRecorded.state.pending?.parkedPriority, undefined);
  assert.equal(terminalRecorded.state.pending?.priority, undefined);
  assert.equal(terminalRecorded.state.failureDetails.length, 100);
  assert.equal(terminalRecorded.state.pending?.untrackedFailures, 18,
    'never silently treat old untracked observations as recovered');
  assert.equal(nextContinuationPriority({ qa: { conversationId: inaccessible,
    messageId, projectId: null, indexedSource: personal.sourceId } }, {},
    { ...terminalRecorded.state, pending: pending() }), null,
  'verified terminal failure cannot regenerate an ordinary capture priority');

  // An old count of timeouts cannot count as twelve proven HTTP 404s.
  requests = []; ingests = []; mode = 'native-generic-404';
  const historical = { ...parked, attempts: 19, nextRetryAtMs: Date.now() - 1 };
  let candidate = await run({ pending: { ...pending(), scopeIndex: 2,
    parkedPriority: historical }, failureDetails: [] });
  assert.equal(candidate.state.pending.priority?.generic404Streak, 1,
    'one new 404 is not proof of repeated inaccessibility');
  assert.equal(candidate.state.failureDetails[0]?.manualReviewPending, undefined);
  candidate.state.pending.priority.nextRetryAtMs = Date.now() - 1;
  mode = 'native-timeout';
  candidate = await run(candidate.state);
  assert.equal(candidate.state.pending.priority?.generic404Streak, 0,
    'a transient timeout breaks consecutive 404 evidence');
  candidate.state.pending.priority.nextRetryAtMs = Date.now() - 1;
  mode = 'native-generic-404';
  candidate = await run(candidate.state);
  assert.equal(candidate.state.pending.priority?.generic404Streak, 1);
  candidate.state.pending.priority.nextRetryAtMs = Date.now() - 1;
  candidate = await run(candidate.state);
  assert.equal(candidate.state.pending.priority?.generic404Streak, 2);
  candidate.state.pending.priority.nextRetryAtMs = Date.now() - 1;
  candidate = await run(candidate.state);
  assert.equal(candidate.state.failureDetails[0]?.manualReviewPending, true,
    'three consecutive 404 responses queue manual review without deleting history');

  // Unknown 404 remains unresolved; after a bounded number of attempts it
  // must enter manual review, not become a fabricated deletion or repeat forever.
  requests = []; ingests = []; mode = 'native-generic-404';
  const genericParked = { ...parked, attempts: 19, generic404Streak: 2,
    nextRetryAtMs: Date.now() - 1 };
  const reviewState = { pending: { ...pending(), scopeIndex: 2,
    parkedPriority: genericParked }, failureDetails: [] };
  const manual = await run(reviewState);
  assert.deepEqual(requests, ['/backend-api/conversations/' + inaccessible]);
  const reviewFailure = manual.state.failureDetails.find(x =>
    x.conversationId === inaccessible && x.projectId === null && !x.resolvedAtMs);
  assert.equal(reviewFailure?.manualReviewPending, true);
  assert.equal(reviewFailure?.accessVerification?.canRetry, undefined,
    'generic 404 must not be labelled a confirmed terminal deletion');
  assert.equal(manual.state.pending?.parkedPriority, undefined);
  assert.equal(manual.state.pending?.priority, undefined);
  assert.equal(nextNativeRecoveryPriority({ ...manual.state, pending: pending() }), null);
  const identity = { conversationId: inaccessible, sourceId: personal.sourceId,
    accountKey: personal.accountKey, projectId: null };
  assert.equal(recheckManualReview(manual.state,
    { ...identity, accountKey: 'other' }), null,
    'recheck is limited to the precise stored source/account/project');
  assert.equal(recheckManualReview(manual.state,
    { ...identity, projectId: project }), null);
  assert.equal(recheckManualReview(manual.state,
    { ...identity, conversationId: 'not-a-uuid' }), null);
  assert.equal(recheckManualReview({ ...manual.state, failureDetails: [
    ...manual.state.failureDetails, { ...manual.state.failureDetails[0],
      accessVerification: { code: 'conversation_deleted', canRetry: false } } ] },
    identity), null, 'explicitly terminal evidence cannot be requeued');
  const duplicated = recheckManualReview({ ...manual.state, failureDetails: [
    ...manual.state.failureDetails, { ...manual.state.failureDetails[0] } ] }, identity);
  assert(duplicated && duplicated.failureDetails.every(f => !f.manualReviewPending),
    'one explicit recheck resumes all records for the exact scoped history');
  const renewed = recheckManualReview(manual.state, identity);
  assert(renewed && renewed !== manual.state);
  assert.equal(renewed.failureDetails[0].manualReviewPending, undefined,
    'user recheck returns the same unresolved evidence to the normal queue');
  assert.equal(manual.state.failureDetails[0].manualReviewPending, true,
    'a recheck must not mutate the original persisted object');
  assert.equal(nextContinuationPriority({ qa: { conversationId: inaccessible,
    messageId, projectId: null, indexedSource: personal.sourceId } }, {},
    { ...renewed, pending: pending() })?.conversationId, inaccessible,
    'ordinary recovery can proceed after a narrowly authorised recheck');
  assert.equal(nextContinuationPriority({ qa: { conversationId: inaccessible,
    messageId, projectId: null, indexedSource: personal.sourceId } }, {},
    { ...manual.state, pending: pending() }), null,
    'manual review keeps captured content without recreating the blocked task');
  // If every diagnostic is still unresolved, preserve all 100 records and
  // the original retry instead of silently losing the new untracked failure.
  requests = []; mode = 'native-generic-404';
  const noSpace = { pending: { ...pending(), scopeIndex: 2,
    parkedPriority: genericParked },
    failureDetails: [unrelatedUnresolved, ...staleResolved.map(f => ({
      ...f, resolvedAtMs: null }))] };
  const blocked = await run(noSpace);
  assert.equal(blocked.state.failureDetails.length, 100);
  assert.equal(blocked.state.pending?.untrackedFailures, 1);
  assert.equal(blocked.state.pending?.priority?.conversationId, inaccessible,
    'do not retire a history until its unresolved failure can be retained');
  assert(blocked.state.pending.priority.nextRetryAtMs > Date.now());
  mode = 'healthy';

  // A staged partial native response cannot be discarded when its worker
  // backoff outlasts the ordinary scan, nor retried through the old endpoint.
  requests = []; ingests = [];
  const stagedCooling = structuredClone(finishedScan);
  delete stagedCooling.pending.parkedPriority;
  stagedCooling.pending.priority = { ...parked,
    stage: { conversationId: inaccessible, pages: 1, complete: false,
      before: messageId, messages: [], seenCursors: [messageId] } };
  stagedCooling.failureDetails = [earlierDueSameChat];
  const savedPartial = await run(stagedCooling);
  assert.equal(requests.length, 0,
    'do not invoke legacy GET while a staged native priority is cooling');
  assert.equal(savedPartial.hasMore, true,
    'unfinished native history must survive an otherwise completed scan');
  assert.deepEqual(savedPartial.state.pending?.priority, stagedCooling.pending.priority,
    'the complete staged page and original deadline must remain intact');

  console.log('PASS native recovery of unreadable legacy history, bounded empty/404 verification, original fairness and rate limit');
} finally {
  globalThis.fetch = previousFetch;
  globalThis.chrome = previousChrome;
}
