// Integration-style service worker test for targeted provider full resync.
// Usage: bun extension/test/full-resync.js

import assert from 'node:assert/strict';

const nowSeconds = Date.now() / 1000;
const oldWatermark = Date.now() + 86_400_000;
const stored = {
  settings: {
    port: 41770,
    token: 'fixture-ingest-token',
    intervalMinutes: 15,
    providers: { chatgpt: true, claude: false, gemini: false, perplexity: false },
  },
  status: {
    chatgpt: {
      state: {
        accounts: { default: { lastSyncMs: oldWatermark } },
        ignoredFailures: [{ conversationId: 'user-deleted-project-chat',
          accountKey: 'default', projectId: 'g-p-deleted', ignoredReason: 'user-deleted' }],
      },
      lastRunMs: 1,
    },
    claude: { state: { sentinel: 'untouched' }, lastRunMs: 2 },
    gemini: { state: { sentinel: 'stale-run' }, lastRunMs: 3, running: true },
  },
};

let messageListener;
globalThis.chrome = {
  action: {
    onClicked: { addListener: () => {} },
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  alarms: {
    get: async () => null,
    create: async () => {},
    onAlarm: { addListener: () => {} },
  },
  tabs: {
    query: async () => [],
    onUpdated: { addListener: () => {} },
    onActivated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  scripting: {}, // Avoid session-based pacing in the isolated full-sync fixture.
  runtime: {
    getManifest: () => ({ version: '0.4.30' }),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: listener => (messageListener = listener) },
  },
  storage: {
    local: {
      get: async keys => {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(name => name in stored).map(name => [name, stored[name]]));
      },
      set: async values => Object.assign(stored, structuredClone(values)),
    },
  },
};

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  requests.push({ pathname: parsed.pathname, method: init.method ?? 'GET' });

  if (parsed.hostname === '127.0.0.1') {
    if (parsed.pathname === '/sources') return Response.json({ ok: true });
    if (parsed.pathname === '/ingest') {
      const payload = JSON.parse(init.body);
      assert.equal(payload.source, 'chatgpt-web');
      assert.equal(payload.conversations.length, 1);
      return Response.json({ conversations: 1, created: 0, updated: 1 });
    }
  }
  if (parsed.pathname === '/api/auth/session') {
    return Response.json({ accessToken: 'fixture-token' });
  }
  if (parsed.pathname === '/backend-api/accounts/check/v4-2023-04-27') {
    return Response.json({ accounts: {} });
  }
  if (parsed.pathname === '/backend-api/gizmos/snorlax/sidebar') return Response.json({ items: [], cursor: null });
  if (parsed.pathname === '/backend-api/conversations') {
    if (parsed.searchParams.get('is_archived') === 'true')
      return Response.json({ total: 0, items: [] });
    return Response.json({
      total: 1,
      items: [{ id: 'full-sync-conversation', update_time: nowSeconds }],
    });
  }
  if (parsed.pathname === '/backend-api/conversation/full-sync-conversation') {
    return Response.json({
      current_node: 'answer',
      mapping: {
        question: {
          id: 'question',
          parent: null,
          message: {
            author: { role: 'user' },
            create_time: nowSeconds - 1,
            content: { content_type: 'text', parts: ['repair this conversation'] },
          },
        },
        answer: {
          id: 'answer',
          parent: 'question',
          message: {
            author: { role: 'assistant' },
            create_time: nowSeconds,
            content: { content_type: 'text', parts: ['repaired'] },
          },
        },
      },
    });
  }
  return new Response('not found', { status: 404 });
};

await import(`../background.js?full-resync-test=${Date.now()}`);
assert.ok(messageListener, 'service worker registered a message listener');

const response = await new Promise(resolve => {
  const asyncResponse = messageListener(
    { type: 'fullSyncProvider', provider: 'chatgpt' },
    {},
    resolve
  );
  assert.equal(asyncResponse, true);
});
assert.deepEqual(response, { ok: true });

async function awaitIdle() {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (stored.status.chatgpt.running === false) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('HSTRY did not finish the scheduled fixture batch');
}
await awaitIdle();
assert.equal(stored.status.chatgpt.trigger, 'full');
// A full scan now yields after each detail; drive its existing continuation
// rather than falsely assuming a single service-worker invocation completes it.
for (let i = 0; stored.status.chatgpt.state.pending && i < 8; i++) {
  stored.status.chatgpt.nextAllowedAtMs = 0;
  const ack = await new Promise(resolve => messageListener({ type: 'syncNow' }, {}, resolve));
  assert.deepEqual(ack, { ok: true });
  await awaitIdle();
}
assert.equal(stored.status.chatgpt.state.pending, undefined);
assert.equal(stored.status.chatgpt.running, false);
assert.equal(stored.status.chatgpt.lastError, null);
assert.deepEqual(stored.status.chatgpt.state.ignoredFailures, [{
  conversationId: 'user-deleted-project-chat', accountKey: 'default',
  projectId: 'g-p-deleted', ignoredReason: 'user-deleted',
}], 'full resync must not lose explicit deleted-conversation exclusions');
assert.notEqual(
  stored.status.chatgpt.state.accounts.default.lastSyncMs,
  oldWatermark,
  'full resync replaces the previous watermark'
);
assert.deepEqual(stored.status.claude, {
  state: { sentinel: 'untouched' },
  lastRunMs: 2,
});
assert.deepEqual(stored.status.gemini, {
  state: { sentinel: 'stale-run' },
  lastRunMs: 3,
  running: false,
  lastError: 'Previous sync was interrupted before a saved checkpoint.',
  progress: { phase: 'failed' },
  continuationPending: false,
});
assert.ok(
  requests.some(request => request.pathname === '/backend-api/conversation/full-sync-conversation'),
  'full resync fetched conversation detail despite the future watermark'
);
assert.equal(
  requests.filter(request => request.pathname === '/ingest').length,
  1,
  'only the selected provider was ingested'
);

console.log('PASS targeted provider full resync resets only its watermark');
