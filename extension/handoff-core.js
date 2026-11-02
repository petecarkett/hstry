// Standalone module owned by the existing HSTRY Chrome extension.
const HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^g-p-[0-9a-f]{32}(?:-[a-z0-9-]+)?$/i;

export function parseConversationUrl(input) {
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let project = null, id = null;
  if (parts.length === 2 && parts[0] === 'c' && CHAT_ID.test(parts[1])) {
    id = parts[1];
  } else if (parts.length === 4 && parts[0] === 'g' && PROJECT.test(parts[1]) &&
             parts[2] === 'c' && CHAT_ID.test(parts[3])) {
    project = parts[1];
    id = parts[3];
  } else {
    return null;
  }
  // Use the verified source URL for history; navigation credentials and query
  // parameters are neither needed nor copied into the handoff message.
  return {
    original: `https://chatgpt.com/${project ? `g/${project}/` : ''}c/${id}`,
    id,
    project,
    landing: project ? `https://chatgpt.com/g/${project}` : 'https://chatgpt.com/',
  };
}

// Each source chat has one existing durable completion receipt. Older receipts
// cannot be retrospectively labelled automatic without evidence.
export function recordedContinuations(receipts = {}) {
  const automatic = [];
  let manualCount = 0, legacyCount = 0, legacyLastAt = null;
  for (const [key, record] of Object.entries(receipts)) {
    if (!key.startsWith('hstryTakeoverSource:') || record?.status !== 'completed' ||
        !Number.isFinite(record?.completedAt)) continue;
    const id = key.slice('hstryTakeoverSource:'.length);
    if (!CHAT_ID.test(id)) continue;
    if (record.automatic === false) { manualCount++; continue; }
    if (record.automatic !== true) {
      legacyCount++;
      legacyLastAt = Math.max(legacyLastAt ?? 0, record.completedAt);
      continue;
    }
    const original = parseConversationUrl(record.originalUrl);
    automatic.push({ id, completedAt: record.completedAt,
      url: original?.id === id ? original.original : 'https://chatgpt.com/c/' + id });
  }
  automatic.sort((a, b) => b.completedAt - a.completedAt);
  return { automatic, manualCount, legacyCount, legacyLastAt };
}

export function takeoverPrompt(originalUrl, pendingCaptures = 0,
                              failedMessage = '', missingAttachments = false) {
  const parsed = parseConversationUrl(originalUrl);
  if (!parsed) throw new Error('Not a supported ChatGPT conversation URL');
  return `Continue the unfinished work from this existing ChatGPT conversation, which reached the conversation-length limit:
${parsed.original}

Use the connected HSTRY_Private_History expand tool with that FULL URL as conversation_id. Read the latest available history first; page through relevant earlier messages and truncated parts as needed. Use HSTRY search only if related chats are required. Do not fetch this history from ChatGPT or OpenAI.

Reconstruct the latest verified task, decisions, completed work, remaining blockers and project state. Resume the unfinished work using the existing SSOT, Ponytail, ownership/release rules and minimal regression-safe changes. Do not recreate tasks, duplicate completed work, or claim deployment without evidence.

${pendingCaptures ? `WARNING: ${pendingCaptures} live capture(s) are not verified by canonical history. They may be indexed only as provisional observations; do not assume the archive is complete.` : 'Verify that HSTRY contains the latest messages; if it does not, identify the gap without inventing missing context.'}

${failedMessage ? `The latest submitted user message was rejected by ChatGPT with conversation_too_large and may be absent from HSTRY. Address it after recovering prior context:\n${JSON.stringify(failedMessage)}\n` : ''}${missingAttachments ? 'The rejected submission included attachments that cannot be transferred automatically. Ask the user to reattach them.\n' : ''}
This is a continuation, not a new project. Continue work after retrieving the evidence; do not stop at a handoff summary.`;
}
