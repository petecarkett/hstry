// ChatGPT provider: syncs conversations (personal + Teams workspaces) via the
// chatgpt.com backend API, authenticated with the browser session cookies.

import { canonicalMessages } from '../lib/live-capture.js';
import {
  NotLoggedInError,
  RateLimitedError,
  fetchJson,
  shortId,
  textPart,
  thinkingPart,
  toMs,
} from '../lib/common.js';

const BASE = 'https://chatgpt.com';
const PAGE_SIZE = 50;
// Refetch a little history on every run so near-simultaneous edits are not
// missed between polls.
const OVERLAP_MS = 5 * 60 * 1000;
// Pace detail requests to stay under ChatGPT's rate limit. Backoff in
// fetchJson handles bursts, but pacing avoids tripping 429 in the first place.
// One conversation per scheduled run avoids rapid bursts against ChatGPT.
const CHUNK_SIZE = 1;
const PAGES_PER_RUN = 1;
const PACE_START_MS = 60_000;
const PACE_MIN_MS = 30_000;
const PACE_MAX_MS = 15 * 60_000;
const PACE_HEALTHY_READS = 24;
const paceMs = state => Math.max(PACE_MIN_MS, Math.min(PACE_MAX_MS,
  state?.paceMs ?? PACE_START_MS));
const slower = state => ({ ...state, paceMs: Math.min(PACE_MAX_MS, paceMs(state) * 2),
  healthyReads: 0 });
const FAILURE_DETAIL_LIMIT = 100;
// Retry individual failed details outside the normal page cursor. Keep Chrome
// service worker requests below its idle deadline; back off between attempts.
const RETRY_BASE_MS = 30 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const retryDelayMs = attempts => Math.min(RETRY_MAX_MS,
  RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, attempts - 1)));

export function failureType(error) {
  if (Number.isInteger(error?.status)) return `HTTP ${error.status}`;
  if (error?.name === 'TimeoutError' || /timed out|timeout/i.test(error?.message ?? '')) {
    return 'TimeoutError';
  }
  if (error?.name === 'AbortError') return 'AbortError';
  if (error?.name === 'TypeError' && /failed to fetch|network/i.test(error?.message ?? '')) {
    return 'NetworkError';
  }
  return /^[A-Za-z][A-Za-z0-9]*Error$/.test(error?.name ?? '')
    ? error.name : 'UnknownError';
}
// Obey server delays and cap repeated fallback backoff without extra timers.
function retryAfterMinutes(error, streak = 1) {
  const serverMinutes = Math.ceil((error.retryAfterMs || 60_000) / 60_000);
  const fallbackMinutes = Math.min(60, 5 * 2 ** Math.min(4, Math.max(0, streak - 1)));
  return Math.max(serverMinutes, fallbackMinutes);
}
// The durable sync scheduler owns retries; never send a second request on 429.
const FETCH_OPTIONS = { retries: 0 };
// Chrome may terminate an extension worker if a fetch has no response for 30s.
const fetchChatGPTJson = (url, init = {}) =>
  fetchJson(url, { ...init, signal: AbortSignal.timeout(25_000) }, FETCH_OPTIONS);

// Only repeatedly timed-out conversations use a longer read. Chrome terminates
// extension *service-worker* fetches after 30s, but an already-open ChatGPT tab
// can fetch in its page context without restarting the import or opening a tab.
async function fetchSlowConversationInTab(id, headers) {
  if (!globalThis.chrome?.tabs?.query || !chrome.scripting?.executeScript) return null;
  let tabs;
  try { tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' }); }
  catch (cause) {
    const error = new Error('Cannot inspect an existing ChatGPT tab', { cause });
    error.name = 'TabReadError';
    throw error;
  }
  const tab = tabs.find(tab => Number.isInteger(tab.id) &&
    tab.status === 'complete' && tab.url?.startsWith('https://chatgpt.com/'));
  if (!tab) return null;
  let results;
  try { results = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: 'ISOLATED',
    func: async (conversationId, auth) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        const response = await fetch(
          `https://chatgpt.com/backend-api/conversation/${encodeURIComponent(conversationId)}`,
          { credentials: 'include', headers: auth, signal: controller.signal });
        if (!response.ok) return {
          status: response.status, retryAfter: response.headers.get('retry-after'),
        };
        return { detail: await response.json() };
      } catch (error) {
        return { name: error.name, error: String(error.message ?? error).slice(0, 150) };
      } finally {
        clearTimeout(timeout);
      }
    },
    args: [id, headers],
  }); } catch (cause) {
    // A tab navigation or denied injection is not proof that ChatGPT data is
    // unavailable; retain the original TimeoutError for future recovery.
    const error = new Error('Existing ChatGPT tab became unavailable', { cause });
    error.name = 'TabReadError';
    throw error;
  }
  const result = results?.[0]?.result;
  if (!result) {
    const error = new Error('Long conversation read returned no result');
    error.name = 'TabReadError';
    throw error;
  }
  if (result.detail) return result.detail;
  if (result.status === 401 || result.status === 403) throw new NotLoggedInError('chatgpt.com');
  if ([429, 502, 503].includes(result.status)) {
    const value = result.retryAfter?.trim();
    const seconds = value ? Number(value) : NaN;
    const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
      : value && Number.isFinite(Date.parse(value))
        ? Math.max(0, Date.parse(value) - Date.now()) : null;
    throw new RateLimitedError(`ChatGPT conversation detail -> ${result.status}`,
      retryAfterMs ?? 60_000, result.status, retryAfterMs);
  }
  if (result.status) {
    const error = new Error(`ChatGPT conversation detail -> ${result.status}`);
    error.status = result.status;
    throw error;
  }
  const error = new Error(result.error || 'Long conversation read failed');
  error.name = result.name === 'AbortError' ? 'TimeoutError' : result.name || 'Error';
  throw error;
}

// Browser-session memory only: token never enters a durable checkpoint.
const SESSION_KEY = 'hstryChatGPTAccessToken';
const SESSION_TTL_MS = 2 * 60 * 60_000;
const sessionStore = () => globalThis.chrome?.storage?.session ?? null;
async function clearSessionToken() {
  if (sessionStore()) await sessionStore().remove(SESSION_KEY);
}
async function getAccessToken() {
  const store = sessionStore();
  if (store) {
    const cached = (await store.get(SESSION_KEY))[SESSION_KEY];
    if (typeof cached?.token === 'string' &&
        cached.expiresAtMs > Date.now() + 30_000) {
      return { token: cached.token, fetched: false, fromCache: true };
    }
  }
  const data = await fetchChatGPTJson(BASE + '/api/auth/session');
  if (!data?.accessToken) throw new NotLoggedInError('chatgpt.com');
  if (store) await store.set({ [SESSION_KEY]: {
    token: data.accessToken, expiresAtMs: Date.now() + SESSION_TTL_MS,
  } });
  return { token: data.accessToken, fetched: Boolean(store), fromCache: false };
}

function authHeaders(token, accountId) {
  const headers = { Authorization: `Bearer ${token}` };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

/** Enumerate accounts (personal + Teams workspaces). Falls back to the
 * default account when the accounts endpoint is unavailable. */
async function listAccounts(token) {
  try {
    const data = await fetchChatGPTJson(`${BASE}/backend-api/accounts/check/v4-2023-04-27`, {
      headers: authHeaders(token),
    });
    const accounts = [];
    for (const entry of Object.values(data?.accounts ?? {})) {
      const account = entry?.account ?? entry;
      const id = account?.account_id ?? account?.id;
      if (!id || account?.is_deactivated) continue;
      if (accounts.some(a => a.id === id)) continue;
      accounts.push({
        id,
        name: account?.organization_name || account?.name || account?.plan_type || 'personal',
        isWorkspace: (account?.structure ?? account?.plan_type) === 'workspace',
      });
    }
    if (accounts.length > 0) return accounts;
  } catch (error) {
    // Only a missing/retired account endpoint permits single-account fallback.
    // Timeouts, 5xx and rate limits must not silently hide workspace projects.
    if (error.status !== 404 && error.status !== 410) throw error;
  }
  return [{ id: null, name: 'default', isWorkspace: false }];
}

// Project chats are not reliably present in the ordinary conversation list.
// Collect project scopes from the authenticated project's own listing.
const PROJECT_ID = /^g-p-[0-9a-f]{32}$/i;
function exactProjectId(value) {
  if (typeof value !== 'string') return null;
  const match = /^g-p-[0-9a-f]{32}(?=$|-)/i.exec(value);
  return match ? match[0] : null;
}

function projectFromUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.origin !== BASE) return null;
    return exactProjectId(url.pathname.split('/').find((part, index, parts) => parts[index - 1] === 'g'));
  } catch { return null; }
}

async function getProjectsPage(token, accountId, cursor) {
  const url = new URL(BASE + '/backend-api/gizmos/snorlax/sidebar');
  url.searchParams.set('conversations_per_gizmo', '0');
  url.searchParams.set('owned_only', 'false');
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  const data = await fetchChatGPTJson(url.toString(), {
    headers: authHeaders(token, accountId),
  });
  if (!Array.isArray(data?.items)) throw new Error('ChatGPT project list has an unexpected response shape');
  if (data.cursor != null && data.cursor !== '' && typeof data.cursor !== 'string') {
    throw new Error('ChatGPT project pagination cursor is invalid');
  }
  const projects = data.items.map(entry => {
    const project = entry?.gizmo?.gizmo ?? entry?.gizmo ?? entry;
    const id = exactProjectId(project?.id);
    if (!id) return null;
    const shortUrl = project.short_url;
    return {
      id,
      name: typeof project?.display?.name === 'string' ? project.display.name : null,
      shortUrl: typeof shortUrl === 'string' && shortUrl.startsWith(id) &&
          /^[a-zA-Z0-9-]+$/.test(shortUrl) ? shortUrl : id,
    };
  }).filter(Boolean);
  return { projects, next: data.cursor || null };
}

async function listProjects(token, accountId) {
  const result = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; page < 1000; page++) {
    const response = await getProjectsPage(token, accountId, cursor);
    for (const project of response.projects) {
      if (seenIds.has(project.id)) continue;
      seenIds.add(project.id);
      result.push(project);
    }
    if (response.next === null) return result;
    if (seenCursors.has(response.next)) {
      throw new Error('ChatGPT project pagination cursor is repeated');
    }
    seenCursors.add(response.next);
    cursor = response.next;
  }
  throw new Error('ChatGPT project enumeration exceeded page safety limit');
}

async function getCollectionPage(token, scope, cursor, offset) {
  const url = scope.projectId
    ? `${BASE}/backend-api/gizmos/${scope.projectId}/conversations?cursor=${encodeURIComponent(cursor ?? '0')}`
    : `${BASE}/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated${scope.archived ? '&is_archived=true' : ''}`;
  const data = await fetchChatGPTJson(url, { headers: authHeaders(token, scope.accountId) });
  if (!Array.isArray(data?.items)) {
    throw new Error(`ChatGPT ${scope.projectId ? 'project' : 'personal'} conversation list has an unexpected response shape`);
  }
  const next = scope.projectId
    ? (data.cursor ?? null)
    : data.items.length === PAGE_SIZE && (!Number.isFinite(data.total) || offset + PAGE_SIZE < data.total)
      ? offset + PAGE_SIZE : null;
  if (scope.projectId && next !== null && typeof next !== 'string') {
    throw new Error('ChatGPT project conversation cursor has an unexpected response shape');
  }
  return { items: data.items, next };
}

function projectContext(item, detail, scope) {
  const candidates = [
    exactProjectId(scope.projectId),
    exactProjectId(item?.gizmo_id),
    exactProjectId(item?.project_id),
    exactProjectId(detail?.gizmo_id),
    exactProjectId(detail?.project_id),
    projectFromUrl(item?.url),
    projectFromUrl(detail?.url),
  ].filter(Boolean);
  const ids = [...new Set(candidates)];
  if (ids.length > 1) throw new Error('Conflicting ChatGPT project IDs on one conversation');
  const id = ids[0] ?? null;
  return id ? { id, name: scope.projectId === id ? scope.projectName : null,
    shortUrl: scope.projectId === id ? scope.projectShortUrl : id } : null;
}

/** Linearize the active branch of the mapping tree (current_node -> root).
 * If ChatGPT returns a broken parent chain, preserve all message-bearing nodes
 * in deterministic chronological order rather than silently losing the prefix. */
function linearize(detail) {
  const mapping = detail?.mapping ?? {};
  const chain = [];
  const visited = new Set();
  let nodeId = detail?.current_node;
  let incomplete = !nodeId;

  while (nodeId) {
    if (!mapping[nodeId] || visited.has(nodeId)) {
      incomplete = true;
      break;
    }
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }

  if (!incomplete) {
    chain.reverse();
    return chain;
  }

  const compareEntries = (left, right) =>
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id) ||
    left.key.localeCompare(right.key);
  const seenIds = new Set();
  const entries = Object.entries(mapping)
    .map(([key, node]) => ({
      key,
      node,
      id: String(node?.id ?? key),
      createdAt: toMs(node?.message?.create_time ?? node?.create_time) ?? 0,
    }))
    .sort(compareEntries)
    .filter(entry => {
      if (seenIds.has(entry.id)) return false;
      seenIds.add(entry.id);
      return true;
    });

  // A topological sort keeps parents before children when ChatGPT assigns the
  // same timestamp to several nodes. The chronological/id ordering of the
  // ready queue makes the result deterministic across repeated syncs.
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const children = new Map();
  const indegree = new Map(entries.map(entry => [entry.id, 0]));
  for (const entry of entries) {
    const parentKey = entry.node?.parent;
    const parentId = parentKey ? String(mapping[parentKey]?.id ?? parentKey) : null;
    if (!parentId || parentId === entry.id || !byId.has(parentId)) continue;
    indegree.set(entry.id, 1);
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry.id);
    children.set(parentId, siblings);
  }

  const ready = entries.filter(entry => indegree.get(entry.id) === 0).sort(compareEntries);
  const ordered = [];
  while (ready.length > 0) {
    const entry = ready.shift();
    ordered.push(entry);
    for (const childId of children.get(entry.id) ?? []) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) {
        ready.push(byId.get(childId));
        ready.sort(compareEntries);
      }
    }
  }

  if (ordered.length < entries.length) {
    const orderedIds = new Set(ordered.map(entry => entry.id));
    ordered.push(...entries.filter(entry => !orderedIds.has(entry.id)).sort(compareEntries));
  }

  return ordered.filter(entry => entry.node?.message).map(entry => entry.node);
}

const NON_TEXT_METADATA_KEYS = new Set([
  'content_type',
  'language',
  'message_type',
  'model',
  'model_slug',
  'request_id',
  'status',
]);

function recoverStrings(value, output) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) recoverStrings(item, output);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      NON_TEXT_METADATA_KEYS.has(childKey) ||
      childKey === 'asset_pointer' ||
      childKey.endsWith('_id') ||
      childKey.endsWith('_slug')
    ) {
      continue;
    }
    recoverStrings(childValue, output);
  }
}

function extractMessage(node) {
  const msg = node?.message;
  if (!msg) return null;
  const role = msg.author?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  // Hidden user turns can contain the prompts for scheduled/automated replies.
  // The flag controls ChatGPT's UI, not whether the turn belongs in history.
  // Keep recoverable user/assistant content so a long chat retains its context.
  const parts = [];
  const texts = [];
  const content = msg.content ?? {};
  const addText = text => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    texts.push(trimmed);
    parts.push(textPart(trimmed));
  };

  if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
    for (const part of content.parts ?? []) {
      if (typeof part === 'string') {
        addText(part);
      } else if (part?.content_type === 'image_asset_pointer') {
        addText(`[image] ${part.asset_pointer ?? ''}`.trim());
      } else {
        const recovered = [];
        recoverStrings(part, recovered);
        for (const text of recovered) addText(text);
      }
    }
  } else if (content.content_type === 'code' && content.text) {
    addText(`\`\`\`${content.language ?? ''}\n${content.text}\n\`\`\``);
  } else if (content.content_type === 'thoughts') {
    for (const thought of content.thoughts ?? []) {
      const text = thought?.content ?? thought?.summary;
      if (text) parts.push(thinkingPart(text));
    }
  } else if (content.content_type === 'image_asset_pointer') {
    addText(`[image] ${content.asset_pointer ?? ''}`.trim());
  } else {
    const recovered = [];
    recoverStrings(content, recovered);
    for (const text of recovered) addText(text);
  }

  if (texts.length === 0 && parts.length === 0) {
    const recovered = [];
    recoverStrings(msg.metadata, recovered);
    for (const text of recovered) addText(text);
  }

  const contentStr = texts.join('\n').trim();
  if (!contentStr && parts.length === 0) return null;

  return {
    role,
    content: contentStr,
    createdAt: toMs(msg.create_time),
    model: msg.metadata?.model_slug ?? null,
    parts,
    ...(typeof (msg.id ?? node.id) === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(msg.id ?? node.id)
      ? { metadata: { messageId: (msg.id ?? node.id).toLowerCase() } } : {}),
  };
}

function toParsedConversation(detail, item, scope) {
  const messages = linearize(detail).map(extractMessage).filter(Boolean);
  if (messages.length === 0) return null;
  const project = projectContext(item, detail, scope);
  const projectDeclared = Boolean(scope.projectId) || [item, detail].some(obj =>
    obj && (Object.hasOwn(obj, 'gizmo_id') || Object.hasOwn(obj, 'project_id'))
  ) || Boolean(projectFromUrl(item?.url) || projectFromUrl(detail?.url));
  const model = [...messages].reverse().find(m => m.model)?.model ?? null;
  const conversationId = item.id;
  const url = project
    ? `${BASE}/g/${project.shortUrl}/c/${conversationId}`
    : `${BASE}/c/${conversationId}`;

  return {
    externalId: conversationId,
    title: detail?.title ?? item.title ?? null,
    createdAt: toMs(detail?.create_time ?? item.create_time) ?? messages[0].createdAt ?? Date.now(),
    updatedAt: toMs(detail?.update_time ?? item.update_time),
    model,
    provider: 'openai',
    // Workspace is the exact project ID, never an inferred topic or account.
    workspace: project?.id ?? null,
    messages,
    metadata: {
      url,
      ...(scope.accountId ? { accountId: scope.accountId } : {}),
      ...(projectDeclared ? { projectId: project?.id ?? null, projectName: project?.name ?? null } : {}),
    },
  };
}

function unresolvedFailureCount(state) {
  const records = Array.isArray(state?.failureDetails) ? state.failureDetails : [];
  return Math.max(
    records.filter(record => !record.resolvedAtMs).length,
    state?.pending?.untrackedFailures ?? 0,
    // Older checkpoints without detail IDs cannot prove earlier failures recovered.
    records.length === 0 ? (state?.pending?.failures ?? 0) : 0,
  );
}

export async function syncChatGPT({
  state,
  push,
  register = async () => {},
  log = () => {},
  report = async () => {},
  checkpoint = async () => {},
  onCanonicalIngest = async () => {},
  pendingLiveConversationIds = [],
}) {
  await report({ phase: 'discovering' });
  const queueDiscovery = async (error, endpoint = 'discovery') => {
    if (!(error instanceof RateLimitedError)) throw error;
    const streak = Math.min(5, (state?.discoveryRateLimitStreak ?? 0) + 1);
    const delay = retryAfterMinutes(error, streak);
    const observedAtMs = Date.now();
    const deferred = { ...(error.status === 429 ? slower(state) : state),
      ...(error.status === 429 ? { lastRateLimitEndpoint: endpoint,
        lastRateLimitAtMs: observedAtMs } : {}), discoveryRateLimitStreak: streak,
      discoveryRateLimitUntilMs: observedAtMs + delay * 60_000,
      serverRetryAfterUntilMs: Number.isFinite(error.serverRetryAfterMs)
        ? observedAtMs + error.serverRetryAfterMs : null,
      discoveryDeferredHttpStatus: error.status };
    await checkpoint(deferred);
    await report({ phase: 'queued', detected: state?.pending?.detected ?? 0,
      processed: state?.pending?.processed ?? 0, failed: state?.pending?.failures ?? 0 });
    return { state: deferred, conversations: 0, hasMore: true,
      retryAfterMinutes: delay, deferredHttpStatus: error.status,
      failures: unresolvedFailureCount(deferred) };
  };
  const pacedMode = Boolean(sessionStore());
  const queueNext = async nextState => {
    await checkpoint(nextState);
    await report({ phase: 'queued',
      detected: nextState.pending?.detected ?? 0,
      processed: nextState.pending?.processed ?? 0,
      failed: nextState.pending?.failures ?? 0 });
    return { state: nextState, conversations: 0, hasMore: true,
      failures: unresolvedFailureCount(nextState),
      retryAfterMinutes: paceMs(nextState) / 60_000 };
  };
  let tokenInfo;
  const authFailed = async (error, nextState) => {
    if (!(error instanceof NotLoggedInError) || !tokenInfo?.fromCache) throw error;
    await clearSessionToken();
    return queueNext(nextState);
  };
  try { tokenInfo = await getAccessToken(); }
  catch (error) { return queueDiscovery(error, 'session'); }
  // Obtaining a session token consumes the entire remote request budget.
  if (tokenInfo.fetched) return queueNext(state ?? {});
  const token = tokenInfo.token;
  let pending = state?.pending?.scopes ? { ...state.pending } : null;
  if (!pending && pacedMode) {
    const discovery = state?.discovery ?? {
      accounts: null, accountIndex: 0, scopes: [], cursor: null,
      pageCount: 0, seenCursors: [],
    };
    try {
      if (!Array.isArray(discovery.accounts)) {
        const accounts = await listAccounts(token);
        return queueNext({ ...state, discovery: { ...discovery, accounts } });
      }
      const account = discovery.accounts[discovery.accountIndex];
      if (!account) throw new Error('Saved ChatGPT account discovery is invalid');
      const response = await getProjectsPage(token, account.id, discovery.cursor);
      const accountKey = account.id ? shortId(account.id) : 'default';
      const sourceId = account.id && account.isWorkspace
        ? 'chatgpt-web-' + accountKey : 'chatgpt-web';
      const scopes = discovery.scopes.slice();
      const seenProjects = new Set(scopes.filter(scope =>
        scope.accountKey === accountKey && scope.projectId).map(scope => scope.projectId));
      for (const project of response.projects) {
        if (seenProjects.has(project.id)) continue;
        seenProjects.add(project.id);
        scopes.push({ accountId: account.id, accountKey, accountName: account.name,
          sourceId, projectId: project.id, projectName: project.name,
          projectShortUrl: project.shortUrl });
      }
      if (response.next === null) {
        scopes.push({ accountId: account.id, accountKey, accountName: account.name,
          sourceId, projectId: null, projectName: null, projectShortUrl: null });
        scopes.push({ accountId: account.id, accountKey, accountName: account.name,
          sourceId, projectId: null, projectName: null, projectShortUrl: null, archived: true });
        const accountIndex = discovery.accountIndex + 1;
        if (accountIndex === discovery.accounts.length) {
          const nextState = { ...state, pending: {
            scopes, scopeIndex: 0, offset: 0, cursor: '0', pageIndex: 0,
            scopeFailures: 0, failures: 0, detected: 0, processed: 0,
            runStartedMs: Date.now(),
          } };
          delete nextState.discovery;
          return queueNext(nextState);
        }
        return queueNext({ ...state, discovery: { ...discovery,
          scopes, accountIndex, cursor: null, pageCount: 0, seenCursors: [] } });
      }
      if (discovery.pageCount >= 999 ||
          discovery.seenCursors.includes(response.next) ||
          response.next === discovery.cursor) {
        throw new Error('ChatGPT project discovery pagination repeated or exceeded limit');
      }
      return queueNext({ ...state, discovery: { ...discovery, scopes,
        cursor: response.next, pageCount: discovery.pageCount + 1,
        seenCursors: [...discovery.seenCursors, response.next] } });
    } catch (error) {
      if (error instanceof NotLoggedInError) return authFailed(error, state ?? {});
      return queueDiscovery(error, 'discovery');
    }
  }
  if (!pending) {
    try {
    const accounts = await listAccounts(token);
    const scopes = [];
    for (const account of accounts) {
      const accountKey = account.id ? shortId(account.id) : 'default';
      const sourceId = account.id && account.isWorkspace ? `chatgpt-web-${accountKey}` : 'chatgpt-web';
      for (const project of await listProjects(token, account.id)) {
        scopes.push({
          accountId: account.id, accountKey, accountName: account.name, sourceId,
          projectId: project.id, projectName: project.name, projectShortUrl: project.shortUrl,
        });
      }
      // Large personal archives must not starve project conversations.
      scopes.push({
        accountId: account.id, accountKey, accountName: account.name, sourceId,
        projectId: null, projectName: null, projectShortUrl: null,
      });
      scopes.push({
        accountId: account.id, accountKey, accountName: account.name, sourceId,
        projectId: null, projectName: null, projectShortUrl: null, archived: true,
      });
    }
    pending = {
      scopes, scopeIndex: 0, offset: 0, cursor: '0', pageIndex: 0,
      scopeFailures: 0, failures: 0, detected: 0, processed: 0,
      runStartedMs: Date.now(),
    };
    } catch (error) {
      if (error instanceof NotLoggedInError) return authFailed(error, state ?? {});
      return queueDiscovery(error, 'discovery');
    }
  }

  // Existing checkpoints may predate archived-chat enumeration. Appending
  // scopes preserves their saved cursor and index without replaying pages.
  if (!pending.scopes.some(scope => scope.archived)) {
    pending.scopes.push(...pending.scopes.filter(scope => !scope.projectId)
      .map(scope => ({ ...scope, archived: true })));
  }
  // A midway upgrade can report a lower bound, never a certified total.
  if (!pending.inventory) {
    pending.inventory = { ids: [], completeFromStart: pending.scopeIndex === 0 &&
      pending.pageIndex === 0 && pending.offset === 0 &&
      (pending.cursor == null || pending.cursor === '0') && !pending.personalResume };
  } else {
    pending.inventory = { ...pending.inventory, ids: [...pending.inventory.ids] };
  }

  const accounts = Object.fromEntries(
    Object.entries(state?.accounts ?? {}).map(([key, account]) => [
      key, { ...account, projects: { ...account?.projects } },
    ])
  );
  const failureDetails = Array.isArray(state?.failureDetails)
    ? state.failureDetails.slice(-FAILURE_DETAIL_LIMIT).map(detail => ({ ...detail })) : [];
  if (!failureDetails.length && pending.failures > 0 && pending.untrackedFailures == null) {
    pending.untrackedFailures = pending.failures;
  }
  const newState = { ...state, accounts, failureDetails,
    // Cached ownership is derived from canonical discovery, not another SSOT.
    sourceRoutes: pending.scopes.map(scope => ({ accountId: scope.accountId,
      sourceId: scope.sourceId, projectId: scope.projectId,
      projectName: scope.projectName })) };
  const pendingLive = new Set(pendingLiveConversationIds);
  const paceMinutes = () => paceMs(newState) / 60_000;
  const outstanding = () => unresolvedFailureCount({ ...newState, pending });
  const clearDeferredStatus = () => {
    delete pending.lastDeferredHttpStatus;
    delete pending.rateLimitUntilMs;
    delete newState.serverRetryAfterUntilMs;
  };
  const healthyRead = () => {
    clearDeferredStatus();
    const count = (newState.healthyReads ?? 0) + 1;
    if (count >= PACE_HEALTHY_READS) {
      // Increase throughput only after a substantial error-free window.
      newState.paceMs = Math.max(PACE_MIN_MS, Math.ceil(paceMs(newState) * 0.8));
      newState.healthyReads = 0;
    } else {
      newState.healthyReads = count;
    }
  };
  // A successful authentication/discovery invalidates its earlier cooldown.
  // Carrying it forward can delay healthy work after the last 429.
  delete newState.discoveryRateLimitStreak;
  delete newState.discoveryRateLimitUntilMs;
  delete newState.discoveryDeferredHttpStatus;
  // The six failures recorded before this repair lack full account metadata.
  // Recover it from the existing checkpoint scopes, not a separate queue.
  for (const failure of failureDetails) {
    const scope = pending.scopes.find(scope =>
      scope.accountKey === failure.accountKey &&
      (scope.projectId ?? null) === failure.projectId);
    if (scope && !failure.sourceId) {
      failure.accountId = scope.accountId;
      failure.sourceId = scope.sourceId;
    }
  }
  let total = 0;
  let thisRun = 0;
  let pagesThisRun = 0;
  const checkpointNow = async () => {
    const snapshot = { ...newState, pending: { ...pending } };
    await checkpoint(snapshot);
    return snapshot;
  };
  const renewAfter401 = error => authFailed(error,
    { ...newState, pending: { ...pending } });
  const deferRateLimit = async (error, endpoint) => {
    if (error.status === 429) {
      Object.assign(newState, slower(newState));
      newState.lastRateLimitEndpoint = endpoint;
      newState.lastRateLimitAtMs = Date.now();
    }
    pending.rateLimitStreak = Math.min(5, (pending.rateLimitStreak ?? 0) + 1);
    const delay = retryAfterMinutes(error, pending.rateLimitStreak);
    const observedAtMs = Date.now();
    pending.rateLimitUntilMs = observedAtMs + delay * 60_000;
    newState.serverRetryAfterUntilMs = Number.isFinite(error.serverRetryAfterMs)
      ? observedAtMs + error.serverRetryAfterMs : null;
    pending.lastDeferredHttpStatus = error.status;
    const snapshot = await checkpointNow();
    await report({ phase: 'queued', detected: pending.detected,
      processed: pending.processed, failed: pending.failures });
    return { state: snapshot, conversations: total, hasMore: true,
      retryAfterMinutes: delay, deferredHttpStatus: error.status,
      failures: outstanding() };
  };
  // A repeatedly rate-limited detail must not starve the saved list cursor.
  // Give a scan one turn after a retry hits the limit; migrate 0.4.6 streaks.
  const scanTurn = pending.scopeIndex < pending.scopes.length &&
    (pending.retryYieldToScan === true ||
      (pending.retryYieldToScan == null && pending.rateLimitStreak >= 3 &&
        pending.lastDeferredHttpStatus === 429));
  pending.retryYieldToScan = false;
  await checkpointNow();

  // At most one due retry per worker run. Persist the attempt and its next
  // retry time BEFORE fetching so a killed worker cannot hammer one timeout.
  const now = Date.now();
  const failure = !scanTurn && failureDetails.find(detail =>
    !detail.resolvedAtMs && detail.sourceId &&
    (detail.nextRetryAtMs ??
      ((detail.lastFailedAtMs ?? 0) + RETRY_BASE_MS)) <= now);
  if (failure) {
    const scope = pending.scopes.find(scope =>
      scope.accountKey === failure.accountKey &&
      (scope.projectId ?? null) === failure.projectId);
    const retryScope = scope ?? {
      accountId: failure.accountId, sourceId: failure.sourceId,
      projectId: failure.projectId, projectName: failure.projectName ?? null,
      projectShortUrl: failure.projectShortUrl ?? failure.projectId,
    };
    const beforeRetry = { attempts: failure.attempts,
      lastAttemptAtMs: failure.lastAttemptAtMs,
      nextRetryAtMs: failure.nextRetryAtMs };
    failure.attempts = (failure.attempts ?? 1) + 1;
    failure.lastAttemptAtMs = now;
    failure.nextRetryAtMs = now + retryDelayMs(failure.attempts);
    await checkpointNow();
    await report({ phase: 'retrying', detected: pending.detected,
      processed: pending.processed, failed: pending.failures });
    // Registration and ingestion belong to the local DB trust boundary. Do
    // not swallow those failures as remote conversation timeouts.
    await register(failure.sourceId, 'chatgpt-web');
    const headers = authHeaders(token, retryScope.accountId);
    if (retryScope.projectId) headers['chatgpt-project-id'] = retryScope.projectId;
    const item = { id: failure.conversationId };
    let conv;
    let confirmed = {};
    let usedLongRead = false;
    try {
      // Third and later attempts use an existing ChatGPT tab when available;
      // only one network request is sent and the saved retry cooldown remains.
      const slowDetail = failure.errorType === 'TimeoutError' && failure.attempts >= 3
        ? await fetchSlowConversationInTab(failure.conversationId, headers) : null;
      usedLongRead = Boolean(slowDetail);
      const detail = slowDetail ?? await fetchChatGPTJson(
        `${BASE}/backend-api/conversation/${failure.conversationId}`, { headers });
      conv = toParsedConversation(detail, item, retryScope);
      confirmed = canonicalMessages(detail);
      if (!conv) throw new Error('Conversation has no readable messages');
      pending.rateLimitStreak = 0;
    } catch (error) {
      if (error instanceof NotLoggedInError) {
        for (const key of Object.keys(beforeRetry)) {
          if (beforeRetry[key] === undefined) delete failure[key];
          else failure[key] = beforeRetry[key];
        }
        return renewAfter401(error);
      }
      if (error instanceof RateLimitedError) {
        pending.retryYieldToScan = true;
        if (error.status === 429) {
          failure.lastDeferredHttpStatus = 429;
          failure.nextRetryAtMs = Math.max(failure.nextRetryAtMs,
            Date.now() + RETRY_MAX_MS);
        }
        return deferRateLimit(error, 'targeted-detail');
      }
      if (error.name === 'TabReadError') {
        failure.lastTransportError = error.message;
      } else {
        failure.errorType = failureType(error);
        delete failure.lastTransportError;
      }
      failure.lastFailedAtMs = Date.now();
      await checkpointNow();
      log(`chatgpt: targeted retry of ${failure.conversationId} failed: ${failure.errorType}`);
    }
    if (conv) {
      total += await push(failure.sourceId, 'chatgpt-web', [conv]);
      await onCanonicalIngest({ conversationId: failure.conversationId, confirmed });
      healthyRead();
      failure.resolvedAtMs = Date.now();
      failure.recoveredVia = usedLongRead ? 'browser-tab' : 'worker';
      delete failure.lastTransportError;
      await checkpointNow();
    }
    // Return without advancing the conversation-list cursor or scanning any
    // other scope. The existing continuation handles the next normal batch.
    return { state: { ...newState, pending: { ...pending } }, conversations: total,
      hasMore: true, failures: outstanding(), retryAfterMinutes: paceMinutes() };
  }

  while (pending.scopeIndex < pending.scopes.length) {
    // Migrate an already-running personal-first import in-place, keeping its
    // cursor, page offset and failure count for a later lossless resumption.
    const current = pending.scopes[pending.scopeIndex];
    if (pending.personalResume?.index === pending.scopeIndex) {
      const resume = pending.personalResume;
      pending.offset = resume.offset;
      pending.cursor = resume.cursor;
      pending.pageIndex = resume.pageIndex;
      pending.scopeFailures = resume.scopeFailures;
      pending.scopeTrackedFailures = resume.scopeTrackedFailures ?? 0;
      delete pending.personalResume;
      await checkpointNow();
    } else if (current && !current.projectId && !pending.personalResume) {
      let end = pending.scopeIndex + 1;
      while (pending.scopes[end]?.projectId &&
             pending.scopes[end].accountKey === current.accountKey) end++;
      if (end > pending.scopeIndex + 1) {
        const idx = pending.scopeIndex;
        pending.personalResume = {
          index: end - 1, offset: pending.offset, cursor: pending.cursor,
          pageIndex: pending.pageIndex, scopeFailures: pending.scopeFailures,
          scopeTrackedFailures: pending.scopeTrackedFailures ?? 0,
        };
        pending.scopes.splice(idx, end - idx,
          ...pending.scopes.slice(idx + 1, end), current);
        pending.offset = 0;
        pending.cursor = '0';
        pending.pageIndex = 0;
        pending.scopeFailures = 0;
        pending.scopeTrackedFailures = 0;
        delete pending.cachedPage;
        await checkpointNow();
      }
    }
    const scope = pending.scopes[pending.scopeIndex];
    await register(scope.sourceId, 'chatgpt-web');
    const existingAccount = accounts[scope.accountKey] ?? {};
    const priorSyncMs = scope.projectId
      ? existingAccount.projects?.[scope.projectId]?.lastSyncMs ?? null
      : scope.archived ? existingAccount.archivedLastSyncMs ?? null
        : existingAccount.lastSyncMs ?? null;
    const since = priorSyncMs ? priorSyncMs - OVERLAP_MS : null;
    let page = pending.cachedPage;
    let fetchedPage = false;
    if (!page || page.scopeIndex !== pending.scopeIndex ||
        page.cursor !== pending.cursor || page.offset !== pending.offset ||
        page.projectId !== scope.projectId || page.accountKey !== scope.accountKey) {
      try { page = await getCollectionPage(token, scope, pending.cursor, pending.offset); }
      catch (error) {
        if (error instanceof RateLimitedError) return deferRateLimit(error, 'conversation-list');
        if (error instanceof NotLoggedInError) return renewAfter401(error);
        throw error;
      }
      // Persist the page once. Repeated workers resume by index without
      // repeating its collection GET for every conversation.
      page = { ...page, scopeIndex: pending.scopeIndex, cursor: pending.cursor,
        offset: pending.offset, projectId: scope.projectId, accountKey: scope.accountKey };
      pending.cachedPage = page;
      clearDeferredStatus();
      await checkpointNow();
      fetchedPage = true;
    }
    if (fetchedPage && pacedMode) {
      await report({ phase: 'queued', detected: pending.detected,
        processed: pending.processed, failed: pending.failures });
      return { state: { ...newState, pending: { ...pending } }, conversations: total,
        hasMore: true, failures: outstanding(), retryAfterMinutes: paceMinutes() };
    }
    const { items, next } = page;
    // Inventory uses the already fetched listing: no additional ChatGPT calls.
    // IDs are deduplicated across projects, personal chats and both accounts.
    const discovered = new Set(pending.inventory.ids);
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      if (!discovered.has(item.id)) {
        discovered.add(item.id);
        pending.inventory.ids.push(item.id);
      }
    }
    await checkpointNow();
    pagesThisRun++;

    for (let index = pending.pageIndex; index < items.length; index++) {
      const item = items[index];
      if (!item || typeof item.id !== 'string' || !item.id) {
        throw new Error('ChatGPT conversation entry is missing its ID');
      }
      pending.detected++;
      await report({ phase: 'importing', detected: pending.detected,
        processed: pending.processed, failed: pending.failures });
      let conv = null;
      let confirmed = {};
      const archivedProject = scope.archived
        ? exactProjectId(item.gizmo_id) ?? exactProjectId(item.project_id) : null;
      const canonicalProject = archivedProject && pending.scopes.find(s =>
        s.accountKey === scope.accountKey && s.projectId === archivedProject);
      const itemScope = archivedProject ? { ...scope, projectId: archivedProject,
        projectName: canonicalProject?.projectName ?? null,
        projectShortUrl: canonicalProject?.projectShortUrl ?? archivedProject } : scope;
      const updatedMs = toMs(item.update_time);
      const previousFailure = failureDetails.find(detail =>
        detail.conversationId === item.id &&
        detail.projectId === (itemScope.projectId ?? null) &&
        detail.accountKey === scope.accountKey && !detail.resolvedAtMs);
      const retryDueMs = previousFailure?.nextRetryAtMs ??
        (previousFailure?.lastFailedAtMs ?? 0) + RETRY_BASE_MS;
      // A listed conversation cannot bypass a targeted retry's cooldown.
      // ChatGPT may leave the listing timestamp unchanged after new visible
      // turns. Outstanding browser captures require canonical reconciliation.
      const needsDetail = (!since || !updatedMs || updatedMs > since ||
        pendingLive.has(item.id)) && (!previousFailure || Date.now() >= retryDueMs);
      if (needsDetail) {
        try {
          const headers = authHeaders(token, scope.accountId);
          if (itemScope.projectId) headers['chatgpt-project-id'] = itemScope.projectId;
          const detail = await fetchChatGPTJson(`${BASE}/backend-api/conversation/${item.id}`, { headers });
          conv = toParsedConversation(detail, item, itemScope);
          confirmed = canonicalMessages(detail);
          pending.rateLimitStreak = 0;
        } catch (err) {
          if (err instanceof NotLoggedInError) return renewAfter401(err);
          if (err instanceof RateLimitedError) return deferRateLimit(err, 'conversation-detail');
          pending.failures++;
          pending.scopeFailures++;
          const reason = failureType(err);
          pending.failureReasons ??= {};
          pending.failureReasons[reason] = (pending.failureReasons[reason] ?? 0) + 1;
          const previousIndex = failureDetails.findIndex(detail =>
            detail.conversationId === item.id && detail.projectId === (itemScope.projectId ?? null) &&
            detail.accountKey === scope.accountKey
          );
          const previous = previousIndex < 0 ? null : failureDetails.splice(previousIndex, 1)[0];
          if (failureDetails.length >= FAILURE_DETAIL_LIMIT) {
            const resolvedIndex = failureDetails.findIndex(detail => detail.resolvedAtMs);
            if (resolvedIndex >= 0) failureDetails.splice(resolvedIndex, 1);
          }
          if (failureDetails.length < FAILURE_DETAIL_LIMIT) {
            failureDetails.push({
              conversationId: item.id, projectId: itemScope.projectId ?? null,
              projectName: itemScope.projectName, projectShortUrl: itemScope.projectShortUrl,
              accountKey: scope.accountKey, accountId: scope.accountId,
              sourceId: scope.sourceId, errorType: reason,
              attempts: (previous?.attempts ?? 0) + 1,
              lastFailedAtMs: Date.now(), resolvedAtMs: null,
              nextRetryAtMs: Date.now() + retryDelayMs((previous?.attempts ?? 0) + 1),
            });
            pending.scopeTrackedFailures = (pending.scopeTrackedFailures ?? 0) + 1;
          } else {
            pending.untrackedFailures = (pending.untrackedFailures ?? 0) + 1;
            log('chatgpt: failure detail capacity reached; scope watermark held for recovery');
          }
          log(`chatgpt: failed to read conversation ${item.id}: ${reason}`);
        }
      }
      // The API acknowledges one stored conversation before cursor advancement.
      // A failed local ingest leaves the current item eligible for retry.
      if (conv) {
        total += await push(scope.sourceId, 'chatgpt-web', [conv]);
        await onCanonicalIngest({ conversationId: item.id, confirmed });
        healthyRead();
        const recovered = failureDetails.find(detail =>
          detail.conversationId === item.id && detail.projectId === (itemScope.projectId ?? null) &&
          detail.accountKey === scope.accountKey && !detail.resolvedAtMs
        );
        if (recovered) recovered.resolvedAtMs = Date.now();
      }
      pending.processed++;
      pending.pageIndex = index + 1;
      if (needsDetail) thisRun++;
      await checkpointNow();
      await report({ detected: pending.detected, processed: pending.processed,
        failed: pending.failures });
      if (thisRun >= CHUNK_SIZE) {
        await report({ phase: 'queued', detected: pending.detected,
          processed: pending.processed, failed: pending.failures });
        return { state: { ...newState, pending: { ...pending } }, conversations: total,
          hasMore: true, failures: outstanding(), retryAfterMinutes: paceMinutes() };
      }
    }

    // The page is complete. Save its next cursor before asking for another.
    if (next != null) {
      delete pending.cachedPage;
      if (scope.projectId) {
        if (next === pending.cursor) throw new Error('Project conversation cursor repeated');
        pending.cursor = next;
      } else {
        pending.offset = next;
      }
      pending.pageIndex = 0;
      await checkpointNow();
      // Scanning historical pages is cheap but still bounded per service-worker run.
      if (pagesThisRun >= PAGES_PER_RUN) {
        return { state: { ...newState, pending: { ...pending } }, conversations: total,
          hasMore: true, failures: outstanding(), retryAfterMinutes: paceMinutes() };
      }
      continue;
    }

    // Watermarks are scoped to the actual ChatGPT project, not merely to the account.
    const account = accounts[scope.accountKey] ?? {
      name: scope.accountName, projects: {},
    };
    if (scope.projectId) {
      account.projects ??= {};
      account.projects[scope.projectId] = {
        lastSyncMs: pending.scopeFailures > (pending.scopeTrackedFailures ?? 0)
          ? priorSyncMs : pending.runStartedMs,
        name: scope.projectName, shortUrl: scope.projectShortUrl,
      };
    } else {
      const key = scope.archived ? 'archivedLastSyncMs' : 'lastSyncMs';
      account[key] = pending.scopeFailures > (pending.scopeTrackedFailures ?? 0)
        ? priorSyncMs : pending.runStartedMs;
      account.name = scope.accountName;
    }
    accounts[scope.accountKey] = account;
    if (pending.scopeFailures) {
      log(`chatgpt: ${pending.scopeFailures} conversation(s) failed in scope, watermark held`);
    }
    pending.scopeIndex++;
    delete pending.cachedPage;
    pending.offset = 0;
    pending.cursor = '0';
    pending.pageIndex = 0;
    pending.scopeFailures = 0;
    pending.scopeTrackedFailures = 0;
    pending.rateLimitStreak = 0;
    await checkpointNow();
  }

  await report({ phase: 'complete', detected: pending.detected,
    processed: pending.processed, failed: pending.failures });
  const completeState = { ...newState };
  // A sweep started before inventory tracking was installed stays partial.
  // Only an entirely enumerated sweep certifies the deduplicated total.
  completeState.conversationInventory = pending.inventory.completeFromStart
    ? { uniqueCount: pending.inventory.ids.length,
      ids: pending.inventory.ids, scopeCount: pending.scopes.length,
      completedAtMs: Date.now(), completeness: 'listed' }
    : { uniqueCount: null, identifiedSinceUpgrade: pending.inventory.ids.length,
      scopeCount: pending.scopes.length, completeness: 'partial' };
  delete completeState.pending;
  return { state: completeState, conversations: total, hasMore: false,
    failures: outstanding() };
}
