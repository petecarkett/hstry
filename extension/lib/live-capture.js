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

export function appendLiveCapture(current, item) {
  const key = `${item.conversationId}:${item.messageId}`;
  if (current[key]?.content === item.content && current[key]?.role === item.role) return current;
  return { ...current, [key]: item };
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
  for (const [key, node] of Object.entries(detail?.mapping ?? {})) {
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
