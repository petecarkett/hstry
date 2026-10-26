import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';
import { appendLiveCapture, confirmLiveCapture, validLiveCapture } from '../lib/live-capture.js';

const conversationId = '6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
const messageId = 'f9085be9-bc56-4ba8-826b-a6e3d4b4b883';
const route = `https://chatgpt.com/c/${conversationId}`;
const observed = validLiveCapture({ conversationId, messageId, role: 'user', content: 'hello live', title: 'Test' }, route);
let pending = appendLiveCapture({}, observed);
let ingests = 0;
let canonicalCalls = 0;
let ingestionSuccess = true;
const originalFetch = globalThis.fetch;
const old = Math.floor(Date.now() / 1000) - 3600;
globalThis.fetch = async url => {
  const path = new URL(url).pathname;
  if (path === '/api/auth/session') return Response.json({ accessToken: 'fixture' });
  if (path.includes('/accounts/check/')) return Response.json({ accounts: {
    a: { account: { account_id: 'acct1', structure: 'personal' } },
  } });
  if (path === '/backend-api/gizmos/snorlax/sidebar') return Response.json({ items: [], cursor: null });
  if (path === '/backend-api/conversations') return Response.json({
    items: [{ id: conversationId, update_time: old }], total: 1,
  });
  if (path === `/backend-api/conversation/${conversationId}`) return Response.json({
    id: conversationId, title: 'Test', create_time: old, update_time: old,
    current_node: messageId, mapping: {
      [messageId]: { id: messageId, parent: null,
        message: { id: messageId, author: { role: 'user' }, create_time: old,
          content: { content_type: 'text', parts: ['hello live'] },
        },
      },
    },
  });
  throw new Error(`Unexpected request ${path}`);
};

const run = () => syncChatGPT({
  state: {},
  register: async () => {}, report: async () => {}, checkpoint: async () => {},
  push: async (_source, _adapter, convs) => {
    ingests++;
    assert.equal(convs[0].externalId, conversationId);
    assert.equal(convs[0].messages[0].metadata?.messageId, messageId);
    if (!ingestionSuccess) throw new Error('ingestion offline');
    return 1;
  },
  onCanonicalIngest: async data => {
    canonicalCalls++;
    assert.equal(data.conversationId, conversationId);
    pending = confirmLiveCapture(pending, data);
  },
});

try {
  await run();
  assert.equal(canonicalCalls, 1, 'successful canonical ingestion clears confirmed capture');
  assert.equal(Object.keys(pending).length, 0);
  // Construct another pending message and assert a failed ingest cannot settle it.
  pending = appendLiveCapture({}, observed);
  const before = canonicalCalls;
  ingestionSuccess = false;
  await assert.rejects(run(), /ingestion offline/);
  assert.equal(canonicalCalls, before);
  assert.equal(Object.keys(pending).length, 1);
  ingestionSuccess = true;
  await run();
  assert.equal(canonicalCalls, before + 1);
  assert.equal(Object.keys(pending).length, 0);
  console.log('PASS canonical live capture: successful ingestion confirms matching DOM records; failed local ingest retains the queue');
} finally { globalThis.fetch = originalFetch; }
