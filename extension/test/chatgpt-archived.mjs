import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const updated = Math.floor(Date.now() / 1000) - 3600;
const calls = [];
const saved = [];
const existingFetch = globalThis.fetch;
const conversation = id => ({
  title: id, create_time: updated, update_time: updated, current_node: 'm',
  mapping: { m: { id: 'm', parent: null, message: { author: { role: 'user' },
    create_time: updated, content: { content_type: 'text', parts: [id] },
  } } },
});
globalThis.fetch = async (url, init = {}) => {
  const target = new URL(url);
  assert.equal(target.origin, 'https://chatgpt.com');
  calls.push({path:target.pathname,archived:target.searchParams.get('is_archived') === 'true'});
  switch (target.pathname) {
    case '/api/auth/session': return Response.json({ accessToken: 'test-only' });
    case '/backend-api/accounts/check/v4-2023-04-27':
      return Response.json({accounts:{}});
    case '/backend-api/gizmos/snorlax/sidebar':
      return Response.json({items:[{gizmo:{gizmo:{id:projectId,
        display:{name:'1hood'},short_url:`${projectId}-1hood`}}}],cursor:null});
    case `/backend-api/gizmos/${projectId}/conversations`:
      return Response.json({items:[],cursor:null});
    case '/backend-api/conversations':
      return Response.json({total:1,items: target.searchParams.get('is_archived') === 'true'
        ? [{id:'archived-one', update_time:updated, gizmo_id:projectId}]
        : [{id:'active-one',update_time:updated}]});
    case '/backend-api/conversation/archived-one':
      assert.equal(init.headers['chatgpt-project-id'],projectId,
        'archived project chat must retain the canonical project header');
      return Response.json({...conversation('archived-one'),gizmo_id:projectId});
    case '/backend-api/conversation/active-one':
      return Response.json(conversation('active-one'));
    default: throw new Error(`Unexpected ChatGPT request: ${target.pathname}`);
  }
};
try {
  let state={};
  for (let i=0;i<10;i++) {
    const result=await syncChatGPT({state,register:async()=>{},report:async()=>{},
      push:async (_source,_adapter,conversations)=>{saved.push(...conversations);return conversations.length;}});
    state=result.state;
    if (!result.hasMore) break;
  }
  assert.deepEqual(saved.map(c=>c.externalId),['active-one','archived-one']);
  assert.equal(saved[1].metadata.projectId,projectId);
  assert.equal(saved[1].metadata.projectName,'1hood');
  const account = Object.values(state.accounts)[0];
  assert(Number.isFinite(account.lastSyncMs));
  assert(Number.isFinite(account.archivedLastSyncMs));
  assert.equal(state.conversationInventory.uniqueCount,2);
  assert.equal(calls.filter(x=>x.path==='/backend-api/conversations' && x.archived).length,1);
  assert.equal(calls.filter(x=>x.path==='/backend-api/conversations' && !x.archived).length,1);
  assert.equal(calls.filter(x=>x.path.startsWith('/backend-api/conversation/')).length,2);
  const repeated=await syncChatGPT({state,register:async()=>{},report:async()=>{},
    push:async (_source,_adapter,conversations)=>{saved.push(...conversations);return conversations.length;}});
  assert.equal(repeated.conversations,0,'unchanged active and archived history must not re-import');
  assert.equal(saved.length,2,'canonical conversation IDs remain unique');
  console.log('PASS archived ChatGPT scope: separate enumeration, canonical project metadata and deduped incremental sync');
} finally { globalThis.fetch=existingFetch; }
