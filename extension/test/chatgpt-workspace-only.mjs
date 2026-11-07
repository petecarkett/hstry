import assert from 'node:assert/strict';
import { syncChatGPT, workspaceOnlyChatGPTState } from '../providers/chatgpt.js';

const workspace = { accountId: 'acc-workspace', accountKey: 'work',
  accountName: 'Pete Workspace', sourceId: 'chatgpt-web-work' };
const personal = { accountId: 'acc-personal', accountKey: 'free',
  accountName: 'free', sourceId: 'chatgpt-web' };
const scope = (owner, projectId = null, archived = false) =>
  ({ ...owner, projectId, archived });
const scopes = [
  ...Array.from({ length: 34 }, (_, i) => scope(workspace, 'p-' + i)),
  ...Array.from({ length: 34 }, (_, i) => scope(personal, 'p-' + i)),
  scope(workspace), scope(workspace, null, true),
  scope(personal), scope(personal, null, true),
];
const initial = {
  accounts: { work: { projects: { 'p-0': { lastSyncMs: 123 } } },
    free: { projects: {} } },
  sourceRoutes: scopes,
  failureDetails: [
    { accountKey: 'work', sourceId: workspace.sourceId, resolvedAtMs: null },
    { accountKey: 'free', sourceId: personal.sourceId, resolvedAtMs: null },
  ],
  pending: { scopes, scopeIndex: 34, offset: 0, cursor: '0',
    pageIndex: 2, scopeFailures: 0, scopeTrackedFailures: 0,
    processed: 3380, detected: 3380, failures: 70,
    personalResume: { index: 68, offset: 2200, cursor: 2200,
      pageIndex: 2, scopeFailures: 67, scopeTrackedFailures: 18 },
    priority: { kind: 'native-fallback', sourceId: personal.sourceId },
    cachedPage: { scopeIndex: 34, accountKey: personal.accountKey, items: [] },
  },
};
const original = JSON.stringify(initial);
const filtered = workspaceOnlyChatGPTState(initial);
assert.equal(JSON.stringify(initial), original, 'migration does not mutate original checkpoint');
assert.equal(filtered.pending.scopes.length, 36, 'personal project and personal list scopes are removed');
assert(filtered.pending.scopes.every(s => s.sourceId === workspace.sourceId));
assert.equal(filtered.pending.scopeIndex, 34, 'completed workspace projects remain completed');
assert.equal(filtered.pending.personalResume.index, 34, 'saved personal-first workspace scope maps to new index');
assert.equal(filtered.pending.personalResume.offset, 2200, 'workspace cursor survives');
assert.equal(filtered.pending.personalResume.pageIndex, 2);
assert.equal(filtered.pending.personalResume.scopeFailures, 67);
assert.equal(filtered.pending.personalResume.scopeTrackedFailures, 18);
assert.equal(filtered.pending.processed, 3380);
assert.equal(filtered.pending.priority, undefined, 'personal recovery is dropped');
assert.equal(filtered.pending.cachedPage, undefined, 'personal cached page is dropped');
assert.deepEqual(Object.keys(filtered.accounts), ['work']);
assert.equal(filtered.failureDetails.length, 1);
assert.equal(filtered.failureDetails[0].sourceId, workspace.sourceId);
assert.strictEqual(workspaceOnlyChatGPTState(filtered), filtered, 'already filtered state is stable');
assert.throws(() => workspaceOnlyChatGPTState({ pending: {
  scopes: [scope(personal)], scopeIndex: 0 } }), /no workspace scopes/);

const discovery = workspaceOnlyChatGPTState({ discovery: {
  accounts: [{ id: personal.accountId, isWorkspace: false },
    { id: workspace.accountId, isWorkspace: true }],
  accountIndex: 0, scopes: [scope(personal)],
  cursor: 'free-cursor', pageCount: 2, seenCursors: ['free-cursor'],
} });
assert.deepEqual(discovery.discovery.accounts.map(x => x.id), [workspace.accountId]);
assert.equal(discovery.discovery.accountIndex, 0);
assert.equal(discovery.discovery.cursor, null, 'excluded discovery cannot reuse personal cursor');
assert.deepEqual(discovery.discovery.scopes, []);

const originalFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  requested.push({ path: u.pathname, account: init.headers?.['chatgpt-account-id'] ?? null,
    offset: u.searchParams.get('offset') });
  if (u.pathname === '/api/auth/session')
    return Response.json({ accessToken: 'fixture' });
  if (u.pathname.includes('/accounts/check/'))
    return Response.json({ accounts: {
      personal: { account: { account_id: personal.accountId, structure: 'personal' } },
      workspace: { account: { account_id: workspace.accountId, structure: 'workspace' } },
    } });
  assert.equal(init.headers?.['chatgpt-account-id'], workspace.accountId,
    'no personal remote inventory or conversation request is allowed');
  if (u.pathname === '/backend-api/gizmos/snorlax/sidebar')
    return Response.json({ items: [], cursor: null });
  if (u.pathname === '/backend-api/conversations')
    return Response.json({ items: [], total: 0 });
  throw new Error('Unexpected request ' + u.pathname);
};
try {
  const resumedCheckpoints = [];
  let resumedState = initial;
  let resumed;
  for (let run = 0; run < 8; run++) {
    resumed = await syncChatGPT({
      state: resumedState, workspaceOnly: true, push: async () => 0,
      checkpoint: async next => {
        if (next.pending?.scopeIndex === 34 && next.pending.offset === 2200) {
          resumedCheckpoints.push(next.pending.scopeFailures);
        }
      },
    });
    resumedState = resumed.state;
    if (!resumed.hasMore) break;
  }
  assert.equal(resumed.hasMore, false, 'workspace resume finishes without personal scopes');
  assert(requested.some(x => x.path === '/backend-api/conversations' &&
    x.account === workspace.accountId && x.offset === '2200'),
    'the saved workspace backlog resumes at its original offset');
  assert(resumedCheckpoints.includes(67), 'workspace failure counter survives resumption');

  const sources = [];
  const result = await syncChatGPT({
    state: {}, workspaceOnly: true,
    push: async () => 0,
    register: async source => sources.push(source),
  });
  assert.equal(result.hasMore, false);
  assert(sources.length > 0 && sources.every(s => s.startsWith('chatgpt-web-')),
    'only registered workspace sources are allowed');
  assert.equal(requested.filter(x => x.account === personal.accountId).length, 0);
  assert.equal(Object.keys(result.state.accounts).length, 1);
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/auth/session')
      return Response.json({ accessToken: 'fixture' });
    if (u.pathname.includes('/accounts/check/'))
      return Response.json({ accounts: {
        personal: { account: { account_id: personal.accountId, structure: 'personal' } },
      } });
    throw new Error('Unexpected personal-only scan request');
  };
  await assert.rejects(syncChatGPT({
    state: {}, workspaceOnly: true, push: async () => 0,
  }), /no workspace is accessible/, 'personal-only login fails closed');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('PASS workspace-only scan: personal scopes excluded, workspace cursor retained, no personal API scans');
