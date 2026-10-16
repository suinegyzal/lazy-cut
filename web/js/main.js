// main.js — app boot, core commands, autosave, splitter, unload flush (SPEC §5.2 main.js).
//
// Boot: api.init → GET /api/bootstrap → initEditor, initShortcuts, initPlayer, initTimeline,
// initPanels(bootstrap). Each init is isolated so one failing module doesn't take the app down.
//
// Autosave: 1.5 s after the last 'dirty' event (and ⌘S). A save carries store.version; if more
// edits arrive while the request is in flight, the project stays dirty and another save follows.
// Autosave is skipped while the project has no clips (the server owns the file during transcription).
//
// Unload: commits an in-progress caption/word edit, then flushes. sendBeacon can't carry the token
// header and Chrome caps keepalive bodies at 64 KB, so small projects go out with fetch keepalive;
// larger ones start a normal save and ask the browser to confirm leaving (giving the save time).
//
// Media loading is owned by player.js (it listens to store 'load' itself); main.js does not call
// player.load.

import { api } from './api.js';
import { store } from './store.js';
import { register, run, has, setErrorHandler, onRegister } from './commands.js';
import { toast, debounce, promptDialog, clamp, el, isTypingTarget, fmtTime } from './util.js';
import { initEditor, editor } from './editor.js';
import { initShortcuts } from './shortcuts.js';
import { initPlayer, player } from './player.js';
import { initTimeline } from './timeline.js';
import { initPanels } from './panels.js';

const AUTOSAVE_MS = 1500;
const SPLIT_KEY = 'lazycut.leftW';
const KEEPALIVE_MAX = 60 * 1024;
const NEEDS_CLIPS = new Set(['split', 'merge-next', 'resegment', 'silence', 'fillers', 'ng', 'find', 'export']);

const $ = (id) => document.getElementById(id);

let saving = null;
let saveQueued = false;
let saveFails = 0;
let retryTimer = null;
let toolbarRaf = 0;

function log(...args) {
  if (typeof console !== 'undefined') console.error(...args);
}

function hint(msg) {
  toast(msg, 'info', 1800);
}

// ---------------------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------------------

const scheduleSave = debounce(() => { saveNow(); }, AUTOSAVE_MS);

function hhmm(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function setSaveState(state, detail) {
  const box = $('save-state');
  if (!box) return;
  box.dataset.state = state;
  let text = '';
  let title = '';
  if (state === 'dirty') text = '수정됨';
  else if (state === 'saving') text = '저장 중…';
  else if (state === 'saved') {
    text = store.savedAt ? `저장됨 ${hhmm(store.savedAt)}` : '저장됨';
    title = store.project && store.project.file ? `자동으로 저장돼요\n${store.project.file}` : '자동으로 저장돼요';
  } else if (state === 'error') {
    text = '저장 실패 · 다시 시도';
    title = `저장하지 못했어요: ${detail || ''}\n누르면 다시 저장해요`;
  }
  box.textContent = text;
  box.title = title;
  box.setAttribute('role', state === 'error' ? 'button' : 'status');
}

/** Save the project now. Resolves true on success. */
function saveNow({ manual = false } = {}) {
  const p = store.project;
  if (!p) return Promise.resolve(false);
  scheduleSave.cancel();
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (manual) editor.commitActive();
  if (saving) {
    saveQueued = true;
    return saving;
  }
  if (!manual && !store.dirty) return Promise.resolve(true);
  if (!manual && !p.clips.length) return Promise.resolve(true);
  const version = store.version;
  setSaveState('saving');
  saving = (async () => {
    try {
      const res = await api.post('/api/project/save', { project: p });
      saveFails = 0;
      if (store.project !== p) return true; // another project was opened meanwhile
      if (res.path) p.file = res.path;
      if (store.version === version) store.markSaved(res.savedAt);
      else {
        store.savedAt = res.savedAt || store.savedAt;
        saveQueued = true;
        setSaveState('dirty');
      }
      return true;
    } catch (err) {
      saveFails += 1;
      if (store.project === p) setSaveState('error', err.message);
      if (manual || saveFails === 1) toast(`저장하지 못했어요. ${err.message || ''}`.trim(), 'error', 5000);
      if (store.project === p) {
        const delay = Math.min(30000, 2000 * Math.pow(2, saveFails - 1));
        retryTimer = setTimeout(() => { retryTimer = null; if (store.dirty && store.project === p) saveNow(); }, delay);
      }
      return false;
    } finally {
      saving = null;
      if (saveQueued) {
        saveQueued = false;
        if (store.dirty && !retryTimer) scheduleSave();
      }
    }
  })();
  return saving;
}

/** Best-effort flush when the window goes away. Returns true if a request was sent with keepalive. */
function flushForUnload() {
  if (!store.project || !store.dirty || !store.project.clips.length) return true;
  scheduleSave.cancel();
  let size = Infinity;
  try {
    size = new TextEncoder().encode(JSON.stringify({ project: store.project })).length;
  } catch (_) { /* treat as large */ }
  if (size < KEEPALIVE_MAX) {
    api.post('/api/project/save', { project: store.project }, { keepalive: true }).catch(() => {});
    return true;
  }
  if (!saving) saveNow();
  return false;
}

function onBeforeUnload(e) {
  if (!store.project) return;
  try { editor.commitActive(); } catch (_) { /* ignore */ }
  if (!store.dirty || !store.project.clips.length) return;
  if (!flushForUnload()) {
    // Ask to stay: keeps the page alive long enough for the save request to finish.
    e.preventDefault();
    e.returnValue = '';
  }
}

// ---------------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------------

function bindToolbar() {
  const topbar = $('topbar');
  if (topbar) {
    // Keep keyboard focus in the editor when toolbar buttons are clicked.
    topbar.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('button')) e.preventDefault();
    });
    topbar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-cmd]');
      if (!b || b.disabled) return;
      const cmd = b.dataset.cmd;
      if (!has(cmd)) {
        toast('이 기능은 아직 준비 중이에요.', 'warn');
        return;
      }
      // Finish an in-progress caption/word edit first so the command sees (and re-renders) final text.
      const ae = document.activeElement;
      if (editor.root && ae && editor.root.contains(ae) && isTypingTarget(ae)) editor.focusChips();
      run(cmd);
    });
  }
  const ss = $('save-state');
  if (ss) ss.addEventListener('click', () => { if (ss.dataset.state === 'error') saveNow({ manual: true }); });
  onRegister(() => updateToolbarSoon());
}

function updateToolbarSoon() {
  if (toolbarRaf) return;
  toolbarRaf = requestAnimationFrame(() => {
    toolbarRaf = 0;
    updateToolbar();
  });
}

function updateToolbar() {
  const topbar = $('topbar');
  if (!topbar) return;
  const p = store.project;
  const hasClips = !!(p && p.clips.length);
  for (const b of topbar.querySelectorAll('[data-cmd]')) {
    const cmd = b.dataset.cmd;
    let disabled = !has(cmd);
    if (!disabled) {
      if (cmd === 'undo') disabled = !store.canUndo();
      else if (cmd === 'redo') disabled = !store.canRedo();
      else if (cmd === 'save') disabled = !p;
      else if (NEEDS_CLIPS.has(cmd)) disabled = !hasClips;
    }
    if (b.disabled !== disabled) b.disabled = disabled;
  }
}

// ---------------------------------------------------------------------------------------------
// Navigation helpers for core commands
// ---------------------------------------------------------------------------------------------

function seekTo(t) {
  try {
    if (player && typeof player.seek === 'function') player.seek(t);
    else store.setTime(t);
  } catch (_) {
    store.setTime(t);
  }
}

function seekToken(fi) {
  const ent = store.flat()[fi];
  if (ent) seekTo(ent.tok.start);
}

function seekClip(ci) {
  const span = store.clipSpan(ci);
  if (span) seekTo(span.keptStart !== null ? span.keptStart : span.start);
}

/** Clip the user is "on": selection focus, else the clip at the playhead. */
function currentClip() {
  const ui = store.ui;
  if (ui.clipSel) return ui.clipSel.f;
  if (ui.sel) {
    const ent = store.flat()[ui.sel.f];
    if (ent) return ent.ci;
  }
  return store.clipAt(ui.time);
}

function clipLastFlat(ci) {
  const clip = store.project.clips[ci];
  return store.clipFirstFlat(ci) + clip.words.length - 1;
}

function navToken(dir, { extend = false } = {}) {
  const L = store.flat();
  const n = L.length;
  if (!n) return;
  const ui = store.ui;
  const s = ui.sel;
  if (!s) {
    const f = Math.max(0, store.tokenAt(ui.time));
    store.select(f);
    editor.revealToken(f);
    return;
  }
  if (!extend && (s.a !== s.f || ui.clipSel)) {
    // Collapse a range to its edge in the direction of travel (like a text cursor).
    const r = store.selectedRange();
    const f = dir < 0 ? r.from : r.to;
    store.select(f);
    seekToken(f);
    editor.revealToken(f);
    return;
  }
  let f = s.f + dir;
  while (f >= 0 && f < n && editor.isClipHidden(L[f].ci)) f += dir;
  if (f < 0 || f >= n) return;
  if (extend) store.select(s.a, f);
  else {
    store.select(f);
    seekToken(f);
  }
  editor.revealToken(f);
}

function nextClipIndex(ci, dir) {
  const nc = store.project.clips.length;
  for (let i = ci + dir; i >= 0 && i < nc; i += dir) if (!editor.isClipHidden(i)) return i;
  return -1;
}

function navClip(dir, { extend = false } = {}) {
  if (!store.project || !store.project.clips.length) return;
  const ui = store.ui;
  if (ui.clipSel) {
    const t = nextClipIndex(ui.clipSel.f, dir);
    if (t < 0) return;
    if (extend) store.selectClips(ui.clipSel.a, t);
    else {
      store.selectClips(t);
      seekClip(t);
    }
    editor.scrollToClip(t, { mode: 'soft' });
    return;
  }
  const s = ui.sel;
  if (!s) {
    const ci = Math.max(0, store.clipAt(ui.time));
    const fi = store.clipFirstFlat(ci);
    store.select(fi);
    editor.scrollToClip(ci, { mode: 'soft' });
    return;
  }
  const ci = store.flat()[s.f].ci;
  const t = nextClipIndex(ci, dir);
  if (t < 0) {
    // Already on the first/last clip: go to its first/last token.
    const edge = dir < 0 ? store.clipFirstFlat(ci) : clipLastFlat(ci);
    if (extend) store.select(s.a, edge);
    else { store.select(edge); seekToken(edge); }
    editor.revealToken(edge);
    return;
  }
  if (extend) {
    const fi = dir > 0 ? clipLastFlat(t) : store.clipFirstFlat(t);
    store.select(s.a, fi);
    editor.revealToken(fi);
  } else {
    const fi = store.clipFirstFlat(t);
    store.select(fi);
    seekClip(t);
    editor.scrollToClip(t, { mode: 'soft' });
  }
}

function navLine(dir, { extend = false } = {}) {
  if (!store.project || !store.project.clips.length) return;
  const ci = Math.max(0, currentClip());
  const fi = dir < 0 ? store.clipFirstFlat(ci) : clipLastFlat(ci);
  const s = store.ui.sel;
  if (extend && s && !store.ui.clipSel) store.select(s.a, fi);
  else {
    store.select(fi);
    seekToken(fi);
  }
  editor.revealToken(fi);
}

function needSelection(msg) {
  if (store.selectedRange()) return true;
  hint(msg || '단어나 클립을 먼저 선택해 주세요.');
  return false;
}

function parseTimeInput(v) {
  const parts = v.split(':').map((x) => x.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((x) => x === '' || Number.isNaN(Number(x)))) return null;
  return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
}

// ---------------------------------------------------------------------------------------------
// Core commands
// ---------------------------------------------------------------------------------------------

function registerCoreCommands() {
  register('undo', () => {
    editor.commitActive();
    if (!store.undo()) hint('되돌릴 작업이 없어요.');
  }, { label: '되돌리기', keys: '⌘Z' });

  register('redo', () => {
    editor.commitActive();
    if (!store.redo()) hint('다시 실행할 작업이 없어요.');
  }, { label: '다시 실행', keys: '⌘⇧Z' });

  register('save', async () => {
    if (!store.project) return;
    const ok = await saveNow({ manual: true });
    if (ok) toast('저장했어요.', 'ok', 1400);
  }, { label: '저장', keys: '⌘S' });

  register('delete', () => {
    if (!store.ui.clipSel && !needSelection('삭제할 단어나 클립을 먼저 선택해 주세요.')) return;
    store.toggleDelete();
  }, { label: '삭제 / 복원', keys: '⌫' });

  register('split', () => {
    const r = store.selectedRange();
    if (!r) { hint('나눌 위치의 단어를 먼저 선택해 주세요.'); return; }
    const L = store.flat();
    let at = r.from;
    if (L[at].ti === 0) {
      // Selection starts a clip: split after the selection instead (selected words become their own clip).
      const after = L[r.to + 1];
      if (r.to > r.from && after && after.ci === L[r.from].ci) at = r.to + 1;
      else { hint('클립의 첫 단어 앞에서는 나눌 수 없어요.'); return; }
    }
    store.splitClip(at);
    editor.revealToken(at);
  }, { label: '클립 나누기', keys: 'Enter' });

  register('split-next', () => {
    const r = store.selectedRange();
    if (!r) { hint('옮길 단어를 먼저 선택해 주세요.'); return; }
    store.splitToNext(r.from);
    editor.revealToken(r.from);
  }, { label: '뒤쪽을 다음 클립으로', keys: '⇧Enter' });

  register('join-prev', () => {
    const r = store.selectedRange();
    if (!r) { hint('앞 클립으로 올릴 단어를 먼저 선택해 주세요.'); return; }
    const ok = r.to > r.from ? store.joinToPrev(r.to, true) : store.joinToPrev(r.from);
    if (!ok) { hint('첫 클립은 앞으로 올릴 수 없어요.'); return; }
    editor.revealToken(r.to);
  }, { label: '여기까지 앞 클립으로', keys: '⇧Backspace' });

  register('merge-next', () => {
    if (!store.project || !store.project.clips.length) return;
    const nc = store.project.clips.length;
    const cr = store.selectedClipRange();
    const from = cr ? cr.from : store.clipAt(store.ui.time);
    const to = cr ? cr.to : from;
    if (from < 0) return;
    if (to > from) store.mergeClips(from, to);
    else if (from >= nc - 1) hint('마지막 클립이라 합칠 다음 클립이 없어요.');
    else store.mergeWithNext(from);
  }, { label: '클립 합치기', keys: '⌘E' });

  register('merge-prev', () => {
    if (!store.project || !store.project.clips.length) return;
    const cr = store.selectedClipRange();
    const ci = cr ? cr.from : store.clipAt(store.ui.time);
    if (ci <= 0) { hint('첫 클립이라 합칠 이전 클립이 없어요.'); return; }
    store.mergeWithPrev(ci);
  }, { label: '이전 클립과 합치기', keys: '⌘⇧E' });

  register('select-all', () => {
    const n = store.flat().length;
    if (n) store.select(0, n - 1);
  }, { label: '전체 선택', keys: '⌘A' });

  register('clear-selection', () => store.clearSelection(), { label: '선택 해제', keys: 'Esc' });

  register('nav-prev-token', (o) => navToken(-1, o), { label: '이전 단어', keys: '← / ⌥←' });
  register('nav-next-token', (o) => navToken(1, o), { label: '다음 단어', keys: '→ / ⌥→' });
  register('nav-prev-clip', (o) => navClip(-1, o), { label: '이전 클립', keys: '↑ / ⌘↑' });
  register('nav-next-clip', (o) => navClip(1, o), { label: '다음 클립', keys: '↓ / ⌘↓' });
  register('nav-line-start', (o) => navLine(-1, o), { label: '클립 처음으로', keys: '⌘←' });
  register('nav-line-end', (o) => navLine(1, o), { label: '클립 끝으로', keys: '⌘→' });

  register('edit-word', () => {
    const s = store.ui.sel;
    if (!s) { hint('고칠 단어를 먼저 선택해 주세요.'); return; }
    const L = store.flat();
    let f = s.f;
    if (L[f].tok.type !== 'word') {
      // Nearest word in the same clip.
      const ci = L[f].ci;
      let best = -1;
      for (let d = 1; d < 50 && best < 0; d++) {
        for (const i of [f + d, f - d]) if (L[i] && L[i].ci === ci && L[i].tok.type === 'word') { best = i; break; }
      }
      if (best < 0) { hint('무음이나 (음성) 구간은 글자를 고칠 수 없어요.'); return; }
      f = best;
    }
    editor.editWord(f);
  }, { label: '단어 고치기', keys: 'F2' });

  register('edit-caption', () => {
    const ci = currentClip();
    if (ci >= 0) editor.focusCaption(ci);
  }, { label: '자막 고치기', keys: '⌥↓' });

  register('back', () => editor.focusChips(currentClip()), { label: '대본으로 돌아가기', keys: '⌥↑ / Esc' });

  register('clear-caption', () => {
    if (!store.project || !store.project.clips.length) return;
    const cr = store.selectedClipRange();
    const from = cr ? cr.from : store.clipAt(store.ui.time);
    const to = cr ? cr.to : from;
    if (from < 0) return;
    const clips = store.project.clips;
    let allEmpty = true;
    for (let ci = from; ci <= to; ci++) if (clips[ci].caption !== '') { allEmpty = false; break; }
    store.batch(() => {
      for (let ci = from; ci <= to; ci++) store.setCaption(ci, allEmpty ? null : '');
    });
    hint(allEmpty ? '자막을 자동으로 되돌렸어요.' : '이 클립은 자막 없이 내보내요. ⌥⌫를 한 번 더 누르면 되돌려요.');
  }, { label: '자막 지우기', keys: '⌥⌫' });

  register('jump-clip', async () => {
    if (!store.project || !store.project.clips.length) return;
    const nc = store.project.clips.length;
    const v = await promptDialog({
      title: '이동하기',
      message: `클립 번호(1–${nc})나 결과 영상 시간(예: 3:25)을 입력해 주세요.`,
      value: '',
      placeholder: '예: 42 또는 3:25',
      ok: '이동',
    });
    if (v === null) return;
    const text = String(v).trim();
    let ci = -1;
    if (text.includes(':')) {
      const o = parseTimeInput(text);
      if (o === null) { toast('시간은 3:25처럼 입력해 주세요.', 'warn'); return; }
      ci = store.clipAt(store.outToSrc(o));
    } else {
      const k = parseInt(text, 10);
      if (!Number.isFinite(k) || k < 1 || k > nc) { toast(`1부터 ${nc} 사이의 번호를 입력해 주세요.`, 'warn'); return; }
      ci = k - 1;
    }
    if (ci < 0) return;
    store.select(store.clipFirstFlat(ci));
    editor.scrollToClip(ci);
    seekClip(ci);
    editor.focusChips(ci);
  }, { label: '클립으로 이동', keys: '⌘J' });

  const T = () => store.ui.time;
  register('split-here', () => {
    if (!store.project || !store.project.clips.length) return;
    const fi = store.splitTokenAt(T());
    if (fi >= 0) { store.select(fi); editor.revealToken(fi); hint('재생 위치에서 잘랐어요'); }
  }, { label: '재생 위치에서 자르기', keys: 'C' });
  register('cut-head', () => {
    if (!store.project || !store.project.clips.length) return;
    const n = store.cutClipEdge(T(), 'head');
    hint(n ? '클립 앞부분을 재생 위치까지 잘라냈어요' : '잘라낼 부분이 없어요');
  }, { label: '클립 처음~재생 위치 잘라내기', keys: 'Q' });
  register('cut-tail', () => {
    if (!store.project || !store.project.clips.length) return;
    const n = store.cutClipEdge(T(), 'tail');
    hint(n ? '재생 위치부터 클립 끝까지 잘라냈어요' : '잘라낼 부분이 없어요');
  }, { label: '재생 위치~클립 끝 잘라내기', keys: 'W' });
  let markIn = null, markOut = null;
  register('mark-in', () => { markIn = T(); hint(`시작점 ${fmtTime(markIn, { ms: true })} — 끝점에서 O, 자르기는 X`); }, { label: '구간 시작점', keys: 'I' });
  register('mark-out', () => { markOut = T(); hint(`끝점 ${fmtTime(markOut, { ms: true })} — X를 누르면 잘라요`); }, { label: '구간 끝점', keys: 'O' });
  register('cut-marked', () => {
    if (markIn === null || markOut === null) { hint('I로 시작점, O로 끝점을 먼저 찍어 주세요'); return; }
    const n = store.cutRange(markIn, markOut);
    hint(n ? '표시한 구간을 잘라냈어요' : '잘라낼 부분이 없어요');
    markIn = markOut = null;
  }, { label: '표시한 구간 잘라내기', keys: 'X' });
  register('add-caption', () => {
    if (!store.project || !store.project.clips.length) return;
    const r = store.selectedRange();
    const fi = r ? r.from : store.tokenAt(T());
    const ent = store.flat()[fi];
    if (!ent) return;
    if (ent.tok.type === 'word') { editor.focusCaption(ent.ci); return; }
    const ci = store.isolateAsCaptionClip(fi);
    if (ci >= 0) { editor.scrollToClip(ci); editor.focusCaption(ci); }
  }, { label: '여기에 자막 넣기', keys: 'T' });
  const step = (d) => { const dur = store.project ? store.project.source.duration : 0; seekTo(Math.max(0, Math.min(dur, T() + d))); };
  register('seek-back', (big) => step(big ? -2 : -0.5), { label: '0.5초 뒤로', keys: 'J' });
  register('seek-fwd', (big) => step(big ? 2 : 0.5), { label: '0.5초 앞으로', keys: 'L' });
  register('frame-back', () => { const s = store.project && store.project.source; step(-(s && s.fpsDen ? s.fpsDen / s.fpsNum : 1 / 30)); }, { label: '1프레임 뒤로', keys: ',' });
  register('frame-fwd', () => { const s = store.project && store.project.source; step(s && s.fpsDen ? s.fpsDen / s.fpsNum : 1 / 30); }, { label: '1프레임 앞으로', keys: '.' });
  register('stop', () => { try { player.pause(); } catch (_) { /* ignore */ } }, { label: '정지', keys: 'K' });

  register('nudge', (edge, delta) => {
    if (!needSelection('경계를 옮길 단어를 먼저 선택해 주세요.')) return;
    store.nudge(edge, delta);
  }, { label: '단어 경계 미세 조정 (±0.05초)', keys: '⌥A / ⌥S / ⌥D / ⌥F' });
}

// ---------------------------------------------------------------------------------------------
// Splitter between #left and #right
// ---------------------------------------------------------------------------------------------

function initSplitter() {
  const ws = $('workspace');
  const sp = $('splitter');
  if (!ws || !sp) return;
  sp.setAttribute('role', 'separator');
  sp.setAttribute('aria-orientation', 'vertical');
  sp.title = '드래그해서 크기 조절 · 더블클릭하면 원래대로';
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem(SPLIT_KEY)); } catch (_) { /* storage unavailable */ }
  if (saved > 0.15 && saved < 0.85) ws.style.setProperty('--left-w', `${(saved * 100).toFixed(3)}%`);

  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = ws.getBoundingClientRect();
    const spw = sp.offsetWidth || 6;
    let frac = null;
    try { sp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    document.body.classList.add('col-resizing');
    const move = (ev) => {
      const maxLeft = Math.max(420, rect.width - 420 - spw);
      const px = clamp(ev.clientX - rect.left - spw / 2, 420, maxLeft);
      frac = px / rect.width;
      ws.style.setProperty('--left-w', `${(frac * 100).toFixed(3)}%`);
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
      try { sp.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      document.body.classList.remove('col-resizing');
      if (frac !== null) {
        try { localStorage.setItem(SPLIT_KEY, String(frac)); } catch (_) { /* storage unavailable */ }
      }
      window.dispatchEvent(new Event('resize'));
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  });

  sp.addEventListener('dblclick', () => {
    ws.style.removeProperty('--left-w');
    try { localStorage.removeItem(SPLIT_KEY); } catch (_) { /* storage unavailable */ }
    window.dispatchEvent(new Event('resize'));
  });
}

// ---------------------------------------------------------------------------------------------
// Store wiring
// ---------------------------------------------------------------------------------------------

function bindStore() {
  store.on('load', (p) => {
    scheduleSave.cancel();
    saveFails = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const app = $('app');
    if (app) app.classList.toggle('no-project', !p);
    const title = $('project-title');
    if (title) {
      title.textContent = p ? p.name || '' : '';
      title.title = p && p.source ? p.source.path || '' : '';
    }
    document.title = p && p.name ? `${p.name} — Lazy - Cut` : 'Lazy - Cut';
    setSaveState(p && store.savedAt ? 'saved' : 'idle');
    updateToolbar();
    if (p) {
      requestAnimationFrame(() => {
        const ae = document.activeElement;
        if (!ae || ae === document.body) editor.focusChips();
      });
    }
  });
  store.on('dirty', () => {
    if (!saving) setSaveState('dirty');
    scheduleSave();
    updateToolbarSoon();
  });
  store.on('saved', () => {
    setSaveState('saved');
    updateToolbarSoon();
  });
  store.on('change', updateToolbarSoon);
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

function showFatal(err) {
  const app = $('app') || document.body;
  const old = document.querySelector('.lc-fatal');
  if (old) old.remove();
  const box = el('div', { class: 'lc-fatal', role: 'alert' },
    el('div', { class: 'lc-fatal-card' },
      el('div', { class: 'lc-fatal-title' }, 'Lazy - Cut을 시작하지 못했어요'),
      el('p', { class: 'lc-fatal-msg' }, (err && err.message) || '알 수 없는 문제가 생겼어요.'),
      el('p', { class: 'lc-fatal-sub' }, 'Lazy - Cut 앱을 다시 열어 주세요. 계속 안 되면 컴퓨터를 재시동한 뒤 다시 해 보세요.'),
      el('div', { class: 'lc-modal-actions' },
        el('button', { class: 'lc-btn primary', type: 'button', onclick: () => location.reload() }, '다시 시도'))));
  app.appendChild(box);
}

const INIT_LABELS = { editor: '대본 편집기', shortcuts: '단축키', player: '미리보기', timeline: '타임라인', panels: '패널' };

/** Run one module's init; a failure (sync or async) is reported but never stops the others. */
function safeInit(name, fn) {
  const fail = (err) => {
    log(`[main] ${name} init failed`, err);
    toast(`${INIT_LABELS[name] || name} 화면을 불러오지 못했어요. 앱을 다시 열어 주세요.`, 'error', 6000);
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') out.then(null, fail); // don't block boot on async inits
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

async function boot() {
  api.init();
  setErrorHandler((err, name) => {
    log(`[command ${name}]`, err);
    toast((err && err.message) || '문제가 생겼어요. 다시 해 주세요.', 'error', 4000);
  });
  window.addEventListener('unhandledrejection', (e) => log('[unhandled]', e.reason));

  initSplitter();
  bindToolbar();
  registerCoreCommands();
  bindStore();

  let bootstrap = null;
  for (let attempt = 0; attempt < 3 && !bootstrap; attempt++) {
    try {
      bootstrap = await api.get('/api/bootstrap');
    } catch (err) {
      if (err.status === 401 || err.status === 403 || attempt === 2) {
        showFatal(err);
        return;
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }

  window.addEventListener('beforeunload', onBeforeUnload);
  safeInit('editor', () => initEditor($('editor')));
  safeInit('shortcuts', () => initShortcuts());
  safeInit('player', () => initPlayer());
  safeInit('timeline', () => initTimeline());
  safeInit('panels', () => initPanels(bootstrap));
  updateToolbar();

  window.addEventListener('pagehide', () => { try { editor.commitActive(); } catch (_) { /* ignore */ } flushForUnload(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && store.dirty) saveNow();
  });

  // Handy for debugging from the devtools console.
  window.lazycut = { store, api, editor, commands: { run, has } };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
