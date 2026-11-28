import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real page helper against the controls verified in ChatGPT's
// native Rename dialog, without writing or navigating any real conversation.
const script = readFileSync(new URL('../handoff-content.js', import.meta.url), 'utf8');
const start = script.indexOf('  async function renameUsingChatGPT(');
const end = script.indexOf('\n  function maybeNameNewChat()', start);
assert(start !== -1 && end > start, 'Native title helper must remain available');
const helper = script.slice(start, end);
const original = 'TikTok Automation';
const named = '2026-11-07 17:28 — 1hood — TikTok Automation 12';
const path = '/g/g-p-6818bc97551c8191865a07d09f7b3678-1hood/c/6addfdd2-81e0-83eb-b37c-97d7b316d6b8';
let menuOpen = false, dialogOpen = false, pointerOpened = false, inputDispatched = false, saved = 0;
class Input {
  constructor() { this._value = original; }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  dispatchEvent(event) { if (event.type === 'input') { inputDispatched = true; save.disabled = false; } }
  closest(selector) { return selector === '[role="dialog"]' && dialogOpen ? dialog : null; }
}
const editor = new Input();
const save = {
  textContent: 'Save', disabled: true,
  click() { assert(inputDispatched, 'React input update must occur before Save'); saved++; doc.title = editor.value; },
};
const dialog = { querySelectorAll: selector => selector === 'button[type="submit"]' ? [save] : [] };
const header = {
  textContent: original,
  dispatchEvent(event) { assert.equal(event.type, 'pointerdown'); pointerOpened = true; menuOpen = true; },
};
const rename = { textContent: 'Rename', click() { assert(menuOpen); menuOpen = false; dialogOpen = true; } };
const doc = {
  title: original,
  querySelector(selector) {
    if (selector === '[role="menu"], input[name="title-editor"]') return menuOpen ? {} : null;
    if (selector === 'input[name="title-editor"], input[aria-label="Chat title"]') return dialogOpen ? editor : null;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'main button[aria-haspopup="menu"]') return [header];
    if (selector === '[role="menuitem"]') return menuOpen ? [rename] : [];
    return [];
  },
};
const context = {
  document: doc,
  manualTitleEdit: false,
  location: { pathname: path },
  editableElement: () => ({ value: '', textContent: '' }),
  pause: async () => {},
  HTMLInputElement: Input,
  PointerEvent: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
  Event: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
};
const renameUsingChatGPT = vm.runInNewContext(`(function () { ${helper}\nreturn renameUsingChatGPT; })()`, context);
assert.equal(await renameUsingChatGPT(original, named, path), true);
assert(pointerOpened, 'Radix requires pointerdown, not a DOM click');
assert.equal(saved, 1, 'native Save is clicked exactly once');
assert.equal(doc.title, named);
assert.equal(await renameUsingChatGPT(original, named, path), false,
  'already renamed conversation cannot be renamed again');
assert.equal(saved, 1);
console.log('PASS native ChatGPT Rename: Radix pointerdown, input event, Save, read-back, no retry');

// Current ChatGPT UI: an icon-only Chat actions menu, RenameR shortcut label,
// and an inline Chat title editor which commits on Enter (no Save dialog).
{
  let menuOpen = false, inlineOpen = false, pointerOpened = false;
  let clock = 0, menuReadyAt = 0, editorReadyAt = 0;
  let menuDelay = 450, onPause = () => {};
  let inputDispatched = false, commits = 0;
  const oldTitle = 'QA verification';
  const newTitle = '2026-11-26 19:07 — 1hood — QA verification';
  class InlineInput {
    constructor() { this._value = oldTitle; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    matches(selector) { return selector === '[data-inline-rename-input="true"]'; }
    dispatchEvent(event) {
      if (event.type === 'input') inputDispatched = true;
      if (event.type === 'keydown' && event.key === 'Enter') {
        assert(inputDispatched, 'React input must update before Enter');
        commits++;
        doc.title = this.value;
        inlineOpen = false;
      }
    }
    closest() { return null; }
  }
  const inlineEditor = new InlineInput();
  const chatActions = {
    textContent: '',
    dispatchEvent(event) {
      assert.equal(event.type, 'pointerdown');
      pointerOpened = true;
      menuOpen = true;
      menuReadyAt = clock + menuDelay;
    },
  };
  const renameMenuItem = {
    textContent: 'RenameR',
    getAttribute(name) { return name === 'aria-keyshortcuts' ? 'R' : null; },
    click() { assert(menuOpen && clock >= menuReadyAt); menuOpen = false; inlineOpen = true; editorReadyAt = clock + 550; },
  };
  const doc = {
    title: oldTitle,
    querySelector(selector) {
      if (selector.includes('input[data-inline-rename-input="true"]') && inlineOpen) return inlineEditor;
      if (selector === 'main button[aria-label="Chat actions"][aria-haspopup="menu"]') return chatActions;
      if (selector === 'input[name="title-editor"], input[aria-label="Chat title"]') {
        return inlineOpen && clock >= editorReadyAt ? inlineEditor : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'main button[aria-haspopup="menu"]') return [];
      if (selector === '[role="menuitem"]') return menuOpen && clock >= menuReadyAt ? [renameMenuItem] : [];
      return [];
    },
  };
  const inlineContext = {
    document: doc, manualTitleEdit: false, location: { pathname: path },
    editableElement: () => ({ value: '', textContent: '' }),
    pause: async ms => { clock += ms; onPause(); }, HTMLInputElement: InlineInput,
    PointerEvent: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
    Event: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type, ...init }); } },
  };
  const runInline = vm.runInNewContext(`(function () { ${helper}\nreturn renameUsingChatGPT; })()`, inlineContext);
  inlineOpen = true;
  assert.equal(await runInline(oldTitle, newTitle, path), false,
    'never take over an inline title the user is editing');
  inlineOpen = false;
  assert.equal(await runInline(oldTitle, newTitle, path), true,
    'delayed Chat actions menu and inline editor must rename successfully');
  assert(pointerOpened, 'Chat actions menu must open via pointerdown');
  assert.equal(commits, 1, 'inline rename must commit exactly once');
  assert.equal(doc.title, newTitle);
  assert.equal(await runInline(oldTitle, newTitle, path), false,
    'readback prevents any second title write');
  assert.equal(commits, 1);

  // An absent control times out without a write or second click.
  doc.title = oldTitle;
  inlineEditor.value = oldTitle;
  menuDelay = 3000;
  const timeoutStart = clock;
  assert.equal(await runInline(oldTitle, newTitle, path), false);
  assert.equal(clock - timeoutStart, 2000, 'bounded menu readiness wait');
  assert.equal(commits, 1, 'never commit if menu is unavailable');

  // User ownership and navigation changes must abort a wait immediately.
  menuOpen = false;
  menuDelay = 450;
  onPause = () => { inlineContext.manualTitleEdit = true; };
  assert.equal(await runInline(oldTitle, newTitle, path), false);
  assert.equal(commits, 1, 'manual rename cancels the automation');
  inlineContext.manualTitleEdit = false;
  menuOpen = false;
  onPause = () => { inlineContext.location.pathname = '/c/different'; };
  assert.equal(await runInline(oldTitle, newTitle, path), false);
  assert.equal(commits, 1, 'navigation cancels the automation');
}
console.log('PASS delayed native rename: bounded wait, manual/navigation guards, once-only commit');

// The real title scheduler must not make an unverified root-account write,
// consume an unconfirmed handoff, or burn its only write on a stale proposal.
{
  const start = script.indexOf('  function maybeNameNewChat()');
  const end = script.indexOf('  // Only a real user submission', start);
  assert(start !== -1 && end > start);
  const rootPath = '/c/99999999-aaaa-4bbb-8ccc-dddddddddddd';
  const accountId = '88888888-aaaa-4bbb-8ccc-dddddddddddd';
  const source = 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111';
  const doc = { title: 'Continue Existing Work', querySelector: selector =>
    selector.includes('stop-button') ? null : selector.includes('assistant') ? {} :
      selector.includes('data-user-message-bubble') ? { innerText: 'collapsed first turn' } : null };
  const writes = [], proposals = [], deferred = [];
  const context = {
    document: doc, location: { pathname: rootPath, href: 'https://chatgpt.com'+rootPath },
    Date: { now: () => 10000 }, clearTimeout() {}, setTimeout() {}, scheduleWarningCheck() {},
    isLanding: path => path === '/', landingPath: '/', newChatLanding: true,
    newChatSubmitted: true, firstSubmittedAtMs: 1000, firstSubmittedPath: '/',
    firstSubmittedText: null, titleAccount: null, titlePredecessorUrl: source,
    titleHandoffDestination: null, autoTitleAttempted: false, titleProposalInFlight: false,
    manualTitleEdit: false, titleTargetPath: null, lastObservedTitle: doc.title,
    titleStableSinceMs: 1000, titleWaitTimer: null, lastProposedTitle: null,
    send: proposal => { proposals.push(proposal); return new Promise(resolve => deferred.push(resolve)); },
    renameUsingChatGPT: async (old, named, path) => { writes.push({old,named,path}); doc.title=named; return true; },
  };
  const schedule = vm.runInNewContext(`(function () { ${script.slice(start,end)}\nreturn maybeNameNewChat; })()`, context);
  schedule(); assert.equal(proposals.length, 0, 'root requires native account evidence');
  context.titleAccount = { path: '/', accountId };
  schedule(); assert.equal(proposals.length, 0, 'automatic continuation must have a verified receipt');
  context.titleHandoffDestination = rootPath;
  schedule(); assert.equal(proposals.length, 1);
  assert.equal(proposals[0].nativeAccountId, accountId);
  assert.equal(proposals[0].predecessorUrl, source, 'do not scrape a collapsed takeover bubble');
  doc.title = 'Archive recovery';
  deferred.shift()({ok:true,title:'2026-11-28 00:00 — Workspace — Old native title'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0, 'late proposal must not rename a newer native title');
  context.lastObservedTitle = doc.title; context.titleStableSinceMs = 1000;
  schedule(); assert.equal(proposals.length, 2);
  deferred.shift()({ok:true,title:'2026-11-28 00:00 — Workspace — Archive recovery'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  schedule(); assert.equal(proposals.length, 2, 'confirmed native write is never repeated');
}
console.log('PASS root continuation title: verified account and receipt, current title, exactly one native write');
