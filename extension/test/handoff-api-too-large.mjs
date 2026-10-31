import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../handoff-network.js', import.meta.url), 'utf8');
const path = '/c/11111111-2222-4333-8444-555555555555';
const rejected = { detail: { code: 'conversation_too_large' } };
const message = {
  author: { role: 'user' },
  content: { content_type: 'text', parts: ['now?'] },
};
const request = { method: 'POST', body: JSON.stringify({ messages: [message] }) };
const settle = () => new Promise(resolve => setImmediate(resolve));

function mount(fetchHandler) {
  const events = [];
  const location = { origin: 'https://chatgpt.com',
    href: 'https://chatgpt.com' + path, pathname: path };
  const context = {
    location, URL, Reflect,
    fetch: fetchHandler,
    CustomEvent: class {
      constructor(type, options) { this.type = type; this.detail = options.detail; }
    },
    dispatchEvent: event => events.push(event),
  };
  context.window = context;
  context.top = context;
  vm.runInNewContext(script, context, { filename: 'handoff-network.js' });
  return { context, events, location };
}
const result = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json' } });

const good = mount(async () => result(400, rejected));
const original = await good.context.fetch('/backend-api/f/conversation', request);
assert.equal(original.status, 400);
assert.deepEqual(await original.json(), rejected, 'original ChatGPT response must be readable');
await settle();
assert.equal(good.events.length, 1);
assert.equal(good.events[0].type, 'hstry:conversation-too-large');
assert.equal(good.events[0].detail.path, path);
assert.equal(good.events[0].detail.failedMessage, 'now?');
assert.equal(good.events[0].detail.includesAttachments, false);
const previousFetch = good.context.fetch;
vm.runInNewContext(script, good.context, { filename: 'handoff-network.js' });
assert.equal(good.context.fetch, previousFetch, 're-injection must not stack fetch wrappers');

const wrongCode = mount(async () => result(400, { detail: { code: 'INVALID_ARGUMENT' } }));
await wrongCode.context.fetch('/backend-api/f/conversation', request);
await settle();
assert.equal(wrongCode.events.length, 0, 'ordinary 400 errors cannot cause handoff');

const wrongEndpoint = mount(async () => result(400, rejected));
await wrongEndpoint.context.fetch('/backend-api/ecosystem/call_mcp', request);
await settle();
assert.equal(wrongEndpoint.events.length, 0, 'MCP 400 is unrelated to conversation length');
await wrongEndpoint.context.fetch('/backend-api/f/conversation', { ...request, method: 'GET' });
await settle();
assert.equal(wrongEndpoint.events.length, 0, 'non-submit requests are ignored');

const success = mount(async () => result(200, rejected));
await success.context.fetch('/backend-api/f/conversation', request);
await settle();
assert.equal(success.events.length, 0, 'successful responses are ignored');

const malformedBody = mount(async () => result(400, rejected));
await malformedBody.context.fetch('/backend-api/f/conversation',
  { method: 'POST', body: 'not json' });
await settle();
assert.equal(malformedBody.events.length, 1, 'malformed request must not hide known server rejection');
assert.equal(malformedBody.events[0].detail.failedMessage, '');
assert.equal(malformedBody.events[0].detail.oversized, true,
  'an unparseable rejected message cannot be silently discarded');

const attachments = mount(async () => result(400, rejected));
await attachments.context.fetch('/backend-api/f/conversation', { method: 'POST',
  body: JSON.stringify({ messages: [{ ...message,
    content: { parts: ['look', { image_asset_pointer: 'test' }] } }] }) });
await settle();
assert.equal(attachments.events[0].detail.includesAttachments, true);

const oversized = mount(async () => result(400, rejected));
await oversized.context.fetch('/backend-api/f/conversation', { method: 'POST',
  body: JSON.stringify({ messages: [{ ...message, content: { parts: ['x'.repeat(8001)] } }] }) });
await settle();
assert.equal(oversized.events[0].detail.oversized, true);
assert.equal(oversized.events[0].detail.failedMessage, '');

let fulfill;
const race = mount(() => new Promise(resolve => { fulfill = resolve; }));
const pending = race.context.fetch('/backend-api/f/conversation', request);
race.location.pathname = '/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
fulfill(result(400, rejected));
await pending;
await settle();
assert.equal(race.events[0].detail.path, path, 'response belongs to originating conversation');

const rejectedFetch = mount(() => Promise.reject(new Error('offline')));
await assert.rejects(rejectedFetch.context.fetch('/backend-api/f/conversation', request), /offline/);
await settle();
assert.equal(rejectedFetch.events.length, 0, 'observer cannot swallow request errors');
console.log('PASS exact ChatGPT server rejection observed without changing fetch or reading unrelated errors');
