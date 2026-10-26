import assert from 'node:assert/strict';
import { fetchJson, RateLimitedError } from '../lib/common.js';

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  if (calls <= 2) return new Response('rl', { status: 429, headers: { 'retry-after': '0' } });
  return new Response(JSON.stringify({ ok: true, calls }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const data = await fetchJson('https://example.com/x', {}, { retries: 5, baseDelayMs: 20 });
console.log(data.ok && data.calls === 3 ? 'PASS recovered after 2x 429' : `FAIL ${JSON.stringify(data)}`);

calls = 0;
globalThis.fetch = async () => new Response('nope', { status: 429, headers: { 'retry-after': '0' } });
try {
  await fetchJson('https://example.com/y', {}, { retries: 2, baseDelayMs: 5 });
  console.log('FAIL should have thrown');
} catch (e) {
  console.log(e instanceof RateLimitedError ? 'PASS gives up as RateLimitedError' : `FAIL wrong error: ${e.name}`);
}

// A server-directed cooldown longer than the in-worker sleep cap must be
// preserved for the alarm continuation. Do not actually sleep in this test.
globalThis.fetch = async () => new Response('', {
  status: 429, headers: { 'retry-after': '180' },
});
await assertLongRetry();
async function assertLongRetry() {
  try {
    await fetchJson('https://example.com/server-cooldown', {}, {
      retries: 0, maxBackoffMs: 20_000,
    });
    throw new Error('expected immediate deferral');
  } catch (error) {
    if (!(error instanceof RateLimitedError) || error.retryAfterMs < 180_000) throw error;
    assert.equal(error.serverRetryAfterMs, 180_000);
    console.log('PASS 3-minute server Retry-After survives worker timeout limit');
  }
}

let hintCalls = 0;
async function expectServerHint(header, expected) {
  globalThis.fetch = async () => {
    hintCalls++;
    return new Response('', { status: 429, headers: header == null ? {} : { 'retry-after': header } });
  };
  await assert.rejects(fetchJson('https://example.com/hint', {}, { retries: 0 }), error => {
    assert(error instanceof RateLimitedError);
    assert.equal(error.status, 429);
    if (expected === null) assert.equal(error.serverRetryAfterMs, null);
    else assert(Math.abs(error.serverRetryAfterMs - expected) < 1200);
    return true;
  });
}
await expectServerHint('120', 120_000);
await expectServerHint(new Date(Date.now() + 60_000).toUTCString(), 60_000);
await expectServerHint('0', 0);
await expectServerHint(null, null);
await expectServerHint('invalid-header', null);
assert.equal(hintCalls, 5, 'each probe must issue exactly one request');
console.log('PASS HTTP Retry-After: seconds, date, zero, absent, invalid; no extra requests');
