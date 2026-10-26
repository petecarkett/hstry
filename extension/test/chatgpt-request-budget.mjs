import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const A = 'g-p-6818bc97551c8191865a07d09f7b3678';
const B = 'g-p-6a80e4e953dc81919a67cce72d95b05f';
const realFetch = globalThis.fetch;
const realChrome = globalThis.chrome;
const realNow = Date.now;
let now = realNow();
let activeRun = 0;
let callsThisRun = 0;
let maxCalls = 0;
let sessionCalls = 0;
let accountCalls = 0;
let sidebarCalls = 0;
let detailCalls = 0;
let listCalls = 0;
let authStaleOnce = true;
let retrySession401 = true;
const events = [];
const store = new Map();
const ingested = [];
const sid = 'fixture-secret-avoid-durable-token';
const old = Math.floor(now/1000) - 3600;

Date.now = () => now;
globalThis.chrome = { storage: { session: {
  get: async key => ({ [key]: store.get(key) }),
  set: async fields => { for (const [k,v] of Object.entries(fields)) store.set(k,v); },
  remove: async key => store.delete(key),
} } };
const msg = id => ({ id, title:id, create_time:old, update_time:old,
  current_node:'m', mapping:{m:{id:'m',parent:null,message:{
    author:{role:'user'},create_time:old,content:{content_type:'text',parts:[id]},
  }}} });
const project = (id,name) => ({ gizmo:{gizmo:{
  id,display:{name},short_url:id+'-'+name.toLowerCase().replaceAll(' ','-'),
}} });
globalThis.fetch = async (url,options={}) => {
  const u=new URL(url);
  assert.equal(u.origin,'https://chatgpt.com','never contact an external service in test');
  callsThisRun++;
  maxCalls=Math.max(maxCalls,callsThisRun);
  events.push({run:activeRun,path:u.pathname,cursor:u.searchParams.get('cursor')});
  assert(callsThisRun<=1,'at most one ChatGPT request per worker run');
  if (u.pathname==='/api/auth/session') {
    sessionCalls++;
    return Response.json({accessToken:sid});
  }
  if (u.pathname.includes('/accounts/check/')) {
    accountCalls++;
    return Response.json({accounts:{
      a:{account:{account_id:'account-workspace',structure:'workspace'}},
      b:{account:{account_id:'account-personal',structure:'personal'}},
    }});
  }
  if (u.pathname==='/backend-api/gizmos/snorlax/sidebar') {
    sidebarCalls++;
    const account=options.headers?.['chatgpt-account-id'];
    if (account==='account-personal') return Response.json({items:[],cursor:null});
    assert.equal(account,'account-workspace');
    return u.searchParams.get('cursor')==='MORE'
      ? Response.json({items:[project(B,'FerroQuant')],cursor:null})
      : Response.json({items:[project(A,'1hood')],cursor:'MORE'});
  }
  if (u.pathname==='/backend-api/conversations') {
    listCalls++;
    return Response.json({items:[],total:0});
  }
  if (u.pathname==='/backend-api/gizmos/'+A+'/conversations') {
    listCalls++;
    return Response.json({items:[{id:'a-conv',gizmo_id:A,update_time:old}],cursor:null});
  }
  if (u.pathname==='/backend-api/gizmos/'+B+'/conversations') {
    listCalls++;
    return Response.json({items:[{id:'b-conv',gizmo_id:B,update_time:old}],cursor:null});
  }
  if (u.pathname==='/backend-api/conversation/retry-throttled') {
    return new Response('',{status:429,headers:{'retry-after':'120'}});
  }
  if (u.pathname==='/backend-api/conversation/retry-session') {
    if (retrySession401) {
      retrySession401=false;
      return new Response('',{status:401});
    }
    return Response.json(msg('retry-session'));
  }
  if (u.pathname==='/backend-api/conversation/a-conv' ||
      u.pathname==='/backend-api/conversation/b-conv') {
    detailCalls++;
    if (authStaleOnce) {
      authStaleOnce=false;
      return new Response('',{status:401});
    }
    return Response.json(msg(u.pathname.endsWith('a-conv')?'a-conv':'b-conv'));
  }
  throw new Error('Unexpected ChatGPT request path '+u.pathname);
};
async function run(state) {
  activeRun++;
  callsThisRun=0;
  const checkpointed=[];
  const result=await syncChatGPT({
    state, report:async()=>{}, register:async()=>{}, log:()=>{},
    checkpoint:async saved=>{checkpointed.push(structuredClone(saved));},
    push:async (_source,_adapter,convs)=>{
      assert.equal(convs.length,1);
      ingested.push(convs[0]);
      return 1;
    },
  });
  assert(callsThisRun<=1);
  assert(!JSON.stringify(result.state).includes(sid),'no token in durable sync state');
  assert(checkpointed.every(s=>!JSON.stringify(s).includes(sid)));
  return result;
}
try {
  let state={};
  let finished;
  for (let i=0;i<32;i++) {
    const result=await run(state);
    state=structuredClone(result.state);
    if (!result.hasMore){finished=result;break;}
    assert(result.retryAfterMinutes>=0.5);
    // Simulate separate alarm invocations; the trusted session store persists.
    now+=15*60_000;
  }
  assert(finished,'bounded 1-request/worker import must complete');
  assert.equal(maxCalls,1);
  assert.equal(ingested.length,2);
  assert.deepEqual(ingested.map(c=>c.externalId),['a-conv','b-conv']);
  assert.deepEqual(ingested.map(c=>c.workspace),[A,B]);
  assert.equal(accountCalls,1,'account discovery only once per sweep');
  assert.equal(sidebarCalls,3,'paginated workspace and personal project discovery');
  assert.equal(sessionCalls,2,'session token reused until invalid/expired');
  assert.equal(detailCalls,3,'a single 401 is retried after refreshing next worker');
  assert.equal(state.pending,undefined,'no stale cursor after completed sweep');
  assert.equal(state.discovery,undefined,'discovery checkpoint cleared when complete');
  assert.equal(store.size,1,'only temporary session token cached');
  assert.equal(listCalls,4,'two project collection lists and two personal lists');
  const sessionSeen=events.filter(e=>e.path==='/api/auth/session').map(e=>e.run);
  assert(sessionSeen.every(run=>events.filter(e=>e.run===run).length===1),
    'authentication refresh is isolated from all other ChatGPT API calls');
  const accountKey='accountw';
  const sourceId='chatgpt-web-'+accountKey;
  const dueFailure={conversationId:'retry-throttled',sourceId,accountId:'account-workspace',
    accountKey,projectId:A,projectName:'1hood',projectShortUrl:A+'-1hood',
    errorType:'TimeoutError',attempts:4,nextRetryAtMs:now-1, resolvedAtMs:null};
  const dueState={...state,paceMs:15*60_000,failureDetails:[dueFailure],
    pending:{scopes:[{accountId:'account-workspace',accountKey,sourceId,
      projectId:A,projectName:'1hood',projectShortUrl:A+'-1hood'}],
      scopeIndex:0,cursor:'0',offset:0,pageIndex:0,scopeFailures:0,
      failures:1,detected:0,processed:0,runStartedMs:now}};
  const deferred=await run(dueState);
  assert.equal(deferred.deferredHttpStatus,429);
  assert.equal(deferred.state.lastRateLimitEndpoint,'targeted-detail');
  assert.equal(deferred.state.pending.retryYieldToScan,true);
  assert(deferred.state.failureDetails[0].nextRetryAtMs>=now+6*60*60_000,
    'the failing conversation must not be retried immediately after a 429');
  const scansBefore=events.filter(e=>e.path.includes('/gizmos/'+A+'/conversations')).length;
  const scan=await run(deferred.state);
  assert(scan.hasMore);
  assert(events.filter(e=>e.path.includes('/gizmos/'+A+'/conversations')).length>scansBefore,
    'the next allowed worker run scans other conversations rather than hammering the failing target');
  assert.equal(deferred.state.failureDetails[0].resolvedAtMs,null);
  const expiredRetry=structuredClone(dueState);
  expiredRetry.failureDetails[0].conversationId='retry-session';
  const beforeExpiry=structuredClone(expiredRetry.failureDetails[0]);
  const refreshed=await run(expiredRetry);
  assert(refreshed.hasMore);
  assert.equal(refreshed.state.failureDetails[0].attempts,beforeExpiry.attempts,
    'a stale authentication token is not a failed conversation attempt');
  assert.equal(refreshed.state.failureDetails[0].nextRetryAtMs,beforeExpiry.nextRetryAtMs);
  assert.equal(store.size,0,'expired cached token must be deleted immediately');
  const tokenOnly=await run(refreshed.state);
  assert(tokenOnly.hasMore);
  assert.equal(store.size,1,'session token re-fetched into memory only');
  assert.equal(events.filter(e=>e.run===activeRun).length,1);
  const afterReauth=await run(tokenOnly.state);
  assert.equal(afterReauth.state.failureDetails[0].resolvedAtMs!==null,true);
  assert(ingested.some(c=>c.externalId==='retry-session'));
  console.log('PASS one remote request per worker: session-only token cache, staged project discovery, saved lists, 401 refresh, targeted 429 isolation, no duplicate imports');
} finally {
  globalThis.fetch=realFetch;
  globalThis.chrome=realChrome;
  Date.now=realNow;
}
