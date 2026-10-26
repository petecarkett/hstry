import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const previousFetch = globalThis.fetch;
const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const future = Date.now() + 3_600_000;
let requests = 0;
const checkpoints = [];
globalThis.fetch = async (input) => {
  requests++;
  const url = new URL(input);
  if (url.pathname === '/api/auth/session') {
    return Response.json({ accessToken: 'fixture-token' });
  }
  if (url.pathname === '/backend-api/gizmos/'+projectId+'/conversations') {
    return Response.json({ items: [], cursor: null });
  }
  throw new Error('Unexpected remote request: '+url.pathname);
};

const basePending = () => ({
  scopes: [], scopeIndex: 0, offset: 0, cursor: '0', pageIndex: 0,
  processed: 1069, detected: 1450, failures: 69, scopeFailures: 0,
  runStartedMs: Date.now()-60_000,
});
const run = state => syncChatGPT({
  state, report:async()=>{}, register:async()=>{}, push:async()=>1,
  checkpoint:async saved => checkpoints.push(structuredClone(saved)),
});
try {
  const completed = await run({
    pending:basePending(),
    failureDetails:[
      {conversationId:'already-recovered',resolvedAtMs:Date.now()-10_000},
      {conversationId:'also-recovered',resolvedAtMs:Date.now()-1000},
    ],
  });
  assert.equal(completed.hasMore,false);
  assert.equal(completed.failures,0,
    'cumulative 69 failed fetches cannot masquerade as unresolved failures');
  assert.equal(completed.state.pending,undefined);

  const unresolved = await run({
    pending:basePending(),
    failureDetails:[
      {conversationId:'unresolved',resolvedAtMs:null, nextRetryAtMs:future,
       sourceId:'chatgpt-web-fixture', accountKey:'fixture', projectId:null},
      {conversationId:'recovered',resolvedAtMs:Date.now()-1000},
    ],
  });
  assert.equal(unresolved.failures,1,'one unresolved ID remains an error');

  const historicUntracked = await run({pending:basePending()});
  assert.equal(historicUntracked.failures,69,
    'legacy checkpoint with no detail records cannot claim recovery');

  const legacyKnown = await run({
    pending:{...basePending(),failures:0,untrackedFailures:2},
    failureDetails:[{conversationId:'recovered',resolvedAtMs:Date.now()-1000}],
  });
  assert.equal(legacyKnown.failures,2,
    'out-of-capacity failures remain reported until a fresh full sweep');

  // A successful list read clears the previous deferred HTTP code while
  // preserving its historical timestamp separately for diagnostics.
  checkpoints.length=0;
  const scope={sourceId:'chatgpt-web-fixture',accountKey:'fixture',
    accountId:'account-123',projectId,projectName:'1hood',
    projectShortUrl:projectId+'-1hood'};
  const scan=await run({
    pending:{...basePending(),scopes:[scope],failures:69,
      lastDeferredHttpStatus:429,rateLimitUntilMs:Date.now()-300_000,
      rateLimitStreak:2},
    failureDetails:[{conversationId:'recovered',resolvedAtMs:Date.now()-1000}],
    lastRateLimitAtMs:Date.now()-3_600_000,
  });
  assert.equal(scan.hasMore,false);
  assert.equal(scan.failures,0);
  assert(checkpoints.some(s => s.pending && !('lastDeferredHttpStatus' in s.pending)),
    'successful collection must clear stale deferred HTTP status');
  assert.equal(scan.state.lastRateLimitAtMs>0,true,'retain historical 429 timestamp');
  assert.equal(scan.state.accounts.fixture.projects[projectId].name,'1hood');
  assert(requests>=5);
  console.log('PASS accurate unresolved failure count, legacy unknown failures, and clearing stale 429 status after healthy reads');
} finally { globalThis.fetch=previousFetch; }
