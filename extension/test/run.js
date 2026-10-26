// Integration test for the hstry sync extension providers.
//
// Stubs the platform APIs (chatgpt.com, claude.ai) with fixtures, then runs
// the real provider modules and pushes through a real hstry-api /ingest into
// a real database. Usage:
//
//   hstry-api --config <tmp>/config.toml --port 39132 --token testtoken &
//   node extension/test/run.js 39132 testtoken <tmp>/config.toml

import { execFileSync } from 'node:child_process';
import { syncChatGPT } from '../providers/chatgpt.js';
import { syncClaude } from '../providers/claude.js';

const PORT = process.argv[2] ?? '39132';
const TOKEN = process.argv[3] ?? 'testtoken';
const CONFIG_PATH = process.argv[4];
if (!CONFIG_PATH) throw new Error('Pass the isolated test database config path.');

const NOW_S = Date.now() / 1000;
const NOW_ISO = new Date().toISOString();
// Updates must be older than the providers' 5-minute overlap window, or run 2
// legitimately re-fetches them (idempotent by server-side dedupe, but noisy
// for this test).
const OLD_S = NOW_S - 3600;
const OLD_ISO = new Date((NOW_S - 3600) * 1000).toISOString();

const FIXTURES = {
  'chatgpt.com': {
    '/api/auth/session': { accessToken: 'fixture-token' },
    '/backend-api/gizmos/snorlax/sidebar': { items: [], cursor: null },
    '/backend-api/accounts/check/v4-2023-04-27': {
      accounts: {
        default: {
          account: { account_id: 'acc-personal', plan_type: 'plus', structure: 'personal' },
        },
        'team-1': {
          account: { account_id: 'acc-team1', organization_name: 'Fixture Workspace', structure: 'workspace' },
        },
      },
    },
    '/backend-api/conversations': {
      total: 1,
      items: [
        { id: 'gpt-conv-1', title: 'GPT fixture chat', create_time: OLD_S, update_time: OLD_S },
      ],
    },
    '/backend-api/conversation/gpt-archived-1': {
      title: 'Archived GPT fixture',
      create_time: OLD_S,
      update_time: OLD_S,
      current_node: 'archived1',
      mapping: {
        archived1: {
          id: 'archived1', parent: null,
          message: {
            author: { role: 'user' },
            create_time: OLD_S,
            content: { content_type: 'text', parts: ['archived fixture record'] },
          },
        },
      },
    },
    '/backend-api/conversation/gpt-conv-1': {
      title: 'GPT fixture chat',
      create_time: OLD_S,
      update_time: OLD_S,
      current_node: 'n3',
      mapping: {
        n1: { id: 'n1', parent: null, message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
        n2: {
          id: 'n2',
          parent: 'n1',
          message: {
            author: { role: 'user' },
            create_time: NOW_S - 3600,
            content: { content_type: 'text', parts: ['hello from fixture'] },
          },
        },
        n3: {
          id: 'n3',
          parent: 'n2',
          message: {
            author: { role: 'assistant' },
            create_time: NOW_S - 3500,
            metadata: { model_slug: 'gpt-5-3' },
            content: { content_type: 'text', parts: ['fixture response'] },
          },
        },
      },
    },
  },
  'claude.ai': {
    '/api/organizations': {
      organizations: [{ id: 'org-fixture-1', name: 'Personal', capabilities: ['claude_pro'] }],
    },
    '/api/organizations/org-fixture-1/chat_conversations': [
      { uuid: 'claude-conv-1', name: 'Claude fixture chat', created_at: OLD_ISO, updated_at: OLD_ISO },
    ],
    '/api/organizations/org-fixture-1/chat_conversations/claude-conv-1': {
      uuid: 'claude-conv-1',
      name: 'Claude fixture chat',
      created_at: OLD_ISO,
      updated_at: OLD_ISO,
      chat_messages: [
        { sender: 'human', created_at: NOW_ISO, content: [{ type: 'text', text: 'hi claude' }] },
        {
          sender: 'assistant',
          created_at: NOW_ISO,
          content: [
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'hello from claude fixture' },
            { type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'hstry' } },
            { type: 'tool_result', tool_use_id: 't1', content: 'result blob' },
          ],
        },
      ],
    },
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    return realFetch(url, init);
  }
  // Archived conversations are a distinct collection, not a replay of
  // the active collection. Keep one archived fixture for real API ingestion.
  if (parsed.hostname === 'chatgpt.com' && parsed.pathname === '/backend-api/conversations' &&
      parsed.searchParams.get('is_archived') === 'true') {
    return Response.json({
      total: 1,
      items: [{id: 'gpt-archived-1', title: 'Archived GPT fixture', create_time: OLD_S, update_time: OLD_S}],
    });
  }
  const fixture = FIXTURES[parsed.hostname]?.[parsed.pathname];
  if (fixture === undefined) {
    return new Response('not found', { status: 404 });
  }
  return new Response(JSON.stringify(fixture), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const pushes = [];
async function push(sourceId, adapter, conversations) {
  pushes.push({ sourceId, count: conversations.length });
  const res = await realFetch(`http://127.0.0.1:${PORT}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ source: sourceId, adapter, conversations }),
  });
  if (!res.ok) throw new Error(`/ingest -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.conversations;
}

const log = message => console.log(`  [provider] ${message}`);
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failures++;
}

// --- First sync: bounded Chrome worker chunks, preserving the same cursor ---
let gpt1State = {};
let chatgptCount = 0;
let gpt1;
for (let i = 0; i < 8; i++) {
  gpt1 = await syncChatGPT({ state: gpt1State, push, log });
  gpt1State = gpt1.state;
  chatgptCount += gpt1.conversations;
  if (!gpt1.hasMore) break;
}
check('chatgpt complete sync', gpt1.hasMore, false);
const claude1 = await syncClaude({ state: {}, push, log });

check('chatgpt run 1 conversations', chatgptCount, 4); // active + archived in personal and workspace
check('claude run 1 conversations', claude1.conversations, 1);
check(
  'source ids',
  [...new Set(pushes.map(p => p.sourceId))].sort(),
  ['chatgpt-web', 'chatgpt-web-accteam1', 'claude-web']
);

// --- Second run: incremental, nothing new ---
pushes.length = 0;
const gpt2 = await syncChatGPT({ state: gpt1.state, push, log });
const claude2 = await syncClaude({ state: claude1.state, push, log });
check('chatgpt run 2 conversations (incremental)', gpt2.conversations, 0);
check('claude run 2 conversations (incremental)', claude2.conversations, 0);
check('run 2 pushes', pushes.length, 0);

// Check the actual indexed database through the maintained hstry CLI.
const search = JSON.parse(execFileSync('hstry', [
  '--config', CONFIG_PATH, '--json', 'search', 'fixture', '--limit', '50', '--max-chars', '25000',
], { encoding: 'utf8' }));
const hits = search.result?.hits ?? [];
const sources = [...new Set(hits.map(h => h.provenance?.source))].sort();
check('search finds all sources', sources, ['chatgpt-web', 'chatgpt-web-accteam1', 'claude-web']);
const gptHit = hits.find(h => h.provenance?.source === 'chatgpt-web' && h.role === 'assistant');
check('gpt assistant content', gptHit?.snippet, 'fixture response');
const archivedSearch = JSON.parse(execFileSync('hstry', [
  '--config', CONFIG_PATH, '--json', 'search', 'archived', '--limit', '10',
], { encoding: 'utf8' }));
check('archived conversations indexed in both ChatGPT accounts',
  archivedSearch.result?.hits?.filter(hit => hit.snippet?.includes('archived fixture record')).length,
  2);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
