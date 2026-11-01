// Main-world observer for native ChatGPT history pages and terminal rejections.
// Never alters responses or replays requests.
(() => {
  if (window !== window.top || typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch;
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if (originalFetch.__hstryTooLargeObserver) return;
  const observedFetch = function(resource, options) {
    const result = Reflect.apply(originalFetch, this, arguments);
    try {
      const url = new URL(typeof resource === 'string' ? resource : resource?.url, location.href);
      const method = (options?.method || resource?.method || 'GET').toUpperCase();
      if (url.origin !== location.origin) return result;
      // The native ChatGPT viewer loads older turns in pages, often unmounting
      // them before the DOM observer can see them. Capture its successful text
      // responses without making another network request or altering the page.
      const native = new RegExp('^/backend-api/conversations/(' + UUID + ')(?:/messages)?$', 'i').exec(url.pathname);
      if (native && method === 'GET') {
        const sourcePath = location.pathname;
        const id = native[1].toLowerCase();
        if (!sourcePath.toLowerCase().endsWith('/c/' + id)) return result;
        void result.then(async response => {
          if (!response.ok || location.pathname !== sourcePath) return;
          const page = await response.clone().json();
          if (!Array.isArray(page?.messages) || location.pathname !== sourcePath) return;
          const turns = page.messages.filter(message => {
            const parts = message?.content?.parts;
            return new RegExp('^' + UUID + '$', 'i').test(message?.id ?? '') &&
              ['user', 'assistant'].includes(message?.author?.role) &&
              !message?.metadata?.is_visually_hidden_from_conversation &&
              message?.channel !== 'analysis' &&
              Array.isArray(parts) && parts.every(part => typeof part === 'string');
          }).map(message => ({
            messageId: message.id.toLowerCase(), role: message.author.role,
            content: message.content.parts.join('\n').trim(),
          })).filter(turn => turn.content && turn.content.length <= 500_000);
          if (turns.length) window.dispatchEvent(new CustomEvent('hstry:native-conversation-page', {
            detail: { conversationId: id, turns },
          }));
        }).catch(() => {});
        return result;
      }
      if (url.pathname !== '/backend-api/f/conversation' || method !== 'POST') return result;
      const sourcePath = location.pathname;
      void result.then(async response => {
        if (response.status < 400) return;
        const error = await response.clone().json();
        if (error?.detail?.code !== 'conversation_too_large') return;
        let failedMessage = '', includesAttachments = false, oversized = false;
        // Only inspect the rejected submission, after the exact server code.
        try {
          if (typeof options?.body !== 'string' || options.body.length > 2_000_000) {
            oversized = true; // Cannot prove that the rejected message is preserved.
          } else {
            const messages = JSON.parse(options.body).messages;
            if (!Array.isArray(messages)) oversized = true;
            const last = Array.isArray(messages)
              ? messages.filter(m => m?.author?.role === 'user').at(-1) : null;
            const parts = last?.content?.parts;
            if (Array.isArray(parts)) {
              failedMessage = parts.filter(p => typeof p === 'string').join('\n');
              includesAttachments = parts.some(p => typeof p !== 'string');
            } else if (last) oversized = true;
            includesAttachments ||= !!last?.metadata?.attachments?.length;
            if (failedMessage.length > 8000) {
              failedMessage = '';
              oversized = true;
            }
          }
        } catch { oversized = true; /* Still report the exact server rejection. */ }
        window.dispatchEvent(new CustomEvent('hstry:conversation-too-large', {
          detail: { path: sourcePath, failedMessage, includesAttachments, oversized },
        }));
      }).catch(() => {});
    } catch { /* Observing a request must never affect ChatGPT's own fetch. */ }
    return result;
  };
  Object.defineProperty(observedFetch, '__hstryTooLargeObserver', { value: true });
  window.fetch = observedFetch;
})();
