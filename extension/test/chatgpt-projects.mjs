import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const A = 'g-p-6818bc97551c8191865a07d09f7b3678';
const B = 'g-p-6828bc97551c8191865a07d09f7b3678';
const old = Math.floor(Date.now() / 1000) - 3600;
const scopeId = 'acc-workspace';
const allA = Array.from({ length: 10 }, (_, index) => ({
  id: `project-a-${index}`,
  update_time: old - index,
  gizmo_id: A,
}));
let sidebarCalls = 0;
const fetchPaths = [];
const originalFetch = globalThis.fetch;
const detail = id => ({
  title: id, update_time: old, create_time: old, current_node: 'm',
  gizmo_id: id.startsWith('project-a') ? A : id.startsWith('project-b') ? B : null,
  mapping: {
    m: { parent: null, id: 'm', message: {
      author: { role: 'user' }, create_time: old,
      content: { content_type: 'text', parts: ['A previous conversation, not a fabricated project'] },
    } },
  },
});
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  fetchPaths.push(u.pathname);
  if (u.pathname === '/api/auth/session') return Response.json({ accessToken: 'fixture' });
  if (u.pathname.includes('/accounts/check/')) return Response.json({
    accounts: { one: { account: { account_id: scopeId, structure: 'workspace' } } },
  });
  if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') {
    sidebarCalls++;
    const project = id => ({ gizmo: { gizmo: {
      id, display: { name: id === A ? '1hood' : 'Second project' },
      short_url: `${id}-${id === A ? '1hood' : 'second-project'}`,
    } } });
    return u.searchParams.get('cursor') === 'NEXT'
      ? Response.json({ items: [project(B)], cursor: null })
      : Response.json({ items: [project(A)], cursor: 'NEXT' });
  }
  if (u.pathname === '/backend-api/conversations') {
    return Response.json({ items: [{ id: 'personal-one', update_time: old }], total: 1 });
  }
  if (u.pathname === `/backend-api/gizmos/${A}/conversations`) {
    return u.searchParams.get('cursor') === 'MORE'
      ? Response.json({ items: allA.slice(7), cursor: null })
      : Response.json({ items: allA.slice(0, 7), cursor: 'MORE' });
  }
  if (u.pathname === `/backend-api/gizmos/${B}/conversations`) {
    return Response.json({ items: [{ id: 'project-b-one', update_time: old, gizmo_id: B }], cursor: null });
  }
  const match = u.pathname.match(/^\/backend-api\/conversation\/(.+)$/);
  if (match) {
    if (match[1].startsWith('project')) {
      assert.equal(init.headers['chatgpt-project-id'], match[1].startsWith('project-a') ? A : B);
    }
    return Response.json(detail(match[1]));
  }
  throw new Error('Unexpected request ' + u.pathname);
};

try {
  const received = [];
  const save = async (_source, _adapter, conversations) => {
    assert.equal(conversations.length, 1);
    received.push(conversations[0]);
    return 1;
  };
  let state = {};
  let loops = 0;
  let result;
  do {
    result = await syncChatGPT({
      state, push: save, register: async () => {}, report: async () => {},
      checkpoint: async next => { /* checkpoint is persisted separately by the caller */ },
    });
    state = result.state;
    loops++;
    assert(loops <= 25, 'project pagination must terminate');
  } while (result.hasMore);
  assert.equal(received.length, 12);
  assert.equal(received[0].externalId, 'project-a-0', 'projects precede personal backfill');
  assert.equal(received.at(-1).externalId, 'personal-one', 'personal backlog remains included');
  assert.equal(new Set(received.map(x => x.externalId)).size, 12);
  assert.equal(sidebarCalls, 2, 'project inventory is reused across worker continuations');
  assert.equal(received.filter(x => x.workspace === A).length, 10);
  assert.equal(received.filter(x => x.workspace === B).length, 1);
  assert.equal(received.filter(x => x.workspace === null).length, 1);
  assert.equal(received.find(x => x.externalId === 'project-a-0').metadata.url,
    `https://chatgpt.com/g/${A}-1hood/c/project-a-0`);
  assert.equal(received.find(x => x.externalId === 'project-a-0').metadata.projectName, '1hood');
  assert.equal(received.find(x => x.externalId === 'personal-one').metadata.projectId, null);
  const account = Object.values(state.accounts)[0];
  assert(account.lastSyncMs);
  assert(account.projects[A].lastSyncMs);
  assert(account.projects[B].lastSyncMs);
  assert(!state.pending, 'complete state does not retain the worker cursor');
  const repeat = await syncChatGPT({ state, push: save, register: async () => {}, report: async () => {} });
  assert.equal(repeat.conversations, 0, 'incremental scope watermarks skip unchanged chats');

  // A pre-upgrade personal-first checkpoint must resume after projects without
  // erasing its acknowledged page position or previously recorded failures.
  const legacyScope = { accountId: scopeId, accountKey: 'accworks',
    accountName: 'workspace', sourceId: 'chatgpt-web-accworks' };
  const legacy = { accounts: {}, pending: {
    scopes: [
      { ...legacyScope, projectId: null, projectName: null, projectShortUrl: null },
      { ...legacyScope, projectId: A, projectName: '1hood', projectShortUrl: `${A}-1hood` },
      { ...legacyScope, projectId: B, projectName: 'Second project', projectShortUrl: `${B}-second-project` },
    ],
    scopeIndex: 0, offset: 0, cursor: '0', pageIndex: 1,
    scopeFailures: 2, failures: 2, detected: 9, processed: 9,
    runStartedMs: Date.now() - 60_000,
  } };
  const migrated = [];
  let legacyState = legacy;
  let savedCheckpoint;
  let legacyResult;
  for (let i = 0; i < 25; i++) {
    legacyResult = await syncChatGPT({ state: legacyState,
      push: async (_source, _adapter, conversations) => {
        migrated.push(conversations[0].externalId); return 1;
      },
      register: async () => {}, report: async () => {},
      checkpoint: async next => { savedCheckpoint = structuredClone(next); },
    });
    legacyState = legacyResult.state;
    if (i === 0) {
      assert.equal(savedCheckpoint.pending.personalResume.index, 2);
      assert.equal(savedCheckpoint.pending.personalResume.pageIndex, 1);
      assert.equal(savedCheckpoint.pending.personalResume.scopeFailures, 2);
    }
    if (!legacyResult.hasMore) break;
  }
  assert.equal(legacyResult.hasMore, false, 'legacy backfill continues after projects');
  assert.equal(migrated.length, 11, 'previously acknowledged personal item is not replayed');
  assert.equal(migrated[0], 'project-a-0');
  assert.equal(migrated.at(-1), 'project-b-one');
  assert.equal(legacyResult.failures, 2, 'existing failed reads cannot be relabelled successful');
  assert.equal(legacyState.accounts.accworks?.lastSyncMs, null,
    'personal watermark remains held after prior failures');
  assert(legacyState.accounts.accworks?.projects[A]?.lastSyncMs);
  assert(!legacyState.pending, 'reordered checkpoint is removed only after all scopes finish');

  // The exact project identifier in a conversation's URL or API metadata wins over topic words.
  const bad = { ...detail('unassigned'), url: `https://chatgpt.com/g/${A}-1hood/c/unassigned` };
  assert(/g-p-/.test(bad.url));
  console.log('PASS project-aware sync: paginated project discovery, independent project cursors, exact IDs and URLs, personal isolation, no duplicate imports');
} finally {
  globalThis.fetch = originalFetch;
}
