import assert from 'node:assert/strict';

// Persistent storage survives a same-version extension reload; session storage
// does not. Reinject once per extension load, not once per manifest version.
const session = new Map();
let injections = 0;
const injected = [];
const queries = [];
let blockedTab = 43;
const tabs = [
  { id: 42, active: true, url: 'https://chatgpt.com/c/test' },
  { id: 43, active: false, url: 'https://chatgpt.com/c/other' },
];
// Accelerate only the bounded production timeout; preserve regular test delays.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) =>
  nativeSetTimeout(fn, ms === 3000 ? 10 : ms, ...args);
const on = { addListener() {} };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.4.23' }), onMessage: on, onInstalled: on },
  tabs: {
    onUpdated: on, onActivated: on, onRemoved: on,
    query: async filters => {
      queries.push(filters);
      return filters.active ? tabs.filter(tab => tab.active) : tabs;
    },
  },
  scripting: { executeScript: options => {
    injections++; injected.push(options);
    if (options.target.tabId === blockedTab) return new Promise(() => {});
    return Promise.resolve();
  } },
  storage: {
    local: { get: async () => ({ hstryTakeoverContentVersion: '0.4.23' }) },
    session: {
      get: async key => ({ [key]: session.get(key) }),
      set: async values => { for (const [key, value] of Object.entries(values)) session.set(key, value); },
    },
  },
};

async function boot(n) {
  await import(new URL('../handoff-background.js?worker=' + n, import.meta.url));
  // Let the asynchronous storage read, tab query, injection and write settle.
  await new Promise(resolve => setTimeout(resolve, 30));
}

await boot(1);
assert.equal(injections, 6, 'first sweep installs all three observers in each open chat');
assert.equal(injected[0].world, 'MAIN', 'network observer uses page-world fetch');
assert.deepEqual(injected.slice(0, 3).map(x => x.files[0]),
  ['handoff-network.js', 'handoff-content.js', 'live-content.js']);
assert.equal(session.has('hstryTakeoverContentVersion'), false,
  'a suspended tab must not mark the entire sweep complete');

blockedTab = null;
await boot(2);
assert.equal(injections, 12, 'unfinished sweep retries on the next worker start');
assert.equal(session.get('hstryTakeoverContentVersion'), '0.4.23');

await boot(3);
assert.equal(injections, 15, 'worker restart repairs the active tab even with a saved version');
assert.equal(queries.at(-1).active, true, 'completed sweep skips inactive tabs');
assert.deepEqual(injected.slice(-3).map(x => x.target.tabId), [42, 42, 42]);

session.clear(); // Chrome clears session storage on extension reload.
await boot(4);
assert.equal(injections, 21, 'same-version reload must replace observers across open tabs');
assert.equal(session.get('hstryTakeoverContentVersion'), '0.4.23');
globalThis.setTimeout = nativeSetTimeout;
console.log('PASS partial sweep retries; active tab recovers after worker restart and reload');
