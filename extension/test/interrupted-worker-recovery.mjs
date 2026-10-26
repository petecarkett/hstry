import assert from 'node:assert/strict';

const initialTime = Date.now();
const record = {
  settings: {
    port: 41770, token: 'fixture-token',
    providers: { chatgpt: true }, intervalMinutes: 15,
  },
  status: {
    chatgpt: {
      running: true,
      lastError: 'prior transient failure',
      lastRunMs: initialTime - 20_000,
      nextAllowedAtMs: initialTime + 150_000,
      state: { pending: { scopes: [{accountId:'fixture'}], pageIndex: 7 } },
      progress: { phase: 'importing', detected: 20, processed: 7 },
    },
  },
};
const alarms = [];
const badgeText = [];
const badgeColours = [];
const events = { addListener() {} };
let alarmListener;
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return {[key]: structuredClone(record[key])};
        if (Array.isArray(key)) return Object.fromEntries(
          key.map(k => [k, structuredClone(record[k])])
        );
        return structuredClone(record);
      },
      async set(items) {Object.assign(record, structuredClone(items));},
    },
  },
  alarms: {
    onAlarm: { addListener(listener) { alarmListener = listener; } },
    async create(name, options) {alarms.push({name,...options});},
    async get() {return null;},
  },
  runtime: {
    onInstalled: events, onStartup: events, onMessage: events,
  },
  tabs: { onUpdated: events, onRemoved: events, onActivated: events },
  scripting: {}, // Injection is not part of this recovery fixture.
  action: {
    onClicked: events,
    async setBadgeText({text}) {badgeText.push(text);},
    async setBadgeBackgroundColor({color}) {badgeColours.push(color);},
  },
};
await import('../background.js');
for(let i=0;i<15 && badgeText.length===0;i++) await new Promise(r=>setTimeout(r,10));
const entry = record.status.chatgpt;
assert.equal(entry.running, false);
assert.equal(entry.continuationPending, true);
assert.equal(entry.progress.phase, 'queued');
assert.equal(entry.lastError, null);
assert.equal(entry.state.pending.pageIndex, 7, 'checkpoint must remain intact');
assert(alarms.some(a => a.name === 'hstry-sync-continue-chatgpt' &&
  a.delayInMinutes >= 2), 'original rate-limit cooldown must be retained');
assert.equal(badgeText.at(-1), '…');
assert.equal(badgeColours.at(-1), '#6b7280');
// A stale continuation alarm must not bypass a persisted provider cooldown.
let prematureRequests = 0;
globalThis.fetch = async () => { prematureRequests++; throw new Error('early request'); };
const alarmsBefore = alarms.length;
alarmListener({ name: 'hstry-sync-continue-chatgpt' });
for (let i = 0; i < 15 && alarms.length === alarmsBefore; i++) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.equal(prematureRequests, 0, 'provider cooldown prevents early fetches');
assert(alarms.at(-1).delayInMinutes >= 2, 'continuation reschedules after cooldown');
assert.equal(record.status.chatgpt.state.pending.pageIndex, 7);
// An idle-but-queued worker can also be reloaded. Its saved continuation
// must be rescheduled even though `running` is already false.
record.status.chatgpt.running = false;
record.status.chatgpt.continuationPending = true;
record.status.chatgpt.nextAllowedAtMs = Date.now() + 120_000;
record.status.chatgpt.lastError = 'Unresolved HTTP 404 details remain';
alarms.length = 0;
await import('../background.js?queued-reload-fixture');
for (let i = 0; i < 15 && alarms.length === 0; i++) await new Promise(r => setTimeout(r, 10));
assert(alarms.some(a => a.name === 'hstry-sync-continue-chatgpt' && a.delayInMinutes >= 1));
assert.equal(record.status.chatgpt.state.pending.pageIndex, 7);
assert.equal(record.status.chatgpt.lastError, 'Unresolved HTTP 404 details remain');
// Project discovery now proceeds one remote request at a time. A service
// worker restart must preserve that partial account/project inventory as well.
record.status.chatgpt.running = true;
record.status.chatgpt.continuationPending = false;
record.status.chatgpt.lastError = null;
record.status.chatgpt.nextAllowedAtMs = Date.now() + 150_000;
record.status.chatgpt.state = { discovery: {
  accounts: [{id:'account-workspace',isWorkspace:true}],
  accountIndex:0, scopes:[{projectId:'g-p-6818bc97551c8191865a07d09f7b3678'}],
  cursor:'MORE', pageCount:1, seenCursors:['MORE'],
}};
alarms.length = 0;
await import('../background.js?staged-discovery-reload-fixture');
for (let i=0;i<20 && alarms.length===0;i++) {
  await new Promise(resolve=>setTimeout(resolve,10));
}
assert.equal(record.status.chatgpt.running,false);
assert.equal(record.status.chatgpt.continuationPending,true);
assert.equal(record.status.chatgpt.progress.phase,'queued');
assert.equal(record.status.chatgpt.state.discovery.cursor,'MORE');
assert.equal(record.status.chatgpt.state.discovery.scopes.length,1);
assert(alarms.some(a=>a.name==='hstry-sync-continue-chatgpt'));
// A saved five-minute retry from an HTTP 429 must not override the currently
// learned 15-minute interval, even after a worker reload or a stale alarm.
const last429 = Date.now() - 6_000;
const minimumNext = last429 + 15 * 60_000;
record.status.chatgpt.running = false;
record.status.chatgpt.continuationPending = true;
record.status.chatgpt.nextAllowedAtMs = Date.now() + 5 * 60_000;
record.status.chatgpt.state = {
  paceMs: 15 * 60_000,
  lastRateLimitAtMs: last429,
  pending: { scopes: [{ accountId:'fixture' }], pageIndex:7 },
};
alarms.length = 0;
await import('../background.js?rate-limit-floor-reload-fixture');
for (let i=0;i<25 && alarms.length===0;i++) {
  await new Promise(resolve=>setTimeout(resolve,10));
}
assert(record.status.chatgpt.nextAllowedAtMs >= minimumNext,
  'migration extends existing five-minute retry after an HTTP 429');
assert(alarms.some(a => a.name==='hstry-sync-continue-chatgpt' &&
  a.delayInMinutes>=14.7), 'next alarm respects local fifteen-minute rate floor');
const requestsBefore429 = prematureRequests;
const countBefore429 = alarms.length;
alarmListener({name:'hstry-sync-continue-chatgpt'});
for (let i=0;i<20 && alarms.length === countBefore429;i++) {
  await new Promise(resolve=>setTimeout(resolve,10));
}
assert.equal(prematureRequests,requestsBefore429,
  'manual or stale early alarms cannot issue ChatGPT requests');
assert(alarms.at(-1).delayInMinutes >= 14.5,
  'premature alarm is requeued at the protected rate-limit deadline');
console.log('PASS worker recovery and 429 safety floor: 5-minute server retry cannot bypass 15-minute client pacing');
