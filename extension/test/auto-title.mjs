import assert from 'node:assert/strict';
import { proposedWorkspaceChatTitle, nextArchivedTaskNumber, taskFromHstryContinuation } from '../lib/live-capture.js';

const projectId = 'g-p-6818bc97551c8191865a07d09f7b3678';
const conversationId = '6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
const sourceId = 'chatgpt-web-workspace1';
const route = { projectId, conversationId };
const scope = { accountId: 'owner-1', sourceId, projectId, projectName: 'FerroQuant' };
const status = { chatgpt: { state: { pending: { scopes: [scope] } } } };
const settings = { chatgptWorkspaceOnly: true, autoNameNewChats: true,
  providers: { chatgpt: true } };
const at = Date.parse('2026-11-07T17:28:00Z');
const title = (s = settings, st = status, r = route, text = 'MT5 integration',
    openedAtMs = at, number = null) =>
  proposedWorkspaceChatTitle(s, st, r, text, openedAtMs, number);
assert.equal(title(), '2026-11-07 17:28 — FerroQuant — MT5 integration');
assert.equal(title(settings, status, route, 'TikTok Automation', at, 12),
  '2026-11-07 17:28 — FerroQuant — TikTok Automation 12');
assert.equal(title(settings, status, route, 'TikTok Automation 11', at, 12),
  '2026-11-07 17:28 — FerroQuant — TikTok Automation 11',
  'existing sequence number is never overwritten');
assert.equal(title(settings, status, route, 'MT5 integration',
  Date.parse('2026-06-01T16:28:00Z')),
  '2026-06-01 17:28 — FerroQuant — MT5 integration',
  'London daylight saving time is applied to the original chat opening');
assert.equal(title(settings, status, route, 'MT5 integration',
  Date.parse('2026-10-25T01:28:00Z')),
  '2026-10-25 01:28 — FerroQuant — MT5 integration',
  'UK winter time is applied after the autumn clock change');
// Root chats have no active-account identity in their URL. A cached Workspace
// scope can persist when the visible browser switches to Personal.
assert.equal(title(settings, { chatgpt: { state: { pending: { scopes: [
  { ...scope, projectId: null, projectName: null } ] } } } },
  { ...route, projectId: null }), null,
  'unprojected chats are not safe to rename from cached Workspace ownership');
for (const flag of ['autoNameNewChats', 'chatgptWorkspaceOnly']) {
  assert.equal(title({ ...settings, [flag]: false }), null, `${flag} must be enabled`);
}
assert.equal(title({ ...settings, providers: { chatgpt: false } }), null);
assert.equal(title(settings, { chatgpt: { state: { pending: { scopes: [
  { ...scope, sourceId: 'chatgpt-web' } ] } } } }), null, 'Personal source cannot be renamed');
assert.equal(title(settings, { chatgpt: { state: { pending: { scopes: [
  scope, { ...scope, accountId: 'other', sourceId: 'chatgpt-web-other' } ] } } } }), null,
  'ambiguous account ownership fails closed');
assert.equal(title(settings, { chatgpt: { state: { pending: { scopes: [
  { ...scope, projectName: '' } ] } } } }), null,
  'unidentified project cannot be named');
for (const generic of ['New chat','ChatGPT','Continue Existing Work','Task Status Check',
  'Advance 1hood Work', 'Continue 1hood Work', 'Read History Chat',
  'Recover Conversation History', 'Continue QA verification', 'Continue Existing Project']) {
  assert.equal(title(settings,status,route,generic),null,`${generic} needs task context`);
}
assert.equal(title(settings,status,route,'Check Telegram Upload Issue',at),
  '2026-11-07 17:28 — FerroQuant — Check Telegram Upload Issue',
  'task-specific titles must remain eligible');
assert.equal(title(settings, status, route, 'MT5 integration', null), null,
  'missing opening timestamp must not use current rename time');
assert.equal(title(settings, status, route, 'MT5 integration', Date.now() + 3_600_000), null,
  'future chat timestamps are rejected');
assert.equal(title(settings, status, route,
  '2026-11-07 17:28 — FerroQuant — MT5 integration'), null,
  'existing formatted titles do not receive a second timestamp');
assert.equal(title(settings, status, route, 'x'.repeat(91)), null);
assert.equal(title(settings, status, route, 'A\nB'), null);

const item = (text, id, workspace = projectId, source = sourceId) => ({
  title: text, external_id: id, workspace, source_id: source, created_at: 100, message_count: 2,
});
const archived = [
  item('TikTok Automation 3', 'p3'),
  item('TikTok Automation 11', 'p11'),
  item('Branch · TikTok Automation 11', 'branch'),
  item('TikTok Automation 14', 'other-project', 'other-project'),
  item('TikTok Automation 16', 'personal', projectId, 'chatgpt-web'),
  item('2026-11-05 08:00 — FerroQuant — TikTok Automation 9', 'dated'),
  item('MT5 evaluator repair', 'unrelated'),
];
assert.equal(nextArchivedTaskNumber('TikTok Automation',
  [{ ...item('TikTok Automation 11', 'iso'), created_at: '2026-11-06T17:28:00Z' }],
  sourceId,projectId,conversationId),12,
  'live HSTRY sessions endpoint ISO timestamp is accepted');
assert.equal(nextArchivedTaskNumber('TikTok Automation',archived,sourceId,projectId,conversationId),12,
  'series continues maximum existing ordinal, excludes branches and other projects');
assert.equal(nextArchivedTaskNumber('TikTok Automation 11',archived,sourceId,projectId,conversationId),null,
  'a user-provided number is authoritative');
assert.equal(nextArchivedTaskNumber('TikTok Automation', [item('TikTok Automation', 'previous')],
  sourceId,projectId,conversationId),2, 'a previous unnumbered chat is series 1');
assert.equal(nextArchivedTaskNumber('Something New',archived,sourceId,projectId,conversationId),null);
assert.equal(nextArchivedTaskNumber('Continue Existing Work',archived,sourceId,projectId,conversationId),null);
assert.equal(nextArchivedTaskNumber('TikTok Automation', [item('TikTok Automation', conversationId)],
  sourceId,projectId,conversationId),null,'current conversation is not counted as its own predecessor');

const continuationId1='11111111-1111-4111-8111-111111111111';
const continuationId2='22222222-2222-4222-8222-222222222222';
const rootId='33333333-3333-4333-8333-333333333333';
const makeLink = id => `https://chatgpt.com/g/${projectId}-1hood/c/${id}`;
const related=[
  { ...item('TikTok Automation 11', rootId), created_at: 100 },
  { ...item('Continue Existing Work', continuationId1), created_at: 200,
    first_user_message: `Continue the unfinished work from this existing ChatGPT conversation: ${makeLink(rootId)}` },
  { ...item('Continue Existing Work', continuationId2), created_at: 300,
    first_user_message: `Continue the unfinished work from this existing ChatGPT conversation: ${makeLink(continuationId1)}` },
  { ...item('Branch · TikTok Automation 11', 'b'), created_at: 210 },
  { ...item('Continue Existing Work', 'empty'), created_at: 240, message_count: 1,
    first_user_message: `Continue the unfinished work from this existing ChatGPT conversation: ${makeLink(rootId)}` },
];
assert.equal(nextArchivedTaskNumber('TikTok Automation', related, sourceId,projectId,'new',400_000),14,
  'two generic predecessor continuations consume 12 and 13; new chat receives 14');
assert.equal(nextArchivedTaskNumber('TikTok Automation', related, sourceId,projectId,continuationId2,250_000),13,
  'historical rename counts only earlier verified chats, not later replies');


const prevId = 'aabaaabb-1111-4222-8333-444444444444';
const olderId = 'bbbbcccc-1111-4222-8333-444444444444';
const prevUrl = `https://chatgpt.com/g/${projectId}-1hood/c/${prevId}`;
const priorSessions = [
  { ...item('Continue Existing Work', prevId),
    first_user_message: `Continue the unfinished work from this existing ChatGPT conversation: https://chatgpt.com/g/${projectId}-1hood/c/${olderId}` },
  item('TikTok Automation 11', olderId),
];
assert.equal(taskFromHstryContinuation('Continue Existing Work',prevUrl,
  priorSessions,sourceId,projectId), 'TikTok Automation',
  'generic continuation finds specific task through verified predecessor lineage');
for (const vague of ['Advance 1hood Work', 'Continue 1hood Work',
  'Read History Chat', 'Continue QA verification']) {
  assert.equal(taskFromHstryContinuation('Continue Existing Work',prevUrl,
    [priorSessions[0], { ...item(vague, olderId) }], sourceId,projectId), null,
    `${vague} must not propagate from a generic predecessor`);
}
assert.equal(taskFromHstryContinuation('Continue Existing Work',prevUrl,
  priorSessions,sourceId,'other-project'), null,
  'cross-project continuation is not trusted');
assert.equal(taskFromHstryContinuation('Continue Existing Work',prevUrl,
  priorSessions,'chatgpt-web',projectId), null,
  'Personal account archive cannot supply Workspace task titles');
assert.equal(taskFromHstryContinuation('Continue Existing Work',null,
  priorSessions,sourceId,projectId), null,
  'unlinked generic chat needs manual or content review');
assert.equal(taskFromHstryContinuation('MT5 evaluator',prevUrl,
  priorSessions,sourceId,projectId), 'MT5 evaluator',
  'ChatGPT specific title is preferred over ancestor text');

console.log('PASS Workspace naming: original London time, task, native sequence, archive numbering, source/project isolation, generic titles');
