// editor.js — the transcript editor (SPEC §5.3): one row per clip (subtitle line), words as chips.
//
// Rendering: rows are built from HTML strings (fast for 1,500 rows / 12,000 chips) and indexed in
// Maps (clip id → row, token id → chip). On 'change' only the listed clips are rebuilt; a cheap
// layout pass keeps DOM order / collapsed groups in sync, and a meta pass refreshes clip numbers and
// output times (they shift after every cut). Selection and the playing token are class toggles only.
// Rows use `content-visibility: auto` (app.css) so off-screen rows cost nothing while scrolling.
//
// Interaction: click chip = select + seek; shift-click extends; drag selects across clips;
// ⌥-click plays the token; double-click / F2 edits a word inline; captions are plain-text
// contenteditable (Enter → next clip, ⇧Enter → line break, Esc → back to chips); right-click menu;
// hover tooltips; NG badge; collapsed deleted clips; follow-playhead scrolling that pauses for 3 s
// after the user scrolls.
//
// Assumptions: player.js exports `player` with seek/playRange/playClip (SPEC §5.2). An optional
// 'transcribe' command (E) is offered from the empty state when registered.

import { store } from './store.js';
import { commands } from './commands.js';
import { escapeHtml as esc, fmtTime, el, isTypingTarget, toast } from './util.js';
import { player } from './player.js';
import { api } from './api.js';

const FOLLOW_PAUSE_MS = 3000;
const TIP_DELAY_MS = 450;
const VIEW_KEY = 'lazycut.view';

let root = null;      // #editor (scroll container, focus target for shortcuts)
let listEl = null;    // rows container
let emptyEl = null;   // empty state
let barEl = null;     // #editor-bar
let barStats = null;

const rows = new Map();   // clipId -> row element
const chips = new Map();  // tokenId -> chip element
const bars = new Map();   // group id (first clip id) -> collapsed-group bar
const expanded = new Set();
const deferred = new Set(); // clip ids whose re-render waits until focus leaves the row

let rendered = { from: -1, to: -1, cfrom: -1, cto: -1 };
let playingTok = null;
let playingClip = null;
let drag = null;
let userScrollAt = -Infinity;
let progScrollUntil = 0;
let menu = null;
let tip = null;
let tipTarget = null;
let tipTimer = null;
let wordEdit = null;
let barRaf = 0;
let CE = 'true';
let measureCtx = null;

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

export const editor = {
  focusCaption,
  scrollToClip,
  editWord,
  revealToken,
  focusChips,
  commitActive,
  isClipHidden,
  get root() { return root; },
};

export default editor;

export function initEditor(elm) {
  root = elm || document.getElementById('editor');
  if (!root) throw new Error('#editor not found');
  CE = detectPlaintextOnly();
  root.classList.add('ed-root');
  if (!root.hasAttribute('tabindex')) root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', '대본 편집기');
  root.textContent = '';
  emptyEl = el('div', { class: 'ed-empty', hidden: true });
  listEl = el('div', { class: 'ed-list' });
  root.append(emptyEl, listEl);

  loadView();
  initBar();

  root.addEventListener('mousedown', onMouseDown);
  root.addEventListener('dblclick', onDblClick);
  root.addEventListener('contextmenu', onContextMenu);
  root.addEventListener('mouseover', onMouseOver);
  root.addEventListener('mouseleave', hideTip);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onCaptionKeyDown);
  root.addEventListener('paste', onPaste);
  root.addEventListener('drop', (e) => { if (e.target.closest && e.target.closest('.c-cap-text')) e.preventDefault(); });
  root.addEventListener('wheel', markUserScroll, { passive: true });
  root.addEventListener('touchmove', markUserScroll, { passive: true });
  root.addEventListener('scroll', onScroll, { passive: true });

  store.on('load', onLoad);
  store.on('change', onChange);
  store.on('flags', onFlags);
  store.on('selection', syncSelection);
  store.on('time', onTime);
  store.on('dirty', scheduleBar);
  store.on('saved', scheduleBar);

  commands.register('toggle-hide-deleted', () => setView('hideDeleted', !store.ui.hideDeleted), { label: '삭제된 클립 숨기기' });
  commands.register('toggle-follow', () => setView('follow', !store.ui.follow), { label: '재생 위치 따라가기' });

  if (store.project) onLoad();
  else updateEmpty();
  return editor;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function detectPlaintextOnly() {
  try {
    const d = document.createElement('div');
    d.contentEditable = 'plaintext-only';
    return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
  } catch (_) {
    return 'true';
  }
}

function fmtSec(x) {
  if (x < 0.05) return '0';
  return x.toFixed(1);
}

function ctx() {
  const r = store.selectedRange();
  const cr = store.ui.clipSel ? store.selectedClipRange() : null;
  return {
    from: r ? r.from : -1,
    to: r ? r.to : -1,
    cfrom: cr ? cr.from : -1,
    cto: cr ? cr.to : -1,
  };
}

function chipHtml(tok, fi, c) {
  let cls = 'tok';
  let text;
  if (tok.type === 'word') {
    cls += ' w';
    text = esc(tok.text);
    if (tok.orig && tok.text !== tok.orig) cls += ' edited';
  } else {
    const dur = tok.end - tok.start;
    const short = tok.keep !== null && tok.keep !== undefined && tok.keep < dur;
    const d = fmtSec(dur);
    const k = short ? fmtSec(Math.max(0, tok.keep)) : '';
    if (tok.type === 'gap') {
      cls += ' gap';
      if (short && Number(tok.keep) <= 0.001) { cls += ' short zero'; text = '[]'; }
      else if (short) { cls += ' short'; text = `[·· ${d}→${k}초]`; }
      else if (dur < 0.5) { cls += ' tiny'; text = '[·]'; }
      else text = `[·· ${d}초]`;
    } else {
      cls += ' noise';
      if (short && Number(tok.keep) <= 0.001) { cls += ' short zero'; text = '[]'; }
      else if (short) { cls += ' short'; text = `[? ${d}→${k}초]`; }
      else text = dur < 0.5 ? '[?]' : `[? ${d}초]`;
    }
  }
  const fl = tok.flags;
  if (fl && fl.length) {
    if (fl.includes('filler')) cls += ' f-filler';
    if (fl.includes('filler?')) cls += ' f-filler-weak';
    if (fl.includes('repeat')) cls += ' f-repeat';
    if (fl.includes('lowconf')) cls += ' f-lowconf';
  }
  if (tok.del) cls += ' del';
  if (fi >= c.from && fi <= c.to) cls += ' sel';
  if (tok.id === playingTok) cls += ' playing';
  return `<span class="${cls}" data-w="${esc(tok.id)}">${text}</span>`;
}

let thumbs = [];          // [{t, url}] sorted by t
let thumbTimer = null;

function loadThumbs(pid, tries = 0) {
  clearTimeout(thumbTimer);
  thumbs = [];
  api.get(`/api/project/${pid}/thumbs`).then((r) => {
    if (!store.project || store.project.id !== pid) return;
    if (r.thumbs && r.thumbs.length) {
      const tk = encodeURIComponent(api.getToken() || '');
      thumbs = r.thumbs.map((x) => ({ t: x.t, url: `${x.url}?t=${tk}` }));
      renderAll();
    } else if (tries < 60) {
      thumbTimer = setTimeout(() => loadThumbs(pid, tries + 1), 2000);
    }
  }).catch(() => {});
}

function thumbFor(t) {
  if (!thumbs.length || t === null || t === undefined) return '';
  let lo = 0, hi = thumbs.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (thumbs[mid].t <= t + 0.05) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return thumbs[best].url;
}

function timingText(ci) {
  const span = store.clipSpan(ci);
  if (!span || span.keptStart === null) return '—';
  const o0 = store.srcToOut(span.keptStart);
  const o1 = span.keptEnd !== null ? store.srcToOut(span.keptEnd) : o0;
  return `${fmtTime(o0)} + ${Math.max(0, o1 - o0).toFixed(2)}초`;
}

function sideHtml(ci) {
  const span = store.clipSpan(ci);
  const timing = timingText(ci);
  const src = span ? thumbFor(span.keptStart !== null ? span.keptStart : span.start) : '';
  return `<div class="c-side"><div class="c-thumb">${src ? `<img src="${esc(src)}" loading="lazy" alt="">` : ''}</div>` +
    `<div class="c-timing">${timing}</div></div>`;
}

function timeLabel(ci) {
  const span = store.clipSpan(ci);
  if (!span || span.keptStart === null) return '—';
  return fmtTime(store.srcToOut(span.keptStart), { ms: true });
}

function rowHtml(ci, c) {
  const clip = store.project.clips[ci];
  const first = store.clipFirstFlat(ci);
  let words = '';
  let allDel = true;
  for (let ti = 0; ti < clip.words.length; ti++) {
    const tok = clip.words[ti];
    if (!tok.del) allDel = false;
    words += chipHtml(tok, first + ti, c);
  }
  const override = clip.caption !== null && clip.caption !== undefined;
  const cap = store.captionOf(clip);
  const ng = !!(clip.flags && clip.flags.includes('ng'));
  let cls = 'clip';
  if (allDel) cls += ' del';
  if (ng) cls += ' ng';
  if (ci >= c.cfrom && ci <= c.cto) cls += ' csel';
  if (clip.id === playingClip) cls += ' cur';
  const time = timeLabel(ci);
  return `<div class="${cls}" data-id="${esc(clip.id)}">` +
    `<div class="c-num"><span class="c-check" aria-hidden="true"></span><span class="c-n">${ci + 1}</span>` +
    (ng ? '<button type="button" class="ng-badge" tabindex="-1">NG?</button>' : '') +
    `</div><div class="c-time${time === '—' ? ' none' : ''}">${time}</div>` +
    `<div class="c-body"><div class="c-words">${words}</div>` +
    `<div class="c-cap${override ? ' override' : ''}${cap ? '' : ' empty'}"><span class="c-cap-label">자막</span>` +
    `<div class="c-cap-text" contenteditable="${CE}" spellcheck="false" data-ph="(자막 없음)">${esc(cap)}</div>` +
    (override ? '<button type="button" class="c-cap-reset" tabindex="-1" aria-label="자동 자막으로 되돌리기">↺</button>' : '') +
    '</div></div>' + sideHtml(ci) + '</div>';
}

function buildRow(ci, c) {
  const tpl = document.createElement('template');
  tpl.innerHTML = rowHtml(ci, c);
  return tpl.content.firstElementChild;
}

function indexChips(row) {
  for (const ch of row.querySelectorAll('.tok')) chips.set(ch.dataset.w, ch);
}

function dropChips(row) {
  for (const ch of row.querySelectorAll('.tok')) {
    if (chips.get(ch.dataset.w) === ch) chips.delete(ch.dataset.w);
  }
}

function renderAll() {
  hideTip();
  closeMenu();
  cancelWordEdit();
  rows.clear();
  chips.clear();
  bars.clear();
  deferred.clear();
  listEl.textContent = '';
  const clips = store.project ? store.project.clips : [];
  updateEmpty();
  if (clips.length) {
    const c = ctx();
    const parts = new Array(clips.length);
    for (let ci = 0; ci < clips.length; ci++) parts[ci] = rowHtml(ci, c);
    const tpl = document.createElement('template');
    tpl.innerHTML = parts.join('');
    const frag = tpl.content;
    for (const row of Array.from(frag.children)) rows.set(row.dataset.id, row);
    for (const ch of frag.querySelectorAll('.tok')) chips.set(ch.dataset.w, ch);
    if (store.ui.hideDeleted) layout();
    else listEl.appendChild(frag);
    rendered = c;
    refreshMeta();
  } else {
    rendered = { from: -1, to: -1, cfrom: -1, cto: -1 };
  }
  scheduleBar();
}

function rerenderRow(id, c) {
  const ci = store.clipIndexOf(id);
  const old = rows.get(id);
  if (ci < 0) {
    if (old) {
      dropChips(old);
      old.remove();
      rows.delete(id);
    }
    deferred.delete(id);
    return;
  }
  if (old && old.isConnected && old.contains(document.activeElement)) {
    deferred.add(id);
    return;
  }
  deferred.delete(id);
  const row = buildRow(ci, c);
  if (old) {
    dropChips(old);
    if (old.parentNode) old.parentNode.replaceChild(row, old);
  }
  rows.set(id, row);
  indexChips(row);
}

function rowFor(ci, c) {
  const clip = store.project.clips[ci];
  let row = rows.get(clip.id);
  if (!row) {
    row = buildRow(ci, c || ctx());
    rows.set(clip.id, row);
    indexChips(row);
  }
  return row;
}

function groupBar(gid, n, open) {
  let bar = bars.get(gid);
  if (!bar) {
    bar = el('div', { class: 'del-group', role: 'button', tabindex: '-1', dataset: { gid } });
    bars.set(gid, bar);
  }
  const key = `${n}|${open ? 1 : 0}`;
  if (bar.__k !== key) {
    bar.__k = key;
    bar.classList.toggle('open', open);
    bar.innerHTML = `<span class="dg-line"></span><span class="dg-label">삭제된 클립 ${n}개${open ? ' · 접기' : ''}</span><span class="dg-line"></span>`;
  }
  return bar;
}

/** Make the DOM order match the clips (and collapsed groups); only mismatched nodes are touched. */
function layout() {
  if (!store.project || !listEl) return;
  const clips = store.project.clips;
  const hide = store.ui.hideDeleted;
  const desired = [];
  const usedBars = new Set();
  let c = null;
  let i = 0;
  while (i < clips.length) {
    if (hide && store.isClipDeleted(i)) {
      let j = i;
      while (j < clips.length && store.isClipDeleted(j)) j++;
      const gid = clips[i].id;
      const open = expanded.has(gid);
      desired.push(groupBar(gid, j - i, open));
      usedBars.add(gid);
      if (open) for (let k = i; k < j; k++) desired.push(rowFor(k, c || (c = ctx())));
      i = j;
    } else {
      desired.push(rowFor(i, c || (c = ctx())));
      i++;
    }
  }
  let cur = listEl.firstChild;
  for (const node of desired) {
    if (node === cur) cur = cur.nextSibling;
    else listEl.insertBefore(node, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    listEl.removeChild(cur);
    cur = next;
  }
  for (const gid of Array.from(bars.keys())) if (!usedBars.has(gid)) bars.delete(gid);
  for (const gid of Array.from(expanded)) if (!usedBars.has(gid)) expanded.delete(gid);
}

/** Refresh clip numbers and output times (they shift after structural edits and cuts). */
function refreshMeta() {
  if (!store.project || !listEl) return;
  const clips = store.project.clips;
  for (let ci = 0; ci < clips.length; ci++) {
    const row = rows.get(clips[ci].id);
    if (!row) continue;
    const n = String(ci + 1);
    if (row.__n !== n) {
      row.__n = n;
      row.querySelector('.c-n').textContent = n;
    }
    const t = timeLabel(ci);
    if (row.__t !== t) {
      row.__t = t;
      const tc = row.children[1];
      tc.textContent = t;
      tc.classList.toggle('none', t === '—');
    }
    const tm = timingText(ci);
    if (row.__tm !== tm) {
      row.__tm = tm;
      const el2 = row.querySelector('.c-timing');
      if (el2) el2.textContent = tm;
    }
  }
}

function updateEmpty() {
  const p = store.project;
  const empty = !p || !p.clips.length;
  emptyEl.hidden = !empty;
  root.classList.toggle('is-empty', empty);
  if (!empty) return;
  emptyEl.textContent = '';
  const icon = el('div', { class: 'ed-empty-icon', html: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 11h11M4 16h14M4 21h8"/></svg>' });
  const title = el('div', { class: 'ed-empty-title' }, p ? '아직 대본이 없어요' : '영상을 불러와 주세요');
  const msg = el('div', { class: 'ed-empty-msg' }, p ? '받아쓰기를 하면 여기에 대본이 나타나요. 단어를 지우면 영상에서도 잘려요.' : '영상을 불러오면 받아쓴 대본으로 컷편집을 할 수 있어요.');
  emptyEl.append(icon, title, msg);
  if (p && commands.has('transcribe')) {
    emptyEl.append(el('button', { class: 'lc-btn primary', type: 'button', onclick: () => commands.run('transcribe') }, '받아쓰기 시작'));
  }
}

// ---------------------------------------------------------------------------------------------
// Store events
// ---------------------------------------------------------------------------------------------

function onLoad() {
  expanded.clear();
  playingTok = null;
  playingClip = null;
  drag = null;
  rendered = { from: -1, to: -1, cfrom: -1, cto: -1 };
  if (store.project) loadThumbs(store.project.id);
  renderAll();
  root.scrollTop = 0;
}

function onChange(ev) {
  if (!store.project || !listEl) return;
  const ids = ev && ev.clipIds;
  if (!ids || ids.size > 400 || rows.size === 0) {
    renderAll();
    return;
  }
  hideTip();
  if (wordEdit && ids.size) {
    // The edited token may have moved; finish the edit against current data.
    const fi = store.flatIndexOf(wordEdit.tokId);
    if (fi < 0 || ids.has(store.flat()[fi].clip.id)) cancelWordEdit();
  }
  const c = ctx();
  for (const id of ids) rerenderRow(id, c);
  // Rows deferred earlier (focused caption) whose focus has since moved are refreshed now too.
  for (const id of Array.from(deferred)) if (!ids.has(id)) rerenderRow(id, c);
  layout();
  refreshMeta();
  syncSelection();
  updateEmpty();
  scheduleBar();
}

function onFlags(ev) {
  const ids = ev && ev.clipIds;
  onChange({ clipIds: ids && ids.size <= 400 ? ids : null, structural: false });
}

function flushDeferred() {
  if (!deferred.size || !store.project) return;
  const c = ctx();
  for (const id of Array.from(deferred)) {
    const row = rows.get(id);
    if (row && row.isConnected && row.contains(document.activeElement)) continue;
    deferred.delete(id);
    rerenderRow(id, c);
  }
  layout();
  refreshMeta();
  syncSelection();
}

function setTokClass(ent, cls, on) {
  if (!ent) return;
  const ch = chips.get(ent.tok.id);
  if (ch) ch.classList.toggle(cls, on);
}

function syncSelection() {
  if (!store.project) return;
  const L = store.flat();
  const r = store.selectedRange();
  const from = r ? r.from : -1;
  const to = r ? r.to : -1;
  const old = rendered;
  if (old.from >= 0) {
    for (let i = old.from; i <= old.to && i < L.length; i++) if (i < from || i > to) setTokClass(L[i], 'sel', false);
  }
  if (from >= 0) {
    for (let i = from; i <= to; i++) if (i < old.from || i > old.to) setTokClass(L[i], 'sel', true);
  }
  const cr = store.ui.clipSel ? store.selectedClipRange() : null;
  const cf = cr ? cr.from : -1;
  const ct = cr ? cr.to : -1;
  if (cf >= 0 || old.cfrom >= 0) {
    const clips = store.project.clips;
    for (let ci = 0; ci < clips.length; ci++) {
      const row = rows.get(clips[ci].id);
      if (row) row.classList.toggle('csel', ci >= cf && ci <= ct);
    }
  }
  rendered = { from, to, cfrom: cf, cto: ct };
  root.classList.toggle('has-sel', from >= 0);
}

function onTime(t) {
  if (!store.project || !store.project.clips.length) return;
  const i = store.tokenAt(typeof t === 'number' ? t : store.ui.time);
  const ent = i >= 0 ? store.flat()[i] : null;
  const tokId = ent ? ent.tok.id : null;
  if (tokId !== playingTok) {
    const a = playingTok && chips.get(playingTok);
    if (a) a.classList.remove('playing');
    const b = tokId && chips.get(tokId);
    if (b) b.classList.add('playing');
    playingTok = tokId;
  }
  const clipId = ent ? ent.clip.id : null;
  if (clipId !== playingClip) {
    const a = playingClip && rows.get(playingClip);
    if (a) a.classList.remove('cur');
    const b = clipId && rows.get(clipId);
    if (b) b.classList.add('cur');
    playingClip = clipId;
    if (clipId) maybeFollow(clipId);
  }
}

// ---------------------------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------------------------

function markUserScroll() {
  userScrollAt = nowMs();
}

function onScroll() {
  if (menu) closeMenu();
  hideTip();
  if (!drag && nowMs() > progScrollUntil) userScrollAt = nowMs();
}

function progScroll(top, smooth) {
  const max = Math.max(0, root.scrollHeight - root.clientHeight);
  const target = Math.max(0, Math.min(max, Math.round(top)));
  if (Math.abs(target - root.scrollTop) < 1) return;
  progScrollUntil = nowMs() + (smooth ? 1200 : 150);
  if (smooth && typeof root.scrollTo === 'function') root.scrollTo({ top: target, behavior: 'smooth' });
  else root.scrollTop = target;
}

/** Scroll so `node` is visible. mode: 'center' | 'soft' (only if outside) | 'follow' (upper third). */
function scrollNodeIntoView(node, mode = 'soft', smooth = false) {
  if (!node || !node.isConnected) return;
  const r = node.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  const margin = 28;
  const inside = r.top >= rr.top + margin && r.bottom <= rr.bottom - margin;
  if (mode !== 'center' && inside) return;
  let delta;
  if (mode === 'center') delta = r.top - rr.top - Math.max(0, (rr.height - r.height) / 2);
  else if (mode === 'follow') delta = r.top - rr.top - rr.height * 0.28;
  else delta = r.top < rr.top + margin ? r.top - (rr.top + margin) : r.bottom - (rr.bottom - margin);
  progScroll(root.scrollTop + delta, smooth);
  if (!smooth && mode === 'center') {
    // Rows above may have been laid out for the first time (content-visibility); correct once.
    requestAnimationFrame(() => {
      if (!node.isConnected) return;
      const r2 = node.getBoundingClientRect();
      const rr2 = root.getBoundingClientRect();
      const d2 = r2.top - rr2.top - Math.max(0, (rr2.height - r2.height) / 2);
      if (Math.abs(d2) > 8) progScroll(root.scrollTop + d2, false);
    });
  }
}

function maybeFollow(clipId) {
  if (!store.ui.follow || drag || menu || wordEdit) return;
  if (nowMs() - userScrollAt < FOLLOW_PAUSE_MS) return;
  const ae = document.activeElement;
  if (ae && root.contains(ae) && isTypingTarget(ae)) return;
  const row = rows.get(clipId);
  if (!row || !row.isConnected) return;
  scrollNodeIntoView(row, 'follow', true);
}

/** Expand the collapsed group that hides clip ci (hideDeleted). Returns true if layout changed. */
function revealClip(ci) {
  const clips = store.project.clips;
  const clip = clips[ci];
  if (!clip) return false;
  const row = rows.get(clip.id);
  if (row && row.isConnected) return false;
  if (store.ui.hideDeleted && store.isClipDeleted(ci)) {
    let g = ci;
    while (g > 0 && store.isClipDeleted(g - 1)) g--;
    expanded.add(clips[g].id);
  }
  layout();
  refreshMeta();
  return true;
}

function isClipHidden(ci) {
  if (!store.project || !store.ui.hideDeleted || !store.isClipDeleted(ci)) return false;
  let g = ci;
  while (g > 0 && store.isClipDeleted(g - 1)) g--;
  return !expanded.has(store.project.clips[g].id);
}

function scrollToClip(ci, { mode = 'center', smooth = false } = {}) {
  if (!store.project || ci < 0 || ci >= store.project.clips.length) return;
  revealClip(ci);
  scrollNodeIntoView(rows.get(store.project.clips[ci].id), mode, smooth);
}

function revealToken(fi) {
  const ent = store.flat()[fi];
  if (!ent) return;
  revealClip(ent.ci);
  const ch = chips.get(ent.tok.id);
  if (ch) scrollNodeIntoView(ch, 'soft');
}

function focusRoot() {
  if (root && document.activeElement !== root) {
    try { root.focus({ preventScroll: true }); } catch (_) { root.focus(); }
  }
}

/** Return keyboard focus to the chips (selects the clip's first token if nothing is selected). */
function focusChips(ci) {
  commitActive();
  focusRoot();
  flushDeferred();
  if (!store.ui.sel && Number.isInteger(ci) && ci >= 0) {
    const fi = store.clipFirstFlat(ci);
    if (fi >= 0) store.select(fi);
  }
}

// ---------------------------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------------------------

function seekTo(t) {
  try {
    if (player && typeof player.seek === 'function') player.seek(t);
    else store.setTime(t);
  } catch (e) {
    store.setTime(t);
  }
}

function playRange(s, e) {
  try {
    if (player && typeof player.playRange === 'function') player.playRange(s, e);
  } catch (err) {
    toast('재생하지 못했어요.', 'warn');
  }
}

function playClip(ci) {
  try {
    if (player && typeof player.playClip === 'function') player.playClip(ci);
    else if (commands.has('play-clip')) commands.run('play-clip');
  } catch (err) {
    toast('재생하지 못했어요.', 'warn');
  }
}

// ---------------------------------------------------------------------------------------------
// Mouse: selection, drag-select, clip numbers, collapsed groups
// ---------------------------------------------------------------------------------------------

function clipIndexOfNode(node) {
  const row = node && node.closest ? node.closest('.clip') : null;
  return row ? store.clipIndexOf(row.dataset.id) : -1;
}

function nearestChipInRow(row, x, y) {
  let best = null, bestD = Infinity;
  for (const ch of row.querySelectorAll('.c-words .tok')) {
    const r = ch.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dy * 4 + dx;
    if (d < bestD) { bestD = d; best = ch; }
  }
  return best;
}

function onMouseDown(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  if (menu && !menu.contains(t)) closeMenu();
  if (e.button !== 0) return;
  if (t.closest('.c-cap-text') || t.closest('.tok-input')) return; // native text editing
  hideTip();

  const reset = t.closest('.c-cap-reset');
  if (reset) {
    e.preventDefault();
    const ci = clipIndexOfNode(reset);
    if (ci >= 0) store.setCaption(ci, null);
    return;
  }

  const group = t.closest('.del-group');
  if (group) {
    e.preventDefault();
    const gid = group.dataset.gid;
    if (expanded.has(gid)) expanded.delete(gid); else expanded.add(gid);
    layout();
    refreshMeta();
    return;
  }

  const badge = t.closest('.ng-badge');
  if (badge) {
    e.preventDefault();
    focusRoot();
    const ci = clipIndexOfNode(badge);
    if (ci >= 0) {
      store.selectClips(ci);
      const span = store.clipSpan(ci);
      if (span) seekTo(span.keptStart !== null ? span.keptStart : span.start);
    }
    return;
  }

  let chip = t.closest('.tok');
  const row = t.closest('.clip');
  if (!chip && row && t.closest('.c-words')) chip = nearestChipInRow(row, e.clientX, e.clientY);
  if (chip && root.contains(chip)) {
    e.preventDefault();
    if (wordEdit) finishWordEdit(true);
    focusRoot();
    const fi = store.flatIndexOf(chip.dataset.w);
    if (fi < 0) return;
    const tok = store.flat()[fi].tok;
    if (e.altKey) {
      store.select(fi);
      playRange(tok.start, tok.end);
      return;
    }
    if (e.shiftKey && store.ui.sel) store.select(store.ui.sel.a, fi);
    else {
      store.select(fi);
      seekTo(tok.start);
    }
    startDrag('tok', store.ui.sel ? store.ui.sel.a : fi, e);
    return;
  }

  if (row && t.closest('.c-cap')) {
    // Click on the caption label / padding → edit the caption.
    e.preventDefault();
    const ci = store.clipIndexOf(row.dataset.id);
    if (ci >= 0) focusCaption(ci);
    return;
  }

  const num = t.closest('.c-num') || t.closest('.c-time');
  if (num && row) {
    e.preventDefault();
    focusRoot();
    const ci = store.clipIndexOf(row.dataset.id);
    if (ci < 0) return;
    if (num.classList.contains('c-time')) {
      const span = store.clipSpan(ci);
      const fi = store.clipFirstFlat(ci);
      store.select(fi);
      if (span) seekTo(span.keptStart !== null ? span.keptStart : span.start);
      return;
    }
    if (e.shiftKey && (store.ui.clipSel || store.ui.sel)) {
      const anchor = store.ui.clipSel ? store.ui.clipSel.a : store.selectedClipRange().from;
      store.selectClips(anchor, ci);
    } else {
      store.selectClips(ci);
      const span = store.clipSpan(ci);
      if (span) seekTo(span.keptStart !== null ? span.keptStart : span.start);
    }
    startDrag('clip', store.ui.clipSel ? store.ui.clipSel.a : ci, e);
  }
}

function startDrag(kind, anchor, e) {
  drag = { kind, anchor, x: e.clientX, y: e.clientY, raf: 0, speed: 0 };
  root.classList.add('dragging');
  window.addEventListener('mousemove', onDragMove, true);
  window.addEventListener('mouseup', onDragEnd, true);
  window.addEventListener('blur', onDragEnd);
}

function dragPick(x, y) {
  if (!drag || !store.project) return;
  let target = document.elementFromPoint(x, y);
  if (!target || !root.contains(target)) {
    // Pointer above/below the list: clamp to the nearest visible edge.
    const rr = root.getBoundingClientRect();
    const cy = Math.max(rr.top + 4, Math.min(rr.bottom - 4, y));
    const cx = Math.max(rr.left + 4, Math.min(rr.right - 16, x));
    target = document.elementFromPoint(cx, cy);
    if (!target || !root.contains(target)) return;
  }
  if (drag.kind === 'tok') {
    let chip = target.closest('.tok');
    if (!chip) {
      const row = target.closest('.clip');
      if (row) chip = nearestChipInRow(row, x, y);
    }
    if (!chip) return;
    const fi = store.flatIndexOf(chip.dataset.w);
    if (fi >= 0) store.select(drag.anchor, fi);
  } else {
    const ci = clipIndexOfNode(target);
    if (ci >= 0) store.selectClips(drag.anchor, ci);
  }
}

function onDragMove(e) {
  if (!drag) return;
  if (!(e.buttons & 1)) { onDragEnd(); return; }
  drag.x = e.clientX;
  drag.y = e.clientY;
  dragPick(e.clientX, e.clientY);
  // Auto-scroll near the top/bottom edges.
  const rr = root.getBoundingClientRect();
  const edge = 36;
  let speed = 0;
  if (e.clientY < rr.top + edge) speed = -Math.min(28, (rr.top + edge - e.clientY) * 0.6 + 4);
  else if (e.clientY > rr.bottom - edge) speed = Math.min(28, (e.clientY - (rr.bottom - edge)) * 0.6 + 4);
  drag.speed = speed;
  if (speed && !drag.raf) drag.raf = requestAnimationFrame(dragScrollTick);
}

function dragScrollTick() {
  if (!drag) return;
  drag.raf = 0;
  if (!drag.speed) return;
  root.scrollTop += drag.speed;
  dragPick(drag.x, drag.y);
  drag.raf = requestAnimationFrame(dragScrollTick);
}

function onDragEnd() {
  if (!drag) return;
  if (drag.raf) cancelAnimationFrame(drag.raf);
  drag = null;
  root.classList.remove('dragging');
  window.removeEventListener('mousemove', onDragMove, true);
  window.removeEventListener('mouseup', onDragEnd, true);
  window.removeEventListener('blur', onDragEnd);
}

function onDblClick(e) {
  const chip = e.target.closest && e.target.closest('.tok.w');
  if (!chip || !root.contains(chip)) return;
  e.preventDefault();
  const fi = store.flatIndexOf(chip.dataset.w);
  if (fi >= 0) editWord(fi);
}

// ---------------------------------------------------------------------------------------------
// Inline word edit
// ---------------------------------------------------------------------------------------------

function sizeInput(input) {
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(input);
    measureCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = measureCtx.measureText(input.value || ' ').width;
    input.style.width = `${Math.ceil(Math.max(24, w) + 16)}px`;
  } catch (_) {
    input.size = Math.max(2, (input.value || '').length + 1);
  }
}

/** Inline-edit the word at flat index fi (double-click / F2). Returns false for gap/noise tokens. */
function editWord(fi) {
  if (!store.project) return false;
  const ent = store.flat()[fi];
  if (!ent || ent.tok.type !== 'word') return false;
  if (wordEdit) finishWordEdit(true);
  closeMenu();
  hideTip();
  revealClip(ent.ci);
  const chip = chips.get(ent.tok.id);
  if (!chip || !chip.isConnected) return false;
  scrollNodeIntoView(chip, 'soft');
  store.select(fi);
  const input = document.createElement('input');
  input.className = 'tok-input';
  input.type = 'text';
  input.value = ent.tok.text;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '단어 고치기');
  chip.classList.add('editing');
  chip.textContent = '';
  chip.appendChild(input);
  wordEdit = { input, chip, tokId: ent.tok.id, original: ent.tok.text, done: false };
  store.ui.editing = { type: 'word', id: ent.tok.id };
  sizeInput(input);
  input.addEventListener('input', () => sizeInput(input));
  input.addEventListener('mousedown', (ev) => ev.stopPropagation());
  input.addEventListener('dblclick', (ev) => ev.stopPropagation());
  input.addEventListener('blur', () => finishWordEdit(true));
  input.addEventListener('keydown', (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      ev.stopPropagation();
      finishWordEdit(true);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finishWordEdit(false);
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      ev.stopPropagation();
      const tokId = wordEdit && wordEdit.tokId;
      finishWordEdit(true);
      // Continue with the next/previous word.
      const L = store.flat();
      let i = store.flatIndexOf(tokId);
      const dir = ev.shiftKey ? -1 : 1;
      for (i += dir; i >= 0 && i < L.length; i += dir) if (L[i].tok.type === 'word') { editWord(i); break; }
    } else if (!(ev.metaKey && ev.code === 'KeyS')) {
      ev.stopPropagation();
    }
  });
  input.focus();
  input.select();
  return true;
}

function finishWordEdit(commit) {
  const w = wordEdit;
  if (!w || w.done) return;
  w.done = true;
  wordEdit = null;
  store.ui.editing = null;
  const value = w.input.value;
  focusRoot(); // the input's blur re-enters here and is ignored (w.done)
  w.chip.classList.remove('editing');
  w.chip.textContent = w.original;
  if (commit && value.trim() && value.trim() !== w.original) {
    const fi = store.flatIndexOf(w.tokId);
    if (fi >= 0) store.setWordText(fi, value);
  }
}

function cancelWordEdit() {
  if (wordEdit) finishWordEdit(false);
}

// ---------------------------------------------------------------------------------------------
// Caption editing
// ---------------------------------------------------------------------------------------------

function readCaption(capEl) {
  return (capEl.innerText || capEl.textContent || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
}

function normCaption(s) {
  return String(s).split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
}

function commitCaption(capEl) {
  if (!store.project || !capEl) return;
  const row = capEl.closest('.clip');
  if (!row) return;
  const ci = store.clipIndexOf(row.dataset.id);
  if (ci < 0) return;
  const clip = store.project.clips[ci];
  const text = normCaption(readCaption(capEl));
  if (text === store.captionOf(clip)) return;
  store.setCaption(ci, text);
}

/** Commit whatever is being edited (word input or caption) — before save/undo/unload. */
function commitActive() {
  if (wordEdit) finishWordEdit(true);
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('c-cap-text') && root && root.contains(ae)) commitCaption(ae);
}

function focusCaption(ci) {
  if (!store.project) return false;
  const clip = store.project.clips[ci];
  if (!clip) return false;
  if (wordEdit) finishWordEdit(true);
  revealClip(ci);
  const row = rows.get(clip.id);
  if (!row) return false;
  const cap = row.querySelector('.c-cap-text');
  if (!cap) return false;
  scrollNodeIntoView(row, 'soft');
  try { cap.focus({ preventScroll: true }); } catch (_) { cap.focus(); }
  flushDeferred(); // the previously focused row (if any) can re-render now
  try {
    const range = document.createRange();
    range.selectNodeContents(cap);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (_) { /* ignore */ }
  return true;
}

function nextVisibleClip(ci, dir) {
  const n = store.project.clips.length;
  for (let i = ci + dir; i >= 0 && i < n; i += dir) if (!isClipHidden(i)) return i;
  return -1;
}

function onFocusIn(e) {
  const cap = e.target.closest && e.target.closest('.c-cap-text');
  if (!cap) return;
  hideTip();
  const row = cap.closest('.clip');
  store.ui.editing = { type: 'caption', id: row ? row.dataset.id : null };
  cap.parentElement.classList.add('editing');
}

function onFocusOut(e) {
  const cap = e.target.closest && e.target.closest('.c-cap-text');
  if (cap) {
    cap.parentElement.classList.remove('editing');
    if (store.ui.editing && store.ui.editing.type === 'caption') store.ui.editing = null;
    if (cap.isConnected) {
      commitCaption(cap);
      // Show the canonical text again (store normalization / unchanged edits).
      const ci = clipIndexOfNode(cap);
      if (ci >= 0 && cap.isConnected) {
        const canon = store.captionOf(store.project.clips[ci]);
        if (readCaption(cap) !== canon) cap.textContent = canon;
      }
    }
  }
  setTimeout(flushDeferred, 0);
}

function insertPlainText(text) {
  try {
    if (document.execCommand && document.execCommand('insertText', false, text)) return;
  } catch (_) { /* fall back */ }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function onPaste(e) {
  const cap = e.target.closest && e.target.closest('.c-cap-text');
  if (!cap) return;
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
  insertPlainText(text.replace(/\r\n?/g, '\n'));
}

function caretOffset(capEl) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const r = sel.getRangeAt(0);
  if (!capEl.contains(r.endContainer)) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(capEl);
  pre.setEnd(r.endContainer, r.endOffset);
  return pre.toString().length;
}

function onCaptionKeyDown(e) {
  const cap = e.target.closest && e.target.closest('.c-cap-text');
  if (!cap) return;
  if (e.isComposing || e.keyCode === 229) return; // Korean IME composition in progress
  const ci = clipIndexOfNode(cap);
  const leaveTo = (target) => {
    e.preventDefault();
    e.stopPropagation();
    commitCaption(cap);
    if (target >= 0) {
      // The committed row may re-render after focus moves; resolve the index again.
      focusCaption(target);
    } else focusChips(ci);
  };
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      insertPlainText('\n');
      return;
    }
    // caret in the middle of the caption -> split the clip there
    const raw = readCaption(cap);
    const pos = caretOffset(cap);
    if (pos > 0 && pos < raw.replace(/\s+$/, '').length) {
      e.preventDefault();
      e.stopPropagation();
      const nci = store.splitClipAtText(ci, raw, pos);
      if (nci >= 0) focusCaption(nci);
      return;
    }
    const next = nextVisibleClip(ci, 1);
    if (next >= 0) leaveTo(next);
    else leaveTo(-1);
    return;
  }
  if (e.key === 'Backspace' && e.shiftKey && !e.metaKey && !e.altKey) {
    // Shift+Backspace in a caption: the whole clip (words + caption) joins the previous clip
    e.preventDefault();
    e.stopPropagation();
    if (ci <= 0) return;
    commitCaption(cap);
    const prevId = store.project.clips[ci - 1].id;
    store.mergeWithPrev(ci);
    const pi = store.clipIndexOf(prevId);
    if (pi >= 0) focusCaption(pi);
    return;
  }
  if (e.key === 'Tab') {
    const next = nextVisibleClip(ci, e.shiftKey ? -1 : 1);
    leaveTo(next >= 0 ? next : -1);
    return;
  }
  if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowUp')) {
    leaveTo(-1);
    return;
  }
  if (e.altKey && e.key === 'ArrowDown') {
    const next = nextVisibleClip(ci, 1);
    if (next >= 0) leaveTo(next);
    else { e.preventDefault(); e.stopPropagation(); }
  }
}

// ---------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------

function onContextMenu(e) {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('.c-cap-text') || t.closest('.tok-input')) return; // native menu for text editing
  const row = t.closest('.clip');
  if (!row) return;
  e.preventDefault();
  hideTip();
  if (wordEdit) finishWordEdit(true);
  focusRoot();
  const chip = t.closest('.tok');
  if (chip) {
    const fi = store.flatIndexOf(chip.dataset.w);
    if (fi < 0) return;
    const r = store.selectedRange();
    if (!r || fi < r.from || fi > r.to || store.ui.clipSel) store.select(fi);
    openMenu(e.clientX, e.clientY, tokenMenuItems(fi));
  } else {
    const ci = store.clipIndexOf(row.dataset.id);
    if (ci < 0) return;
    const cr = store.ui.clipSel ? store.selectedClipRange() : null;
    if (!cr || ci < cr.from || ci > cr.to) store.selectClips(ci);
    openMenu(e.clientX, e.clientY, clipMenuItems(ci));
  }
}

function tokenMenuItems(fi) {
  const L = store.flat();
  const ent = L[fi];
  const r = store.selectedRange() || { from: fi, to: fi };
  const nc = store.project.clips.length;
  let allDel = true;
  let silences = 0, shortened = 0;
  for (let i = r.from; i <= r.to; i++) {
    const tk = L[i].tok;
    if (!tk.del) allDel = false;
    if (tk.type !== 'word') {
      silences++;
      if (tk.keep !== null && tk.keep !== undefined && tk.keep < tk.end - tk.start) shortened++;
    }
  }
  const multi = r.to > r.from;
  const items = [
    { label: allDel ? (multi ? '선택한 부분 복원' : '복원') : (multi ? '선택한 부분 삭제' : '삭제'), kbd: '⌫', run: () => store.toggleDelete() },
    '-',
    { label: '여기서 클립 나누기', kbd: '↵', disabled: ent.ti === 0, run: () => store.splitClip(fi) },
    { label: ent.ti === 0 ? '이 클립을 앞 클립에 붙이기' : '이 앞까지 앞 클립으로 올리기', kbd: '⇧⌫', disabled: ent.ci === 0, run: () => store.joinToPrev(fi) },
    { label: '여기부터 다음 클립으로 보내기', kbd: '⇧↵', disabled: ent.ti === 0 && ent.ci >= nc - 1, run: () => store.splitToNext(fi) },
    { label: '다음 클립과 합치기', kbd: '⌘E', disabled: ent.ci >= nc - 1, run: () => store.mergeWithNext(ent.ci) },
    '-',
  ];
  if (ent.tok.type === 'word') {
    items.push({ label: '단어 고치기', kbd: 'F2', run: () => editWord(fi) });
  }
  if (silences) {
    if (shortened === silences) items.push({ label: '무음 원래대로', run: () => store.setKeep(r.from, r.to, null) });
    else items.push({ label: '무음 0초로', run: () => store.setKeep(r.from, r.to, 0) });
  }
  items.push({
    label: multi ? '선택한 부분 들어보기' : '이 부분 들어보기',
    kbd: '⌥클릭',
    run: () => playRange(L[r.from].tok.start, L[r.to].tok.end),
  });
  return items;
}

function clipMenuItems(ci) {
  const nc = store.project.clips.length;
  const cr = store.selectedClipRange() || { from: ci, to: ci };
  let allDel = true;
  for (let i = cr.from; i <= cr.to; i++) if (!store.isClipDeleted(i)) { allDel = false; break; }
  const clip = store.project.clips[ci];
  const multi = cr.to > cr.from;
  const override = clip.caption !== null && clip.caption !== undefined;
  return [
    { label: allDel ? (multi ? `클립 ${cr.to - cr.from + 1}개 복원` : '클립 복원') : (multi ? `클립 ${cr.to - cr.from + 1}개 삭제` : '클립 삭제'), kbd: '⌫', run: () => store.toggleDelete() },
    '-',
    multi
      ? { label: `클립 ${cr.to - cr.from + 1}개 합치기`, kbd: '⌘E', run: () => store.mergeClips(cr.from, cr.to) }
      : { label: '다음 클립과 합치기', kbd: '⌘E', disabled: ci >= nc - 1, run: () => store.mergeWithNext(ci) },
    { label: '이전 클립과 합치기', kbd: '⌘⇧E', disabled: cr.from === 0, run: () => store.mergeWithPrev(cr.from) },
    '-',
    { label: '자막 고치기', kbd: '⌥↓', run: () => focusCaption(ci) },
    { label: '자막을 자동으로 되돌리기', disabled: !override, run: () => store.setCaption(ci, null) },
    { label: '이 클립 자막 없애기', disabled: override && clip.caption === '', run: () => store.setCaption(ci, '') },
    '-',
    { label: '이 클립 재생', kbd: 'Tab', run: () => playClip(ci) },
  ];
}

function openMenu(x, y, items) {
  closeMenu();
  const m = el('div', { class: 'lc-menu', role: 'menu' });
  let prevSep = true;
  for (const it of items) {
    if (it === '-') {
      if (!prevSep) m.appendChild(el('div', { class: 'lc-menu-sep', role: 'separator' }));
      prevSep = true;
      continue;
    }
    prevSep = false;
    const b = el('button', { class: 'lc-menu-item', type: 'button', role: 'menuitem', disabled: !!it.disabled },
      el('span', { class: 'lc-menu-label' }, it.label),
      it.kbd ? el('span', { class: 'lc-menu-kbd' }, it.kbd) : null);
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      closeMenu();
      focusRoot();
      try { it.run(); } catch (err) { if (typeof console !== 'undefined') console.error(err); toast('실행하지 못했어요.', 'error'); }
    });
    m.appendChild(b);
  }
  if (m.lastElementChild && m.lastElementChild.classList.contains('lc-menu-sep')) m.lastElementChild.remove();
  m.style.left = '0px';
  m.style.top = '0px';
  m.style.visibility = 'hidden';
  document.body.appendChild(m);
  const w = m.offsetWidth, h = m.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  m.style.left = `${Math.max(6, Math.min(x, vw - w - 6))}px`;
  m.style.top = `${Math.max(6, y + h > vh - 6 ? y - h : y)}px`;
  m.style.visibility = '';
  menu = m;
  window.addEventListener('mousedown', onMenuOutside, true);
  window.addEventListener('keydown', onMenuKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
}

function closeMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  window.removeEventListener('mousedown', onMenuOutside, true);
  window.removeEventListener('keydown', onMenuKey, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
}

function onMenuOutside(e) {
  if (menu && !menu.contains(e.target)) closeMenu();
}

function onMenuKey(e) {
  if (!menu) return;
  const items = Array.from(menu.querySelectorAll('.lc-menu-item:not([disabled])'));
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') {
    closeMenu();
    focusRoot();
  } else if (e.key === 'ArrowDown') {
    (items[(i + 1) % items.length] || items[0]).focus();
  } else if (e.key === 'ArrowUp') {
    (items[i <= 0 ? items.length - 1 : i - 1] || items[0]).focus();
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (i >= 0) items[i].click();
    else if (items[0]) items[0].click();
  } else if (e.key === 'Tab') {
    closeMenu();
    focusRoot();
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------------------------
// Tooltips
// ---------------------------------------------------------------------------------------------

const FLAG_TIPS = {
  filler: '군말일 가능성이 높아요',
  'filler?': '군말일 수도 있어요',
  repeat: '반복된 말이에요 — 뒤에서 다시 말했어요',
  lowconf: '인식이 불확실해요. 들어보고 고쳐 주세요',
};

function tipFor(node) {
  if (!store.project) return '';
  if (node.classList.contains('tok')) {
    const fi = store.flatIndexOf(node.dataset.w);
    if (fi < 0) return '';
    const tok = store.flat()[fi].tok;
    const dur = tok.end - tok.start;
    let head = `원본 ${fmtTime(tok.start, { ms: 2 })}–${fmtTime(tok.end, { ms: 2 })} · ${dur.toFixed(2)}초`;
    if (tok.type === 'word' && typeof tok.p === 'number') head += ` · 정확도 ${Math.round(tok.p * 100)}%`;
    const lines = [head];
    if (tok.type === 'gap') {
      const short = tok.keep !== null && tok.keep !== undefined && tok.keep < dur;
      lines.push(short ? `무음 구간 · ${fmtSec(Math.max(0, tok.keep))}초로 줄였어요` : '무음 구간이에요');
    } else if (tok.type === 'noise') {
      const short = tok.keep !== null && tok.keep !== undefined && tok.keep < dur;
      lines.push('음성 미인식 구간이에요 (숨소리·군말일 수 있어요)');
      if (short) lines.push(`${fmtSec(Math.max(0, tok.keep))}초로 줄였어요`);
    }
    for (const f of tok.flags || []) if (FLAG_TIPS[f]) lines.push(FLAG_TIPS[f]);
    if (tok.type === 'word' && tok.orig && tok.text !== tok.orig) lines.push(`원래 인식: ${tok.orig}`);
    if (tok.del) lines.push('삭제됨 · 결과 영상에서 빠져요');
    return lines.join('\n');
  }
  if (node.classList.contains('ng-badge')) {
    const ci = clipIndexOfNode(node);
    const clip = store.project.clips[ci];
    const target = clip && clip.ngOf ? store.clipIndexOf(clip.ngOf) : -1;
    return target >= 0 ? `#${target + 1}번 클립에서 다시 말했어요\n누르면 이 클립을 선택해요` : 'NG일 수 있어요. 다시 말한 부분이 있는지 확인해 주세요';
  }
  if (node.classList.contains('c-time')) {
    const ci = clipIndexOfNode(node);
    const span = store.clipSpan(ci);
    if (!span) return '';
    if (span.keptStart === null) return '이 클립은 결과 영상에서 빠져요';
    return `결과 영상에서 시작하는 시간이에요\n원본 ${fmtTime(span.start, { ms: true })}`;
  }
  if (node.classList.contains('c-cap-reset')) return '직접 고친 자막이에요. 누르면 단어에서 자동으로 만든 자막으로 돌아가요';
  if (node.classList.contains('c-n')) return '클릭해서 클립 선택 · ⇧클릭으로 여러 개';
  return '';
}

function onMouseOver(e) {
  if (drag || menu) return;
  const t = e.target;
  const node = t && t.closest ? t.closest('.tok, .ng-badge, .c-time, .c-cap-reset, .c-n') : null;
  if (node === tipTarget) return;
  hideTip();
  if (!node || node.classList.contains('editing')) return;
  tipTarget = node;
  tipTimer = setTimeout(() => showTip(node), TIP_DELAY_MS);
}

function showTip(node) {
  tipTimer = null;
  if (!node.isConnected || drag || menu || wordEdit) return;
  const text = tipFor(node);
  if (!text) return;
  if (!tip) {
    tip = el('div', { class: 'lc-tip', role: 'tooltip' });
    document.body.appendChild(tip);
  }
  tip.textContent = text;
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.classList.add('show');
  const r = node.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const vw = window.innerWidth;
  let top = r.top - h - 8;
  if (top < 6) top = r.bottom + 8;
  tip.style.left = `${Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2))}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = null;
  tipTarget = null;
  if (tip) tip.classList.remove('show');
}

// ---------------------------------------------------------------------------------------------
// Editor bar (#editor-bar): counts + view toggles
// ---------------------------------------------------------------------------------------------

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    if (typeof v.hideDeleted === 'boolean') store.ui.hideDeleted = v.hideDeleted;
    if (typeof v.follow === 'boolean') store.ui.follow = v.follow;
  } catch (_) { /* storage unavailable */ }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ hideDeleted: store.ui.hideDeleted, follow: store.ui.follow }));
  } catch (_) { /* storage unavailable */ }
}

function setView(key, value) {
  store.ui[key] = !!value;
  saveView();
  if (barEl) {
    const input = barEl.querySelector(`input[data-view="${key}"]`);
    if (input) input.checked = !!value;
  }
  if (key === 'hideDeleted' && store.project) {
    expanded.clear();
    layout();
    refreshMeta();
    toast(value ? '삭제된 클립을 숨겼어요.' : '삭제된 클립을 다시 보여 줘요.', 'info', 1600);
  }
  if (key === 'follow' && value) {
    userScrollAt = -Infinity;
    if (playingClip) maybeFollow(playingClip);
  }
  store.emit('view', { key, value: !!value });
}

function initBar() {
  barEl = document.getElementById('editor-bar');
  if (!barEl) return;
  barEl.textContent = '';
  barStats = el('div', { class: 'eb-stats', 'aria-live': 'polite' });
  const toggle = (key, label, title) => {
    const input = el('input', { type: 'checkbox', dataset: { view: key } });
    input.checked = !!store.ui[key];
    input.addEventListener('change', () => setView(key, input.checked));
    return el('label', { class: 'lc-switch', title },
      input, el('span', { class: 'lc-switch-track', 'aria-hidden': 'true' }), el('span', { class: 'lc-switch-label' }, label));
  };
  barEl.append(
    barStats,
    el('div', { class: 'eb-toggles' },
      toggle('hideDeleted', '삭제된 클립 숨기기', '완전히 삭제한 클립을 한 줄로 접어요'),
      toggle('follow', '따라가기', '재생 중인 위치로 대본을 자동으로 스크롤해요')),
  );
  scheduleBar();
}

function scheduleBar() {
  if (!barStats || barRaf) return;
  barRaf = requestAnimationFrame(() => {
    barRaf = 0;
    updateBar();
  });
}

function updateBar() {
  if (!barStats) return;
  const p = store.project;
  if (!p || !p.clips.length) {
    barStats.textContent = p ? '대본 없음' : '';
    return;
  }
  const st = store.stats();
  const parts = [
    `<span class="eb-item"><b>${st.clips}</b>개 클립</span>`,
  ];
  if (st.deletedClips) parts.push(`<span class="eb-item eb-del">삭제 <b>${st.deletedClips}</b></span>`);
  const saved = st.srcDur - st.outDur;
  parts.push(`<span class="eb-item">결과 <b>${fmtTime(st.outDur)}</b><span class="eb-sub"> / 원본 ${fmtTime(st.srcDur)}</span></span>`);
  if (saved > 0.5) parts.push(`<span class="eb-item eb-saved">−${fmtTime(saved)}</span>`);
  barStats.innerHTML = parts.join('<span class="eb-dot" aria-hidden="true">·</span>');
}
