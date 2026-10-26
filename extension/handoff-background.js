import { parseConversationUrl, takeoverPrompt } from './handoff-core.js';

const PREFIX = 'hstryTakeoverTab:';
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
    return replyAsync(sendResponse, (async () => {
      const parsed = parseConversationUrl(sender.url || senderTab.url || '');
      if (!parsed) throw new Error('Open an existing ChatGPT conversation first.');
      if (parseConversationUrl(senderTab.url || '')?.id !== parsed.id) {
        throw new Error('Conversation changed during takeover; try again.');
      }
      const entries = Object.values((await chrome.storage.local.get('liveCaptureQueue')).liveCaptureQueue || {});
      const pending = entries.filter(v => v && !v.indexedAt &&
        (v.conversationId === parsed.id || v.conversation_id === parsed.id)).length;
      const tab = await chrome.tabs.create({ url: parsed.landing, active: true });
      if (!Number.isInteger(tab.id)) throw new Error('New ChatGPT tab was not created.');
      await chrome.storage.session.set({ [PREFIX + tab.id]: {
        original: parsed.original, project: parsed.project,
        prompt: takeoverPrompt(parsed.original, pending),
        createdAt: Date.now(), sourceTabId: senderTab.id,
      } });
      chrome.tabs.sendMessage(tab.id, { type: 'HSTRY_TAKEOVER_WAKE' }).catch(() => {});
      return { tabId: tab.id, pendingCaptures: pending };
    })());
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
      const current = new URL(sender.url || senderTab.url);
      if (current.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(current.hostname)) {
        throw new Error('Takeover destination is not ChatGPT.');
      }
      if (msg.type === 'HSTRY_TAKEOVER_DONE') {
        await chrome.storage.session.remove(key);
        return { found: false, completed: true };
      }
      return { found: true, prompt: record.prompt, original: record.original };
    })());
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status === 'complete' && tab?.url?.startsWith('https://chatgpt.com/')) {
    chrome.tabs.sendMessage(tabId, { type: 'HSTRY_TAKEOVER_WAKE' }).catch(() => {});
  }
});

// The startup sweep is bounded. A tab that misses it is repaired when
// the user returns, without refreshing or submitting the conversation.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then(tab => {
    if (!tab.url?.startsWith('https://chatgpt.com/')) return;
    return chrome.scripting.executeScript({
      target: { tabId }, files: ['handoff-content.js'],
    });
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(PREFIX + tabId).catch(() => {});
});

// A runtime.reload() does not reinject content scripts into already-open
// chats. Run once per installed version so stale DOM buttons get fresh handlers.
const CONTENT_VERSION_KEY = 'hstryTakeoverContentVersion';
let contentRefresh;
function refreshOpenChatScripts() {
  if (contentRefresh) return contentRefresh;
  contentRefresh = (async () => {
    if (!chrome.scripting?.executeScript) return;
    const version = chrome.runtime.getManifest().version;
    const saved = await chrome.storage.local.get(CONTENT_VERSION_KEY);
    if (saved[CONTENT_VERSION_KEY] === version) return;
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    // A suspended tab can leave executeScript pending indefinitely. Bound the
    // refresh; future navigations receive the manifest content script normally.
    const injections = Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
      chrome.scripting.executeScript({ target: { tabId: tab.id },
        files: ['handoff-content.js'] })));
    await Promise.race([injections, new Promise(resolve => setTimeout(resolve, 3000))]);
    await chrome.storage.local.set({ [CONTENT_VERSION_KEY]: version });
  })().catch(() => {}).finally(() => { contentRefresh = null; });
  return contentRefresh;
}
chrome.runtime.onInstalled.addListener(() => { void refreshOpenChatScripts(); });
void refreshOpenChatScripts();
