import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const accountId = 'acc-workspace';
const sourceId = 'chatgpt-web-test';
const scope = {
  accountId, accountKey: 'workspace', sourceId, projectId,
  projectName: 'Fixture', projectShortUrl: projectId + '-fixture',
};
const timestamp = Math.floor((Date.now() - 3_600_000) / 1000);
const node = (id, parent, role, content) => ({
  id, parent, message: {
    id, author: { role }, create_time: timestamp,
    content: { content_type: 'text', parts: [content] },
  },
});
// A ChatGPT edit creates an alternate user path. Regenerate creates another
// assistant path. Neither should be presented as part of the selected thread.
const detail = {
  title: 'Fixture conversation', create_time: timestamp, update_time: timestamp,
  current_node: 'answer-current',
  mapping: {
    system: { id: 'system', parent: null, message: null },
    'ask-current': node('ask-current', 'system', 'user', 'edited question'),
    'answer-current': node('answer-current', 'ask-current', 'assistant', 'selected reply'),
    'answer-regen': node('answer-regen', 'ask-current', 'assistant', 'regenerated reply'),
    'ask-original': node('ask-original', 'system', 'user', 'original question'),
    'answer-original': node('answer-original', 'ask-original', 'assistant', 'original reply'),
  },
};
const originalFetch = globalThis.fetch;
const detailCalls = [];
const batches = [];
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.pathname === '/api/auth/session') {
    return Response.json({ accessToken: 'fixture-token' });
  }
  if (url.pathname === '/backend-api/gizmos/' + projectId + '/conversations') {
    return Response.json({
      cursor: null,
      items: [{ id: 'conversation-1', gizmo_id: projectId, update_time: timestamp }],
    });
  }
  if (url.pathname === '/backend-api/conversation/conversation-1') {
    detailCalls.push('conversation-1');
    return Response.json(detail);
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
    batches.push(conversations);
    return conversations.length;
  },
});
try {
  let result = await run({ pending: pending() });
  for (let n = 0; result.hasMore && n < 5; n++) result = await run(result.state);
  assert.equal(result.hasMore, false);
  assert.equal(result.failures, 0);
  assert.deepEqual(detailCalls, ['conversation-1'],
    'alternate versions do not cause extra ChatGPT requests');
  assert.equal(batches.length, 1);
  const [primary, ...forks] = batches[0];
  assert.equal(primary.externalId, 'conversation-1');
  assert.deepEqual(primary.messages.map(m => m.content),
    ['edited question', 'selected reply'],
    'the canonical active message indices remain unchanged');
  assert.equal(forks.length, 2);
  assert.deepEqual(forks.map(f => f.externalId), [
    'conversation-1:alternate:answer-original',
    'conversation-1:alternate:answer-regen',
  ]);
  assert.deepEqual(forks.map(f => f.messages.map(m => m.content)),
    [['original question', 'original reply'], ['regenerated reply']]);
  assert.deepEqual(forks.map(f => f.parentMessageIdx), [null, 0]);
  for (const fork of forks) {
    assert.equal(fork.parentExternalId, primary.externalId);
    assert.equal(fork.forkType, 'fork');
    assert.equal(fork.workspace, projectId);
    assert.equal(fork.metadata.alternateBranch, true);
    assert.equal(fork.metadata.parentConversationId, primary.externalId);
  }
  assert.equal(forks[0].metadata.alternateLeafId, 'answer-original');
  assert.equal(forks[1].metadata.alternateLeafId, 'answer-regen');

  // Re-importing the same mapping must keep deterministic external IDs,
  // branch anchors, and content rather than multiplying alternate snapshots.
  batches.length = 0;
  detailCalls.length = 0;
  let replay = await run({ pending: pending() });
  for (let n = 0; replay.hasMore && n < 5; n++) replay = await run(replay.state);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(c => ({
    id: c.externalId, parent: c.parentExternalId ?? null,
    parentIdx: c.parentMessageIdx ?? null,
    messages: c.messages.map(m => m.content),
  })), [primary, ...forks].map(c => ({
    id: c.externalId, parent: c.parentExternalId ?? null,
    parentIdx: c.parentMessageIdx ?? null,
    messages: c.messages.map(m => m.content),
  })));
  assert.deepEqual(detailCalls, ['conversation-1']);
  console.log('PASS ChatGPT edited and regenerated branches imported as stable HSTRY forks; active thread unchanged');
} finally {
  globalThis.fetch = originalFetch;
}
