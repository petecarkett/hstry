import { parseConversationUrl, isContinuationDestinationPath, takeoverPrompt } from './handoff-core.js';

const PREFIX = 'hstryTakeoverTab:';
const SOURCE_PREFIX = 'hstryTakeoverSource:';
const activeStarts = new Map();
const activeOpens = new Map();
const MAX_AGE_MS = 30 * 60_000;
const TYPE = 'HSTRY_TAKEOVER_';

function replyAsync(sendResponse, task) {
  task.then(value => sendResponse({ ok: true, ...value }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
}

// A lost START reply can leave a durable receipt without a source-page
// intent. Only its original, still-unmoved tab may recover the saved token.
async function resumeSourceReceipt(source, tabId, receipt) {
  if (receipt?.status !== 'started' || receipt.tabId !== tabId ||
      receipt.originalUrl !== source.original) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (parseConversationUrl(tab?.url || '')?.original !== source.original ||
      (tab.pendingUrl && parseConversationUrl(tab.pendingUrl)?.original !== source.original)) return null;
  const key = PREFIX + tabId;
  const record = (await chrome.storage.session.get(key))[key];
  if (record?.sourceTabId !== tabId || record.original !== source.original ||
      record.project !== source.project || typeof record.prompt !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(record.intentToken || '') ||
      !Number.isFinite(record.createdAt) || Date.now() < record.createdAt ||
      Date.now() - record.createdAt >= MAX_AGE_MS) return null;
  return { tabId, landingUrl: source.landing, sourceUrl: source.original,
    intentToken: record.intentToken, intentCreatedAt: record.createdAt };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith(TYPE)) return false;
  const senderTab = sender.tab;
  if (!senderTab || !Number.isInteger(senderTab.id)) {
    sendResponse({ ok: false, error: 'The takeover must originate in a Chrome tab.' });
    return false;
  }

  if (msg.type === 'HSTRY_TAKEOVER_STATUS' || msg.type === 'HSTRY_TAKEOVER_OPEN') {
    const source = parseConversationUrl(senderTab.url || '');
    const claimed = parseConversationUrl(msg.sourceUrl || '');
    if (!source || claimed?.original !== source.original ||
        !/^https:\/\/chatgpt\.com(?:\/|$)/.test(sender.url || '')) {
      sendResponse({ ok: false, error: 'Open the original ChatGPT conversation first.' });
      return false;
    }
    return replyAsync(sendResponse, (async () => {
      const key = SOURCE_PREFIX + source.id;
      const receipt = (await chrome.storage.local.get(key))[key];
      if (!receipt || (receipt.originalUrl && receipt.originalUrl !== source.original)) {
        return { found: false };
      }
      const destination = parseConversationUrl(receipt.destinationUrl || '');
      const verified = receipt.originalUrl === source.original &&
        receipt.status === 'completed' && destination &&
        destination.project === source.project && destination.id !== source.id;
      if (msg.type === 'HSTRY_TAKEOVER_STATUS') {
        const resume = msg.resumePending === true
          ? await resumeSourceReceipt(source, senderTab.id, receipt) : null;
        return { found: true, status: receipt.status, hasDestination: !!verified,
          ...(resume ? { resume } : {}) };
      }
      if (!verified) throw new Error(
        'This continuation has no verified destination link. Do not start a duplicate.');
      if (activeOpens.has(key)) return activeOpens.get(key);
      const opening = (async () => {
        const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
        const existing = tabs.find(tab =>
          parseConversationUrl(tab.url || '')?.original === destination.original);
        if (existing) {
          await chrome.tabs.update(existing.id, { active: true });
          await chrome.windows.update(existing.windowId, { focused: true });
          return { tabId: existing.id, reused: true, destinationUrl: destination.original };
        }
        const tab = await chrome.tabs.create({
          url: destination.original, openerTabId: senderTab.id, active: true,
        });
        return { tabId: tab.id, reused: false, destinationUrl: destination.original };
      })();
      activeOpens.set(key, opening);
      try { return await opening; }
      finally { if (activeOpens.get(key) === opening) activeOpens.delete(key); }
    })());
  }

  if (msg.type === 'HSTRY_TAKEOVER_START') {
    // ChatGPT uses SPA navigation: sender.url can remain the frame's original
    // URL after the active tab has moved to another conversation.
    const parsed = parseConversationUrl(senderTab.url || '');
    const claimed = parseConversationUrl(msg.sourceUrl || '');
    if (!parsed || claimed?.original !== parsed.original ||
        !/^https:\/\/chatgpt\.com(?:\/|$)/.test(sender.url || '')) {
      sendResponse({ ok: false, error: 'Open the original ChatGPT conversation first.' });
      return false;
    }
    const current = activeStarts.get(parsed.id);
    if (current) return replyAsync(sendResponse, current.task.then(result =>
      ({ ...result, existing: current.tabId !== senderTab.id })));
    const task = (async () => {
      const sourceKey = SOURCE_PREFIX + parsed.id;
      const prior = (await chrome.storage.local.get(sourceKey))[sourceKey];
      if (prior?.originalUrl && prior.originalUrl !== parsed.original) {
        throw new Error('Existing continuation belongs to a different project.');
      }
      if (prior?.status === 'completed') {
        return { existing: true, completed: true, tabId: prior.tabId };
      }
      if (Number.isInteger(prior?.tabId)) {
        const resume = await resumeSourceReceipt(parsed, senderTab.id, prior);
        if (resume) return resume;
        const tab = await chrome.tabs.get(prior.tabId).catch(() => null);
        // A started receipt with missing/expired intent cannot safely be
        // replaced: the original submission may already have happened.
        if (tab?.id === senderTab.id && parseConversationUrl(tab.url)?.original === parsed.original) {
          throw new Error('Saved continuation cannot be verified. Do not start a duplicate.');
        }
        // Reuse a previous continuation, including one opened by older builds.
        if (tab?.url?.startsWith('https://chatgpt.com/')) {
          const previous = (await chrome.storage.session.get(PREFIX + tab.id))[PREFIX + tab.id];
          if (previous?.original !== parsed.original ||
              !isContinuationDestinationPath(parsed, new URL(tab.url).pathname, true)) {
            throw new Error('Previous continuation tab is no longer in its source project.');
          }
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
      const intentToken = crypto.randomUUID();
      const automatic = msg.automatic === true;
      try {
        const current = await chrome.tabs.get(tabId);
        if (parseConversationUrl(current.url || '')?.original !== parsed.original) {
          throw new Error('Original conversation or project changed before takeover.');
        }
        // Persist the handoff before acknowledging the source page.
        // The source page navigates itself after receiving this reply.
        await chrome.storage.session.set({ [PREFIX + tabId]: {
          original: parsed.original, project: parsed.project,
          prompt: takeoverPrompt(parsed.original, pending,
            msg.failedMessage || '', msg.missingAttachments === true),
          createdAt: startedAt, sourceTabId: tabId, automatic, intentToken,
        } });
        await chrome.storage.local.set({ [sourceKey]: {
          status: 'started', tabId, startedAt, automatic, originalUrl: parsed.original,
        } });
        return { tabId, pendingCaptures: pending, landingUrl: parsed.landing,
          sourceUrl: parsed.original, intentToken, intentCreatedAt: startedAt };
      } catch (error) {
        // Failed persistence leaves the source page in place. Clear partial
        // receipts so the same tab can retry safely.
        await chrome.storage.session.remove(PREFIX + tabId).catch(() => {});
        await chrome.storage.local.remove(sourceKey).catch(() => {});
        throw error;
      }
    })();
    activeStarts.set(parsed.id, { task, tabId: senderTab.id });
    void task.finally(() => {
      if (activeStarts.get(parsed.id)?.task === task) activeStarts.delete(parsed.id);
    }).catch(() => {});
    return replyAsync(sendResponse, task);
  }

  if (msg.type === 'HSTRY_TAKEOVER_POLL' || msg.type === 'HSTRY_TAKEOVER_DONE') {
    return replyAsync(sendResponse, (async () => {
      const key = PREFIX + senderTab.id;
      const record = (await chrome.storage.session.get(key))[key];
      if (!record || record.sourceTabId !== senderTab.id) return { found: false };
      // The same browser tab can later visit an unrelated chat. An explicit
      // source-page continuation intent must match before returning a prompt.
      if (typeof record.intentToken !== 'string' ||
          msg.intentToken !== record.intentToken || msg.sourceUrl !== record.original) {
        if (msg.type === 'HSTRY_TAKEOVER_DONE') {
          throw new Error('Continuation intent no longer belongs to this source chat.');
        }
        return { found: false };
      }
      if (Date.now() - record.createdAt > MAX_AGE_MS) {
        await chrome.storage.session.remove(key);
        return { found: false };
      }
      const current = new URL(senderTab.url || sender.url);
      if (current.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(current.hostname)) {
        throw new Error('Takeover destination is not ChatGPT.');
      }
      const original = parseConversationUrl(record.original);
      if (!original || record.project !== original.project) {
        throw new Error('Stored takeover source or project is invalid.');
      }
      // The sender tab and its live SPA path must agree. Never trust a stale
      // document URL when several ChatGPT projects are changing at once.
      const sourceKey = SOURCE_PREFIX + original.id;
      if (msg.type === 'HSTRY_TAKEOVER_DONE') {
        if (!isContinuationDestinationPath(original, msg.pagePath, true)) {
          throw new Error('Continuation destination changed project before completion.');
        }
        const destination = parseConversationUrl('https://chatgpt.com' + msg.pagePath);
        if (!destination || destination.project !== original.project ||
            destination.id === original.id) {
          throw new Error('ChatGPT has not created the destination conversation yet.');
        }
        // sender.tab is a snapshot. The native SPA can expose its new path
        // before Chrome commits the tab URL. Re-read the actual tab; only the
        // original landing is eligible for a bounded receipt-only retry.
        const tab = await chrome.tabs.get(senderTab.id);
        const live = new URL(tab.url || 'https://invalid.invalid/');
        if (live.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(live.hostname)) {
          throw new Error('Takeover destination is not ChatGPT.');
        }
        if (live.pathname !== msg.pagePath) {
          if (isContinuationDestinationPath(original, live.pathname)) return { found: false, pending: true };
          throw new Error('Continuation destination changed project before completion.');
        }
        const prior = (await chrome.storage.local.get(sourceKey))[sourceKey];
        if (prior?.tabId != null && prior.tabId !== senderTab.id) {
          throw new Error('Continuation receipt belongs to a different tab');
        }
        await chrome.storage.local.set({ [sourceKey]: {
          status: 'completed', tabId: senderTab.id,
          startedAt: prior?.startedAt ?? record.createdAt,
          completedAt: Date.now(), automatic: record.automatic === true,
          originalUrl: original.original, destinationUrl: destination.original,
        } });
        await chrome.storage.session.remove(key);
        return { found: false, completed: true };
      }
      if (msg.pagePath !== current.pathname ||
          !isContinuationDestinationPath(original, current.pathname)) return { found: false };
      const receipt = (await chrome.storage.local.get(sourceKey))[sourceKey];
      if (receipt?.status === 'completed') return { found: false, completed: true };
      return { found: true, prompt: record.prompt, original: record.original,
        intentToken: record.intentToken, landingPath: new URL(original.landing).pathname };
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
