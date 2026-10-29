import assert from 'node:assert/strict';
import { fetchJson } from '../lib/common.js';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const accountId = 'acc-workspace';
const sourceId = 'chatgpt-web-test';
const scope = {
  accountId, accountKey: 'workspace', sourceId, projectId,
  projectName: 'Fixture', projectShortUrl: projectId + '-fixture',
};
const oldSeconds = Math.floor((Date.now() - 3_600_000) / 1000);
const items = ['ignored', 'inaccessible', 'healthy'].map(id => ({
  id, gizmo_id: projectId, update_time: oldSeconds,
}));
const originalFetch = globalThis.fetch;
const calls = [];
let responseMode = 'all-healthy';
const parsed = [];
const detail = id => ({
  title: id, create_time: oldSeconds, update_time: oldSeconds,
  current_node: 'm1', mapping: { m1: { id: 'm1', parent: null, message: {
    author: { role: 'user' }, create_time: oldSeconds,
    content: { content_type: 'text', parts: [id] },
  } } },
});

globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.pathname === '/api/auth/session')
    return Response.json({ accessToken: 'fixture-token' });
  if (url.pathname === '/backend-api/gizmos/' + projectId + '/conversations')
    return Response.json({ items, cursor: null });
  if (url.pathname.startsWith('/backend-api/conversation/')) {
    const id = url.pathname.split('/').at(-1);
    calls.push(id);
    if (id === 'ordinary-404') return new Response('', { status: 404 });
    if (id === 'inaccessible' && responseMode === 'inaccessible-404')
      return Response.json({ detail: {
        code: 'conversation_inaccessible', can_retry: false,
      } }, { status: 404 });
    if (id !== 'healthy' && responseMode === 'all-healthy')
      throw new Error('Excluded or terminal conversation was fetched: ' + id);
    return Response.json(detail(id));
  }
  throw new Error('Unexpected fetch: ' + url.pathname);
};

const pending = () => ({
  scopes: [scope], scopeIndex: 0, pageIndex: 0, offset: 0, cursor: '0',
  scopeFailures: 0, failures: 0, detected: 0, processed: 0,
  runStartedMs: Date.now(),
});
const run = state => syncChatGPT({
  state, register: async () => {}, checkpoint: async () => {},
  report: async () => {}, log: () => {},
  push: async (_source, _adapter, conversations) => {
    parsed.push(conversations[0].externalId);
    return 1;
  },
});

try {
  // Error metadata is read from the same 404 response: no extra network request.
  responseMode = 'inaccessible-404';
  await assert.rejects(
    fetchJson('https://chatgpt.com/backend-api/conversation/inaccessible', {}, { retries: 0 }),
    error => error.status === 404 && error.code === 'conversation_inaccessible' &&
      error.canRetry === false,
  );
  assert.deepEqual(calls, ['inaccessible']);
  calls.length = 0;

  // Migrated historical access failures must never consume a due retry.
  responseMode = 'all-healthy';
  const knownFailure = {
    conversationId: 'inaccessible', projectId, accountKey: scope.accountKey,
    sourceId, accountId, resolvedAtMs: null, errorType: 'HTTP 404',
    lastFailedAtMs: 1, nextRetryAtMs: 1, attempts: 4,
    accessVerification: { code: 'conversation_inaccessible', canRetry: false },
  };
  const excluded = {
    conversationId: 'ignored', projectId, accountKey: scope.accountKey,
    sourceId, accountId, ignoredReason: 'user deleted project',
  };
  let sync = await run({
    pending: pending(), failureDetails: [knownFailure], ignoredFailures: [excluded],
  });
  for (let i = 0; sync.hasMore && i < 8; i++) sync = await run(sync.state);
  assert.equal(sync.hasMore, false);
  assert.deepEqual(calls, ['healthy'], 'only the accessible conversation is fetched');
  assert.deepEqual(parsed, ['healthy']);
  assert.equal(sync.failures, 1, 'inaccessible history remains explicitly unresolved');
  assert.equal(sync.state.failureDetails[0].nextRetryAtMs, undefined,
    'stale retry timers are removed for non-retryable records');
  assert.equal(sync.state.ignoredFailures[0].conversationId, 'ignored',
    'explicit exclusions survive normal sync checkpoint transitions');

  // A new non-retryable response is persisted and does not block the next chat.
  calls.length = 0;
  parsed.length = 0;
  responseMode = 'inaccessible-404';
  const fresh = await run({ pending: pending(), ignoredFailures: [excluded] });
  assert.deepEqual(calls, ['inaccessible']);
  const failure = fresh.state.failureDetails.find(f => f.conversationId === 'inaccessible');
  assert.equal(failure.errorType, 'HTTP 404');
  assert.equal(failure.accessVerification.code, 'conversation_inaccessible');
  assert.equal(failure.accessVerification.canRetry, false);
  assert.equal(failure.nextRetryAtMs, undefined);
  calls.length = 0;
  let resumed = await run(fresh.state);
  for (let i = 0; resumed.hasMore && i < 8; i++) resumed = await run(resumed.state);
  assert.deepEqual(calls, ['healthy'], 'subsequent scan skips terminal inaccessible detail');
  assert.equal(resumed.failures, 1);
  assert.deepEqual(parsed, ['healthy']);

  // An ordinary 404 without explicit can_retry=false remains retryable.
  await assert.rejects(
    fetchJson('https://chatgpt.com/backend-api/conversation/ordinary-404', {}, { retries: 0 }),
    error => error.status === 404 && error.canRetry !== false,
  );
  console.log('PASS inaccessible 404 metadata, terminal retry suppression, user exclusion, healthy import and retryable 404');
} finally {
  globalThis.fetch = originalFetch;
}
