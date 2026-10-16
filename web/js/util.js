// util.js — small shared helpers (formatting, timing, DOM building, toasts, dialogs).
//
// Importable without a DOM: every function that touches `document` does so lazily when called.
// Shared CSS primitives used here (.lc-toast, .lc-modal, .lc-btn, .lc-input …) live in css/app.css.
// Assumptions (not fixed by the SPEC):
//  - fmtTime floors to the shown precision (like video players) instead of rounding.
//  - fmtTime `ms` accepts true (= 1 decimal, "02:03.4") or a number of decimals (2 → "02:03.45").
//  - confirmDialog({cancel: null}) renders a single-button notice.

/** Format seconds as "1:02:03" / "02:03" / "02:03.4". */
export function fmtTime(sec, { ms = false, hours = 'auto' } = {}) {
  let v = Number(sec);
  if (!Number.isFinite(v) || v < 0) v = 0;
  const dec = ms === true ? 1 : (typeof ms === 'number' && ms > 0 ? Math.min(3, Math.floor(ms)) : 0);
  const unit = Math.pow(10, dec);
  // Integer arithmetic in units of the shown precision avoids "02:60.0"-style artifacts.
  const total = Math.floor(v * unit + 1e-6);
  const whole = Math.floor(total / unit);
  const frac = total - whole * unit;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const showH = hours === true || (hours === 'auto' && h > 0);
  let out = showH ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m + h * 60)}:${pad2(s)}`;
  if (dec) out += '.' + String(frac).padStart(dec, '0');
  return out;
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/** Human friendly duration: "1분 23초", "4.2초", "1시간 2분". */
export function fmtDuration(sec) {
  let v = Number(sec);
  if (!Number.isFinite(v)) v = 0;
  const neg = v < 0;
  v = Math.abs(v);
  let out;
  if (v < 10) out = `${(Math.round(v * 10) / 10).toString()}초`;
  else if (v < 60) out = `${Math.round(v)}초`;
  else if (v < 3600) {
    const m = Math.floor(v / 60), s = Math.round(v - m * 60);
    out = s === 60 ? `${m + 1}분` : (s ? `${m}분 ${s}초` : `${m}분`);
  } else {
    const h = Math.floor(v / 3600), m = Math.round((v - h * 3600) / 60);
    out = m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  return neg ? '-' + out : out;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Trailing-edge debounce. The returned function has .cancel(), .flush() and .pending(). */
export function debounce(fn, ms) {
  let timer = null, lastArgs = null, lastThis = null;
  function invoke() {
    timer = null;
    const args = lastArgs, self = lastThis;
    lastArgs = lastThis = null;
    return fn.apply(self, args || []);
  }
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, ms);
  }
  debounced.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; lastArgs = lastThis = null; };
  debounced.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return invoke();
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/** Leading + trailing throttle. */
export function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null, lastThis = null;
  function throttled(...args) {
    const now = Date.now();
    const wait = ms - (now - last);
    lastArgs = args;
    lastThis = this;
    if (wait <= 0) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      last = now;
      fn.apply(lastThis, lastArgs);
    } else if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(lastThis, lastArgs);
      }, wait);
    }
  }
  throttled.cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  return throttled;
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text for safe use inside HTML text or attribute values. */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESC[c]);
}

/**
 * Build a DOM element.
 * attrs: class/className, style (string|object), dataset (object), on<Event> (function),
 *        boolean attributes (true → present, false/null → omitted), anything else → setAttribute.
 * children: strings, numbers, nodes, arrays (flattened), null/false (skipped).
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const val = attrs[key];
      if (val === undefined || val === null || val === false) continue;
      if (key === 'class' || key === 'className') node.className = val;
      else if (key === 'style') {
        if (typeof val === 'string') node.style.cssText = val;
        else Object.assign(node.style, val);
      } else if (key === 'dataset') Object.assign(node.dataset, val);
      else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
      else if (key === 'html') node.innerHTML = val;
      else if (key === 'text') node.textContent = val;
      else if (val === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(val));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(node, c);
    else if (typeof c === 'object' && c.nodeType) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Random id: prefix + 8 base36 chars ("c_k3j9x0aa"). */
export function uid(prefix = '') {
  let out = prefix;
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint8Array(8);
    c.getRandomValues(buf);
    for (let i = 0; i < 8; i++) out += B36[buf[i] % 36];
  } else {
    for (let i = 0; i < 8; i++) out += B36[Math.floor(Math.random() * 36)];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------------

const TOAST_MAX = 4;

/** Show a short message at the bottom of the window. kind: 'info' | 'ok' | 'warn' | 'error'. */
export function toast(message, kind = 'info', ms = 2600) {
  if (typeof document === 'undefined') return null;
  const root = document.getElementById('toast-root') || document.body;
  const text = String(message == null ? '' : message);
  // Same message already visible → restart its timer instead of stacking duplicates.
  for (const t of root.querySelectorAll('.lc-toast')) {
    if (t._lcText === text && !t.classList.contains('out')) {
      t._lcRestart(ms);
      return t;
    }
  }
  const node = el('div', { class: `lc-toast lc-toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    el('span', { class: 'lc-toast-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'lc-toast-msg' }, text));
  node._lcText = text;
  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    if (node.classList.contains('out')) return;
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  };
  node._lcRestart = (dur) => {
    if (timer) clearTimeout(timer);
    timer = dur > 0 ? setTimeout(close, dur) : null;
  };
  node.addEventListener('click', close);
  root.appendChild(node);
  const live = Array.from(root.querySelectorAll('.lc-toast:not(.out)'));
  for (let i = 0; i < live.length - TOAST_MAX; i++) live[i].click();
  node._lcRestart(ms);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Dialogs (shared .lc-modal primitives; E's modals may reuse the same classes)
// ---------------------------------------------------------------------------------------------

function openDialog(build) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root') || document.body;
    const prevFocus = document.activeElement;
    const backdrop = el('div', { class: 'lc-modal-backdrop' });
    const modal = el('div', { class: 'lc-modal', role: 'dialog', 'aria-modal': 'true' });
    backdrop.appendChild(modal);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('out');
      setTimeout(() => backdrop.remove(), 140);
      try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      resolve(value);
    };
    const api = build(modal, finish);
    const onKey = (e) => {
      // Only the top-most dialog reacts.
      if (root.lastElementChild !== backdrop) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(api.cancelValue);
      } else if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey) {
        const t = e.target;
        if (t && t.tagName === 'BUTTON' && modal.contains(t)) return; // let the focused button act
        e.preventDefault();
        e.stopPropagation();
        finish(api.okValue());
      } else if (e.key === 'Tab') {
        // Keep focus inside the dialog.
        const f = Array.from(modal.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])'))
          .filter((n) => !n.disabled);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        e.stopPropagation();
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length;
        f[next].focus();
      } else {
        // Keep global shortcuts away while a dialog is open.
        e.stopPropagation();
      }
    };
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(api.cancelValue);
    });
    window.addEventListener('keydown', onKey, true);
    root.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('in'));
    (api.focus || modal).focus();
  });
}

/** Ask a yes/no question. Resolves true for OK, false for cancel/Esc/backdrop. */
export function confirmDialog({ title = '', message = '', ok = '확인', cancel = '취소', danger = false } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return openDialog((modal, finish) => {
    const okBtn = el('button', { class: `lc-btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => finish(true) }, ok);
    const cancelBtn = cancel ? el('button', { class: 'lc-btn', type: 'button', onclick: () => finish(false) }, cancel) : null;
    modal.classList.add('lc-modal--sm');
    modal.append(
      title ? el('h2', { class: 'lc-modal-title' }, title) : null,
      message ? el('p', { class: 'lc-modal-msg' }, message) : null,
      el('div', { class: 'lc-modal-actions' }, cancelBtn, okBtn),
    );
    if (title) modal.setAttribute('aria-label', title);
    return { focus: okBtn, okValue: () => true, cancelValue: false };
  });
}

/** Ask for a line of text. Resolves the string, or null when canceled. */
export function promptDialog({ title = '', message = '', value = '', placeholder = '', ok = '확인', cancel = '취소' } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return openDialog((modal, finish) => {
    const input = el('input', { class: 'lc-input', type: 'text', value: value == null ? '' : String(value), placeholder, spellcheck: 'false', autocomplete: 'off' });
    const okBtn = el('button', { class: 'lc-btn primary', type: 'button', onclick: () => finish(input.value) }, ok);
    const cancelBtn = el('button', { class: 'lc-btn', type: 'button', onclick: () => finish(null) }, cancel);
    modal.classList.add('lc-modal--sm');
    modal.append(
      title ? el('h2', { class: 'lc-modal-title' }, title) : null,
      message ? el('p', { class: 'lc-modal-msg' }, message) : null,
      el('div', { class: 'lc-modal-field' }, input),
      el('div', { class: 'lc-modal-actions' }, cancelBtn, okBtn),
    );
    if (title) modal.setAttribute('aria-label', title);
    setTimeout(() => input.select(), 0);
    return { focus: input, okValue: () => input.value, cancelValue: null };
  });
}

/** True when the event target is a text-entry element (input, textarea, contenteditable). */
export function isTypingTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(type);
  }
  return false;
}

export default {
  fmtTime, fmtDuration, clamp, debounce, throttle, escapeHtml, el, uid, toast, confirmDialog, promptDialog, isTypingTarget,
};
