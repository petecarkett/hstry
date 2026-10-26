import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../providers/index.js';

assert.deepEqual(DEFAULT_PROVIDER_SETTINGS, { chatgpt: true });
const historySeconds = 1700000000;
const oldConversation = {
  title: 'Historical fixture',
  create_time: historySeconds,
  update_time: historySeconds,
  current_node: 'assistant',
  mapping: {
    user: {
      id: 'user', parent: null,
      message: { author: { role: 'user' }, create_time: historySeconds, content: { content_type: 'text', parts: ['old question'] } },
    },
    assistant: {
      id: 'assistant', parent: 'user',
      message: { author: { role: 'assistant' }, create_time: historySeconds + 1, content: { content_type: 'text', parts: ['old answer'] } },
    },
  },
};
const originalFetch = globalThis.fetch;
const requested = [];
globalThis.fetch = async url => {
  const path = new URL(url).pathname;
  requested.push(path);
  if (path === '/api/auth/session') return Response.json({ accessToken: 'fixture-token' });
  if (path === '/backend-api/accounts/check/v4-2023-04-27') return Response.json({ accounts: {} });
  if (path === '/backend-api/gizmos/snorlax/sidebar') return Response.json({ items: [], cursor: null });
  if (path === '/backend-api/conversations' && new URL(url).searchParams.get('is_archived') === 'true') return Response.json({ total: 0, items: [] });
  if (path === '/backend-api/conversations') return Response.json({ total: 1, items: [{ id: 'old-chat', update_time: historySeconds }] });
  if (path === '/backend-api/conversation/old-chat') return Response.json(oldConversation);
  throw new Error(`Unexpected path ${path}`);
};
try {
  const imported = [];
  const params = { log: () => {}, push: async (source, adapter, conversations) => { imported.push(...conversations); return conversations.length; } };
  const first = await syncChatGPT({ ...params, state: {} });
  assert.equal(first.conversations, 1, 'first sync must include historical conversations');
  assert.deepEqual(imported[0].messages.map(m => m.content), ['old question', 'old answer']);
  assert.equal(imported[0].externalId, 'old-chat');
  const second = await syncChatGPT({ ...params, state: first.state });
  assert.equal(second.conversations, 0, 'incremental sync must not reimport unchanged history');
  assert.equal(imported.length, 1);
  assert.equal(requested.filter(path => path === '/backend-api/conversation/old-chat').length, 1);
  console.log('PASS historical first sync and incremental dedupe without network/API writes');
} finally {
  globalThis.fetch = originalFetch;
}
