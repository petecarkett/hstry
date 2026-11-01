import assert from 'node:assert/strict';

// Persistent storage survives a same-version extension reload; session storage
// does not. Reinject once per extension load, not once per manifest version.
const session = new Map();
let injections = 0;
const injected = [];
const on = { addListener() {} };
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.4.23' }), onMessage: on, onInstalled: on },
  tabs: {
    onUpdated: on, onActivated: on, onRemoved: on,
    query: async () => [{ id: 42, url: 'https://chatgpt.com/c/test' }],
  },
  scripting: { executeScript: async options => { injections++; injected.push(options); } },
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
assert.equal(injections, 2, 'first load injects both network observer and handoff');
assert.equal(injected[0].world, 'MAIN', 'network observer uses page-world fetch');
assert.deepEqual(injected.slice(0, 2).map(x => x.files[0]),
  ['handoff-network.js', 'handoff-content.js']);
assert.equal(session.get('hstryTakeoverContentVersion'), '0.4.23');

await boot(2);
assert.equal(injections, 2, 'service worker restart must not repeat tab-wide injection');

session.clear(); // Chrome clears storage.session on extension reload, even without a version bump.
await boot(3);
assert.equal(injections, 4, 'same-version reload must replace both observers');
console.log('PASS same-version reload reinjects; ordinary worker restart does not');
