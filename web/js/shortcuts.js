// shortcuts.js — global keymap (macOS).
//
// - Letter keys are matched with e.code (layout/IME independent: ⌥A gives "å" and the Korean
//   layout gives "ㅁ" in e.key, but e.code stays "KeyA").
// - While typing (input/textarea/contenteditable) only ⌘S is handled; the editor's own inputs deal
//   with Enter/Tab/Esc themselves (and stop propagation).
// - While a modal / context menu / job overlay is open, shortcuts stay out of the way. Esc on a modal
//   falls back to clicking its close control ([data-close], .modal-close, [aria-label="닫기"]) if the
//   modal's own handler did not already handle it (e.defaultPrevented).
// - Browser defaults that would hijack the app (⌘S save page, ⌘O open file, ⌘F find bar, ⌘J downloads,
//   ⌘, preferences, Space scroll, Tab focus moves) are always prevented.
// Command names are the SPEC ones; 'nudge' takes (edge, delta), nav-* take {extend}, 'back' returns
// focus to the chips, 'clear-selection' handles Esc.

import { run, has } from './commands.js';
import { isTypingTarget } from './util.js';
import { store } from './store.js';

const NUDGE = 0.05;
// Commands that make sense while a key is held down.
const REPEATABLE = new Set([
  'nav-prev-token', 'nav-next-token', 'nav-prev-clip', 'nav-next-clip', 'nudge', 'undo', 'redo', 'speed-up', 'speed-down',
]);
// Mod-key combos whose browser default must never run inside the app window.
const BLOCK_DEFAULT = new Set(['KeyS', 'KeyO', 'KeyF', 'KeyJ', 'KeyE', 'KeyY', 'Comma', 'Period', 'KeyP', 'KeyD', 'KeyG']);
// Commands that work without an open project.
const NO_PROJECT_OK = new Set(['open-video', 'open-project', 'help', 'settings']);

let inited = false;

export function initShortcuts() {
  if (inited) return;
  inited = true;
  document.addEventListener('keydown', onKeyDown);
}

/** Map a keydown to [command, ...args] or null. Exported for tests/help. */
export function resolveKey(e) {
  const mod = e.metaKey || e.ctrlKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const code = e.code;
  const key = e.key;
  if (mod && !alt) {
    switch (code) {
      case 'KeyS': return ['save'];
      case 'KeyZ': return shift ? ['redo'] : ['undo'];
      case 'KeyY': return ['redo'];
      case 'KeyO': return ['open-video'];
      case 'KeyE': return shift ? ['merge-prev'] : ['merge-next'];
      case 'KeyF': return ['find'];
      case 'KeyA': return shift ? null : ['select-all'];
      case 'KeyJ': return ['jump-clip'];
      case 'Comma': return ['speed-down'];
      case 'Period': return ['speed-up'];
      case 'ArrowLeft': return ['nav-line-start', { extend: shift }];
      case 'ArrowRight': return ['nav-line-end', { extend: shift }];
      case 'ArrowUp': return ['nav-prev-clip', { extend: shift }];
      case 'ArrowDown': return ['nav-next-clip', { extend: shift }];
      default: return null;
    }
  }
  if (alt && shift && !mod) {
    switch (code) {
      case 'KeyA': return ['nudge', 'start', -NUDGE * 5];
      case 'KeyS': return ['nudge', 'start', NUDGE * 5];
      case 'KeyD': return ['nudge', 'end', -NUDGE * 5];
      case 'KeyF': return ['nudge', 'end', NUDGE * 5];
      default: break;
    }
  }
  if (alt && !mod) {
    switch (code) {
      case 'KeyA': return ['nudge', 'start', -NUDGE];
      case 'KeyS': return ['nudge', 'start', NUDGE];
      case 'KeyD': return ['nudge', 'end', -NUDGE];
      case 'KeyF': return ['nudge', 'end', NUDGE];
      case 'ArrowDown': return ['edit-caption'];
      case 'ArrowUp': return ['back'];
      case 'ArrowLeft': return ['nav-prev-token', { extend: shift }];
      case 'ArrowRight': return ['nav-next-token', { extend: shift }];
      case 'Backspace':
      case 'Delete': return ['clear-caption'];
      default: return null;
    }
  }
  if (mod) return null;
  if (code === 'Space' || key === ' ') return shift ? null : ['play-toggle'];
  switch (code) {
    case 'KeyC': return ['split-here'];
    case 'KeyQ': return ['cut-head'];
    case 'KeyW': return ['cut-tail'];
    case 'KeyI': return ['mark-in'];
    case 'KeyO': return ['mark-out'];
    case 'KeyX': return ['cut-marked'];
    case 'KeyT': return ['add-caption'];
    case 'KeyJ': return ['seek-back', shift];
    case 'KeyL': return ['seek-fwd', shift];
    case 'KeyK': return ['stop'];
    case 'Comma': return shift ? null : ['frame-back'];
    case 'Period': return shift ? null : ['frame-fwd'];
    default: break;
  }
  switch (key) {
    case 'Tab': return shift ? ['play-all'] : ['play-clip'];
    case 'Enter': return shift ? ['split-next'] : ['split'];
    case 'Delete': return ['delete'];
    case 'Backspace': return shift ? ['join-prev'] : ['delete'];
    case 'ArrowLeft': return ['nav-prev-token', { extend: shift }];
    case 'ArrowRight': return ['nav-next-token', { extend: shift }];
    case 'ArrowUp': return ['nav-prev-clip', { extend: shift }];
    case 'ArrowDown': return ['nav-next-clip', { extend: shift }];
    case 'Home': return ['jump-start'];
    case 'End': return ['jump-end'];
    case 'F2': return ['edit-word'];
    case 'Escape': return ['clear-selection'];
    case '?': return ['help'];
    default: break;
  }
  if (code === 'Slash' && shift) return ['help'];
  return null;
}

function modalOpen() {
  const mr = document.getElementById('modal-root');
  if (mr && mr.childElementCount > 0) return mr.lastElementChild;
  return document.querySelector('.lc-modal-backdrop');
}

function overlayOpen() {
  const jo = document.getElementById('job-overlay');
  return !!(jo && !jo.hidden && jo.childElementCount > 0 && getComputedStyle(jo).display !== 'none');
}

function closeTopModal(top) {
  if (!top) return false;
  const btn = top.querySelector('[data-close], .modal-close, [data-action="close"], [aria-label="닫기"], .lc-modal-close');
  if (btn && typeof btn.click === 'function') {
    btn.click();
    return true;
  }
  return false;
}

function isNativeActivator(t) {
  if (!t || t.nodeType !== 1) return false;
  const tag = t.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || '').toLowerCase();
    return type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'range';
  }
  return false;
}

function onKeyDown(e) {
  if (e.isComposing || e.keyCode === 229) return; // Korean IME composition
  const mod = e.metaKey || e.ctrlKey;
  // Never let the browser's own Save/Open/Find/Downloads/Preferences run in the app window.
  if (mod && !e.altKey && BLOCK_DEFAULT.has(e.code)) e.preventDefault();

  const target = e.target;
  const typing = isTypingTarget(target);
  const res = resolveKey(e);

  if (typing) {
    if (res && res[0] === 'save') {
      e.preventDefault();
      if (has('save')) run('save');
    }
    return;
  }

  const top = modalOpen();
  if (top) {
    if (e.key === 'Escape' && !e.defaultPrevented && closeTopModal(top)) e.preventDefault();
    return;
  }
  if (document.querySelector('.lc-menu')) return; // the context menu handles its own keys
  if (overlayOpen()) {
    if (e.code === 'Space' || e.key === 'Tab') e.preventDefault();
    return;
  }
  if (!res) return;
  const [cmd, ...args] = res;

  // Enter/Space on a focused button, checkbox, etc. keep their native meaning.
  if ((e.key === 'Enter' || e.code === 'Space') && isNativeActivator(target)) return;

  if (cmd === 'clear-selection' && e.defaultPrevented) return;
  // Handled keys never fall through to the browser (⌘← history back, Space scroll, Tab focus…).
  e.preventDefault();

  const app = document.getElementById('app');
  const noProject = !store.project || (app && app.classList.contains('no-project'));
  if (noProject && !NO_PROJECT_OK.has(cmd)) return;
  if (e.repeat && !REPEATABLE.has(cmd)) return;
  if (has(cmd)) run(cmd, ...args);
}

export default { initShortcuts, resolveKey };
