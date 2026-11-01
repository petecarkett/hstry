// Main-world observation of the exact ChatGPT terminal rejection.
// Does not alter responses, replay requests, or inspect successful traffic.
(() => {
  if (window !== window.top || typeof window.fetch !== 'function') return;
  const originalFetch = window.fetch;
  if (originalFetch.__hstryTooLargeObserver) return;
  const observedFetch = function(resource, options) {
    const result = Reflect.apply(originalFetch, this, arguments);
    try {
      const url = new URL(typeof resource === 'string' ? resource : resource?.url, location.href);
      const method = (options?.method || resource?.method || 'GET').toUpperCase();
      if (url.origin !== location.origin ||
          url.pathname !== '/backend-api/f/conversation' || method !== 'POST') return result;
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
