import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const id = '11111111-2222-4333-8444-555555555555';
const msgId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other = '99999999-8888-4777-8666-555555555555';
const accountId = 'account-fixture';
const scope = { sourceId: 'chatgpt-web-fixture', accountId,
  accountKey: 'fixture', projectId: null, projectName: null };
const initial = () => ({ pending: {
  scopes: [scope], scopeIndex: 0, pageIndex: 0, offset: 0, cursor: '0',
  detected: 0, processed: 0, failures: 0, scopeFailures: 0,
  runStartedMs: Date.now(),
  priority: { conversationId: id, sourceId: scope.sourceId,
    accountKey: scope.accountKey, projectId: null, kind: 'continuation' },
} });
const oldFetch = globalThis.fetch;
const oldChrome = globalThis.chrome;
let inTab = false;
let mode = 'success';
let tabs = [{ id: 71, status: 'complete', url: 'https://chatgpt.com/c/' + other }];
const requests = [];
let injected = 0;
let ingested = 0;
const events = [];
globalThis.chrome = { storage: { session: {
  get: async () => ({ hstryChatGPTAccessToken: { token: 'fixture',
    expiresAtMs: Date.now() + 3_600_000 } }),
} }, tabs: { query: async () => tabs }, scripting: {
  executeScript: async options => {
    injected++;
    assert.equal(options.world, 'ISOLATED');
    assert.equal(options.target.tabId, 71, 'use an existing same-origin tab, not a new tab');
    assert.equal(options.args[0], id);
    assert.equal(options.args[1].Authorization, 'Bearer fixture');
    assert.equal(options.args[1]['chatgpt-account-id'], accountId);
    assert(options.args[2].startsWith('https://chatgpt.com/backend-api/conversations/' + id));
    if (mode === 'tab-closed') throw Error('tab closed during injection');
    inTab = true;
    try { return [{ result: await options.func(...options.args) }]; }
    finally { inTab = false; }
  },
} };
globalThis.fetch = async url => {
  const u = new URL(url);
  requests.push({ pathname: u.pathname, inTab });
  if (u.pathname !== '/backend-api/conversations/' + id) throw Error('bad path');
  if (!inTab) throw new DOMException('worker 25s timeout', 'TimeoutError');
  if (mode === '429') return new Response('', {
    status: 429, headers: { 'retry-after': '90' },
  });
  return Response.json({
    conversation_id: id, title: 'Canonical test',
    create_time: Date.now() / 1000 - 300,
    messages: [{ id: msgId, author: { role: 'user' },
      create_time: Date.now() / 1000 - 250,
      content: { content_type: 'text', parts: ['recovered'] } }],
    page_info: { has_previous_page: false, has_next_page: false },
  });
};
const run = state => syncChatGPT({ state, report: async () => {},
  checkpoint: async state => events.push(structuredClone(state)),
  register: async () => {},
  push: async (_source, _adapter, convs) => {
    ingested++;
    assert.equal(convs[0].externalId, id);
    return convs.length;
  },
});
try {
  const success = await run(initial());
  assert.equal(success.state.pending.priority, undefined);
  assert.equal(success.state.pending.processed, 0, 'historic scan cursor must stay put');
  assert.equal(ingested, 1);
  assert.deepEqual(requests.map(x => x.inTab), [true],
    'closed target chat must not force a service-worker fetch');
  assert.equal(injected, 1);

  requests.length = 0; mode = '429';
  const limited = await run(initial());
  assert.equal(limited.deferredHttpStatus, 429);
  assert.equal(limited.state.pending.retryYieldToScan, true);
  assert.deepEqual(requests.map(x => x.inTab), [true],
    'do not send another request after in-tab 429');
  assert.equal(ingested, 1);

  requests.length = 0; mode = 'tab-closed';
  const closed = await run(initial());
  assert.equal(closed.state.pending.priority.kind, 'continuation');
  assert(closed.state.pending.priority.nextRetryAtMs > Date.now());
  assert.deepEqual(requests, [],
    'a failed injection must defer rather than duplicate the remote request');
  assert.equal(ingested, 1);

  requests.length = 0; mode = 'success'; tabs = [
    { id: 71, status: 'complete', url: 'https://example.com/c/' + id },
  ];
  const noTab = await run(initial());
  assert.equal(noTab.state.pending.priority.kind, 'continuation');
  assert.deepEqual(requests.map(x => x.inTab), [false],
    'never execute a private ChatGPT request in an unrelated origin');

  console.log('PASS unrelated same-origin tab supports long native recovery, 429 and closed-tab preserve budget and checkpoint');
} finally {
  globalThis.fetch = oldFetch;
  globalThis.chrome = oldChrome;
}
