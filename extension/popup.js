import { DEFAULT_PROVIDER_SETTINGS, PROVIDERS, formatTime, providerState } from './ui.js';

const DEFAULTS = { port: 41770, intervalMinutes: 15, providers: DEFAULT_PROVIDER_SETTINGS };
const el = id => document.getElementById(id);
let apiConnected = false;

function providerCard(name, entry, enabled) {
  const provider = PROVIDERS[name];
  const state = providerState(entry, enabled, { apiConnected });
  const article = document.createElement('article');
  article.className = 'provider';
  article.innerHTML = `
    <div><h2>${provider.name}</h2><p></p></div>
    <div class="provider-meta"><strong>${state.label}</strong><span>${entry?.running ? 'Now' : formatTime(entry?.lastRunMs)}</span></div>`;
  const detail = article.querySelector('p');
  detail.textContent = state.detail;
  if (state.tone === 'error') detail.className = 'error-copy';
  const recent = entry?.state?.failureDetails;
  if (name === 'chatgpt' && Array.isArray(recent) && recent.length) {
    const disclosure = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Failure details (${recent.length} recorded)`;
    disclosure.appendChild(summary);
    const list = document.createElement('ul');
    list.className = 'failure-details';
    const ordered = [...recent].sort((a, b) =>
      Number(Boolean(a.resolvedAtMs)) - Number(Boolean(b.resolvedAtMs)) ||
      (b.lastFailedAtMs ?? 0) - (a.lastFailedAtMs ?? 0));
    for (const failure of ordered.slice(0, 15)) {
      const row = document.createElement('li');
      const origin = failure.projectId ? 'Project' : 'Personal';
      row.textContent = `${origin} ${failure.conversationId}: ${failure.errorType}` +
        (failure.resolvedAtMs ? ' (recovered)' :
          failure.accessVerification?.canRetry === false ? ' (inaccessible; access required)' : '');
      list.appendChild(row);
    }
    disclosure.appendChild(list);
    article.firstElementChild.appendChild(disclosure);
  }
  return article;
}

async function render() {
  el('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
  const { settings, status, liveCaptureQueue } = await chrome.storage.local.get(['settings', 'status', 'liveCaptureQueue']);
  const entries = Object.values(liveCaptureQueue ?? {});
  const indexed = entries.filter(item => item.indexedAt).length;
  el('live-capture').textContent = `Live capture: ${indexed} indexed in HSTRY, ${entries.length - indexed} waiting for indexing; ${entries.length} await canonical confirmation`;

  const merged = { ...DEFAULTS, ...settings, providers: { ...DEFAULTS.providers, ...settings?.providers } };
  el('api-detail').textContent = `http://127.0.0.1:${merged.port}`;
  el('schedule').textContent = `Every ${merged.intervalMinutes} minute${merged.intervalMinutes === 1 ? '' : 's'}`;
  const container = el('providers');
  container.replaceChildren(...Object.keys(PROVIDERS).map(name => providerCard(name, status?.[name], merged.providers[name])));
  return merged;
}

async function checkApi() {
  el('api-dot').className = 'status-dot checking';
  el('api-title').textContent = 'Checking local API…';
  el('retry').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'checkApi' });
    if (!result?.ok) throw new Error(result?.error);
    apiConnected = true;
    el('api-dot').className = 'status-dot success';
    el('api-title').textContent = 'Local API connected';
  } catch {
    apiConnected = false;
    el('api-dot').className = 'status-dot error';
    el('api-title').textContent = 'Local API is offline';
  } finally {
    await render();
    el('retry').disabled = false;
  }
}

el('sync').addEventListener('click', async () => {
  const button = el('sync');
  button.disabled = true;
  button.textContent = 'Syncing…';
  el('notice').textContent = 'You can close this popup; sync continues in the background.';
  try { await chrome.runtime.sendMessage({ type: 'syncNow' }); } catch { /* worker still starts */ }
  setTimeout(() => { button.disabled = false; button.textContent = 'Sync now'; }, 1800);
});
el('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('retry').addEventListener('click', checkApi);
chrome.storage.onChanged.addListener(changes => { if (changes.status || changes.settings || changes.liveCaptureQueue) render(); });

await render();
await checkApi();
