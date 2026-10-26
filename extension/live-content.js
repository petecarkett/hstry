// Page-local observer: no ChatGPT HTTP requests and no private credentials.
// Observes new/changed visible turns, with a local durable queue in the worker.
(() => {
  if (globalThis.__hstryLiveCaptureInitialized) return;
  globalThis.__hstryLiveCaptureInitialized = true;
  const msgId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const seen = new Map();
  const pending = new Map();
  let lastConversation = null;
  let observerTimer = null;
  let draining = false;

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
    if (draining || pending.size === 0) return;
    draining = true;
    const next = async () => {
      while (pending.size) {
        const [key, value] = pending.entries().next().value;
        let ok = false;
        try {
          const res = await chrome.runtime.sendMessage({ type: 'hstryLiveCapture', capture: value });
          ok = res?.ok === true;
        } catch { /* Worker may be restarting; the page retains its pending item. */ }
        if (!ok) break;
        if (pending.get(key) === value) pending.delete(key);
      }
      draining = false;
      if (pending.size) setTimeout(flush, 4000);
    };
    void next();
  }

  function scan() {
    const route = currentRoute();
    if (!route) return;
    const initial = route.conversationId !== lastConversation;
    if (initial) {
      lastConversation = route.conversationId;
      seen.clear();
    }
    const messages = [...document.querySelectorAll('[data-chatgpt-search-message-ids]')]
      .map(node => visibleMessage(node, route)).filter(Boolean);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const key = `${msg.conversationId}:${msg.messageId}`;
      if (initial && i < messages.length - 2) {
        seen.set(key, msg.content);
        continue;
      }
      if (seen.get(key) === msg.content) continue;
      seen.set(key, msg.content);
      pending.set(key, msg);
    }
    flush();
  }

  function schedule() {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(scan, 1200);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true,
    characterData: true, attributes: true, attributeFilter: ['data-chatgpt-search-message-ids'] });
  schedule();
})();
