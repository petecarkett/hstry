import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalChrome = globalThis.chrome;
const start = originalNow();
const old = Math.floor((start - 3600_000) / 1000);
let now = start;
Date.now = () => now;
let browserContext = false;
let browserOutcome = 'success';
let shortDetailCalls = 0;
let longDetailCalls = 0;
let injected = 0;
const imported = [];
const record = id => ({
  id, title: id, create_time: old, update_time: old, current_node: 'm',
  mapping: { m: { id: 'm', parent: null, message: {
    author: { role: 'user' }, create_time: old,
    content: { content_type: 'text', parts: [id] },
  } } },
});

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/api/auth/session') return Response.json({ accessToken: 'fixture' });
  if (u.pathname.includes('/accounts/check/')) return Response.json({
    accounts: { primary: { account: {
      account_id: 'acc-1234', structure: 'workspace',
    } } },
  });
  if (u.pathname === '/backend-api/gizmos/snorlax/sidebar') return Response.json({
    items: [{ gizmo: { gizmo: {
      id: projectId, display: { name: '1hood' }, short_url: `${projectId}-1hood`,
    } } }], cursor: null,
  });
  if (u.pathname === `/backend-api/gizmos/${projectId}/conversations`) return Response.json({
    items: [{ id: 'large', gizmo_id: projectId, update_time: old },
      { id: 'healthy', gizmo_id: projectId, update_time: old }], cursor: null,
  });
  if (u.pathname === '/backend-api/conversations') return Response.json({ items: [], total: 0 });
  if (u.pathname === '/backend-api/conversation/healthy') return Response.json(record('healthy'));
  if (u.pathname === '/backend-api/conversation/large') {
    assert.equal(init.headers['chatgpt-project-id'], projectId);
    if (!browserContext) {
      shortDetailCalls++;
      throw new DOMException('signal timed out', 'TimeoutError');
    }
    longDetailCalls++;
    if (browserOutcome === '429') return new Response('', {
      status: 429, headers: { 'retry-after': '90' },
    });
    if (browserOutcome === 'timeout') throw new DOMException('signal timed out', 'AbortError');
    return Response.json(record('large'));
  }
  throw new Error(`Unexpected URL ${u.pathname}`);
};

const sync = state => syncChatGPT({ state,
  report: async () => {}, register: async () => {}, checkpoint: async () => {},
  push: async (_source, _adapter, conversations) => {
    imported.push(conversations[0].externalId);
    return 1;
  },
});

try {
  let first = await sync({});
  for (let n = 0; first.hasMore && n < 5; n++) first = await sync(first.state);
  assert.equal(first.hasMore, false);
  assert.deepEqual(imported, ['healthy']);
  assert.equal(shortDetailCalls, 1);
  assert.equal(first.state.failureDetails[0].attempts, 1);

  // A second retry still uses the bounded 25-second fetch as before.
  now = start + 31 * 60_000;
  const second = await sync(first.state);
  assert.equal(second.state.failureDetails[0].attempts, 2);
  assert.equal(second.state.failureDetails[0].errorType, 'TimeoutError');
  assert.equal(shortDetailCalls, 2);

  globalThis.chrome = {
    tabs: { query: async () => [{ id: 72, status: 'complete', url: 'https://chatgpt.com/c/test' }] },
    scripting: { executeScript: async options => {
      injected++;
      assert.equal(options.world, 'ISOLATED');
      assert.equal(options.target.tabId, 72);
      assert.equal(options.args[0], 'large');
      assert.equal(options.args[1].Authorization, 'Bearer fixture');
      browserContext = true;
      try { return [{ result: await options.func(...options.args) }]; }
      finally { browserContext = false; }
    } },
  };

  // Third attempt routes through the existing tab, not the 25s worker fetch.
  now += 61 * 60_000;
  const recovered = await sync(second.state);
  assert.equal(recovered.conversations, 1);
  assert.equal(shortDetailCalls, 2);
  assert.equal(longDetailCalls, 1);
  assert.equal(injected, 1);
  assert.equal(recovered.state.failureDetails[0].errorType, 'TimeoutError');
  assert(Number.isFinite(recovered.state.failureDetails[0].resolvedAtMs));
  assert.deepEqual(imported, ['healthy', 'large']);

  // A 429 in the long-path is propagated into the existing persisted cooldown.
  browserOutcome = '429';
  const before429 = longDetailCalls;
  const rateLimited = await sync(second.state);
  assert.equal(rateLimited.deferredHttpStatus, 429);
  assert.equal(rateLimited.state.serverRetryAfterUntilMs, now + 90_000);
  assert.equal(rateLimited.state.pending.retryYieldToScan, true);
  assert.equal(rateLimited.state.failureDetails[0].resolvedAtMs, null);
  assert.equal(shortDetailCalls, 2, 'do not send a second immediate request after a 429');
  assert.equal(longDetailCalls, before429 + 1);

  // If the user closes ChatGPT tabs, fall back to the bounded standard path.
  globalThis.chrome.tabs.query = async () => [];
  browserOutcome = 'success';
  const noTab = await sync(second.state);
  assert.equal(noTab.state.failureDetails[0].errorType, 'TimeoutError');
  assert.equal(shortDetailCalls, 3);
  assert.equal(longDetailCalls, 2);

  // A tab closing during injection is not a conversation error, and cannot
  // trigger a second unpaced ChatGPT request in the same worker run.
  globalThis.chrome.tabs.query = async () => [
    { id: 72, status: 'complete', url: 'https://chatgpt.com/c/test' },
  ];
  globalThis.chrome.scripting.executeScript = async () => {
    throw new Error('The target tab was closed');
  };
  const transport = await sync(second.state);
  assert.equal(transport.state.failureDetails[0].errorType, 'TimeoutError');
  assert.match(transport.state.failureDetails[0].lastTransportError, /unavailable/);
  assert.equal(shortDetailCalls, 3, 'failed injection must not send another request');
  assert.equal(transport.state.failureDetails[0].resolvedAtMs, null);

  console.log('PASS long timeout recovery: bounded first retries, existing tab fallback, 429 cooldown, no-tab fallback, no doubled requests');
} finally {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}
