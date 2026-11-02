// Page-local observer: no ChatGPT HTTP requests and no private credentials.
// Observes new/changed visible turns, with a local durable queue in the worker.
(() => {
  const previous = globalThis.__hstryLiveCaptureInitialized;
  const version = chrome.runtime.getManifest().version;
  try { if (previous?.version === version && previous.isLive?.()) return; }
  catch { /* A previous extension context can be invalidated. */ }
  const msgId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const seen = new Map();
  const skippedBaseline = new Set();
  let pending;
  try { pending = previous?.pending instanceof Map ? previous.pending : new Map(); }
  catch { pending = new Map(); }
  let lastConversation = null;
  let observerTimer = null;
  let retryTimer = null;
  let observer;
  let draining = false;
  let active = true;
  globalThis.__hstryLiveCaptureInitialized = {
    version, pending,
    isLive() {
      try { return active && chrome.runtime.id && chrome.runtime.getManifest().version === version; }
      catch { return false; }
    },
    stop() {
      active = false;
      observer?.disconnect();
      clearTimeout(observerTimer);
      clearTimeout(retryTimer);
      globalThis.removeEventListener?.('hstry:native-conversation-page', onNativePage);
    },
  };
  try { previous?.stop?.(); } catch { /* Old invalidated context. */ }

  function currentRoute() {
    const match = /^\/(?:g\/(g-p-[0-9a-f]{32})(?:-[^/]*)\/)?c\/([0-9a-f-]{36})(?:\/)?$/i.exec(location.pathname);
    if (!match || !msgId.test(match[2])) return null;
    return { conversationId: match[2].toLowerCase(), projectId: match[1]?.toLowerCase() ?? null,
      url: `https://chatgpt.com${location.pathname}` };
  }

  function visibleMessage(node, route) {
    const id = msgId.exec(node.getAttribute('data-chatgpt-search-message-ids') ?? '')?.[0];
    if (!id) return null;
    const user = node.querySelector('[data-user-message-bubble="true"]');
    const assistantHeading = node.querySelector('[data-conversation-role="assistant"]');
    const role = user ? 'user' : assistantHeading ? 'assistant' : null;
    const textNode = user || assistantHeading?.nextElementSibling;
    const content = textNode?.innerText?.trim();
    if (!role || !content) return null;
    return { ...route, messageId: id.toLowerCase(), role, content, title: document.title };
  }

  function flush() {
    if (!active || draining || pending.size === 0) return;
    draining = true;
    const next = async () => {
      while (active && pending.size) {
        const batch = [];
        let size = 0;
        for (const [key, value] of pending) {
          if (batch.length >= 25 || (batch.length && size + value.content.length > 500_000)) break;
          batch.push([key, value]);
          size += value.content.length;
        }
        let ok = false;
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'hstryLiveCaptureBatch', captures: batch.map(([, value]) => value),
          });
          ok = res?.ok === true;
        } catch { /* Worker may be restarting; the page retains its pending items. */ }
        if (!active || !ok) break;
        for (const [key, value] of batch) {
          if (pending.get(key) === value) pending.delete(key);
        }
      }
      draining = false;
      if (active && pending.size) retryTimer = setTimeout(flush, 4000);
    };
    void next();
  }

  function scan() {
    if (!active) return;
    const route = currentRoute();
    if (!route) return;
    const initial = route.conversationId !== lastConversation;
    if (initial) {
      lastConversation = route.conversationId;
      seen.clear();
      skippedBaseline.clear();
    }
    const messages = [...document.querySelectorAll('[data-chatgpt-search-message-ids]')]
      .map(node => visibleMessage(node, route)).filter(Boolean);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const key = `${msg.conversationId}:${msg.messageId}`;
      if (initial && i < messages.length - 2) {
        seen.set(key, msg.content);
        skippedBaseline.add(key);
        continue;
      }
      if (seen.get(key) === msg.content) continue;
      seen.set(key, msg.content);
      skippedBaseline.delete(key);
      pending.set(key, msg);
    }
    flush();
  }

  function schedule() {
    if (!active) return;
    clearTimeout(observerTimer);
    observerTimer = setTimeout(scan, 1200);
  }
  // Native history pages can disappear from the virtualized DOM immediately.
  // Listen before DOM readiness so even the first successful page is retained.
  function onNativePage(event) {
    if (!active) return;
    const route = currentRoute();
    if (!route || event.detail?.conversationId !== route.conversationId ||
        !Array.isArray(event.detail.turns)) return;
    for (const turn of event.detail.turns) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn?.messageId ?? '') ||
          !['user', 'assistant'].includes(turn?.role) ||
          typeof turn.content !== 'string' || !turn.content.trim() ||
          turn.content.length > 500_000) continue;
      const key = `${route.conversationId}:${turn.messageId}`;
      if (seen.get(key) === turn.content && !skippedBaseline.has(key)) continue;
      skippedBaseline.delete(key);
      seen.set(key, turn.content);
      pending.set(key, { ...route, ...turn, title: document.title });
    }
    flush();
  }
  globalThis.addEventListener('hstry:native-conversation-page', onNativePage);

  observer = new MutationObserver(schedule);
  function startObserver() {
    if (!active) return;
    if (!document.documentElement) { setTimeout(startObserver, 50); return; }
    observer.observe(document.documentElement, { childList: true, subtree: true,
      characterData: true, attributes: true, attributeFilter: ['data-chatgpt-search-message-ids'] });
    schedule();
  }
  startObserver();
  flush();
})();
