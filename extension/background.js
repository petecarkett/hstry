import './handoff-background.js';
// hstry sync service worker: polls AI chat platforms on an alarm and pushes
// new/updated conversations to a local hstry-api instance (POST /ingest).

import { NotLoggedInError } from './lib/common.js';
import { appendLiveCapture, confirmLiveCapture, validLiveCapture, resolveLiveOwner, resolveLiveProjectName } from './lib/live-capture.js';
import { DEFAULT_PROVIDER_SETTINGS, PROVIDERS } from './providers/index.js';
import { badgeState } from './ui.js';

const DEFAULT_SETTINGS = {
  port: 41770,
  token: '',
  intervalMinutes: 15,
  providers: DEFAULT_PROVIDER_SETTINGS,
};

const ALARM_NAME = 'hstry-sync';
const CONTINUE_ALARM_PREFIX = 'hstry-sync-continue-';
// Never let a short server Retry-After override the slower local 429 budget.
function nextAllowedAfterRateLimit(name, entry) {
  const last429 = name === 'chatgpt' ? entry?.state?.lastRateLimitAtMs ?? 0 : 0;
  const pace = name === 'chatgpt' ? entry?.state?.paceMs ?? 0 : 0;
  return Math.max(entry?.nextAllowedAtMs ?? 0, last429 + pace);
}
const activeProviders = new Set();
let statusWriteQueue = Promise.resolve();
const LIVE_KEY = 'liveCaptureQueue';
const LIVE_ALARM_NAME = 'hstry-live-index';
let liveWriteQueue = Promise.resolve();

function updateLiveQueue(change) {
  const job = liveWriteQueue.then(async () => {
    const current = (await chrome.storage.local.get(LIVE_KEY))[LIVE_KEY] ?? {};
    const next = change(current);
    if (next !== current) await chrome.storage.local.set({ [LIVE_KEY]: next });
    return Object.keys(next).length;
  });
  liveWriteQueue = job.catch(() => {});
  return job;
}

let liveFlushActive = false;
async function flushLiveCaptures() {
  if (liveFlushActive) return;
  liveFlushActive = true;
  try {
    const settings = await getSettings();
    if (!settings.providers.chatgpt || !settings.token) return;
    const [status, stored] = await Promise.all([
      getStatus(), chrome.storage.local.get(LIVE_KEY),
    ]);
    let count = 0;
    for (const [key, item] of Object.entries(stored[LIVE_KEY] ?? {})) {
      if (count >= 25) break;
      const owner = resolveLiveOwner(item, status);
      const projectName = owner?.projectName || resolveLiveProjectName(item, status);
      if (item.indexedAt && (!projectName || item.indexedProjectName === projectName)) continue;
      count++;
      let response;
      try {
        response = await fetch('http://127.0.0.1:' + settings.port + '/ingest/live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
            Authorization: 'Bearer ' + settings.token },
          body: JSON.stringify({ source: owner?.sourceId ?? 'auto', capture: {
            conversationId: item.conversationId, messageId: item.messageId,
            projectId: item.projectId, projectName: projectName ?? null,
            accountId: owner?.accountId ?? null, url: item.url, title: item.title,
            role: item.role, content: item.content, observedAt: item.observedAt,
          } }),
          signal: AbortSignal.timeout(8000),
        });
        if (response.status === 409) continue;
        if (!response.ok) {
          console.warn('[hstry-sync] local live indexing deferred (HTTP ' + response.status + ')');
          break;
        }
        response = await response.json();
      } catch {
        // The capture is already durable. Retry on the next local-only alarm.
        break;
      }
      await updateLiveQueue(queue => {
        const current = queue[key];
        if (!current || current.content !== item.content ||
            current.observedAt !== item.observedAt) return queue;
        return { ...queue, [key]: { ...current, indexedAt: Date.now(),
          indexedSource: response.source,
          ...(projectName ? { indexedProjectName: projectName } : {}) } };
      });
    }
  } finally {
    liveFlushActive = false;
  }
}

async function handleLiveCapture(raw, sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0) return { ok: false };
  const item = validLiveCapture(raw, sender.tab?.url ?? '');
  if (!item) return { ok: false };
  const settings = await getSettings();
  if (!settings.providers.chatgpt) return { ok: true, paused: true };
  const pending = await updateLiveQueue(queue => appendLiveCapture(queue, item));
  void flushLiveCaptures().catch(error => console.warn('[hstry-sync] live indexing deferred:', error));
  return { ok: true, pending };
}

async function settleLiveCapture(canonical) {
  // Failed cleanup must never turn a successful server import into a retry.
  try {
    await updateLiveQueue(queue => confirmLiveCapture(queue, canonical));
  } catch (error) {
    console.warn('[hstry-sync] live capture reconciliation deferred:', error);
  }
}

async function ensureLiveCaptureObservers() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    await Promise.all(tabs.filter(t => Number.isInteger(t.id) && t.status === 'complete')
      .map(tab => chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ['live-content.js'],
      }).catch(() => {})));
  } catch (error) { console.warn('[hstry-sync] live observer bootstrap deferred:', error); }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    providers: { ...DEFAULT_SETTINGS.providers, ...settings?.providers },
  };
}

async function getStatus() {
  const { status } = await chrome.storage.local.get('status');
  return status ?? {};
}

async function setStatus(status) {
  await chrome.storage.local.set({ status });
}

function setStatusEntry(name, entry) {
  statusWriteQueue = statusWriteQueue.then(async () => {
    const status = await getStatus();
    status[name] = entry;
    await setStatus(status);
  });
  return statusWriteQueue;
}

async function refreshBadge() {
  const [status, settings] = await Promise.all([getStatus(), getSettings()]);
  const indicator = badgeState(status, settings.providers);
  await chrome.action.setBadgeBackgroundColor({
    color: indicator === '!' ? '#cc3333' : '#6b7280',
  });
  await chrome.action.setBadgeText({ text: indicator });
}

async function clearInterruptedRuns() {
  const [status, settings] = await Promise.all([getStatus(), getSettings()]);
  let changed = false;
  for (const [name, entry] of Object.entries(status)) {
    if (!entry?.running) {
      const next = nextAllowedAfterRateLimit(name, entry);
      const extended = entry?.continuationPending && next > (entry.nextAllowedAtMs ?? 0);
      if (extended) { entry.nextAllowedAtMs = next; changed = true; }
      // A worker reload must extend a stale 5-minute alarm after a 429.
      if (entry?.continuationPending && settings.providers[name] &&
          (extended || !await chrome.alarms.get(`${CONTINUE_ALARM_PREFIX}${name}`))) {
        await scheduleContinuation(name,
          Math.max(0.5, (next - Date.now()) / 60_000));
      }
      continue;
    }
    entry.running = false;
    const canResume = settings.providers[name] &&
      (Array.isArray(entry.state?.pending?.scopes) ||
        Array.isArray(entry.state?.discovery?.accounts));
    if (canResume) {
      entry.continuationPending = true;
      entry.lastError = null;
      entry.progress = { ...entry.progress, phase: 'queued' };
      const delay = Math.max(
        0.5, (nextAllowedAfterRateLimit(name, entry) - Date.now()) / 60_000
      );
      await scheduleContinuation(name, delay);
    } else {
      entry.lastError = 'Previous sync was interrupted before a saved checkpoint.';
      entry.progress = { ...entry.progress, phase: 'failed' };
      entry.continuationPending = false;
    }
    changed = true;
  }
  if (changed) await setStatus(status);
  await refreshBadge();
}

const startupReady = clearInterruptedRuns();

function makePush(settings, onResult = async () => {}) {
  const url = `http://127.0.0.1:${settings.port}/ingest`;
  return async function push(sourceId, adapter, conversations) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
        },
        body: JSON.stringify({ source: sourceId, adapter, conversations }),
      });
    } catch {
      // fetch() rejects with a bare "Failed to fetch" when nothing is
      // listening. Turn it into something actionable.
      throw new Error(
        `cannot reach hstry-api at ${url} — is it running on port ${settings.port}? ` +
          `start it with: hstry-api --port ${settings.port}` +
          (settings.token ? ' --token <your-token>' : '')
      );
    }
    if (res.status === 401) {
      throw new Error(`hstry-api rejected the token (401) — extension token must match the server's --token / HSTRY_API_TOKEN`);
    }
    if (!res.ok) {
      throw new Error(`hstry-api /ingest -> ${res.status}`);
    }
    const data = await res.json();
    await onResult({
      accepted: data?.conversations ?? conversations.length,
      created: data?.created ?? 0,
      updated: data?.updated ?? 0,
    });
    return data?.conversations ?? conversations.length;
  };
}

function makeRegister(settings) {
  const url = `http://127.0.0.1:${settings.port}/sources`;
  return async function register(source, adapter) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
        },
        body: JSON.stringify({ source, adapter }),
      });
    } catch {
      throw new Error(`cannot reach hstry-api at ${url}`);
    }
    if (res.status === 401) throw new Error('hstry-api rejected the token (401)');
    if (!res.ok) throw new Error(`hstry-api /sources -> ${res.status}`);
    return res.json();
  };
}

async function registerEnabledSources(settings) {
  settings ??= await getSettings();
  if (!settings.token) return {};
  const register = makeRegister(settings);
  const results = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    if (!settings.providers[id]) continue;
    try {
      results[id] = await register(provider.sourceId, provider.adapter);
    } catch (error) {
      results[id] = { error: error.message };
    }
  }
  return results;
}

async function checkApi() {
  const settings = await getSettings();
  const url = `http://127.0.0.1:${settings.port}/health`;
  if (!settings.token) return { ok: false, error: 'Set your ingest token in extension settings', url };
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `hstry-api /health -> ${res.status}`, url };
    const data = await res.json();
    return { ok: data?.status === 'ok', url };
  } catch {
    return { ok: false, error: `cannot reach hstry-api on port ${settings.port}`, url };
  }
}

async function ensureAlarm() {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== settings.intervalMinutes) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: settings.intervalMinutes,
      delayInMinutes: 1,
    });
  }
}

async function scheduleContinuation(providerName, delayInMinutes = 0.5) {
  await chrome.alarms.create(`${CONTINUE_ALARM_PREFIX}${providerName}`, {
    delayInMinutes,
  });
}

async function runSync(
  trigger,
  { onlyProvider = null, full = false, onStarted = async () => {} } = {}
) {
  await startupReady;
  const settings = await getSettings();
  if (!settings.token) return false;
  const status = await getStatus();
  const selected = Object.entries(PROVIDERS).filter(
    ([name]) =>
      settings.providers[name] &&
      (!onlyProvider || name === onlyProvider) &&
      !activeProviders.has(name) &&
      Date.now() >= nextAllowedAfterRateLimit(name, status[name])
  );
  if (selected.length === 0) {
    if (trigger === 'continuation' && onlyProvider && settings.providers[onlyProvider] &&
        status[onlyProvider]?.continuationPending && !activeProviders.has(onlyProvider)) {
      const minutes = Math.max(0.5,
        (nextAllowedAfterRateLimit(onlyProvider, status[onlyProvider]) - Date.now()) / 60_000);
      await scheduleContinuation(onlyProvider, minutes);
    }
    return false;
  }
  for (const [name] of selected) activeProviders.add(name);
  await chrome.action.setBadgeText({ text: '…' });

  let startedReported = false;
  await Promise.all(
    selected.map(async ([name, provider]) => {
      const entry = {
        ...(status[name] ?? {}),
        ...(full && name === onlyProvider ? { state: {} } : {}),
        lastRunMs: Date.now(),
        trigger,
        running: true,
        progress: {
          ...(trigger === 'continuation' ? status[name]?.progress : {}),
          phase: 'discovering',
          detected: trigger === 'continuation' ? (status[name]?.progress?.detected ?? 0) : 0,
          processed: trigger === 'continuation' ? (status[name]?.progress?.processed ?? 0) : 0,
          failed: trigger === 'continuation' ? (status[name]?.progress?.failed ?? 0) : 0,
          accepted: trigger === 'continuation' ? (status[name]?.progress?.accepted ?? 0) : 0,
          created: trigger === 'continuation' ? (status[name]?.progress?.created ?? 0) : 0,
          updated: trigger === 'continuation' ? (status[name]?.progress?.updated ?? 0) : 0,
        },
      };
      await setStatusEntry(name, entry);
      if (!startedReported) {
        startedReported = true;
        await onStarted();
      }
      const report = async progress => {
        entry.progress = { ...entry.progress, ...progress };
        await setStatusEntry(name, entry);
      };
      const push = makePush(settings, async result => {
        await report({
          accepted: entry.progress.accepted + result.accepted,
          created: entry.progress.created + result.created,
          updated: entry.progress.updated + result.updated,
        });
      });
      const register = makeRegister(settings);
      try {
        const result = await provider.sync({
          state: entry.state ?? {},
          push,
          register,
          report,
          ...(name === 'chatgpt' ? { onCanonicalIngest: settleLiveCapture } : {}),
          checkpoint: async state => {
            entry.state = state;
            entry.lastDeferredHttpStatus = state.pending?.lastDeferredHttpStatus ??
              state.discoveryDeferredHttpStatus ?? null;
            const deadline = Math.max(state.pending?.rateLimitUntilMs ?? 0,
              state.discoveryRateLimitUntilMs ?? 0);
            if (deadline > Date.now()) {
              entry.nextAllowedAtMs = Math.max(entry.nextAllowedAtMs ?? 0, deadline);
            }
            await setStatusEntry(name, entry);
          },
          log: message => console.warn(`[hstry-sync] ${message}`),
        });
        entry.state = result.state;
        entry.lastDeferredHttpStatus = result.deferredHttpStatus ?? null;
        // A saved batch is not a completed sync across all project scopes.
        if (!result.hasMore && !result.failures) entry.lastSuccessMs = Date.now();
        entry.lastCount = result.conversations;
        entry.lastError = result.failures
          ? `${result.failures} conversation request(s) failed; they will be retried on the next poll`
          : null;
        entry.running = false;
        entry.continuationPending = Boolean(result.hasMore);
        entry.progress = {
          ...entry.progress,
          phase: result.hasMore ? 'queued' : 'complete',
        };
        const continuationMinutes = result.retryAfterMinutes ?? 0.5;
        entry.nextAllowedAtMs = result.hasMore
          ? Math.max(entry.nextAllowedAtMs ?? 0,
            Date.now() + continuationMinutes * 60_000,
            nextAllowedAfterRateLimit(name, entry))
          : null;
        if (result.hasMore) await scheduleContinuation(name,
          Math.max(0.5, (entry.nextAllowedAtMs - Date.now()) / 60_000));
      } catch (err) {
        entry.lastError =
          err instanceof NotLoggedInError ? `${err.message} — open the site and log in` : err.message;
        entry.running = false;
        entry.progress = { ...entry.progress, phase: 'failed' };
        console.warn(`[hstry-sync] ${name} failed:`, err);
      } finally {
        activeProviders.delete(name);
        await setStatusEntry(name, entry);
      }
    })
  );

  await refreshBadge();
  return true;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(LIVE_ALARM_NAME, { periodInMinutes: 1 });
  void flushLiveCaptures();
  ensureAlarm();
  registerEnabledSources();
  ensureLiveCaptureObservers();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(LIVE_ALARM_NAME, { periodInMinutes: 1 });
  void flushLiveCaptures();
  ensureAlarm();
  registerEnabledSources();
  ensureLiveCaptureObservers();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === LIVE_ALARM_NAME) {
    void flushLiveCaptures();
    return;
  }
  if (alarm.name === ALARM_NAME) {
    runSync('alarm');
    return;
  }
  if (alarm.name.startsWith(CONTINUE_ALARM_PREFIX)) {
    const providerName = alarm.name.slice(CONTINUE_ALARM_PREFIX.length);
    if (Object.hasOwn(PROVIDERS, providerName)) {
      runSync('continuation', { onlyProvider: providerName }).then(started => {
        // Do not retry forever when the provider was disabled in settings.
        if (!started && activeProviders.has(providerName)) scheduleContinuation(providerName);
      });
    }
  }
});

chrome.action.onClicked.addListener(() => runSync('manual'));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'hstryLiveCapture') {
    handleLiveCapture(message.capture, sender)
      .then(sendResponse)
      .catch(error => {
        console.warn('[hstry-sync] live capture failed:', error);
        sendResponse({ ok: false });
      });
    return true;
  }
  // Acknowledge synchronously and let the work continue in the background. A
  // full sync can outlive the message channel (or the worker), so we must not
  // hold the channel open waiting for it — status flows to the UI via
  // chrome.storage instead. Returning true here would reproduce the
  // "message channel closed before a response was received" error.
  if (message?.type === 'syncNow') {
    runSync('manual');
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'fullSyncProvider') {
    const providerName = message.provider;
    if (!Object.hasOwn(PROVIDERS, providerName)) {
      sendResponse({ ok: false, error: 'Unknown provider' });
      return false;
    }
    if (activeProviders.has(providerName)) {
      sendResponse({ ok: false, error: 'This provider is already syncing' });
      return false;
    }
    getSettings()
      .then(settings => {
        if (!settings.providers[providerName]) {
          sendResponse({ ok: false, error: 'Enable this provider before syncing' });
          return;
        }
        if (activeProviders.has(providerName)) {
          sendResponse({ ok: false, error: 'This provider is already syncing' });
          return;
        }
        let responded = false;
        const respond = result => {
          if (responded) return;
          responded = true;
          sendResponse(result);
        };
        runSync('full', {
          onlyProvider: providerName,
          full: true,
          onStarted: async () => respond({ ok: true }),
        }).catch(error => respond({ ok: false, error: error.message }));
      })
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === 'settingsChanged') {
    Promise.all([ensureAlarm(), registerEnabledSources(), refreshBadge()]).then(([, sources]) => {
      sendResponse({ ok: true, sources });
    });
    return true;
  }
  if (message?.type === 'checkApi') {
    checkApi().then(sendResponse);
    return true;
  }
  return false;
});
