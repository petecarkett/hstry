// Browser-only continuation UI. It never calls ChatGPT history endpoints.
(() => {
  if (window !== window.top || typeof chrome === 'undefined' || !chrome.runtime?.id) return;
  // A page can outlive an extension reload. Old booleans must not block
  // the new version from replacing an orphaned click handler.
  const version = chrome.runtime.getManifest().version;
  const previous = window.__hstryOneclickInstalled;
  try {
    if (previous?.version === version && previous.isLive?.()) return;
  } catch { /* An earlier extension context may already be invalidated. */ }
  window.__hstryOneclickInstalled = { version, isLive: () => {
    try { return !!chrome.runtime?.id && chrome.runtime.getManifest().version === version; }
    catch { return false; }
  } };
  // A prior extension instance can leave an orphaned DOM button behind.
  // Replace it so its invalidated click handler can no longer be invoked.
  document.getElementById('hstry-continue-chat')?.remove();

  const RETRY_KEY = 'hstry.takeover.retryAfterReload';
  const RETRY_TTL_MS = 60_000;
  let retryOnce = false;
  let resumePending = false;
  try {
    const saved = sessionStorage.getItem(RETRY_KEY);
    sessionStorage.removeItem(RETRY_KEY);
    if (saved) {
      const retry = JSON.parse(saved);
      if (retry?.path === location.pathname &&
          Number.isFinite(retry.at) && Date.now() - retry.at < RETRY_TTL_MS &&
          Date.now() >= retry.at) {
        resumePending = true;
        retryOnce = true;
      }
    }
  } catch { /* Session storage is optional; normal clicks still work. */ }

  const WARNING = /you(?:'|\u2019)ve\s+reached\s+the\s+maximum\s+length\s+for\s+this\s+conversation/i;
  let resumeWhenComposerReady = false;
  let submittedPath = null;
  let autoAttemptedPath = null;
  let started = false;
  let detectionTimer;
  let handoffStarted = false;
  let checkingHandoff = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Only newly reached limits after a real user submission auto-continue.
  // Existing expired chats opened after an update retain their manual button.
  document.addEventListener('click', event => {
    if (event.target?.closest?.('button[data-testid="send-button"], '+
        'button[aria-label="Send prompt"], button[aria-label="Send message"], '+
        'button[aria-label="Send"]')) submittedPath = location.pathname;
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey &&
        !event.metaKey && !event.altKey && !event.isComposing &&
        event.target?.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], '+
          '[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"]')) {
      submittedPath = location.pathname;
    }
  }, true);

  const send = msg => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, response => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (err) { reject(err); }
  });

  async function startTakeover(btn, automatic = false) {
    if (btn.disabled) return;
    const editor = editableElement();
    const hasDraft = !!(editor?.value || editor?.textContent || '').trim();
    const hasFiles = [...document.querySelectorAll('input[type="file"]')]
      .some(input => input.files?.length);
    if (hasDraft || hasFiles || document.querySelector?.(
      '[aria-label="Remove attachment"], [data-testid="attachment-preview"]')) {
      fallbackBanner('HSTRY paused: save or send the unsent draft or attachment before continuing.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Opening continuation...';
    try {
      const result = await send({ type: 'HSTRY_TAKEOVER_START', automatic });
      if (!result?.ok) throw new Error(result?.error || 'Unable to open the new chat');
      btn.textContent = result.existing ? 'Continuation already opened' : 'Continuing in this tab';
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Continue with HSTRY';
      const message = String(err?.message || err);
      btn.title = message;
      if (!retryOnce &&
          (/extension context invalidated/i.test(message) || !chrome.runtime?.id)) {
        // One reload restores a current extension context. A tab-local marker
        // resumes this user-initiated action exactly once after navigation.
        try {
          sessionStorage.setItem(RETRY_KEY,
            JSON.stringify({ path: location.pathname, at: Date.now() }));
          location.reload();
          return;
        } catch { /* Do not reload if the marker could not be stored. */ }
      }
      fallbackBanner(/extension context invalidated/i.test(message)
        ? 'HSTRY was updated but the extension is still unavailable. Refresh this chat and try again.'
        : 'HSTRY takeover: ' + message);
    }
  }

  function autoContinue(btn) {
    if (autoAttemptedPath === location.pathname) return;
    const active = document.visibilityState === 'visible' && document.hasFocus();
    if (submittedPath === location.pathname || active) {
      autoAttemptedPath = location.pathname;
      submittedPath = null;
      void startTakeover(btn, true);
    }
  }

  function detectLimit() {
    if (!/\\/c\\/[0-9a-f-]{36}/i.test(location.pathname)) return;
    const pageText = document.body?.textContent || '';
    if (!WARNING.test(pageText) && !/\\bunknown error\\b/i.test(pageText)) return;
    const native = [...document.querySelectorAll('button, a')].find(node =>
      /start new chat/i.test(node.textContent || ''));
    if (!native) return;
    // A generic error is not proof that the conversation has reached its limit.
    // Offer a manual recovery only when it shares the native new-chat panel.
    const terminalError = text =>
      /\\bunknown error\\b/i.test(text) && /start new chat/i.test(text);
    let panel = native.parentElement;
    for (let i = 0; i < 5 && panel && !WARNING.test(panel.textContent || '') &&
        !terminalError(panel.textContent || ''); i++) {
      panel = panel.parentElement;
    }
    if (!panel || (panel.textContent || '').length > 1500) return;
    const explicitLimit = WARNING.test(panel.textContent || '');
    if (!explicitLimit && !terminalError(panel.textContent || '')) return;
    const existing = document.getElementById('hstry-continue-chat');
    if (existing) { if (explicitLimit) autoContinue(existing); return; }
    const btn = document.createElement('button');
    btn.id = 'hstry-continue-chat';
    btn.type = 'button';
    btn.textContent = 'Continue with HSTRY';
    btn.title = 'Continue in this tab from your HSTRY archive';
    btn.style.cssText = 'margin:8px 8px 8px 0;padding:9px 16px;border-radius:24px;'+
      'border:1px solid #7d9e88;background:#305e46;color:#fff;cursor:pointer;'+
      'font:inherit;font-size:14px;';
    btn.addEventListener('click', event => {
      event.preventDefault();
      void startTakeover(btn);
    });
    native.insertAdjacentElement('afterend', btn);
    if (resumePending) {
      resumePending = false;
      submittedPath = null;
      void startTakeover(btn);
    } else if (explicitLimit) {
      autoContinue(btn);
    }
  }

  function editableElement() {
    const matches = document.querySelectorAll(
      '#prompt-textarea, [data-testid="prompt-textarea"], '+
      '[contenteditable="true"][role="textbox"], textarea[placeholder*="Message"], '+
      '[contenteditable="true"][data-placeholder]');
    return [...matches].find(el => el.getBoundingClientRect().width > 0 &&
      el.getBoundingClientRect().height > 0 && !el.hasAttribute('disabled')) || null;
  }

  function enterPrompt(el, prompt) {
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setValue.call(el, prompt);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      // React/ProseMirror editors listen for native insertion/input events.
      if (!document.execCommand('insertText', false, prompt)) {
        el.textContent = prompt;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }
    }
    return (el.value || el.textContent || '').includes(prompt.slice(0, 32));
  }

  function sendButton() {
    const candidates = document.querySelectorAll(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], '+
      'button[aria-label="Send message"], button[aria-label="Send"]');
    return [...candidates].find(b => !b.disabled && b.getBoundingClientRect().width > 0) || null;
  }

  function fallbackBanner(text) {
    if (document.getElementById('hstry-takeover-feedback')) return;
    const b = document.createElement('div');
    b.id = 'hstry-takeover-feedback';
    b.setAttribute('role', 'status');
    b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:999999;'+
      'max-width:340px;padding:14px;background:#274735;color:#fff;'+
      'border-radius:12px;box-shadow:0 4px 20px #0004;font:14px sans-serif';
    b.textContent = text;
    document.body.append(b);
  }

  async function takeOverIfPending() {
    if (handoffStarted || checkingHandoff ||
        (resumeWhenComposerReady && !editableElement())) return;
    checkingHandoff = true;
    let result;
    try { result = await send({ type:'HSTRY_TAKEOVER_POLL' }); }
    catch { checkingHandoff = false; return; }
    checkingHandoff = false;
    if (!result?.ok || !result.found || handoffStarted) return;
    handoffStarted = true;
    const prompt = result.prompt;
    try {
      const editor = editableElement();
      if (!editor) {
        // ChatGPT may render its composer after the page has loaded.
        // Keep the pending handoff and resume on the existing DOM observer.
        resumeWhenComposerReady = true;
        handoffStarted = false;
        scheduleWarningCheck();
        return;
      }
      resumeWhenComposerReady = false;
      if (!enterPrompt(editor, prompt)) throw new Error('ChatGPT did not accept the takeover text');
      // Wait for ChatGPT to enable its native send control.
      let button;
      for (let i = 0; i < 20; i++) {
        button = sendButton();
        if (button) break;
        await pause(250);
      }
      if (!button) throw new Error('Takeover text is ready; send it manually');
      button.click();
      // A native click alone is not a successful submission. Keep the handoff
      // pending if ChatGPT leaves the instruction in the composer.
      let submitted = false;
      for (let i = 0; i < 40; i++) {
        if (!(editor.value || editor.textContent || '').includes(prompt.slice(0, 32))) {
          submitted = true;
          break;
        }
        await pause(250);
      }
      if (!submitted) throw new Error('Takeover text remains in the composer; send it manually');
      await send({ type:'HSTRY_TAKEOVER_DONE' });
    } catch (e) {
      fallbackBanner('HSTRY takeover: ' + String(e.message || e) +
        '. If the instruction is in the composer, press Send. Otherwise retry from the original chat.');
    }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'HSTRY_TAKEOVER_WAKE') takeOverIfPending();
  });

  // Existing chat tabs do not poll. Only a new-chat landing page can be a
  // handoff destination; this does not create remote network traffic.
  if (location.pathname === '/' || /^\/g\/g-p-[0-9a-f]{32}(?:-[a-z0-9-]+)?(?:\/project)?\/?$/i.test(location.pathname)) {
    let retries = 0;
    const poll = setInterval(() => {
      if (handoffStarted || resumeWhenComposerReady || ++retries > 30) return clearInterval(poll);
      takeOverIfPending();
    }, 800);
    takeOverIfPending();
  }

  let observer;
  function scheduleWarningCheck() {
    clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      detectLimit();
      if (resumeWhenComposerReady && editableElement()) {
        resumeWhenComposerReady = false;
        void takeOverIfPending();
      }
    }, 700);
  }
  window.addEventListener('focus', scheduleWarningCheck);
  document.addEventListener('visibilitychange', scheduleWarningCheck);
  if (document.body) {
    observer = new MutationObserver(scheduleWarningCheck);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleWarningCheck();
  }
})();
