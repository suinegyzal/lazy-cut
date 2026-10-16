// panels.js [E] — start screen, create/open flows, transcription, stats panel and all modals.
//
// Modals are rendered into #modal-root with their own .lp-* classes (css/panels.css). One window-level
// keydown listener (capture phase) gives the top-most modal Esc / Enter / Tab-trap handling and keeps
// editor shortcuts quiet while a modal is open (⌘S still passes through).
//
// Assumptions (SPEC leaves these open):
//  - "정확도 낮음" in the stats panel has no list panel; clicking it jumps to the next low-confidence word
//    (select + seek) so it can be fixed with F2.
//  - The 군말 tab lists tokens flagged filler / filler? (any type); the 미인식 음성 tab lists every kept
//    noise token (so a noise token flagged filler? shows in both). Counts match store.stats().
//  - Repeats are unchecked by default (only strong fillers and NG clips are pre-checked, per SPEC §5.5).
//  - Export size estimate = (video bitrate for the quality + 192 kbps audio) × output duration; the video
//    bitrate follows SPEC §3.8 and is not scaled by the resolution choice.
//  - "play-all" (⇧Tab) plays from the selection start to the end (Space plays from the playhead).
//  - Overwrite confirmations always come from the server's 409 "exists" answer.
import { store } from './store.js';
import { register, run } from './commands.js';
import { api } from './api.js';
import { fmtTime, clamp, debounce, toast } from './util.js';
import { player } from './player.js';

const DEFAULT_SETTINGS = {
  model: 'turbo', lang: 'ko', maxChars: 22, silenceMin: 0.15, silenceKeep: 0.0, includeNoise: true,
  exportQuality: 'high', exportResolution: 'source', exportSrt: true, exportMap: false,
  skipDeleted: true, showCaptions: true,
};

const MODEL_INFO = {
  turbo: { title: '빠르게', badge: '권장', desc: '대부분 이걸로 충분해요 · 17분 영상 약 4~5분', size: '1.5GB' },
  'large-v3': { title: '정확하게', badge: '', desc: '조금 더 정확하지만 아주 느려요 · 영상 길이만큼 걸려요', size: '3GB' },
};

const STAGE_TEXT = {
  queued: '앞의 작업이 끝나길 기다리고 있어요',
  prep: '영상을 준비하고 있어요',
  model: '음성인식 모델을 준비하고 있어요',
  transcribe: '받아쓰는 중이에요',
  recover: '놓친 말을 다시 듣고 있어요',
  analyze: '자막 줄을 나누고 있어요',
  export: '영상을 만들고 있어요',
  proxy: '재생용 영상을 만들고 있어요',
};

let boot = { version: '', settings: {}, recent: [], models: {}, jobs: [] };
let settings = { ...DEFAULT_SETTINGS };
let appEl = null;
let modalRoot = null;
let transcribing = null;    // {jobId, projectId}
let exporting = null;       // {jobId}
let quitting = false;
const stack = [];           // open modals, top-most last
let modalSeq = 0;

// =====================================================================================================
// Small helpers
// =====================================================================================================

const $ = (id) => document.getElementById(id);
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'indeterminate', 'tabIndex']);

/** Tiny DOM builder: h('div', {class, style, dataset, html, onclick, ...attrs}, ...children). */
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') { if (typeof v === 'string') n.style.cssText = v; else Object.assign(n.style, v); }
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  addKids(n, kids);
  return n;
}

function addKids(n, kids) {
  for (const c of kids) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) addKids(n, c);
    else if (typeof c === 'object' && c.nodeType) n.appendChild(c);
    else n.appendChild(document.createTextNode(String(c)));
  }
}

function basename(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function dirname(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : (i === 0 ? '/' : '');
}

function prettyDir(p) {
  return String(p || '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
}

/** "1분 23초", "4.2초", "1시간 2분" (rounded for display). */
function fmtKDur(sec) {
  let v = Math.abs(Number(sec) || 0);
  if (v < 10) return `${Math.round(v * 10) / 10}초`;
  if (v < 60) return `${Math.round(v)}초`;
  if (v < 3600) {
    let m = Math.floor(v / 60), s = Math.round(v - m * 60);
    if (s === 60) { m += 1; s = 0; }
    return s ? `${m}분 ${s}초` : `${m}분`;
  }
  const hh = Math.floor(v / 3600), m = Math.round((v - hh * 3600) / 60);
  return m ? `${hh}시간 ${m}분` : `${hh}시간`;
}

/** Korean particle after a word: josa('1분', '이', '가') → '이'. */
function josa(word, withFinal, withoutFinal) {
  const s = String(word || '').trim();
  const c = s.charCodeAt(s.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? withFinal : withoutFinal;
  return withFinal;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}GB`;
  if (v >= 1e6) return `${Math.round(v / 1e6)}MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}KB`;
  return `${Math.round(v)}B`;
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `오늘 ${hm}`;
  if (diff === 1) return `어제 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function fmtEta(sec) {
  if (!(sec >= 0) || !isFinite(sec)) return '';
  if (sec < 10) return '곧 끝나요';
  if (sec < 60) return `남은 시간 약 ${Math.ceil(sec / 10) * 10}초`;
  if (sec < 90) return '남은 시간 약 1분';
  if (sec < 3600) return `남은 시간 약 ${Math.round(sec / 60)}분`;
  return `남은 시간 약 ${fmtKDur(sec)}`;
}

function truncate(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function errMsg(e, fallback = '문제가 생겼어요. 다시 해 볼까요?') {
  return (e && e.message) || fallback;
}

/** Wrap an async UI action so failures always end in a friendly toast. */
function guard(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error('[panels]', e);
      toast(errMsg(e), 'error', 5000);
      return undefined;
    }
  };
}

function setAppClass(name, on) {
  if (appEl) appEl.classList.toggle(name, !!on);
}

function hasProject() { return !!store.project; }
function hasClips() { return !!(store.project && store.project.clips && store.project.clips.length); }

function requireClips() {
  if (!hasProject()) { toast('먼저 영상을 불러와 주세요', 'info'); return false; }
  if (transcribing) { toast('받아쓰기가 끝나면 쓸 수 있어요', 'info'); return false; }
  if (!hasClips()) { toast('먼저 받아쓰기를 해 주세요', 'info'); return false; }
  return true;
}

/** Subscribe to several store events; returns an unsubscribe function. */
function onStore(events, fn) {
  for (const e of events) store.on(e, fn);
  return () => { for (const e of events) store.off(e, fn); };
}

const ICONS = {
  film: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 9.2v5.6l4.6-2.8z" fill="currentColor"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 3.2v9.6a.7.7 0 0 0 1.06.6l7.7-4.8a.7.7 0 0 0 0-1.2l-7.7-4.8a.7.7 0 0 0-1.06.6z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3.5V8h4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

const LOGO_SVG = `<svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">
<defs><linearGradient id="lp-logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6F9BFF"/><stop offset="1" stop-color="#2450F5"/></linearGradient></defs>
<rect width="64" height="64" rx="15" fill="url(#lp-logo-g)"/>
<g fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
<circle cx="14.5" cy="34" r="4.4"/><circle cx="14.5" cy="45.4" r="4.4"/>
<path d="M18.6 36.2L41 43.2M18.6 43.2L41 36.2"/>
<path d="M45 39.7h2.4M50.3 39.7h2.4M55.6 39.7h1.6"/>
<path d="M41 14.8h9.4l-9.4 9.2h9.4"/>
<path d="M34.6 24.4h5.4l-5.4 5.4h5.4"/>
</g></svg>`;

// =====================================================================================================
// Modal system
// =====================================================================================================

function btn(label, { kind = '', onClick, title, small = false, primary = false, disabled = false, icon = null } = {}) {
  const cls = ['lp-btn'];
  if (kind) cls.push(kind);
  if (small) cls.push('small');
  const b = h('button', { type: 'button', class: cls.join(' '), title, disabled },
    icon ? h('span', { class: 'lp-btn-icon', html: icon }) : null, h('span', { class: 'lp-btn-label' }, label));
  if (primary) b.dataset.primary = '1';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function setBtnLabel(b, label) {
  const l = b.querySelector('.lp-btn-label');
  if (l) l.textContent = label; else b.textContent = label;
}

/**
 * Open a modal (or a right-side drawer).
 * opts: {key, title, size:'sm'|'md'|'lg', drawer, body, footLeft:[], footRight:[], onClose(reason),
 *        onEnter(e) → true if handled, canClose() → bool, backdropClose, initialFocus, className}
 */
function openModal(opts) {
  const titleId = `lp-modal-title-${++modalSeq}`;
  const closeBtn = h('button', { type: 'button', class: 'lp-icon-btn lp-modal-x', title: '닫기 (Esc)', 'aria-label': '닫기', html: ICONS.close });
  const titleEl = h('h2', { class: 'lp-modal-title', id: titleId }, opts.title || '');
  const body = h('div', { class: 'lp-modal-body' });
  const footL = h('div', { class: 'lp-foot-left' });
  const footR = h('div', { class: 'lp-foot-right' });
  const foot = h('footer', { class: 'lp-modal-foot' }, footL, footR);
  const box = h('div', {
    class: `lp-modal lp-modal--${opts.size || 'md'}${opts.drawer ? ' lp-drawer' : ''}${opts.className ? ' ' + opts.className : ''}`,
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  }, h('header', { class: 'lp-modal-head' }, titleEl, closeBtn), body, foot);
  const back = h('div', { class: `lp-backdrop${opts.drawer ? ' lp-backdrop--drawer' : ''}` }, box);

  const m = {
    key: opts.key || null,
    opts,
    el: box,
    back,
    body,
    closed: false,
    prevFocus: document.activeElement,
    setTitle(t) { titleEl.textContent = t; },
    setBody(...nodes) { body.replaceChildren(); addKids(body, nodes); },
    setFoot(left, right) {
      footL.replaceChildren(); addKids(footL, left || []);
      footR.replaceChildren(); addKids(footR, right || []);
      foot.hidden = !(footL.childNodes.length || footR.childNodes.length);
    },
    primary() {
      const b = footR.querySelector('[data-primary="1"]') || box.querySelector('[data-primary="1"]');
      return b && !b.disabled && b.offsetParent !== null ? b : null;
    },
    focusFirst() {
      const f = focusables(box);
      const target = (opts.initialFocus && opts.initialFocus.isConnected && opts.initialFocus) || f.find((x) => x !== closeBtn) || closeBtn;
      try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    },
    close(reason = 'close') {
      if (m.closed) return;
      if (reason !== 'force' && opts.canClose && opts.canClose(reason) === false) return;
      m.closed = true;
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
      back.classList.add('is-out');
      setTimeout(() => back.remove(), 140);
      if (opts.onClose) { try { opts.onClose(reason); } catch (e) { console.error(e); } }
      const top = stack[stack.length - 1];
      if (top) top.focusFirst();
      else if (m.prevFocus && m.prevFocus.isConnected && m.prevFocus.focus) {
        try { m.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
    },
  };
  closeBtn.addEventListener('click', () => m.close('x'));
  back.addEventListener('mousedown', (e) => {
    if (e.target === back && (opts.backdropClose || opts.drawer)) m.close('backdrop');
  });
  if (opts.body) m.setBody(opts.body);
  m.setFoot(opts.footLeft, opts.footRight);
  stack.push(m);
  modalRoot.appendChild(back);
  requestAnimationFrame(() => back.classList.add('is-in'));
  m.focusFirst();
  return m;
}

function focusables(root) {
  const sel = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll(sel)).filter((n) => {
    if (n.offsetParent === null && n.getClientRects().length === 0) return false;
    // Radio groups: only the checked one (or the first) takes part in Tab order.
    if (n.type === 'radio' && !n.checked) {
      const group = root.querySelectorAll(`input[type="radio"][name="${CSS.escape(n.name)}"]`);
      const anyChecked = Array.from(group).some((g) => g.checked);
      return !anyChecked && group[0] === n;
    }
    return true;
  });
}

function topModal() {
  const m = stack[stack.length - 1];
  if (!m) return null;
  // Someone else's dialog (util.confirmDialog) may sit above ours in #modal-root; backdrops that are
  // fading out (ours: .is-out, util's: .out) don't count.
  const kids = modalRoot.children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i];
    if (k.classList.contains('is-out') || k.classList.contains('out')) continue;
    return k === m.back ? m : null;
  }
  return null;
}

function findModal(key) {
  return stack.find((m) => m.key === key && !m.closed) || null;
}

function onModalKey(e) {
  const m = topModal();
  if (!m) return;
  const t = e.target;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    m.close('esc');
    return;
  }
  if (e.key === 'Tab') {
    e.stopImmediatePropagation();
    const f = focusables(m.el);
    if (!f.length) { e.preventDefault(); return; }
    const i = f.indexOf(document.activeElement);
    const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i >= f.length - 1 ? 0 : i + 1);
    e.preventDefault();
    f[next].focus();
    return;
  }
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const tag = t && t.tagName;
    if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || e.shiftKey) {
      e.stopImmediatePropagation();
      return; // native behavior (button click, newline …)
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (m.opts.onEnter && m.opts.onEnter(e)) return;
    const p = m.primary();
    if (p) p.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) return;   // let ⌘S save
  e.stopImmediatePropagation();   // keep editor shortcuts away; native typing still works
}

function onFocusIn(e) {
  const m = topModal();
  if (!m || quitting) return;
  const t = e.target;
  if (m.back.contains(t)) return;
  if (t && t.closest && t.closest('[role="dialog"], [aria-modal="true"]')) return;
  m.focusFirst();
}

function closeAllModals() {
  for (const m of stack.slice().reverse()) m.close('force');
}

/** Ask with several choices. Resolves the chosen value, or cancelValue for Esc / ×. */
function ask({ title, message, detail, choices, cancelValue = null, size = 'sm' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close('choice');
      resolve(v);
    };
    const right = choices.map((c) => btn(c.label, { kind: c.kind || '', primary: !!c.primary, onClick: () => finish(c.value) }));
    const m = openModal({
      title, size,
      body: [message ? h('p', { class: 'lp-msg' }, message) : null, detail ? h('p', { class: 'lp-detail' }, detail) : null],
      footRight: right,
      onClose: () => { if (!done) { done = true; resolve(cancelValue); } },
      initialFocus: right.find((b) => b.dataset.primary === '1') || right[right.length - 1],
    });
  });
}

function confirmAsk({ title, message, detail, ok = '확인', cancel = '취소', danger = false }) {
  return ask({
    title, message, detail, cancelValue: false,
    choices: [{ label: cancel, value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary', primary: true }],
  });
}

/** A small "working…" pill (not a modal). Returns hide(). */
function busy(text, sub) {
  const pill = h('div', { class: 'lp-busy', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'lp-spinner' }),
    h('div', { class: 'lp-busy-text' }, h('div', null, text), sub ? h('div', { class: 'lp-busy-sub' }, sub) : null));
  document.body.appendChild(pill);
  requestAnimationFrame(() => pill.classList.add('is-in'));
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    pill.classList.remove('is-in');
    setTimeout(() => pill.remove(), 160);
  };
}

async function withBusy(text, fn, sub) {
  const hide = busy(text, sub);
  try { return await fn(); } finally { hide(); }
}

/** Native dialogs (osascript) can open behind the browser window — say so while we wait. */
function nativeDialog(path, body) {
  return withBusy('파일을 고르는 창을 열었어요', () => api.post(path, body || {}), '창이 안 보이면 다른 창 뒤에 있을 수 있어요');
}

// --- form controls ---

function numInput({ value, min, max, step = 0.1, width = 72, label }) {
  return h('input', { type: 'number', class: 'lp-num', value: String(value), min, max, step, inputmode: 'decimal', style: { width: `${width}px` }, 'aria-label': label });
}

function readNum(input, lo, hi, fallback) {
  const v = parseFloat(String(input.value).replace(',', '.'));
  if (!isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

function checkbox(label, checked, onChange, extra) {
  const i = h('input', { type: 'checkbox', checked: !!checked });
  if (onChange) i.addEventListener('change', () => onChange(i.checked));
  const l = h('label', { class: 'lp-check' }, i, h('span', { class: 'lp-check-box', 'aria-hidden': 'true' }), h('span', { class: 'lp-check-label' }, label, extra || null));
  l.input = i;
  return l;
}

/** Segmented radio control. options: [{value, label, disabled, title}]. */
function segmented(name, options, value, onChange) {
  const wrap = h('div', { class: 'lp-seg', role: 'radiogroup' });
  const uname = `${name}-${++modalSeq}`;
  for (const o of options) {
    const input = h('input', { type: 'radio', name: uname, value: o.value, checked: o.value === value, disabled: !!o.disabled });
    input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
    wrap.appendChild(h('label', { class: `lp-seg-opt${o.disabled ? ' is-disabled' : ''}`, title: o.title }, input, h('span', null, o.label)));
  }
  return wrap;
}

function modelPicker(value, onChange) {
  const name = `lp-model-${++modalSeq}`;
  const wrap = h('div', { class: 'lp-choices', role: 'radiogroup' });
  for (const key of Object.keys(MODEL_INFO)) {
    const info = MODEL_INFO[key];
    const m = (boot.models && boot.models[key]) || {};
    const input = h('input', { type: 'radio', name, value: key, checked: key === value });
    input.addEventListener('change', () => { if (input.checked) onChange(key); });
    const note = m.downloaded === false
      ? h('span', { class: 'lp-choice-note' }, `처음 한 번 ${m.sizeLabel || info.size}를 내려받아요`)
      : null;
    wrap.appendChild(h('label', { class: 'lp-choice' }, input,
      h('span', { class: 'lp-choice-body' },
        h('span', { class: 'lp-choice-title' }, info.title, info.badge ? h('span', { class: 'lp-badge' }, info.badge) : null),
        h('span', { class: 'lp-choice-desc' }, info.desc),
        note)));
  }
  return wrap;
}

// --- progress block (job overlay + export modal) ---

function makeEta() {
  let t0 = null, p0 = 0, est = null, estAt = 0;
  return {
    feed(p, counting) {
      const now = Date.now();
      if (!counting) { t0 = null; est = null; return; }
      if (t0 == null) { t0 = now; p0 = p; return; }
      const dt = (now - t0) / 1000, dp = p - p0;
      if (dt < 4 || dp < 0.01) return;
      const remain = Math.max(0, (1 - p) * dt / dp);
      const cur = est == null ? null : Math.max(0, est - (now - estAt) / 1000);
      est = cur == null ? remain : cur * 0.6 + remain * 0.4;
      estAt = now;
    },
    get() { return est == null ? null : Math.max(0, est - (Date.now() - estAt) / 1000); },
  };
}

function stageText(job) {
  if (!job) return '';
  if (job.state === 'queued') return job.message || STAGE_TEXT.queued;
  return job.message || STAGE_TEXT[job.stage] || '';
}

function progressBlock() {
  const bar = h('div', { class: 'lp-progress-bar' });
  const track = h('div', { class: 'lp-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, bar);
  const pct = h('span', { class: 'lp-prog-pct' }, '0%');
  const time = h('span', { class: 'lp-prog-time' }, '');
  const stage = h('p', { class: 'lp-prog-stage' }, '');
  const el = h('div', { class: 'lp-prog' }, track, h('div', { class: 'lp-prog-meta' }, pct, time), stage);
  const eta = makeEta();
  let startedAt = Date.now();
  let gotStart = false;
  let last = null;
  const render = () => {
    const j = last;
    const parts = [];
    if (j && j.state === 'queued') parts.push('대기 중');
    else {
      parts.push(`경과 ${fmtTime((Date.now() - startedAt) / 1000)}`);
      const e = eta.get();
      if (e != null) parts.push(fmtEta(e));
    }
    time.textContent = parts.join(' · ');
  };
  const timer = setInterval(render, 1000);
  return {
    el,
    update(j) {
      if (!j) return;
      last = j;
      const p = clamp(+j.progress || 0, 0, 1);
      if (!gotStart && j.started && j.started * 1000 <= Date.now() + 5000 && Date.now() - j.started * 1000 < 864e5) {
        startedAt = j.started * 1000;
        gotStart = true;
      }
      const pc = Math.floor(p * 100);
      bar.style.width = `${(p * 100).toFixed(1)}%`;
      track.setAttribute('aria-valuenow', String(pc));
      pct.textContent = `${pc}%`;
      // Model download / waiting would distort the estimate: only count the real work.
      eta.feed(p, j.state === 'running' && j.stage !== 'model' && j.stage !== 'prep');
      stage.textContent = stageText(j);
      render();
    },
    stop() { clearInterval(timer); },
  };
}

// =====================================================================================================
// Start screen
// =====================================================================================================

function renderStart() {
  const host = $('start-screen');
  if (!host) return;
  const openVideo = btn('영상 불러오기', { kind: 'primary', icon: ICONS.film, onClick: () => run('open-video') });
  const openProject = btn('프로젝트 열기', { icon: ICONS.folder, onClick: () => run('open-project') });
  openVideo.classList.add('lg');
  openProject.classList.add('lg');

  const recent = (boot.recent || []).filter((r) => r && r.path);
  let list;
  if (!recent.length) {
    list = h('p', { class: 'lp-recent-empty' }, '아직 만든 프로젝트가 없어요. 영상을 불러와서 시작해 보세요.');
  } else {
    list = h('ul', { class: 'lp-recent-list' }, recent.map((r) => {
      const missing = r.exists === false;
      const meta = missing
        ? h('span', { class: 'lp-recent-meta is-missing' }, '파일을 찾을 수 없어요')
        : h('span', { class: 'lp-recent-meta' }, [r.duration ? fmtTime(r.duration) : '', fmtDate(r.updatedAt)].filter(Boolean).join(' · '));
      const item = h('button', {
        type: 'button',
        class: `lp-recent-item${missing ? ' is-missing' : ''}`,
        title: r.path,
        'aria-disabled': missing ? 'true' : null,
      }, h('span', { class: 'lp-recent-icon', html: ICONS.file }), h('span', { class: 'lp-recent-name' }, r.name || basename(r.path)), meta);
      item.addEventListener('click', () => {
        if (missing) { toast('파일을 찾을 수 없어요. 옮기거나 지웠는지 확인해 주세요', 'warn'); return; }
        guard(openFromStart)(r.path);
      });
      return h('li', null, item);
    }));
  }

  host.replaceChildren(h('div', { class: 'lp-start' },
    h('div', { class: 'lp-start-main' },
      h('div', { class: 'lp-start-brand' }, h('span', { class: 'lp-logo', html: LOGO_SVG }), h('span', { class: 'lp-logo-text' }, 'Lazy - Cut')),
      h('p', { class: 'lp-tagline' }, '말한 대로 자르는 컷편집'),
      h('div', { class: 'lp-start-actions' }, openVideo, openProject),
      h('section', { class: 'lp-recent', 'aria-label': '최근 프로젝트' },
        h('h3', { class: 'lp-recent-head' }, '최근 프로젝트'), list)),
    h('footer', { class: 'lp-start-foot' },
      h('span', null, `Lazy - Cut ${boot.version || ''}`.trim()),
      h('span', null, h('kbd', null, '⌘'), h('kbd', null, 'O'), ' 영상 불러오기'),
      h('span', null, h('kbd', null, '?'), ' 단축키'))));
}

async function openFromStart(path) {
  if (!(await canLeaveProject())) return;
  await openProjectPath(path);
}

// =====================================================================================================
// Create / open / relink flows
// =====================================================================================================

async function flushSave() {
  if (!store.project || !store.dirty) return true;
  try {
    await run('save');   // main.js's save command (shows "저장 중…"); falls through if it is missing
  } catch (e) { /* fall back to a direct save */ }
  if (!store.dirty) return true;
  try {
    const res = await api.post('/api/project/save', { project: store.project });
    store.markSaved(res.savedAt);
    return true;
  } catch (e) {
    toast(`저장하지 못했어요: ${errMsg(e)}`, 'error', 5000);
    return false;
  }
}

async function canLeaveProject() {
  if (transcribing) { toast('받아쓰기가 끝나면 다른 영상을 열 수 있어요', 'info'); return false; }
  if (exporting) { toast('내보내기가 끝나면 열 수 있어요', 'info'); return false; }
  if (store.project && store.dirty) return flushSave();
  return true;
}

function loadProject(project, { missingSource = false } = {}) {
  player.setMissing(!!missingSource, () => guard(relinkFlow)(false));
  store.load(project);
}

function onProjectLoaded() {
  setAppClass('no-project', !store.project);   // main.js does this too; harmless and keeps E self-contained
  renderStatsSoon();
}

async function cmdOpenVideo() {
  if (!(await canLeaveProject())) return;
  const r = await nativeDialog('/api/dialog/open-video');
  if (!r || !r.path) return;
  await createFromVideo(r.path, false);
}

async function cmdOpenProject() {
  if (!(await canLeaveProject())) return;
  const r = await nativeDialog('/api/dialog/open-project');
  if (!r || !r.path) return;
  await openProjectPath(r.path);
}

async function createFromVideo(videoPath, force) {
  const res = await withBusy('영상을 살펴보는 중이에요…', () => api.post('/api/project/create', { videoPath, force: !!force }));
  if (res.exists) {
    const choice = await ask({
      title: '이미 만든 프로젝트가 있어요',
      message: '이 영상으로 만든 프로젝트가 있어요. 열까요?',
      detail: '새로 만들면 기존 프로젝트를 덮어쓰고 처음부터 다시 받아써요.',
      choices: [
        { label: '새로 만들기', value: 'new' },
        { label: '열기', value: 'open', kind: 'primary', primary: true },
      ],
    });
    if (choice === 'open') return openProjectPath(res.projectPath);
    if (choice === 'new') {
      const sure = await confirmAsk({ title: '새로 만들까요?', message: '기존 프로젝트의 편집 내용이 사라져요.', ok: '새로 만들기', danger: true });
      if (sure) return createFromVideo(videoPath, true);
    }
    return undefined;
  }
  if (!res.project) throw new Error('프로젝트를 만들지 못했어요');
  loadProject(res.project);
  if (res.warning) toast(res.warning, 'warn', 6000);
  openTranscribeSetup();
  return undefined;
}

async function openProjectPath(path) {
  const res = await withBusy('프로젝트를 여는 중이에요…', () => api.post('/api/project/open', { path }));
  if (!res.project) throw new Error('프로젝트를 열지 못했어요');
  loadProject(res.project, { missingSource: !!res.missingSource });
  if (res.warning) toast(res.warning, 'warn', 6000);
  else if (res.relinked) toast('옮겨진 영상을 찾아서 다시 연결했어요', 'ok');
  if (res.missingSource) {
    const linked = await relinkFlow(true);
    if (!linked) return;
  }
  afterOpen();
}

/** After opening: re-attach to a transcription still running for it, or offer one. */
function afterOpen() {
  const p = store.project;
  if (!p || hasClips() || transcribing) return;
  const running = (boot.jobs || []).find((j) => j && /transcri/.test(j.kind || '') && j.projectId === p.id
    && (j.state === 'running' || j.state === 'queued'));
  if (running) attachTranscribe(running);
  else openTranscribeSetup();
}

/** Ask for the moved source video and relink it. Returns true when relinked. */
async function relinkFlow(fromOpen) {
  const p = store.project;
  if (!p) return false;
  const name = basename((p.source && p.source.path) || '') || p.name || '';
  if (fromOpen) {
    const go = await ask({
      title: '원본 영상을 찾을 수 없어요',
      message: `'${name}' 파일을 옮겼거나 이름을 바꿨나 봐요. 영상을 다시 연결할까요?`,
      detail: '연결하기 전에는 편집 내용만 볼 수 있어요.',
      choices: [{ label: '나중에', value: false }, { label: '영상 찾기', value: true, kind: 'primary', primary: true }],
      cancelValue: false,
    });
    if (!go) return false;
  }
  const r = await nativeDialog('/api/dialog/locate', { name });
  if (!r || !r.path) return false;
  await flushSave();
  const res = await withBusy('영상을 연결하는 중이에요…', () => api.post('/api/project/relink', { projectId: p.id, videoPath: r.path }));
  if (!res.project) throw new Error('영상을 연결하지 못했어요');
  loadProject(res.project, { missingSource: false });
  if (res.warning) toast(res.warning, 'warn', 7000);
  else toast('영상을 다시 연결했어요', 'ok');
  if (!fromOpen) afterOpen();
  return true;
}

// =====================================================================================================
// Transcription
// =====================================================================================================

function openTranscribeSetup() {
  const p = store.project;
  if (!p || transcribing) return;
  const existing = findModal('transcribe');
  if (existing) { existing.focusFirst(); return; }
  let model = MODEL_INFO[settings.model] ? settings.model : 'turbo';
  const maxIn = numInput({ value: (p.settings && p.settings.maxChars) || settings.maxChars || 22, min: 8, max: 60, step: 1, width: 64, label: '최대 글자수' });
  const startBtn = btn('받아쓰기 시작', { kind: 'primary', primary: true });
  const m = openModal({
    key: 'transcribe',
    title: '받아쓰기',
    size: 'md',
    body: [
      h('p', { class: 'lp-lead' }, '영상 속 말을 받아써서 편집할 대본과 자막을 만들어요.'),
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '받아쓰기 방식'), modelPicker(model, (v) => { model = v; })),
      h('div', { class: 'lp-field lp-field--row' },
        h('div', { class: 'lp-field-label' }, '자막 한 줄 최대 글자수'),
        h('div', { class: 'lp-inline' }, maxIn, h('span', null, '자'))),
      h('p', { class: 'lp-hint' }, '받아쓰는 동안 다른 앱을 써도 돼요.'),
    ],
    footRight: [btn('나중에', { onClick: () => m.close('later') }), startBtn],
    initialFocus: startBtn,
  });
  startBtn.addEventListener('click', guard(async () => {
    const maxChars = Math.round(readNum(maxIn, 8, 60, 22));
    startBtn.disabled = true;
    try {
      await startTranscribe(model, maxChars);
      m.close('start');
    } finally {
      startBtn.disabled = false;
    }
  }));
}

async function startTranscribe(model, maxChars) {
  const p = store.project;
  if (!p) return;
  const res = await api.post('/api/project/transcribe', { projectId: p.id, model, lang: settings.lang || 'ko', maxChars });
  settings = { ...settings, model, maxChars };   // the server remembers these as the new defaults
  if (!res.job) throw new Error('받아쓰기를 시작하지 못했어요');
  attachTranscribe(res.job);
}

let jobOverlay = null;

function showJobOverlay({ title, name, onCancel, tip }) {
  const host = $('job-overlay');
  if (!host) return null;
  const prog = progressBlock();
  const cancelBtn = btn('취소', { onClick: onCancel });
  const titleEl = h('h2', { class: 'lp-job-title' }, title);
  host.replaceChildren(h('div', { class: 'lp-job' },
    h('div', { class: 'lp-job-card', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'lp-job-spin' }, h('div', { class: 'lp-spinner lp-spinner--lg' })),
      titleEl,
      name ? h('p', { class: 'lp-job-name' }, name) : null,
      prog.el,
      h('div', { class: 'lp-job-actions' }, cancelBtn),
      tip ? h('p', { class: 'lp-job-tip' }, tip) : null)));
  host.hidden = false;
  const ov = {
    update: (j) => prog.update(j),
    setCancelBusy(b) { cancelBtn.disabled = b; setBtnLabel(cancelBtn, b ? '취소하는 중…' : '취소'); },
    hide() { prog.stop(); host.hidden = true; host.replaceChildren(); if (jobOverlay === ov) jobOverlay = null; },
  };
  jobOverlay = ov;
  return ov;
}

async function attachTranscribe(job) {
  if (!job || !job.id) return;
  if (transcribing && transcribing.jobId === job.id) return;
  transcribing = { jobId: job.id, projectId: job.projectId || null };
  setAppClass('transcribing', true);
  renderStatsSoon();
  const p = store.project;
  const name = p && p.id === job.projectId ? p.name : '';
  const ov = showJobOverlay({
    title: '받아쓰는 중…',
    name,
    tip: '다른 앱을 써도 괜찮아요. 창을 닫아도 받아쓰기는 계속돼요.',
    onCancel: guard(async () => {
      const ok = await confirmAsk({ title: '받아쓰기를 멈출까요?', message: '지금까지 받아쓴 내용은 남지 않아요.', ok: '멈추기', cancel: '계속하기', danger: true });
      if (!ok || !transcribing || transcribing.jobId !== job.id) return;
      if (ov) ov.setCancelBusy(true);
      await api.post(`/api/jobs/${encodeURIComponent(job.id)}/cancel`);
    }),
  });
  if (ov) ov.update(job);
  let done = null, failure = null;
  try {
    done = await api.pollJob(job.id, (j) => { if (ov) ov.update(j); }, 600);
  } catch (e) {
    failure = e;
  }
  if (ov) ov.hide();
  transcribing = null;
  setAppClass('transcribing', false);
  boot.jobs = (boot.jobs || []).filter((j) => j.id !== job.id);
  if (done) {
    const project = done.result && done.result.project;
    if (!project) { toast('받아쓰기 결과를 받지 못했어요. 프로젝트를 다시 열어 주세요', 'error', 6000); renderStatsSoon(); return; }
    if (store.project && store.project.id !== project.id) {
      toast(`'${project.name || '다른 영상'}' 받아쓰기를 마쳤어요. 프로젝트를 열면 볼 수 있어요`, 'ok', 6000);
      return;
    }
    loadProject(project);
    const f = store.stats().flags || {};
    toast(`받아쓰기를 마쳤어요. 군말 ${(f.filler || 0) + (f.fillerWeak || 0)}개 · NG 의심 ${f.ng || 0}개를 찾았어요`, 'ok', 6000);
    return;
  }
  renderStatsSoon();
  const st = failure && (failure.code || (failure.job && failure.job.state));
  if (st === 'canceled') { toast('받아쓰기를 멈췄어요', 'info'); return; }
  const msg = (failure && failure.job && failure.job.error) || errMsg(failure, '받아쓰기 중에 문제가 생겼어요');
  const again = await ask({
    title: '받아쓰기를 하지 못했어요',
    message: msg,
    choices: [{ label: '닫기', value: false }, { label: '다시 시도', value: true, kind: 'primary', primary: true }],
    cancelValue: false,
  });
  if (again && store.project) openTranscribeSetup();
}

// =====================================================================================================
// Stats panel (#stats)
// =====================================================================================================

let statsEl = null;
const renderStatsSoon = debounce(() => renderStats(), 120);

function renderStats() {
  if (!statsEl) return;
  const p = store.project;
  if (!p) { statsEl.replaceChildren(); return; }
  if (!hasClips()) {
    statsEl.replaceChildren(h('div', { class: 'lp-stats lp-stats--empty' },
      h('div', { class: 'lp-stats-empty-text' }, transcribing ? '받아쓰는 중이에요…' : '아직 받아쓰기 전이에요'),
      transcribing ? null : btn('받아쓰기 시작', { kind: 'primary', small: true, onClick: () => openTranscribeSetup() })));
    return;
  }
  const st = store.stats();
  const src = st.srcDur || (p.source && p.source.duration) || 0;
  const out = st.outDur != null ? st.outDur : store.outDuration();
  const saved = Math.max(0, src - out);
  const pct = src > 0 ? Math.round((saved / src) * 100) : 0;
  const f = st.flags || {};
  const fillers = (f.filler || 0) + (f.fillerWeak || 0);

  const chip = (label, count, kind, onClick, title) => {
    const b = h('button', { type: 'button', class: `lp-flag lp-flag--${kind}${count ? '' : ' is-zero'}`, title },
      h('span', { class: 'lp-flag-dot', 'aria-hidden': 'true' }), label, h('b', null, String(count)));
    b.addEventListener('click', () => { b.blur(); onClick(); });
    return b;
  };

  statsEl.replaceChildren(h('div', { class: 'lp-stats' },
    h('div', { class: 'lp-stats-top' },
      h('div', { class: 'lp-stat' }, h('span', { class: 'lp-stat-label' }, '원본'), h('span', { class: 'lp-stat-val' }, fmtTime(src))),
      h('span', { class: 'lp-stat-arrow', 'aria-hidden': 'true' }, '→'),
      h('div', { class: 'lp-stat' }, h('span', { class: 'lp-stat-label' }, '편집 후'), h('span', { class: 'lp-stat-val is-strong' }, fmtTime(out))),
      h('div', { class: 'lp-stat-saved' }, saved >= 0.05 ? `${fmtKDur(saved)} 줄었어요 (${pct}%)` : '아직 줄인 부분이 없어요')),
    h('div', { class: 'lp-stats-bar', title: `남은 길이 ${100 - pct}%` }, h('div', { style: { width: `${clamp(100 - pct, 0, 100)}%` } })),
    h('div', { class: 'lp-stats-clips' }, `클립 ${st.clips || 0}개${st.deletedClips ? ` · 삭제 ${st.deletedClips}개` : ''}`),
    h('div', { class: 'lp-flag-row' },
      chip('군말', fillers, 'filler', () => run('fillers'), '군말 목록 열기'),
      chip('NG 의심', f.ng || 0, 'ng', () => run('ng'), 'NG·반복 목록 열기'),
      chip('미인식 음성', f.noise || 0, 'noise', () => openFillers('noise'), '음성 미인식 구간 목록 열기'),
      chip('정확도 낮음', f.lowconf || 0, 'lowconf', () => jumpNextLowconf(), '다음 정확도 낮은 단어로 이동해요'))));
}

function jumpNextLowconf() {
  if (!requireClips()) return;
  const fl = store.flat();
  const idx = [];
  for (let i = 0; i < fl.length; i++) {
    const t = fl[i].tok;
    if (t.type === 'word' && !t.del && t.flags && t.flags.includes('lowconf')) idx.push(i);
  }
  if (!idx.length) { toast('정확도가 낮은 단어가 없어요', 'ok'); return; }
  const r = store.selectedRange();
  const from = r ? r.to + 1 : store.tokenAt(+store.ui.time || 0);
  let k = idx.findIndex((i) => i >= from);
  if (k < 0) k = 0;
  jumpToToken(idx[k]);
  toast(`정확도 낮은 단어 ${k + 1}/${idx.length} · F2로 고칠 수 있어요`, 'info', 2200);
}

function jumpToToken(fi) {
  const f = store.flat()[fi];
  if (!f) return;
  store.select(fi);
  player.seek(f.tok.start);
}

function jumpToClip(ci) {
  let span = null;
  try { span = store.clipSpan(ci); } catch (e) { span = null; }
  if (!span) return;
  store.selectClips(ci);
  player.seek(span.keptStart != null ? span.keptStart : span.start);
}

// =====================================================================================================
// Collectors (lists for the panels)
// =====================================================================================================

function collectFillers() {
  const out = [];
  const fl = store.flat();
  for (let i = 0; i < fl.length; i++) {
    const t = fl[i].tok;
    if (t.del || !t.flags || !t.flags.length) continue;
    if (t.flags.includes('filler')) out.push({ fi: i, id: t.id, strong: true });
    else if (t.flags.includes('filler?')) out.push({ fi: i, id: t.id, strong: false });
  }
  return out;
}

function collectNoise() {
  const out = [];
  const fl = store.flat();
  for (let i = 0; i < fl.length; i++) {
    const t = fl[i].tok;
    if (t.type === 'noise' && !t.del) out.push({ fi: i, id: t.id, strong: false });
  }
  return out;
}

function collectRepeats() {
  const out = [];
  const fl = store.flat();
  for (let i = 0; i < fl.length; i++) {
    const t = fl[i].tok;
    if (!t.del && t.flags && t.flags.includes('repeat')) out.push({ fi: i, id: t.id, strong: false });
  }
  return out;
}

function collectNG() {
  const out = [];
  const clips = store.project ? store.project.clips : [];
  for (let ci = 0; ci < clips.length; ci++) {
    const c = clips[ci];
    if (!c.flags || !c.flags.includes('ng')) continue;
    if (c.words.every((t) => t.del)) continue;
    const target = c.ngOf ? store.clipIndexOf(c.ngOf) : -1;
    out.push({ ci, id: c.id, target });
  }
  return out;
}

function tokenLabel(tok) {
  if (tok.type === 'noise') return `(음성 ${(tok.end - tok.start).toFixed(1)}초)`;
  if (tok.type === 'gap') return `(무음 ${(tok.end - tok.start).toFixed(1)}초)`;
  return tok.text;
}

/** "… 앞말 [음] 뒷말 …" as DOM. */
function contextNode(fi, markClass) {
  const fl = store.flat();
  const pick = (dir) => {
    const words = [];
    let i = fi + dir, more = false;
    while (i >= 0 && i < fl.length) {
      const t = fl[i].tok;
      if (t.type !== 'gap') {
        if (words.length >= 3) { more = true; break; }
        words.push(t.type === 'noise' ? '(음성)' : t.text);
      }
      i += dir;
    }
    if (dir < 0) words.reverse();
    return { text: words.join(' '), more };
  };
  const before = pick(-1), after = pick(+1);
  const tok = fl[fi].tok;
  return h('span', { class: 'lp-ctx' },
    before.text ? h('span', { class: 'lp-ctx-side' }, `${before.more ? '… ' : ''}${before.text} `) : null,
    h('mark', { class: `lp-mark ${markClass || ''}` }, tokenLabel(tok)),
    after.text ? h('span', { class: 'lp-ctx-side' }, ` ${after.text}${after.more ? ' …' : ''}`) : null);
}

function playToken(fi) {
  const f = store.flat()[fi];
  if (!f) return;
  // A little context on both sides makes it easier to judge.
  player.playRange(Math.max(0, f.tok.start - 0.5), f.tok.end + 0.5);
}

function playClipIdx(ci) {
  player.playClip(ci);
}

// =====================================================================================================
// 무음 구간 줄이기
// =====================================================================================================

function silenceCount(min, keep, includeNoise) {
  let gaps = 0, noise = 0, saved = 0;
  for (const f of store.flat()) {
    const t = f.tok;
    if (t.del || (t.type !== 'gap' && t.type !== 'noise')) continue;
    const dur = t.end - t.start;
    if (dur < min - 1e-6) continue;
    if (t.type === 'gap') gaps++; else noise++;
    if (t.type === 'noise' && !includeNoise) continue;
    const before = t.keep != null && t.keep < dur ? Math.max(0, t.keep) : dur;
    const nk = Math.min(keep, dur);
    const after = nk < dur ? nk : dur;
    saved += Math.max(0, before - after);
  }
  return { gaps, noise, total: gaps + (includeNoise ? noise : 0), saved };
}

function openSilence() {
  if (!requireClips()) return;
  if (findModal('silence')) return;
  const ps = store.project.settings || {};
  const minIn = numInput({ value: ps.silenceMin != null ? ps.silenceMin : settings.silenceMin, min: 0.1, max: 30, step: 0.1, label: '최소 무음 길이' });
  const keepIn = numInput({ value: ps.silenceKeep != null ? ps.silenceKeep : settings.silenceKeep, min: 0, max: 30, step: 0.1, label: '줄일 길이' });
  const totalEl = h('b', null, '0개');
  const noiseCount = h('b', null, '0개');
  const noiseChk = checkbox(h('span', null, '음성 미인식 구간 ', noiseCount, ' 포함'), ps.includeNoise != null ? ps.includeNoise : settings.includeNoise, () => update());
  const hint = h('p', { class: 'lp-hint' }, '');
  const applyBtn = btn('무음 구간 줄이기', { kind: 'primary', primary: true });

  const values = () => {
    const min = readNum(minIn, 0.05, 30, 0.2);
    const keep = readNum(keepIn, 0, 30, 0);
    return { min, keep, includeNoise: noiseChk.input.checked };
  };
  const update = () => {
    const v = values();
    const c = silenceCount(v.min, v.keep, v.includeNoise);
    totalEl.textContent = `총 ${c.total}개`;
    noiseCount.textContent = `${c.noise}개`;
    setBtnLabel(applyBtn, `${c.total}개의 무음 구간 줄이기`);
    applyBtn.disabled = c.total === 0;
    const parts = [];
    parts.push(v.keep <= 0 ? '0초로 하면 무음을 모두 잘라요' : `무음을 최대 ${v.keep}초만 남겨요`);
    if (c.saved >= 0.05) parts.push(`약 ${fmtKDur(c.saved)} 줄어요`);
    hint.textContent = parts.join(' · ');
  };
  minIn.addEventListener('input', update);
  keepIn.addEventListener('input', update);

  const m = openModal({
    key: 'silence',
    title: '무음 구간 줄이기',
    size: 'sm',
    body: [
      h('div', { class: 'lp-silence' },
        h('div', { class: 'lp-inline lp-big-row' }, minIn, h('span', null, '초 이상인 무음 구간')),
        h('div', { class: 'lp-silence-total' }, totalEl, h('span', null, ' 무음 구간')),
        noiseChk,
        h('hr', { class: 'lp-sep' }),
        h('div', { class: 'lp-q' }, '무음 구간의 최대 길이를 몇 초로 줄일까요?'),
        h('div', { class: 'lp-inline lp-big-row' }, keepIn, h('span', null, '초')),
        hint),
    ],
    footRight: [btn('취소', { onClick: () => m.close('cancel') }), applyBtn],
    initialFocus: minIn,
  });
  update();
  setTimeout(() => { try { minIn.select(); } catch (e) { /* ignore */ } }, 0);

  applyBtn.addEventListener('click', () => {
    const v = values();
    const partial = { silenceMin: v.min, silenceKeep: v.keep, includeNoise: v.includeNoise };
    store.updateSettings(partial);
    settings = { ...settings, ...partial };
    api.post('/api/settings', { settings: partial }).catch((e) => console.warn('[panels] settings not saved', e));
    const before = store.outDuration();
    const r = store.shortenSilences(v) || {};
    const count = r.count != null ? r.count : 0;
    const savedSec = r.savedSec != null ? r.savedSec : before - store.outDuration();
    m.close('apply');
    if (!count) { toast('줄일 무음 구간이 없어요', 'info'); return; }
    if (savedSec > 0.05) {
      const d = fmtKDur(savedSec);
      toast(`무음 ${count}개를 줄여서 ${d}${josa(d, '이', '가')} 짧아졌어요`, 'ok', 4000);
    } else {
      toast(`무음 ${count}개를 정리했어요`, 'ok');
    }
  });
}

// =====================================================================================================
// 군말 (fillers / unrecognized speech)
// =====================================================================================================

function listRow({ checked, onCheck, no, content, tag, plays, onJump, extraClass }) {
  const chk = h('input', { type: 'checkbox', class: 'lp-item-check', checked: !!checked, 'aria-label': '삭제할 항목으로 고르기' });
  chk.addEventListener('change', () => onCheck(chk.checked));
  chk.addEventListener('click', (e) => e.stopPropagation());
  const row = h('div', { class: `lp-item${checked ? ' is-checked' : ''}${extraClass ? ' ' + extraClass : ''}`, role: 'listitem', title: '눌러서 이 위치로 이동' },
    h('label', { class: 'lp-item-checkwrap', onclick: (e) => e.stopPropagation() }, chk),
    no != null ? h('span', { class: 'lp-item-no' }, `#${no}`) : null,
    h('div', { class: 'lp-item-main' }, content),
    tag || null,
    h('div', { class: 'lp-item-plays' }, plays.map((p) => {
      const b = h('button', { type: 'button', class: 'lp-play-btn', title: p.title || '들어보기' }, h('span', { html: ICONS.play }), p.label ? h('span', null, p.label) : null);
      b.addEventListener('click', (e) => { e.stopPropagation(); p.onClick(); });
      return b;
    })));
  row.addEventListener('click', () => onJump());
  chk.addEventListener('change', () => row.classList.toggle('is-checked', chk.checked));
  return row;
}

function tabsBar(tabs, current, onPick) {
  const bar = h('div', { class: 'lp-tabs', role: 'tablist' });
  for (const t of tabs) {
    const b = h('button', { type: 'button', role: 'tab', class: `lp-tab${t.key === current ? ' is-active' : ''}`, 'aria-selected': t.key === current ? 'true' : 'false' },
      t.label, h('span', { class: 'lp-tab-count' }, String(t.count)));
    b.addEventListener('click', () => {
      onPick(t.key);
      // onPick re-renders the bar: keep keyboard focus on the new active tab.
      if (!bar.isConnected) {
        const active = document.querySelector('.lp-tabs .lp-tab.is-active');
        if (active) active.focus();
      }
    });
    bar.appendChild(b);
  }
  return bar;
}

async function reanalyze(button) {
  if (!store.project) return;
  button.disabled = true;
  setBtnLabel(button, '찾는 중…');
  try {
    const res = await api.post('/api/project/analyze', { project: store.project });
    if (res && Array.isArray(res.clips)) store.applyFlags(res.clips);
    toast('다시 찾았어요', 'ok');
  } catch (e) {
    toast(`다시 찾지 못했어요: ${errMsg(e)}`, 'error', 5000);
  } finally {
    button.disabled = false;
    setBtnLabel(button, '다시 찾기');
  }
}

function openFillers(tab = 'filler') {
  if (!requireClips()) return;
  const existing = findModal('fillers');
  if (existing) existing.close('force');
  let current = tab === 'noise' ? 'noise' : 'filler';
  let m = null;
  const checked = new Map();   // token id → bool (survives re-renders and tab switches)
  const tabsHost = h('div');
  const tools = h('div', { class: 'lp-list-tools' });
  const list = h('div', { class: 'lp-list', role: 'list' });
  const delBtn = btn('선택한 0개 삭제', { kind: 'danger', primary: true });
  const againBtn = btn('다시 찾기', { title: '군말과 NG를 처음부터 다시 찾아요' });
  againBtn.addEventListener('click', () => reanalyze(againBtn));

  const isChecked = (it) => (checked.has(it.id) ? checked.get(it.id) : (current === 'filler' && it.strong));
  const items = () => (current === 'filler' ? collectFillers() : collectNoise());

  const render = () => {
    if (m && m.closed) return;
    const fillers = collectFillers(), noise = collectNoise();
    const its = current === 'filler' ? fillers : noise;
    tabsHost.replaceChildren(tabsBar([
      { key: 'filler', label: '군말', count: fillers.length },
      { key: 'noise', label: '미인식 음성', count: noise.length },
    ], current, (k) => { current = k; render(); }));
    tools.replaceChildren(
      h('span', { class: 'lp-muted' }, current === 'filler' ? '확실한 군말은 미리 골라 뒀어요' : '숨소리나 못 알아들은 말이에요. 들어보고 골라 주세요'),
      h('span', { class: 'lp-spacer' }),
      h('button', { type: 'button', class: 'lp-link', onclick: () => { for (const it of items()) checked.set(it.id, true); render(); } }, '모두 고르기'),
      h('button', { type: 'button', class: 'lp-link', onclick: () => { for (const it of items()) checked.set(it.id, false); render(); } }, '모두 해제'));
    const fl = store.flat();
    if (!its.length) {
      list.replaceChildren(h('div', { class: 'lp-empty-state' }, current === 'filler' ? '남은 군말이 없어요' : '음성 미인식 구간이 없어요'));
    } else {
      list.replaceChildren(...its.map((it) => {
        const tok = fl[it.fi].tok;
        const weak = !it.strong;
        return listRow({
          checked: isChecked(it),
          onCheck: (v) => { checked.set(it.id, v); updateBtn(); },
          no: fl[it.fi].ci + 1,
          content: contextNode(it.fi, tok.type === 'noise' ? 'lp-mark--noise' : weak ? 'lp-mark--weak' : 'lp-mark--filler'),
          tag: current === 'filler' && weak ? h('span', { class: 'lp-tag', title: '군말인지 애매해요' }, '애매') : null,
          plays: [{ title: '들어보기', onClick: () => playToken(store.flatIndexOf(it.id)) }],
          onJump: () => jumpToToken(store.flatIndexOf(it.id)),
        });
      }));
    }
    updateBtn();
  };
  const updateBtn = () => {
    const n = items().filter(isChecked).length;
    setBtnLabel(delBtn, `선택한 ${n}개 삭제`);
    delBtn.disabled = n === 0;
  };
  const renderSoon = debounce(render, 60);
  const unsub = onStore(['change', 'flags', 'load'], renderSoon);

  delBtn.addEventListener('click', () => {
    const idx = items().filter(isChecked).map((it) => store.flatIndexOf(it.id)).filter((i) => i >= 0);
    if (!idx.length) return;
    const n = store.deleteTokens(idx);
    toast(`${current === 'filler' ? '군말' : '미인식 음성'} ${n || idx.length}개를 지웠어요 · ⌘Z로 되돌릴 수 있어요`, 'ok', 3200);
    render();
  });

  m = openModal({
    key: 'fillers',
    title: '군말',
    drawer: true,
    size: 'lg',
    body: [tabsHost, tools, list],
    footLeft: [againBtn],
    footRight: [btn('닫기', { onClick: () => m.close('close') }), delBtn],
    onClose: () => { unsub(); renderSoon.cancel(); },
  });
  render();
  const firstTab = tabsHost.querySelector('.lp-tab.is-active');
  if (firstTab) firstTab.focus();
}

// =====================================================================================================
// NG·반복
// =====================================================================================================

function openNG(tab = 'ng') {
  if (!requireClips()) return;
  const existing = findModal('ng');
  if (existing) existing.close('force');
  let current = tab === 'repeat' ? 'repeat' : 'ng';
  let m = null;
  const checked = new Map();   // clip id / token id → bool
  const tabsHost = h('div');
  const tools = h('div', { class: 'lp-list-tools' });
  const list = h('div', { class: 'lp-list', role: 'list' });
  const delBtn = btn('선택한 0개 삭제', { kind: 'danger', primary: true });
  const againBtn = btn('다시 찾기', { title: '군말과 NG를 처음부터 다시 찾아요' });
  againBtn.addEventListener('click', () => reanalyze(againBtn));

  const isChecked = (it) => (checked.has(it.id) ? checked.get(it.id) : current === 'ng');
  const items = () => (current === 'ng' ? collectNG() : collectRepeats());

  const ngRow = (it) => {
    const clip = store.project.clips[it.ci];
    const text = truncate(store.captionOf(clip) || clip.words.filter((t) => t.type === 'word').map((t) => t.text).join(' '), 42);
    const plays = [{ label: `#${it.ci + 1}`, title: 'NG로 보이는 클립 들어보기', onClick: () => playClipIdx(store.clipIndexOf(it.id)) }];
    if (it.target >= 0) {
      const targetId = store.project.clips[it.target].id;
      plays.push({ label: `#${it.target + 1}`, title: '다시 말한 클립 들어보기', onClick: () => playClipIdx(store.clipIndexOf(targetId)) });
    }
    return listRow({
      checked: isChecked(it),
      onCheck: (v) => { checked.set(it.id, v); updateBtn(); },
      no: it.ci + 1,
      content: h('div', { class: 'lp-ng' },
        h('div', { class: 'lp-ng-text' }, `'${text || '(자막 없음)'}'`),
        h('div', { class: 'lp-ng-sub' }, it.target >= 0 ? `→ #${it.target + 1}에서 다시 말했어요` : '→ 뒤에서 다시 말한 것 같아요')),
      plays,
      onJump: () => jumpToClip(store.clipIndexOf(it.id)),
      extraClass: 'lp-item--ng',
    });
  };

  const render = () => {
    if (m && m.closed) return;
    const ngs = collectNG(), reps = collectRepeats();
    const its = current === 'ng' ? ngs : reps;
    tabsHost.replaceChildren(tabsBar([
      { key: 'ng', label: 'NG 의심', count: ngs.length },
      { key: 'repeat', label: '반복', count: reps.length },
    ], current, (k) => { current = k; render(); }));
    tools.replaceChildren(
      h('span', { class: 'lp-muted' }, current === 'ng' ? '같은 말을 다시 한 클립이에요. 앞의 것을 지우면 돼요' : '더듬거나 두 번 말한 단어예요'),
      h('span', { class: 'lp-spacer' }),
      h('button', { type: 'button', class: 'lp-link', onclick: () => { for (const it of items()) checked.set(it.id, true); render(); } }, '모두 고르기'),
      h('button', { type: 'button', class: 'lp-link', onclick: () => { for (const it of items()) checked.set(it.id, false); render(); } }, '모두 해제'));
    if (!its.length) {
      list.replaceChildren(h('div', { class: 'lp-empty-state' }, current === 'ng' ? 'NG로 보이는 클립이 없어요' : '반복된 단어가 없어요'));
    } else if (current === 'ng') {
      list.replaceChildren(...its.map(ngRow));
    } else {
      const fl = store.flat();
      list.replaceChildren(...its.map((it) => listRow({
        checked: isChecked(it),
        onCheck: (v) => { checked.set(it.id, v); updateBtn(); },
        no: fl[it.fi].ci + 1,
        content: contextNode(it.fi, 'lp-mark--repeat'),
        plays: [{ title: '들어보기', onClick: () => playToken(store.flatIndexOf(it.id)) }],
        onJump: () => jumpToToken(store.flatIndexOf(it.id)),
      })));
    }
    updateBtn();
  };
  const updateBtn = () => {
    const n = items().filter(isChecked).length;
    setBtnLabel(delBtn, `선택한 ${n}개 삭제`);
    delBtn.disabled = n === 0;
  };
  const renderSoon = debounce(render, 60);
  const unsub = onStore(['change', 'flags', 'load'], renderSoon);

  delBtn.addEventListener('click', () => {
    const sel = items().filter(isChecked);
    if (!sel.length) return;
    if (current === 'ng') {
      const cis = sel.map((it) => store.clipIndexOf(it.id)).filter((i) => i >= 0);
      store.deleteClips(cis);
      toast(`NG 클립 ${cis.length}개를 지웠어요 · ⌘Z로 되돌릴 수 있어요`, 'ok', 3200);
    } else {
      const idx = sel.map((it) => store.flatIndexOf(it.id)).filter((i) => i >= 0);
      store.deleteTokens(idx);
      toast(`반복된 단어 ${idx.length}개를 지웠어요 · ⌘Z로 되돌릴 수 있어요`, 'ok', 3200);
    }
    render();
  });

  m = openModal({
    key: 'ng',
    title: 'NG·반복',
    drawer: true,
    size: 'lg',
    body: [tabsHost, tools, list],
    footLeft: [againBtn],
    footRight: [btn('닫기', { onClick: () => m.close('close') }), delBtn],
    onClose: () => { unsub(); renderSoon.cancel(); },
  });
  render();
  const firstTab = tabsHost.querySelector('.lp-tab.is-active');
  if (firstTab) firstTab.focus();
}

// =====================================================================================================
// 찾아 바꾸기
// =====================================================================================================

function findMatches(q, scope) {
  const out = [];
  if (!q || !store.project) return out;
  const fl = store.flat();
  if (scope !== 'captions') {
    for (let i = 0; i < fl.length; i++) {
      const t = fl[i].tok;
      if (t.type === 'word' && t.text.includes(q)) out.push({ kind: 'word', id: t.id, ci: fl[i].ci, t: t.start });
    }
  }
  if (scope !== 'words') {
    const clips = store.project.clips;
    for (let ci = 0; ci < clips.length; ci++) {
      const c = clips[ci];
      if (c.caption != null && c.caption.includes(q)) out.push({ kind: 'caption', id: c.id, ci, t: c.words[0].start });
    }
  }
  out.sort((a, b) => a.t - b.t || (a.kind === 'word' ? -1 : 1));
  return out;
}

function highlight(text, q) {
  const parts = String(text).split(q);
  const nodes = [];
  parts.forEach((p, i) => {
    if (i) nodes.push(h('mark', { class: 'lp-mark' }, q));
    if (p) nodes.push(p);
  });
  return nodes;
}

function openFind() {
  if (!requireClips()) return;
  const existing = findModal('find');
  if (existing) { existing.focusFirst(); return; }
  let scope = 'all';
  let matches = [];
  let cur = -1;

  let initial = '';
  const r = store.selectedRange();
  if (r && r.from === r.to) {
    const t = store.flat()[r.from].tok;
    if (t.type === 'word') initial = t.text;
  }
  const findIn = h('input', { type: 'text', class: 'lp-input', value: initial, placeholder: '찾을 말', spellcheck: 'false', autocomplete: 'off', 'aria-label': '찾을 말' });
  const replIn = h('input', { type: 'text', class: 'lp-input', value: '', placeholder: '바꿀 말', spellcheck: 'false', autocomplete: 'off', 'aria-label': '바꿀 말' });
  const status = h('div', { class: 'lp-find-status', 'aria-live': 'polite' });
  const list = h('div', { class: 'lp-list lp-list--find', role: 'list' });
  const oneBtn = btn('바꾸기', { title: '지금 고른 곳 하나만 바꿔요' });
  const allBtn = btn('모두 바꾸기', { kind: 'primary', primary: true });

  const recompute = (keepId) => {
    const q = findIn.value;
    const prevId = keepId !== undefined ? keepId : (matches[cur] && matches[cur].id);
    matches = findMatches(q, scope);
    cur = prevId ? matches.findIndex((x) => x.id === prevId) : -1;
    renderList();
  };
  const renderList = () => {
    const q = findIn.value;
    if (!q) {
      status.textContent = '찾을 말을 입력해 주세요';
      list.replaceChildren();
    } else if (!matches.length) {
      status.textContent = '찾는 말이 없어요';
      list.replaceChildren(h('div', { class: 'lp-empty-state' }, `'${q}'${josa(q, '을', '를')} 찾지 못했어요`));
    } else {
      status.textContent = `${matches.length}곳 찾았어요${cur >= 0 ? ` · ${cur + 1}/${matches.length}` : ' · Enter로 다음 곳으로 가요'}`;
      const fl = store.flat();
      list.replaceChildren(...matches.map((mt, i) => {
        let content;
        if (mt.kind === 'word') {
          const fi = store.flatIndexOf(mt.id);
          const tok = fl[fi].tok;
          content = h('span', { class: `lp-ctx${tok.del ? ' is-del' : ''}` }, highlight(tok.text, q));
        } else {
          content = h('span', { class: 'lp-ctx' }, h('span', { class: 'lp-tag lp-tag--cap' }, '자막'), ' ', highlight(truncate(store.project.clips[mt.ci].caption, 60), q));
        }
        const row = h('div', { class: `lp-item lp-item--find${i === cur ? ' is-current' : ''}`, role: 'listitem' },
          h('span', { class: 'lp-item-no' }, `#${mt.ci + 1}`), h('div', { class: 'lp-item-main' }, content));
        row.addEventListener('click', () => goto(i));
        return row;
      }));
      const curRow = list.querySelector('.is-current');
      if (curRow && curRow.scrollIntoView) curRow.scrollIntoView({ block: 'nearest' });
    }
    allBtn.disabled = !matches.length;
    oneBtn.disabled = !matches.length;
  };
  const goto = (i) => {
    if (!matches.length) return;
    cur = ((i % matches.length) + matches.length) % matches.length;
    const mt = matches[cur];
    if (mt.kind === 'word') jumpToToken(store.flatIndexOf(mt.id));
    else jumpToClip(store.clipIndexOf(mt.id));
    renderList();
  };
  const findNext = () => {
    if (!findIn.value) { findIn.focus(); return; }
    if (!matches.length) recompute();
    if (!matches.length) return;
    goto(cur + 1);
  };
  const replaceOne = () => {
    const q = findIn.value, rep = replIn.value;
    if (!q || !matches.length) return;
    if (cur < 0) { goto(0); return; }
    const mt = matches[cur];
    let ok = false;
    if (mt.kind === 'word') {
      const fi = store.flatIndexOf(mt.id);
      const tok = store.flat()[fi] && store.flat()[fi].tok;
      if (tok) {
        const next = tok.text.split(q).join(rep).replace(/\s+/g, ' ').trim();
        if (!next) { toast('단어가 비게 되어서 바꾸지 않았어요', 'warn'); return; }
        ok = store.setWordText(fi, next);
      }
    } else {
      const ci = store.clipIndexOf(mt.id);
      const c = store.project.clips[ci];
      if (c && c.caption != null) ok = store.setCaption(ci, c.caption.split(q).join(rep));
    }
    const at = cur;
    recompute(null);
    if (ok && matches.length) goto(Math.min(at, matches.length - 1));
  };
  const replaceAll = () => {
    const q = findIn.value;
    if (!q) return;
    const n = store.replaceAll(q, replIn.value, { words: scope !== 'captions', captions: scope !== 'words' });
    toast(n ? `${n}곳을 바꿨어요 · ⌘Z로 되돌릴 수 있어요` : '바꿀 곳이 없어요', n ? 'ok' : 'info', 3000);
    recompute(null);
  };

  const recomputeSoon = debounce(() => recompute(null), 120);
  findIn.addEventListener('input', recomputeSoon);
  oneBtn.addEventListener('click', replaceOne);
  allBtn.addEventListener('click', replaceAll);
  const unsub = onStore(['change', 'load'], debounce(() => recompute(), 80));

  const m = openModal({
    key: 'find',
    title: '찾아 바꾸기',
    drawer: true,
    size: 'lg',
    body: [
      h('div', { class: 'lp-find' },
        h('label', { class: 'lp-field' }, h('span', { class: 'lp-field-label' }, '찾을 말'), findIn),
        h('label', { class: 'lp-field' }, h('span', { class: 'lp-field-label' }, '바꿀 말'), replIn),
        h('div', { class: 'lp-field' }, h('span', { class: 'lp-field-label' }, '범위'),
          segmented('scope', [
            { value: 'all', label: '단어와 자막' },
            { value: 'words', label: '단어만' },
            { value: 'captions', label: '고친 자막만', title: '직접 고친 자막에서만 찾아요' },
          ], scope, (v) => { scope = v; recompute(null); })),
        status),
      list,
    ],
    footLeft: [oneBtn],
    footRight: [btn('닫기', { onClick: () => m.close('close') }), allBtn],
    onEnter: () => { findNext(); return true; },   // Enter = find next, never "replace all"
    onClose: () => { unsub(); recomputeSoon.cancel(); },
    initialFocus: findIn,
  });
  recompute(null);
  setTimeout(() => { try { findIn.select(); } catch (e) { /* ignore */ } }, 0);
}

// =====================================================================================================
// 자동 클립 나누기
// =====================================================================================================

function openResegment() {
  if (!requireClips()) return;
  if (findModal('resegment')) return;
  const maxIn = numInput({ value: (store.project.settings && store.project.settings.maxChars) || settings.maxChars || 22, min: 8, max: 60, step: 1, width: 64, label: '최대 글자수' });
  const goBtn = btn('다시 나누기', { kind: 'primary', primary: true });
  const m = openModal({
    key: 'resegment',
    title: '자동 클립 나누기',
    size: 'sm',
    body: [
      h('p', { class: 'lp-lead' }, '자막 한 줄 길이에 맞춰 클립을 처음부터 다시 나눠요. 삭제한 부분은 그대로 남아요.'),
      h('div', { class: 'lp-field lp-field--row' }, h('div', { class: 'lp-field-label' }, '한 줄 최대 글자수'), h('div', { class: 'lp-inline' }, maxIn, h('span', null, '자'))),
      h('div', { class: 'lp-callout lp-callout--warn' }, h('span', { class: 'lp-callout-icon', html: ICONS.warn }),
        h('span', null, '직접 나누거나 합친 클립, 고친 자막은 처음 상태로 돌아갈 수 있어요. ⌘Z로 되돌릴 수 있어요.')),
    ],
    footRight: [btn('취소', { onClick: () => m.close('cancel') }), goBtn],
    initialFocus: maxIn,
  });
  setTimeout(() => { try { maxIn.select(); } catch (e) { /* ignore */ } }, 0);
  goBtn.addEventListener('click', guard(async () => {
    const maxChars = Math.round(readNum(maxIn, 8, 60, 22));
    goBtn.disabled = true;
    setBtnLabel(goBtn, '나누는 중…');
    try {
      const res = await api.post('/api/project/resegment', { project: store.project, maxChars });
      if (!res || !Array.isArray(res.clips) || !res.clips.length) throw new Error('클립을 나누지 못했어요');
      store.replaceClips(res.clips);
      store.updateSettings({ maxChars });
      m.close('done');
      toast(`클립을 ${res.clips.length}개로 다시 나눴어요`, 'ok');
    } finally {
      if (!m.closed) { goBtn.disabled = false; setBtnLabel(goBtn, '다시 나누기'); }
    }
  }));
}

// =====================================================================================================
// 내보내기
// =====================================================================================================

function estimateBytes(quality) {
  const s = (store.project && store.project.source) || {};
  const fps = s.fps || (s.fpsNum && s.fpsDen ? s.fpsNum / s.fpsDen : 30);
  let vb = s.vbitrate || (s.bitrate ? Math.max(0, s.bitrate - 192000) : 0);
  if (!vb) vb = 0.15 * (s.width || 1920) * (s.height || 1080) * fps;
  vb = Math.min(vb, 50e6) * ({ high: 1, medium: 0.6, small: 0.35 }[quality] || 1);
  if (s.hasVideo === false) vb = 0;
  const ab = s.hasAudio === false ? 0 : 192000;
  return (vb + ab) * store.outDuration() / 8;
}

function openExport() {
  if (!requireClips()) return;
  const existing = findModal('export');
  if (existing) { existing.focusFirst(); return; }
  if (!(store.outDuration() > 0)) { toast('남은 부분이 없어서 내보낼 수 없어요', 'warn'); return; }
  const src = store.project.source || {};
  const shortSide = Math.min(src.width || 0, src.height || 0);
  const opts = {
    outPath: '', srtPath: '', dir: '',
    srt: settings.exportSrt !== false,
    map: !!settings.exportMap,
    quality: ['high', 'medium', 'small'].includes(settings.exportQuality) ? settings.exportQuality : 'high',
    resolution: ['source', '1080', '720'].includes(settings.exportResolution) ? settings.exportResolution : 'source',
  };
  if (opts.resolution !== 'source' && !(shortSide > +opts.resolution)) opts.resolution = 'source';
  let phase = 'form';
  let prog = null;

  const m = openModal({
    key: 'export',
    title: '내보내기',
    size: 'md',
    body: [h('div', { class: 'lp-loading' }, h('div', { class: 'lp-spinner' }), '저장할 위치를 정하는 중이에요…')],
    canClose: (reason) => {
      if (phase !== 'progress' || reason === 'force') return true;
      toast('내보내는 중이에요. 멈추려면 취소를 눌러 주세요', 'info');
      return false;
    },
    onClose: () => { if (prog) prog.stop(); },
  });

  const showForm = () => {
    phase = 'form';
    m.setTitle('내보내기');
    const pathName = h('div', { class: 'lp-path-name' }, basename(opts.outPath));
    const pathDir = h('div', { class: 'lp-path-dir', title: opts.outPath }, prettyDir(dirname(opts.outPath)));
    const change = btn('변경', { small: true });
    change.addEventListener('click', guard(async () => {
      const r = await nativeDialog('/api/dialog/save', { defaultName: basename(opts.outPath), defaultDir: dirname(opts.outPath) });
      if (!r || !r.path) return;
      let p = r.path;
      if (!/\.(mp4|m4v|mov)$/i.test(p)) p += '.mp4';
      opts.outPath = p;
      pathName.textContent = basename(p);
      pathDir.textContent = prettyDir(dirname(p));
      pathDir.title = p;
    }));
    const summary = h('div', { class: 'lp-export-summary' });
    const updateSummary = () => {
      summary.replaceChildren(
        h('span', null, '결과 길이 ', h('b', null, fmtTime(store.outDuration()))),
        h('span', { class: 'lp-dot-sep' }, '·'),
        h('span', null, '예상 용량 ', h('b', null, `약 ${fmtBytes(estimateBytes(opts.quality))}`)));
    };
    const resOpts = [
      { value: 'source', label: src.width && src.height ? `원본 ${src.width}×${src.height}` : '원본' },
      { value: '1080', label: '1080p', disabled: !(shortSide > 1080), title: shortSide > 1080 ? '' : '원본보다 크게 만들 수는 없어요' },
      { value: '720', label: '720p', disabled: !(shortSide > 720), title: shortSide > 720 ? '' : '원본보다 크게 만들 수는 없어요' },
    ];
    const srtChk = checkbox('자막(SRT) 같이 저장', opts.srt, (v) => { opts.srt = v; }, h('span', { class: 'lp-check-sub' }, '같은 폴더에 같은 이름으로 저장해요'));
    const mapChk = checkbox('편집 정보(JSON) 저장 — Claude 작업용', opts.map, (v) => { opts.map = v; });
    const goBtn = btn('내보내기', { kind: 'primary', primary: true });
    goBtn.addEventListener('click', guard(async () => {
      goBtn.disabled = true;
      try { await start(false); } finally { if (!m.closed && phase === 'form') goBtn.disabled = false; }
    }));
    const srtOnly = btn('SRT만 저장', { title: '영상 없이 자막 파일만 저장해요' });
    srtOnly.addEventListener('click', guard(() => exportSrtFlow({ srt: opts.srtPath || opts.outPath.replace(/\.[^./]+$/, '.srt') })));

    m.setBody(
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '저장할 곳'),
        h('div', { class: 'lp-path' }, h('span', { class: 'lp-path-icon', html: ICONS.film }), h('div', { class: 'lp-path-text' }, pathName, pathDir), change)),
      h('div', { class: 'lp-field' }, srtChk, mapChk),
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '화질'),
        segmented('quality', [
          { value: 'high', label: '원본과 비슷(권장)' },
          { value: 'medium', label: '보통' },
          { value: 'small', label: '용량 작게' },
        ], opts.quality, (v) => { opts.quality = v; updateSummary(); })),
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '해상도'),
        segmented('res', resOpts, opts.resolution, (v) => { opts.resolution = v; updateSummary(); })),
      summary);
    m.setFoot([srtOnly], [btn('취소', { onClick: () => m.close('cancel') }), goBtn]);
    updateSummary();
    try { goBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  const start = async (overwrite) => {
    const partial = { exportQuality: opts.quality, exportResolution: opts.resolution, exportSrt: opts.srt, exportMap: opts.map };
    settings = { ...settings, ...partial };
    api.post('/api/settings', { settings: partial }).catch(() => {});
    await flushSave();
    let res;
    try {
      res = await api.post('/api/export', {
        project: store.project,
        options: { outPath: opts.outPath, srt: opts.srt, map: opts.map, quality: opts.quality, resolution: opts.resolution, overwrite: !!overwrite },
      });
    } catch (e) {
      if (e && e.code === 'exists' && !overwrite) {
        const names = ((e.data && e.data.paths) || [opts.outPath]).map(basename);
        const ok = await confirmAsk({
          title: '같은 이름의 파일이 있어요',
          message: `${names.map((n) => `'${n}'`).join(', ')} 파일을 덮어쓸까요?`,
          ok: '덮어쓰기', danger: true,
        });
        if (ok) return start(true);
        return undefined;
      }
      throw e;
    }
    if (!res.job) throw new Error('내보내기를 시작하지 못했어요');
    return runJob(res.job);
  };

  const runJob = async (j) => {
    phase = 'progress';
    exporting = { jobId: j.id };
    m.setTitle('내보내는 중…');
    prog = progressBlock();
    const cancelBtn = btn('취소');
    cancelBtn.addEventListener('click', guard(async () => {
      const ok = await confirmAsk({ title: '내보내기를 멈출까요?', message: '만들던 파일은 지워져요.', ok: '멈추기', cancel: '계속하기', danger: true });
      if (!ok || phase !== 'progress') return;
      cancelBtn.disabled = true;
      setBtnLabel(cancelBtn, '취소하는 중…');
      await api.post(`/api/jobs/${encodeURIComponent(j.id)}/cancel`);
    }));
    m.setBody(h('div', { class: 'lp-export-progress' },
      h('div', { class: 'lp-export-file' }, h('span', { class: 'lp-path-icon', html: ICONS.film }), h('span', null, basename(opts.outPath))),
      prog.el,
      h('p', { class: 'lp-hint' }, '다른 앱을 써도 괜찮아요. 이 창은 열어 두세요.')));
    m.setFoot([], [cancelBtn]);
    prog.update(j);
    let done = null, failure = null;
    try { done = await api.pollJob(j.id, (x) => prog && prog.update(x), 500); } catch (e) { failure = e; }
    exporting = null;
    if (prog) { prog.stop(); prog = null; }
    if (m.closed) {
      if (done) toast('내보내기를 마쳤어요', 'ok');
      return;
    }
    if (done) { showDone(done.result || {}); return; }
    const st = failure && (failure.code || (failure.job && failure.job.state));
    if (st === 'canceled') { toast('내보내기를 멈췄어요', 'info'); showForm(); return; }
    showError((failure && failure.job && failure.job.error) || errMsg(failure, '내보내는 중에 문제가 생겼어요'));
  };

  const showDone = (r) => {
    phase = 'done';
    m.setTitle('내보내기');
    const files = [];
    const mp4 = r.mp4 || opts.outPath;
    files.push(h('li', null, h('span', { class: 'lp-done-kind' }, '영상'), h('span', { class: 'lp-done-name', title: mp4 }, basename(mp4)),
      h('span', { class: 'lp-done-meta' }, [r.duration ? fmtTime(r.duration) : '', r.size ? fmtBytes(r.size) : ''].filter(Boolean).join(' · '))));
    if (r.srt) files.push(h('li', null, h('span', { class: 'lp-done-kind' }, '자막'), h('span', { class: 'lp-done-name', title: r.srt }, basename(r.srt))));
    if (r.map) files.push(h('li', null, h('span', { class: 'lp-done-kind' }, '편집 정보'), h('span', { class: 'lp-done-name', title: r.map }, basename(r.map))));
    const reveal = btn('Finder에서 보기');
    reveal.addEventListener('click', guard(() => api.post('/api/reveal', { path: mp4 })));
    const closeBtn = btn('닫기', { kind: 'primary', primary: true, onClick: () => m.close('done') });
    m.setBody(h('div', { class: 'lp-done' },
      h('div', { class: 'lp-done-icon', html: ICONS.check }),
      h('h3', { class: 'lp-done-title' }, '다 됐어요'),
      h('p', { class: 'lp-done-sub' }, prettyDir(dirname(mp4))),
      h('ul', { class: 'lp-done-files' }, files)));
    m.setFoot([], [reveal, closeBtn]);
    try { closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  const showError = (msg) => {
    phase = 'error';
    m.setTitle('내보내기');
    m.setBody(h('div', { class: 'lp-done lp-done--error' },
      h('div', { class: 'lp-done-icon', html: ICONS.warn }),
      h('h3', { class: 'lp-done-title' }, '내보내지 못했어요'),
      h('p', { class: 'lp-done-sub' }, msg)));
    const retry = btn('다시 시도', { kind: 'primary', primary: true, onClick: () => showForm() });
    m.setFoot([], [btn('닫기', { onClick: () => m.close('close') }), retry]);
    try { retry.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  (async () => {
    try {
      const d = await api.post('/api/export/default-paths', { project: store.project });
      if (m.closed) return;
      opts.outPath = d.mp4;
      opts.srtPath = d.srt;
      opts.dir = d.dir;
      showForm();
    } catch (e) {
      m.close('force');
      toast(`내보낼 위치를 정하지 못했어요: ${errMsg(e)}`, 'error', 5000);
    }
  })();
}

async function exportSrtFlow(defaults) {
  if (!requireClips()) return;
  let d = defaults;
  if (!d || !d.srt) d = await api.post('/api/export/default-paths', { project: store.project });
  const r = await nativeDialog('/api/dialog/save', { defaultName: basename(d.srt), defaultDir: d.dir || dirname(d.srt) });
  if (!r || !r.path) return;
  let path = r.path;
  if (!/\.srt$/i.test(path)) path += '.srt';
  let res;
  try {
    res = await api.post('/api/export/srt', { project: store.project, outPath: path, overwrite: false });
  } catch (e) {
    if (!(e && e.code === 'exists')) throw e;
    const ok = await confirmAsk({ title: '같은 이름의 파일이 있어요', message: `'${basename(path)}' 파일을 덮어쓸까요?`, ok: '덮어쓰기', danger: true });
    if (!ok) return;
    res = await api.post('/api/export/srt', { project: store.project, outPath: path, overwrite: true });
  }
  toast(`자막 파일을 저장했어요 · ${basename((res && res.path) || path)}`, 'ok', 3500);
}

// =====================================================================================================
// 설정 / 종료
// =====================================================================================================

function openSettings() {
  if (findModal('settings')) return;
  let model = MODEL_INFO[settings.model] ? settings.model : 'turbo';
  const maxIn = numInput({ value: settings.maxChars || 22, min: 8, max: 60, step: 1, width: 64, label: '최대 글자수' });
  const minIn = numInput({ value: settings.silenceMin, min: 0.1, max: 30, step: 0.1, label: '최소 무음 길이' });
  const keepIn = numInput({ value: settings.silenceKeep, min: 0, max: 30, step: 0.1, label: '줄일 길이' });
  const noiseChk = checkbox('음성 미인식 구간도 같이 줄이기', !!settings.includeNoise);
  const saveBtn = btn('저장', { kind: 'primary', primary: true });
  const quitBtn = btn('Lazy - Cut 종료', { kind: 'ghost-danger', onClick: () => run('quit-app') });
  const m = openModal({
    key: 'settings',
    title: '설정',
    size: 'md',
    body: [
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '기본 받아쓰기 방식'), modelPicker(model, (v) => { model = v; })),
      h('div', { class: 'lp-field lp-field--row' }, h('div', { class: 'lp-field-label' }, '자막 한 줄 최대 글자수'), h('div', { class: 'lp-inline' }, maxIn, h('span', null, '자'))),
      h('div', { class: 'lp-field' }, h('div', { class: 'lp-field-label' }, '무음 구간 줄이기 기본값'),
        h('div', { class: 'lp-inline lp-wrap' }, minIn, h('span', null, '초 이상인 무음을'), keepIn, h('span', null, '초로 줄여요')),
        noiseChk),
      h('p', { class: 'lp-hint' }, '새로 만드는 프로젝트부터 이 값을 써요.'),
      h('div', { class: 'lp-about' }, h('span', { class: 'lp-logo lp-logo--sm', html: LOGO_SVG }), h('span', null, `Lazy - Cut ${boot.version || ''}`.trim()), h('span', { class: 'lp-muted' }, '팀 제이커브')),
    ],
    footLeft: [quitBtn],
    footRight: [btn('취소', { onClick: () => m.close('cancel') }), saveBtn],
  });
  saveBtn.addEventListener('click', guard(async () => {
    const partial = {
      model,
      maxChars: Math.round(readNum(maxIn, 8, 60, 22)),
      silenceMin: readNum(minIn, 0.05, 30, 0.2),
      silenceKeep: readNum(keepIn, 0, 30, 0),
      includeNoise: noiseChk.input.checked,
    };
    saveBtn.disabled = true;
    try {
      const res = await api.post('/api/settings', { settings: partial });
      settings = { ...settings, ...((res && res.settings) || partial) };
      m.close('saved');
      toast('설정을 저장했어요', 'ok');
    } finally {
      if (!m.closed) saveBtn.disabled = false;
    }
  }));
}

async function quitApp() {
  if (quitting) return;
  const busyJob = transcribing || exporting;
  const ok = await confirmAsk({
    title: 'Lazy - Cut을 종료할까요?',
    message: busyJob ? '진행 중인 작업이 있어요. 종료하면 작업이 멈춰요.' : '편집 내용은 저장하고 종료해요.',
    ok: '종료', danger: !!busyJob,
  });
  if (!ok) return;
  const saved = await flushSave();
  if (!saved) {
    const anyway = await confirmAsk({ title: '저장하지 못했어요', message: '그래도 종료할까요? 저장하지 않은 편집은 사라져요.', ok: '종료', danger: true });
    if (!anyway) return;
  }
  quitting = true;
  try { player.pause(); } catch (e) { /* ignore */ }
  try { await api.post('/api/shutdown'); } catch (e) { /* the server may already be gone */ }
  closeAllModals();
  const screen = h('div', { class: 'lp-quit', role: 'alert' },
    h('div', { class: 'lp-quit-card' },
      h('span', { class: 'lp-logo', html: LOGO_SVG }),
      h('h1', null, 'Lazy - Cut을 종료했어요.'),
      h('p', null, '이 창을 닫아도 돼요.')));
  document.body.appendChild(screen);
  setTimeout(() => { try { window.close(); } catch (e) { /* ignore */ } }, 800);
}

// =====================================================================================================
// 단축키 도움말
// =====================================================================================================

const HELP = [
  ['재생', [
    ['Space', '재생 / 일시정지'],
    ['Tab', '지금 클립만 재생'],
    ['⇧ Tab', '선택한 곳부터 재생'],
    ['⌘ , / ⌘ .', '느리게 / 빠르게 재생'],
    ['Home / End', '처음 / 끝으로'],
    ['⌥ 클릭', '단어 하나만 들어보기'],
    ['J / L', '0.5초 뒤로 / 앞으로 (⇧ 2초)'],
    ['K', '정지'],
    [', / .', '1프레임 뒤로 / 앞으로'],
  ]],
  ['편집', [
    ['Delete , ⌫', '삭제 / 되살리기'],
    ['Enter', '여기서 클립 나누기'],
    ['⇧ Enter', '뒷부분을 다음 클립으로 보내기'],
    ['⌘ E / ⌘ ⇧ E', '다음 / 이전 클립과 합치기'],
    ['F2 , 더블클릭', '단어 고치기'],
    ['⌥ ↓', '자막 고치기'],
    ['자막 안에서 Enter', '커서 위치에서 클립 나누기 (단어 중간이면 그 단어도 잘라요)'],
    ['⌥ ↑ , Esc', '자막에서 돌아가기'],
    ['⌥ ⌫', '자막 지우기'],
    ['⌥ A / ⌥ S', '시작점을 0.05초 앞 / 뒤로'],
    ['⌥ D / ⌥ F', '끝점을 0.05초 앞 / 뒤로'],
    ['C', '재생 위치에서 자르기 (단어 중간도)'],
    ['Q / W', '클립 처음~재생 위치 / 재생 위치~끝 잘라내기'],
    ['I → O → X', '시작점·끝점 찍고 그 구간 잘라내기'],
    ['T', '무음 자리에 자막 넣기'],
    ['⇧ ⌫', '커서 앞부분을 앞 클립으로 (클립 맨 앞·자막 칸에선 클립 전체)'],
    ['⌥ ⇧ A·S·D·F', '경계를 0.25초씩 크게 옮기기'],
    ['⌘ Z', '되돌리기'],
    ['⌘ ⇧ Z , ⌘ Y', '다시 실행'],
  ]],
  ['이동·선택', [
    ['← / →', '이전 / 다음 단어 (⇧ 누르면 선택 넓히기)'],
    ['⌥ ← / ⌥ →', '이전 / 다음 단어'],
    ['↑ / ↓', '이전 / 다음 클립'],
    ['⌘ ↑ / ⌘ ↓', '이전 / 다음 클립'],
    ['⌘ ← / ⌘ →', '줄 처음 / 끝'],
    ['⌘ A', '모두 선택'],
    ['⌘ J', '클립 번호로 이동'],
  ]],
  ['그 밖에', [
    ['⌘ S', '저장'],
    ['⌘ O', '영상 불러오기 (시작 화면)'],
    ['⌘ F', '찾아 바꾸기'],
    ['?', '단축키 도움말'],
    ['Esc', '창 닫기 / 선택 해제'],
    ['⌘ 휠', '타임라인 확대 / 축소'],
    ['휠', '타임라인 좌우로 움직이기'],
  ]],
];

function keysNode(spec) {
  const out = h('span', { class: 'lp-keys' });
  for (const part of spec.split(' ')) {
    if (part === '/' || part === ',') out.appendChild(h('span', { class: 'lp-key-sep' }, part === ',' ? ',' : '/'));
    else if (/[가-힣]/.test(part)) out.appendChild(h('span', { class: 'lp-key-word' }, part));
    else out.appendChild(h('kbd', null, part));
  }
  return out;
}

function openHelp() {
  const existing = findModal('help');
  if (existing) { existing.close('toggle'); return; }
  const m = openModal({
    key: 'help',
    title: '단축키',
    size: 'lg',
    backdropClose: true,
    body: h('div', { class: 'lp-help' }, HELP.map(([group, rows]) => h('section', { class: 'lp-help-group' },
      h('h3', null, group),
      h('table', { class: 'lp-help-table' }, h('tbody', null, rows.map(([k, d]) => h('tr', null, h('td', null, keysNode(k)), h('td', null, d)))))))),
    footRight: [btn('닫기', { kind: 'primary', primary: true, onClick: () => m.close('close') })],
  });
}

// =====================================================================================================
// Init
// =====================================================================================================

function resumeJobs() {
  for (const j of boot.jobs || []) {
    if (!j || !(j.state === 'running' || j.state === 'queued')) continue;
    const kind = String(j.kind || '');
    if (/transcri/.test(kind) && !transcribing && !store.project) {
      // A transcription that kept running while the window was closed: show it, load the result when done.
      attachTranscribe(j);
    } else if (/export/.test(kind)) {
      toast('내보내기가 진행 중이에요. 끝나면 알려 드릴게요', 'info', 4000);
      api.pollJob(j.id, null, 1500)
        .then((d) => toast(`내보내기를 마쳤어요 · ${basename((d.result && d.result.mp4) || '')}`, 'ok', 5000))
        .catch((e) => { if (e && e.code !== 'canceled') toast(`내보내기를 하지 못했어요: ${errMsg(e)}`, 'error', 6000); });
    }
  }
}

function registerCommands() {
  register('open-video', guard(cmdOpenVideo), { label: '불러오기', keys: '⌘O' });
  register('open-project', guard(cmdOpenProject), { label: '프로젝트 열기' });
  register('silence', () => openSilence(), { label: '무음 구간 줄이기' });
  register('fillers', () => openFillers('filler'), { label: '군말' });
  register('ng', () => openNG('ng'), { label: 'NG·반복' });
  register('find', () => openFind(), { label: '찾아 바꾸기', keys: '⌘F' });
  register('resegment', () => openResegment(), { label: '자동 클립 나누기' });
  register('export', () => openExport(), { label: '내보내기' });
  register('export-srt', guard(() => exportSrtFlow(null)), { label: 'SRT만 저장' });
  register('settings', () => openSettings(), { label: '설정' });
  register('help', () => openHelp(), { label: '단축키 도움말', keys: '?' });
  register('quit-app', guard(quitApp), { label: 'Lazy - Cut 종료' });
  // Extra (not in the SPEC list): the editor's empty state offers it when registered.
  register('transcribe', () => {
    if (!hasProject()) { toast('먼저 영상을 불러와 주세요', 'info'); return; }
    if (transcribing) return;
    openTranscribeSetup();
  }, { label: '받아쓰기' });
}

/** Panels API for other modules (all optional; commands are the main entry points). */
export const panels = {
  openTranscribeSetup: () => openTranscribeSetup(),
  openFillers: (tab) => openFillers(tab),
  openNG: (tab) => openNG(tab),
  relink: guard(() => relinkFlow(false)),
  get busy() { return !!(transcribing || exporting); },
  get modalOpen() { return stack.length > 0; },
};

export function initPanels(bootstrap) {
  const b = bootstrap && typeof bootstrap === 'object' ? bootstrap : {};
  boot = {
    version: b.version || '',
    settings: b.settings || {},
    recent: Array.isArray(b.recent) ? b.recent : [],
    models: b.models || {},
    jobs: Array.isArray(b.jobs) ? b.jobs : [],
  };
  settings = { ...DEFAULT_SETTINGS, ...boot.settings };
  appEl = $('app');
  modalRoot = $('modal-root') || document.body;
  statsEl = $('stats');
  const ov = $('job-overlay');
  if (ov) ov.hidden = true;

  player.applySettings(settings);
  window.addEventListener('keydown', onModalKey, true);
  document.addEventListener('focusin', onFocusIn);

  renderStart();
  registerCommands();
  store.on('load', onProjectLoaded);
  onStore(['change', 'flags'], renderStatsSoon);
  setAppClass('no-project', !store.project);
  if (store.project) onProjectLoaded();
  resumeJobs();
  return panels;
}
