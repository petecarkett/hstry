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
