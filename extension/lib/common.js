// Shared helpers for hstry sync providers.

let partCounter = 0;

export function textPart(text) {
  return { id: `p-${++partCounter}`, type: 'text', text };
}

export function thinkingPart(text) {
  return { id: `p-${++partCounter}`, type: 'thinking', text };
}

export function toolCallPart(toolCallId, name, input) {
  return { id: `p-${++partCounter}`, type: 'tool_call', toolCallId, name, input };
}

export function toolResultPart(toolCallId, output) {
  return { id: `p-${++partCounter}`, type: 'tool_result', toolCallId, output };
}

export class NotLoggedInError extends Error {
  constructor(service) {
    super(`${service}: not logged in`);
    this.name = 'NotLoggedInError';
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Cap on how long we honor a server-provided Retry-After (ms). */
const MAX_BACKOFF_MS = 60_000;

/**
 * GET/POST JSON with retry-and-backoff on rate limits (429) and transient
 * server errors (502/503). Honors the `Retry-After` header when present,
 * otherwise uses exponential backoff with jitter. 401/403 fail fast as
 * "not logged in" — retrying those is pointless.
 */
export async function fetchJson(url, init = {}, { retries = 5, baseDelayMs = 1000, maxBackoffMs = MAX_BACKOFF_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: 'include', ...init });

    if (res.status === 401 || res.status === 403) {
      throw new NotLoggedInError(new URL(url).hostname);
    }

    if (res.status === 429 || res.status === 502 || res.status === 503) {
      const retryHeader = res.headers.get('retry-after');
      const retrySeconds = retryHeader?.trim() ? Number(retryHeader) : NaN;
      const retryDate = retryHeader ? Date.parse(retryHeader) : NaN;
      const serverRetryAfterMs = Number.isFinite(retrySeconds) && retrySeconds >= 0
        ? retrySeconds * 1000
        : Number.isFinite(retryDate) ? Math.max(0, retryDate - Date.now()) : null;
      const backoffMs = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500);
      const requestedWaitMs = Math.max(serverRetryAfterMs ?? 0, backoffMs);
      const waitMs = Math.min(MAX_BACKOFF_MS, requestedWaitMs);
      if (attempt >= retries || requestedWaitMs > maxBackoffMs) {
        throw new RateLimitedError(
          `${init.method ?? 'GET'} ${url} -> ${res.status} (retry later)`,
          requestedWaitMs,
          res.status,
          serverRetryAfterMs
        );
      }
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const error = new Error(`${init.method ?? 'GET'} ${url} -> ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }
}

export class RateLimitedError extends Error {
  constructor(message, retryAfterMs = 60_000, status = null, serverRetryAfterMs = null) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
    this.serverRetryAfterMs = serverRetryAfterMs;
  }
}

export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds (possibly fractional) vs milliseconds.
    return Math.floor(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function shortId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
}
