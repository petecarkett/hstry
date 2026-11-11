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
  let reloadRecord = null;
  try {
    const saved = sessionStorage.getItem(RETRY_KEY);
    sessionStorage.removeItem(RETRY_KEY);
    if (saved) {
      const retry = JSON.parse(saved);
      if (retry?.path === location.pathname &&
          Number.isFinite(retry.at) && Date.now() - retry.at < RETRY_TTL_MS &&
          Date.now() >= retry.at) {
        reloadRecord = retry;
        resumePending = true;
        retryOnce = true;
      }
    }
  } catch { /* Session storage is optional; normal clicks still work. */ }

  const WARNING = /you(?:'|\u2019)ve\s+reached\s+the\s+maximum\s+length\s+for\s+this\s+conversation/i;
  let serverLimitPath = reloadRecord?.serverLimit ? location.pathname : null;
  let rejectedMessage = typeof reloadRecord?.failedMessage === 'string' &&
    reloadRecord.failedMessage.length <= 8000 ? reloadRecord.failedMessage : '';
  let rejectedHasAttachments = reloadRecord?.missingAttachments === true;
  let rejectedTooLong = reloadRecord?.oversized === true;
  let resumeWhenComposerReady = false;
  let submittedPath = null;
  let autoAttemptedPath = null;
  let started = false;
  let detectionTimer;
  let handoffStarted = false;
  let checkingHandoff = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Title a new chat only after a real user sends from its empty landing page.
  // Existing chats, manually named chats and uncertain account identities stay unchanged.
  const isLanding = path => path === '/' ||
    /^\/g\/g-p-[0-9a-f]{32}(?:-[^/]*)?(?:\/project)?\/?$/i.test(path);
  let newChatLanding = isLanding(location.pathname);
  let landingPath = location.pathname;
  let newChatSubmitted = false, autoTitleAttempted = false, manualTitleEdit = false;
  let firstSubmittedAtMs = null;
  let titleTargetPath = null, lastObservedTitle = '', titleStableSinceMs = 0, titleWaitTimer = null;
  document.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const action = event.target?.closest?.('button, a, [role="button"], [role="menuitem"]');
    const name = (action?.getAttribute?.('aria-label') || action?.textContent || '').trim();
    if (/^new chat$/i.test(name)) {
      newChatLanding = true; landingPath = location.pathname;
      newChatSubmitted = false; autoTitleAttempted = false;
      firstSubmittedAtMs = null; manualTitleEdit = false; titleTargetPath = null;
      lastObservedTitle = ''; titleStableSinceMs = 0; clearTimeout(titleWaitTimer);
    }
    if (action?.getAttribute?.('role') === 'menuitem' && /^rename$/i.test(name)) {
      manualTitleEdit = true;
    }
  }, true);

  async function renameUsingChatGPT(oldTitle, newTitle, path) {
    if (location.pathname !== path || document.title !== oldTitle ||
        document.querySelector('[role="menu"], input[name="title-editor"]') ||
        (editableElement()?.textContent || editableElement()?.value || '').trim()) return false;
    const header = [...document.querySelectorAll('main button[aria-haspopup="menu"]')]
      .find(button => button.textContent?.trim() === oldTitle);
    if (!header) return false;
    // ChatGPT's Radix title menu listens to pointerdown, not element.click().
    header.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 1, pointerType: 'mouse',
      button: 0, buttons: 1, isPrimary: true,
    }));
    await pause(140);
    if (location.pathname !== path) return false;
    const rename = [...document.querySelectorAll('[role="menuitem"]')]
      .find(item => item.textContent?.trim().toLowerCase() === 'rename');
    if (!rename) return false;
    rename.click();
    await pause(140);
    const editor = document.querySelector('input[name="title-editor"], input[aria-label="Chat title"]');
    if (!editor || location.pathname !== path || document.title !== oldTitle ||
        editor.value?.trim() !== oldTitle) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(editor, newTitle);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await pause(75);
    const save = [...(editor.closest('[role="dialog"]')?.querySelectorAll('button[type="submit"]') ?? [])]
      .find(button => button.textContent?.trim() === 'Save' && !button.disabled);
    if (!save || location.pathname !== path || document.title !== oldTitle ||
        editor.value !== newTitle) return false;
    save.click();
    for (let i = 0; i < 10; i++) {
      await pause(200);
      if (location.pathname !== path) break;
      if (document.title === newTitle) return true;
    }
    return false; // Never retry an uncertain title write.
  }

  function maybeNameNewChat() {
    if (!newChatLanding || !newChatSubmitted || !firstSubmittedAtMs ||
        autoTitleAttempted || manualTitleEdit) return;
    const path = location.pathname;
    if (isLanding(path) || path === landingPath || !/\/c\/[0-9a-f-]{36}\/?$/i.test(path)) return;
    if (titleTargetPath && path !== titleTargetPath) return;
    titleTargetPath = path;
    if (document.querySelector('[data-testid="stop-button"]') ||
        !document.querySelector('[data-conversation-role="assistant"], [data-message-author-role="assistant"]')) return;
    const originalTitle = (document.title || '').trim();
    if (!originalTitle || /^(?:new chat|chatgpt)$/i.test(originalTitle)) return;
    if (originalTitle !== lastObservedTitle) {
      lastObservedTitle = originalTitle;
      titleStableSinceMs = Date.now();
    }
    if (Date.now() - titleStableSinceMs < 1800) {
      clearTimeout(titleWaitTimer);
      titleWaitTimer = setTimeout(maybeNameNewChat, 1900);
      return;
    }
    clearTimeout(titleWaitTimer);
    autoTitleAttempted = true;
    void (async () => {
      if (location.pathname !== path || document.title !== originalTitle || manualTitleEdit) return;
      const firstUser = document.querySelector('[data-user-message-bubble="true"]')?.innerText || '';
      const handoff = /^(?:continue the unfinished work|take over from this chat|resume (?:this|the) (?:chat|conversation))/i.test(firstUser.trim());
      const predecessorUrl = handoff ? firstUser.match(/https:\/\/chatgpt\.com\/(?:g\/[^\s)]+?\/)?c\/[0-9a-f-]{36}/i)?.[0] : null;
      const result = await send({ type: 'hstryAutoTitleProposal', url: location.href,
        title: originalTitle, openedAtMs: firstSubmittedAtMs,
        predecessorUrl });
      if (result?.ok && result.title && result.title !== originalTitle && !manualTitleEdit) {
        await renameUsingChatGPT(originalTitle, result.title, path);
      }
    })().catch(() => {}); // UI changes fail closed; never affect history capture.
  }

  // Only a real user submission may automatically recover a generic error.
  // Programmatic HSTRY handoff sends and historical errors stay manual.
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target?.closest?.('button[data-testid="send-button"], '+
        'button[aria-label="Send prompt"], button[aria-label="Send message"], '+
        'button[aria-label="Send"]')) {
      submittedPath = location.pathname;
      if (newChatLanding && isLanding(location.pathname)) {
        newChatSubmitted = true;
        firstSubmittedAtMs ??= Date.now();
      }
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.isTrusted && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey &&
        !event.metaKey && !event.altKey && !event.isComposing &&
        event.target?.closest?.('#prompt-textarea, [data-testid="prompt-textarea"], '+
          '[contenteditable="true"][data-composer-markdown], '+
          '[data-composer-body] [contenteditable="true"][role="textbox"], '+
          'textarea[placeholder*="Message"]')) {
      submittedPath = location.pathname;
      if (newChatLanding && isLanding(location.pathname)) {
        newChatSubmitted = true;
        firstSubmittedAtMs ??= Date.now();
      }
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
    if (serverLimitPath === location.pathname && rejectedTooLong) {
      fallbackBanner('HSTRY paused: the rejected message could not be preserved safely. Copy it before continuing.');
      return;
    }
    if (serverLimitPath === location.pathname && rejectedHasAttachments && automatic) {
      fallbackBanner('HSTRY paused: the rejected submission contained attachments. Reattach them manually before continuing.');
      return;
    }
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
      const result = await send({ type: 'HSTRY_TAKEOVER_START', automatic,
        failedMessage: serverLimitPath === location.pathname ? rejectedMessage : '',
        missingAttachments: serverLimitPath === location.pathname && rejectedHasAttachments });
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
          sessionStorage.setItem(RETRY_KEY, JSON.stringify({
            path: location.pathname, at: Date.now(), automatic,
            serverLimit: serverLimitPath === location.pathname,
            failedMessage: serverLimitPath === location.pathname ? rejectedMessage : '',
            missingAttachments: rejectedHasAttachments, oversized: rejectedTooLong,
          }));
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
    if (!/\/c\/[0-9a-f-]{36}/i.test(location.pathname)) return;
    const serverLimit = serverLimitPath === location.pathname;
    const pageText = document.body?.textContent || '';
    if (!serverLimit && !WARNING.test(pageText) && !/unknown error/i.test(pageText)) return;
    const native = [...document.querySelectorAll('button, a')].find(node =>
      /start new chat/i.test(node.textContent || ''));
    if (!native && !serverLimit) return;
    // Only generic terminal errors following a trusted submission may auto-continue.
    // Existing errors and programmatic submissions remain manual.
    // DOM textContent joins adjacent labels ('Unknown errorStart new chat').
    // Rendered innerText preserves the visual line break between the labels.
    const terminalError = node => {
      const text = node?.innerText || node?.textContent || '';
      return /\bunknown error\b/i.test(text) && /start new chat/i.test(text);
    };
    let panel = native?.parentElement || null;
    for (let i = 0; i < 5 && panel && !WARNING.test(panel.textContent || '') &&
        !terminalError(panel); i++) {
      panel = panel.parentElement;
    }
    if (!serverLimit && (!panel || (panel.textContent || '').length > 1500)) return;
    const explicitLimit = serverLimit || WARNING.test(panel?.textContent || '');
    const newTerminalError = !explicitLimit && submittedPath === location.pathname && terminalError(panel);
    if (!explicitLimit && !terminalError(panel)) return;
    const existing = document.getElementById('hstry-continue-chat');
    if (existing) { if (explicitLimit || newTerminalError) autoContinue(existing); return; }
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
    if (native) native.insertAdjacentElement('afterend', btn);
    else {
      btn.style.cssText += 'position:fixed;right:20px;bottom:85px;z-index:999999;';
      document.body.append(btn);
    }
    if (explicitLimit || newTerminalError) autoContinue(btn);
  }

  function editableElement() {
    const matches = document.querySelectorAll(
      '#prompt-textarea, [data-testid="prompt-textarea"], '+
      '[contenteditable="true"][data-composer-markdown], '+
      '[data-composer-body] [contenteditable="true"][role="textbox"], '+
      'textarea[placeholder*="Message"], [contenteditable="true"][data-placeholder]');
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
      const handoffSubmitAtMs = Date.now();
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
      if (newChatLanding) {
        newChatSubmitted = true;
        firstSubmittedAtMs ??= handoffSubmitAtMs;
        scheduleWarningCheck();
      }
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
    let composerWaits = 0;
    const poll = setInterval(() => {
      if (handoffStarted) return clearInterval(poll);
      if (checkingHandoff) {
        // Do not exhaust initial retries while a worker response is in flight.
        if (++composerWaits > 750) clearInterval(poll);
        return;
      }
      if (resumeWhenComposerReady) {
        // ChatGPT may keep mutating the page while its editor mounts.
        // DOM-only debounce can starve for minutes; do not repeat storage polls.
        if (++composerWaits > 750) {
          clearInterval(poll);
          fallbackBanner('HSTRY continuation: ChatGPT has not loaded its composer. Refresh this tab to retry.');
        } else if (editableElement()) {
          void takeOverIfPending();
        }
      } else if (++retries > 30) {
        clearInterval(poll);
      } else {
        void takeOverIfPending();
      }
    }, 800);
    takeOverIfPending();
  }

  let observer;
  function scheduleWarningCheck() {
    // Background tabs throttle timers, but DOM changes can wake a ready composer.
    if (resumeWhenComposerReady && editableElement()) {
      resumeWhenComposerReady = false;
      void takeOverIfPending();
    }
    clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => { detectLimit(); maybeNameNewChat(); }, 700);
  }
  window.addEventListener('hstry:conversation-too-large', event => {
    const detail = event?.detail;
    if (!detail || detail.path !== location.pathname ||
        !/\/c\/[0-9a-f-]{36}/i.test(detail.path)) return;
    serverLimitPath = detail.path;
    rejectedMessage = typeof detail.failedMessage === 'string' &&
      detail.failedMessage.length <= 8000 ? detail.failedMessage : '';
    rejectedHasAttachments = detail.includesAttachments === true;
    rejectedTooLong = detail.oversized === true ||
      (typeof detail.failedMessage === 'string' && detail.failedMessage.length > 8000);
    detectLimit();
  });
  window.addEventListener('focus', scheduleWarningCheck);
  document.addEventListener('visibilitychange', scheduleWarningCheck);
  if (document.body) {
    observer = new MutationObserver(scheduleWarningCheck);
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleWarningCheck();
  }
  if (resumePending) {
    // The terminal panel may vanish on reload; the exact-path, one-shot
    // receipt, not a surviving error DOM, authorizes resuming this action.
    resumePending = false;
    submittedPath = null;
    autoAttemptedPath = location.pathname;
    void startTakeover(document.createElement('button'), reloadRecord?.automatic === true);
  }
})();
