import { parseConversationUrl, takeoverPrompt } from './handoff-core.js';

const PREFIX = 'hstryTakeoverTab:';
const SOURCE_PREFIX = 'hstryTakeoverSource:';
const activeStarts = new Map();
const MAX_AGE_MS = 30 * 60_000;
const TYPE = 'HSTRY_TAKEOVER_';

function replyAsync(sendResponse, task) {
  task.then(value => sendResponse({ ok: true, ...value }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith(TYPE)) return false;
  const senderTab = sender.tab;
  if (!senderTab || !Number.isInteger(senderTab.id)) {
    sendResponse({ ok: false, error: 'The takeover must originate in a Chrome tab.' });
    return false;
  }

  if (msg.type === 'HSTRY_TAKEOVER_START') {
    // ChatGPT uses SPA navigation: sender.url can remain the frame's original
    // URL after the active tab has moved to another conversation.
    const parsed = parseConversationUrl(senderTab.url || '');
    if (!parsed || !/^https:\/\/chatgpt\.com(?:\/|$)/.test(sender.url || '')) {
      sendResponse({ ok: false, error: 'Open the original ChatGPT conversation first.' });
      return false;
    }
    const current = activeStarts.get(parsed.id);
    if (current) return replyAsync(sendResponse, current);
    const task = (async () => {
      const sourceKey = SOURCE_PREFIX + parsed.id;
      const prior = (await chrome.storage.local.get(sourceKey))[sourceKey];
      if (prior?.status === 'completed') {
        return { existing: true, completed: true, tabId: prior.tabId };
      }
      if (Number.isInteger(prior?.tabId)) {
        const tab = await chrome.tabs.get(prior.tabId).catch(() => null);
        // Reuse a previous continuation, including one opened by older builds.
        // If the same source tab never navigated, allow a safe retry in place.
        if (tab?.url?.startsWith('https://chatgpt.com/') &&
            !(tab.id === senderTab.id && parseConversationUrl(tab.url)?.id === parsed.id)) {
          return { existing: true, tabId: tab.id };
        }
      }
      const entries = Object.values((await chrome.storage.local.get('liveCaptureQueue')).liveCaptureQueue || {});
      // Indexed live captures are still provisional until canonical history
      // confirms and removes them from this queue.
      const pending = entries.filter(v => v &&
        (v.conversationId === parsed.id || v.conversation_id === parsed.id)).length;
      if (msg.failedMessage !== undefined &&
          (typeof msg.failedMessage !== 'string' || msg.failedMessage.length > 8000)) {
        throw new Error('Rejected message is too large for a safe handoff.');
      }
      const tabId = senderTab.id;
      const startedAt = Date.now();
      const automatic = msg.automatic === true;
      try {
        const current = await chrome.tabs.get(tabId);
        if (parseConversationUrl(current.url || '')?.id !== parsed.id) {
          throw new Error('Original conversation changed before takeover.');
        }
        // Navigate the original tab only after storing the full handoff.
        // Its browser history retains the source conversation for Back.
        await chrome.storage.session.set({ [PREFIX + tabId]: {
          original: parsed.original, project: parsed.project,
          prompt: takeoverPrompt(parsed.original, pending,
            msg.failedMessage || '', msg.missingAttachments === true),
          createdAt: startedAt, sourceTabId: tabId, automatic,
        } });
        await chrome.storage.local.set({ [sourceKey]: {
          status: 'started', tabId, startedAt, automatic, originalUrl: parsed.original,
        } });
        await chrome.tabs.update(tabId, { url: parsed.landing });
        return { tabId, pendingCaptures: pending };
      } catch (error) {
        // Do not close the user's tab. Failed navigation leaves the source in
        // place and clears both receipts so the same tab can be retried.
        await chrome.storage.session.remove(PREFIX + tabId).catch(() => {});
        await chrome.storage.local.remove(sourceKey).catch(() => {});
        throw error;
      }
    })();
    activeStarts.set(parsed.id, task);
    void task.finally(() => {
      if (activeStarts.get(parsed.id) === task) activeStarts.delete(parsed.id);
    }).catch(() => {});
    return replyAsync(sendResponse, task);
  }

  if (msg.type === 'HSTRY_TAKEOVER_POLL' || msg.type === 'HSTRY_TAKEOVER_DONE') {
    return replyAsync(sendResponse, (async () => {
      const key = PREFIX + senderTab.id;
      const record = (await chrome.storage.session.get(key))[key];
      if (!record) return { found: false };
      if (Date.now() - record.createdAt > MAX_AGE_MS) {
        await chrome.storage.session.remove(key);
        return { found: false };
      }
      const current = new URL(senderTab.url || sender.url);
      if (current.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(current.hostname)) {
        throw new Error('Takeover destination is not ChatGPT.');
      }
      const original = parseConversationUrl(record.original);
      if (!original) throw new Error('Stored takeover source is invalid.');
      if (msg.type === 'HSTRY_TAKEOVER_POLL') {
        const landing = new URL(original.landing).pathname.replace(/\/$/, '') || '/';
        const path = current.pathname.replace(/\/$/, '') || '/';
        if (path !== landing && !(original.project && path === landing + '/project')) {
          return { found: false };
        }
      }
      const sourceKey = SOURCE_PREFIX + original.id;
      if (msg.type === 'HSTRY_TAKEOVER_DONE') {
        const prior = (await chrome.storage.local.get(sourceKey))[sourceKey];
        if (prior?.tabId != null && prior.tabId !== senderTab.id) {
          throw new Error('Continuation receipt belongs to a different tab');
        }
        await chrome.storage.local.set({ [sourceKey]: {
          status: 'completed', tabId: senderTab.id,
          startedAt: prior?.startedAt ?? record.createdAt,
          completedAt: Date.now(), automatic: record.automatic === true,
          originalUrl: original.original,
        } });
        await chrome.storage.session.remove(key);
        return { found: false, completed: true };
      }
      const receipt = (await chrome.storage.local.get(sourceKey))[sourceKey];
      if (receipt?.status === 'completed') return { found: false, completed: true };
      return { found: true, prompt: record.prompt, original: record.original };
    })());
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status === 'complete' && tab?.url?.startsWith('https://chatgpt.com/')) {
    // ChatGPT can replace window.fetch after document_start. Reinstall the
    // existing idempotent observer once the page finishes initializing.
    void chrome.scripting.executeScript({ target: { tabId },
      files: ['handoff-network.js'], world: 'MAIN' }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: 'HSTRY_TAKEOVER_WAKE' }).catch(() => {});
  }
});

// The startup sweep is bounded. A tab that misses it is repaired when
// the user returns, without refreshing or submitting the conversation.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(tab => {
    if (!tab.url?.startsWith('https://chatgpt.com/')) return;
    return Promise.all([
      chrome.scripting.executeScript({
        target: { tabId }, files: ['handoff-network.js'], world: 'MAIN',
      }),
      chrome.scripting.executeScript({
        target: { tabId }, files: ['handoff-content.js'],
      }),
    ]);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(PREFIX + tabId).catch(() => {});
});

// A runtime.reload() does not reinject content scripts into already-open
// chats. Run once per loaded extension context, including same-version reloads.
const CONTENT_VERSION_KEY = 'hstryTakeoverContentVersion';
let contentRefresh;
function refreshOpenChatScripts() {
  if (contentRefresh) return contentRefresh;
  contentRefresh = (async () => {
    if (!chrome.scripting?.executeScript) return;
    const version = chrome.runtime.getManifest().version;
    const saved = await chrome.storage.session.get(CONTENT_VERSION_KEY);
    const refreshed = saved[CONTENT_VERSION_KEY] === version;
    // After a worker restart, the current tab may still lack its content script.
    // Recheck only active chats; a version change still refreshes all open chats.
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*',
      ...(refreshed ? { active: true } : {}) });
    const injections = Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).flatMap(tab => [
      chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ['handoff-network.js'], world: 'MAIN' }),
      chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ['handoff-content.js'] }),
      chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ['live-content.js'] }),
    ]));
    // Do not certify a sweep when a suspended tab timed out or rejected injection.
    let timeout;
    const results = await Promise.race([injections, new Promise(resolve => {
      timeout = setTimeout(() => resolve(null), 3000);
    })]);
    clearTimeout(timeout);
    if (!refreshed && results?.every(result => result.status === 'fulfilled')) {
      await chrome.storage.session.set({ [CONTENT_VERSION_KEY]: version });
    }
  })().catch(() => {}).finally(() => { contentRefresh = null; });
  return contentRefresh;
}
chrome.runtime.onInstalled.addListener(() => { void refreshOpenChatScripts(); });
void refreshOpenChatScripts();
