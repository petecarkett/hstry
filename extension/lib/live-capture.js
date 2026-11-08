// Durable write-ahead capture of visible ChatGPT messages. The canonical
// conversation importer owns HSTRY's indexed messages; this queue holds DOM
// observations until a successful canonical ingestion confirms their content.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^g-p-[0-9a-f]{32}$/i;
const MAX_TEXT = 500_000;

export function conversationFromUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== 'https://chatgpt.com') return null;
  const match = /^\/(?:g\/(g-p-[0-9a-f]{32})(?:-[^/]*)\/)?c\/([0-9a-f-]{36})(?:\/)?$/i.exec(url.pathname);
  if (!match || !UUID.test(match[2])) return null;
  return { conversationId: match[2].toLowerCase(), projectId: match[1]?.toLowerCase() ?? null,
    url: `${url.origin}${url.pathname}` };
}

export function validLiveCapture(raw, senderUrl) {
  // A message queued just before SPA navigation remains valid after the tab
  // moves to another ChatGPT chat; both URLs must still be same-origin.
  let sender;
  try { sender = new URL(senderUrl); } catch { return null; }
  if (sender.origin !== 'https://chatgpt.com' || !raw || typeof raw !== 'object') return null;
  const route = conversationFromUrl(raw.url ?? senderUrl);
  if (!route) return null;
  if (route.conversationId !== raw.conversationId || route.projectId !== (raw.projectId ?? null)) return null;
  if (!UUID.test(raw.messageId ?? '') || !['user', 'assistant'].includes(raw.role)) return null;
  if (typeof raw.content !== 'string' || !raw.content.trim() || raw.content.length > MAX_TEXT) return null;
  return { ...route, messageId: raw.messageId.toLowerCase(), role: raw.role,
    content: raw.content.trim(), title: String(raw.title ?? '').slice(0, 300),
    observedAt: Date.now() };
}

// Resolve account/project from the existing canonical discovery checkpoint.
export function resolveLiveOwner(capture, status) {
  const state = status.chatgpt?.state ?? {};
  const scopes = state.pending?.scopes ?? state.sourceRoutes ?? [];
  const candidates = scopes.filter(scope =>
    (scope.projectId ?? null) === (capture.projectId ?? null) &&
    typeof scope.sourceId === 'string' && typeof scope.accountId === 'string');
  const owners = new Map(candidates.map(scope => [scope.accountId, scope]));
  if (owners.size !== 1) return null;
  return owners.values().next().value;
}

// A project name is usable when all discovered scopes agree, even if account
// ownership must still be resolved from the canonical archive.
export function resolveLiveProjectName(capture, status) {
  if (!capture.projectId) return null;
  const state = status.chatgpt?.state ?? {};
  const scopes = state.pending?.scopes ?? state.sourceRoutes ?? [];
  const names = new Set(scopes.filter(s => s.projectId === capture.projectId)
    .map(s => s.projectName?.trim()).filter(Boolean));
  return names.size === 1 ? [...names][0] : null;
}

// Prioritize verified captured conversations without bypassing canonical account
// ownership, per-conversation dedupe, or ordinary scan fairness.
export function nextContinuationPriority(queue, receipts, state) {
  const pending = state?.pending;
  if (!pending?.scopes || pending.priority || pending.nativeDetail ||
      pending.retryYieldToScan === true ||
      Number.isFinite(pending.lastPriorityProcessed) &&
        pending.processed - pending.lastPriorityProcessed < 3) return null;
  const done = new Set(pending.priorityDoneIds ?? []);
  const owners = new Map();
  for (const capture of Object.values(queue ?? {})) {
    if (!UUID.test(capture?.conversationId ?? '') || !capture.indexedSource) continue;
    const existing = owners.get(capture.conversationId);
    const candidate = { sourceId: capture.indexedSource,
      projectId: capture.projectId ?? null };
    owners.set(capture.conversationId,
      existing && (existing.sourceId !== candidate.sourceId ||
        existing.projectId !== candidate.projectId) ? { ambiguous: true } :
        existing?.ambiguous ? existing : candidate);
  }
  const taskFor = (id, capture, explicitReceipt = false) => {
    if (done.has(id) || !capture || capture.ambiguous) return null;
    const matching = pending.scopes.filter(scope =>
      !scope.archived && scope.sourceId === capture.sourceId &&
      (scope.projectId ?? null) === capture.projectId);
    if (matching.length !== 1 || typeof matching[0].accountKey !== 'string' ||
        (!explicitReceipt && (!matching[0].accountId ||
          typeof matching[0].accountId !== 'string')) ||
        (state.ignoredFailures ?? []).some(entry =>
          entry.conversationId === id && entry.accountKey === matching[0].accountKey &&
          (entry.projectId ?? null) === capture.projectId)) return null;
    return { conversationId: id, sourceId: capture.sourceId,
      accountKey: matching[0].accountKey, projectId: capture.projectId,
      kind: 'continuation' };
  };
  const ordered = Object.entries(receipts ?? {}).filter(([key, receipt]) =>
    key.startsWith('hstryTakeoverSource:') && receipt?.status === 'completed' &&
    receipt.automatic === true && Number.isFinite(receipt.completedAt))
    .sort((a, b) => b[1].completedAt - a[1].completedAt);
  for (const [key, receipt] of ordered) {
    const id = key.slice('hstryTakeoverSource:'.length);
    const route = conversationFromUrl(receipt.originalUrl);
    const capture = owners.get(id);
    if (!route || route.conversationId !== id ||
        capture?.projectId !== route.projectId) continue;
    const task = taskFor(id, capture, true);
    if (task) return task;
  }
  // An indexed live capture is also a bounded recovery request. Unlike a
  // handoff receipt it has no original URL, so only its verified source/project
  // scope may authorize the existing canonical native-detail path.
  for (const [id, capture] of owners) {
    if (Object.hasOwn(receipts ?? {}, 'hstryTakeoverSource:' + id)) continue;
    const task = taskFor(id, capture);
    if (task) return task;
  }
  return null;
}

export function appendLiveCaptures(current, items) {
  let next = current;
  for (const item of items) {
    const key = `${item.conversationId}:${item.messageId}`;
    if (next[key]?.content === item.content && next[key]?.role === item.role) continue;
    if (next === current) next = { ...current };
    next[key] = item;
  }
  return next;
}

export function appendLiveCapture(current, item) {
  return appendLiveCaptures(current, [item]);
}

export function confirmLiveCapture(current, { conversationId, confirmed }) {
  if (!UUID.test(conversationId ?? '') || !confirmed || typeof confirmed !== 'object') return current;
  let next = current;
  for (const [key, entry] of Object.entries(current)) {
    if (entry.conversationId !== conversationId ||
        typeof confirmed[entry.messageId] !== 'string') continue;
    const canonical = confirmed[entry.messageId].replace(/\s+/g, ' ').trim();
    const local = entry.content.replace(/\s+/g, ' ').trim();
    if (canonical !== local) continue;
    if (next === current) next = { ...current };
    delete next[key];
  }
  return next;
}

export function canonicalMessages(detail) {
  const confirmed = {};
  const nodes = Array.isArray(detail?.messages) &&
      detail?.page_info?.has_previous_page === false &&
      detail.page_info.has_next_page === false
    ? detail.messages.map(message => [message.id, { message }])
    : Object.entries(detail?.mapping ?? {});
  for (const [key, node] of nodes) {
    const id = node?.message?.id ?? node?.id ?? key;
    if (!UUID.test(id)) continue;
    const content = node?.message?.content;
    if (content?.content_type !== 'text' && content?.content_type !== 'multimodal_text') continue;
    const parts = content.parts;
    if (!Array.isArray(parts) || !parts.every(part => typeof part === 'string')) continue;
    confirmed[id.toLowerCase()] = parts.join('\n').trim();
  }
  return confirmed;
}
