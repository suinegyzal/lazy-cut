// store.js — single source of truth for the open project (SPEC §5.2). DOM-free.
//
// Data model and derived values follow SPEC §2.2 exactly (kept ranges, output timeline, captions);
// tests/js/store_test.js checks them against the shared parity vectors.
//
// Performance notes (1,500 clips / 12,000 tokens):
//  - flat() / id maps, kept ranges (+ prefix sums) and stats are cached and invalidated on change.
//  - Undo snapshots are per-clip JSON strings. Each clip's string is cached (WeakMap) until an op
//    touches that clip, so a snapshot costs O(#clips) pointer copies plus the clips that changed,
//    and unchanged strings are shared between undo steps (memory ≈ one copy + deltas, not 100 copies).
//    Every mutation therefore goes through touch(clip).
//
// Additions beyond the SPEC list (documented, harmless for other modules):
//  - store.version: increments on every mutation (lets the autosaver detect edits made mid-save).
//  - batch(fn): run several ops as ONE undo step / one 'change' event.
//  - mergeClips(ciFrom, ciTo): merge a clip range (⌘E on a multi-clip selection).
//  - setKeep(from, to, keep): set/clear `keep` on gap/noise tokens (context menu "무음 0초로/원래대로").
//  - isClipDeleted(ci), clipFirstFlat(ci).
//
// Assumptions (SPEC leaves these open):
//  - keptRanges: pieces are merged first, then ranges shorter than 0.001 s are dropped.
//  - isKept/nextKept treat kept ranges as half-open [s, e) so playback skips at a range end.
//  - stats().flags counts suggestions still in the output (not deleted): token flags on kept tokens,
//    ng = NG clips not fully deleted, noise = noise tokens not deleted.
//  - shortenSilences returns count = matching tokens (same rule as the panel preview) and
//    savedSec = output duration before − after (ms-rounded; may be negative if keep grew).
//  - replaceAll never empties a word: a replacement that would leave a word blank is skipped.
//  - setCaption(ci, text) with text equal to the auto caption stores null (keeps following words).
//  - splitToNext at a clip's first token merges the clip into the next one; on the last clip it splits.
//  - Undo also restores the selection that was active before the op.

import { uid } from './util.js';

const MAX_UNDO = 100;
const MERGE_EPS = 1e-6;
const MIN_RANGE = 0.001;
const MIN_TOKEN = 0.02;
const DEFAULT_SETTINGS = { maxChars: 22, silenceMin: 0.2, silenceKeep: 0.0, includeNoise: false };

const r3 = (x) => Math.round(x * 1000) / 1000;
const ceil3 = (x) => Math.ceil(x * 1000 - 1e-6) / 1000;
const floor3 = (x) => Math.floor(x * 1000 + 1e-6) / 1000;
const isSilence = (tok) => tok.type === 'gap' || tok.type === 'noise';

function logError(...args) {
  if (typeof console !== 'undefined' && console.error) console.error(...args);
}

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

const listeners = new Map(); // evt -> Set<fn>

let FLAT = null;   // { list:[{ci,ti,tok,clip}], tokIdx:Map, clipIdx:Map, clipFirst:number[] }
let KEPT = null;   // { ranges:[[s,e]], s:Float64Array, e:Float64Array, cum:Float64Array, total }
let STATS = null;
let jsonCache = new WeakMap(); // clip object -> JSON string (valid until the clip is touched)

let undoStack = [];
let redoStack = [];
let batchDepth = 0;
let pending = null; // open batch: { snap, ids:Set, all, structural, changed }

function clipsArr() {
  return store.project ? store.project.clips : [];
}

function invalidate(structural) {
  KEPT = null;
  STATS = null;
  if (structural) FLAT = null;
}

function buildFlat() {
  const clips = clipsArr();
  const list = [];
  const tokIdx = new Map();
  const clipIdx = new Map();
  const clipFirst = new Array(clips.length);
  for (let ci = 0; ci < clips.length; ci++) {
    const clip = clips[ci];
    clipIdx.set(clip.id, ci);
    clipFirst[ci] = list.length;
    const words = clip.words;
    for (let ti = 0; ti < words.length; ti++) {
      const tok = words[ti];
      tokIdx.set(tok.id, list.length);
      list.push({ ci, ti, tok, clip });
    }
  }
  FLAT = { list, tokIdx, clipIdx, clipFirst };
  return FLAT;
}

function F() {
  return FLAT || buildFlat();
}

/** Kept ranges per SPEC §2.2.3 (+ prefix sums for the output timeline). */
function computeKeptRanges(clips) {
  const out = [];
  const add = (s, e) => {
    const last = out.length ? out[out.length - 1] : null;
    if (last && s <= last[1] + MERGE_EPS) {
      if (e > last[1]) last[1] = e;
    } else out.push([s, e]);
  };
  for (const clip of clips) {
    for (const tok of clip.words) {
      if (tok.del) continue;
      const dur = tok.end - tok.start;
      if (isSilence(tok) && tok.keep !== null && tok.keep !== undefined && tok.keep < dur) {
        const k = Math.max(0, tok.keep) / 2;
        if (k > 0) {
          add(tok.start, tok.start + k);
          add(tok.end - k, tok.end);
        }
      } else add(tok.start, tok.end);
    }
  }
  return out.filter((r) => r[1] - r[0] >= MIN_RANGE);
}

function K() {
  if (KEPT) return KEPT;
  const ranges = computeKeptRanges(clipsArr());
  const n = ranges.length;
  const s = new Float64Array(n);
  const e = new Float64Array(n);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s[i] = ranges[i][0];
    e[i] = ranges[i][1];
    cum[i + 1] = cum[i] + (e[i] - s[i]);
  }
  KEPT = { ranges, s, e, cum, total: cum[n] };
  return KEPT;
}

/** Index of the last element with arr[i] <= x (−1 if none). arr is sorted ascending. */
function lastLE(arr, x, n = arr.length) {
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function autoCaptionOf(words) {
  // tokens made by splitting one word (joinPrev) are written without a space
  let out = '';
  for (const t of words) {
    if (t.type !== 'word' || t.del || !t.text) continue;
    out += (out && !t.joinPrev ? ' ' : '') + t.text;
  }
  return out.trim();
}

function captionOfClip(clip) {
  return clip.caption !== null && clip.caption !== undefined ? clip.caption : autoCaptionOf(clip.words);
}

function clipFullyDeleted(clip) {
  for (const t of clip.words) if (!t.del) return false;
  return true;
}

function normalizeCaption(text) {
  if (text === null || text === undefined) return null;
  return String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').trim();
}

function newClipId() {
  const ids = F().clipIdx;
  let id;
  do { id = uid('c_'); } while (ids.has(id));
  return id;
}

/** Fill defaults so the rest of the code can rely on every field; drops clips without tokens. */
function normalizeClips(clips) {
  const out = [];
  for (const c of Array.isArray(clips) ? clips : []) {
    if (!c || !Array.isArray(c.words) || !c.words.length) continue;
    if (c.caption === undefined) c.caption = null;
    if (!Array.isArray(c.flags)) c.flags = [];
    if (c.ngOf === undefined) c.ngOf = null;
    for (const t of c.words) {
      if (!t.type) t.type = 'word';
      if (typeof t.text !== 'string') t.text = t.text == null ? '' : String(t.text);
      if (t.orig === undefined) t.orig = t.type === 'word' ? t.text : '';
      t.del = !!t.del;
      if (t.keep === undefined) t.keep = null;
      if (!Array.isArray(t.flags)) t.flags = [];
      if (t.p === undefined) t.p = null;
    }
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Undo snapshots & op machinery
// ---------------------------------------------------------------------------------------------

function clipJson(clip) {
  let s = jsonCache.get(clip);
  if (s === undefined) {
    s = JSON.stringify(clip);
    jsonCache.set(clip, s);
  }
  return s;
}

function snapshot() {
  const clips = clipsArr();
  const arr = new Array(clips.length);
  for (let i = 0; i < clips.length; i++) arr[i] = clipJson(clips[i]);
  const ui = store.ui;
  return {
    clips: arr,
    settings: JSON.stringify(store.project ? store.project.settings || {} : {}),
    sel: ui.sel ? { a: ui.sel.a, f: ui.sel.f } : null,
    clipSel: ui.clipSel ? { a: ui.clipSel.a, f: ui.clipSel.f } : null,
  };
}

/** Replace the current clips with a snapshot; reuses unchanged clip objects. */
function applySnapshot(target, current) {
  const p = store.project;
  const byStr = new Map();
  const oldClips = p.clips;
  for (let i = 0; i < oldClips.length; i++) byStr.set(current.clips[i], oldClips[i]);
  const oldIds = oldClips.map((c) => c.id);
  const changed = new Set();
  const next = new Array(target.clips.length);
  for (let i = 0; i < target.clips.length; i++) {
    const s = target.clips[i];
    let c = byStr.get(s);
    if (c) byStr.delete(s);
    else {
      c = JSON.parse(s);
      jsonCache.set(c, s);
      changed.add(c.id);
    }
    next[i] = c;
  }
  const newIds = new Set(next.map((c) => c.id));
  for (const id of oldIds) if (!newIds.has(id)) changed.add(id);
  let structural = oldIds.length !== next.length;
  if (!structural) for (let i = 0; i < next.length; i++) if (next[i].id !== oldIds[i]) { structural = true; break; }
  if (!structural && changed.size) {
    // Same clip sequence, but tokens may have moved between clips (e.g. undoing Shift+Enter).
    const oldById = new Map(oldClips.map((c) => [c.id, c]));
    for (const c of next) {
      if (!changed.has(c.id)) continue;
      const o = oldById.get(c.id);
      if (!o || o.words.length !== c.words.length || o.words[0].id !== c.words[0].id) { structural = true; break; }
    }
  }
  p.clips = next;
  let settingsChanged = false;
  if (target.settings !== current.settings) {
    try { p.settings = JSON.parse(target.settings); settingsChanged = true; } catch (_) { /* keep */ }
  }
  invalidate(true);
  store.ui.sel = target.sel;
  store.ui.clipSel = target.clipSel;
  fixSelection();
  markDirty();
  emit('change', { clipIds: changed, structural });
  if (settingsChanged) emit('settings', p.settings);
  emit('selection', { sel: store.ui.sel, clipSel: store.ui.clipSel });
}

function begin() {
  if (batchDepth++ === 0) {
    pending = { snap: snapshot(), ids: new Set(), all: false, structural: false, changed: false };
  }
}

function end() {
  if (--batchDepth > 0) return;
  const p = pending;
  pending = null;
  if (!p || !p.changed) return;
  undoStack.push(p.snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  invalidate(p.structural);
  let selChanged = false;
  if (p.structural) selChanged = fixSelection(true);
  markDirty();
  emit('change', { clipIds: p.all ? null : p.ids, structural: p.structural });
  if (selChanged) emit('selection', { sel: store.ui.sel, clipSel: store.ui.clipSel });
}

/** Run fn as one undoable step. fn mutates through touch()/touchAll()/structuralChange(). */
function op(fn) {
  if (!store.project) return undefined;
  begin();
  try {
    return fn();
  } finally {
    end();
  }
}

function touch(clip) {
  if (!clip) return;
  jsonCache.delete(clip);
  if (pending) {
    pending.ids.add(clip.id);
    pending.changed = true;
  }
  invalidate(false);
}

function touchAll() {
  if (pending) {
    pending.all = true;
    pending.changed = true;
  }
  invalidate(true);
}

function structuralChange(removedIds) {
  if (pending) {
    pending.structural = true;
    pending.changed = true;
    if (removedIds) for (const id of removedIds) pending.ids.add(id);
  }
  invalidate(true);
}

function markDirty() {
  store.dirty = true;
  store.version += 1;
  emit('dirty', true);
}

/** Clamp selection after structural edits. With `dropClipSel`, clip selection is cleared. Returns true if changed. */
function fixSelection(dropClipSel = false) {
  const ui = store.ui;
  const n = F().list.length;
  const nc = clipsArr().length;
  let changed = false;
  if (ui.sel) {
    if (!n) { ui.sel = null; changed = true; } else {
      const a = Math.min(Math.max(0, ui.sel.a), n - 1);
      const f = Math.min(Math.max(0, ui.sel.f), n - 1);
      if (a !== ui.sel.a || f !== ui.sel.f) { ui.sel = { a, f }; changed = true; }
    }
  }
  if (ui.clipSel) {
    if (dropClipSel || !nc || ui.clipSel.a >= nc || ui.clipSel.f >= nc) { ui.clipSel = null; changed = true; }
  }
  return changed;
}

function emit(evt, payload) {
  const set = listeners.get(evt);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try { fn(payload); } catch (e) { logError(`[store] '${evt}' listener failed`, e); }
  }
}

// Pairwise merge of clips[ci] and clips[ci+1] (inside an open op).
/** Split the token containing time t (inside an op). Returns the flat index of the token starting at t. */
function splitAtInternal(t) {
  const L = F().list;
  if (!L.length) return -1;
  const fi = store.tokenAt(t);
  if (fi < 0) return -1;
  const ent = L[fi];
  const tok = ent.tok;
  if (t - tok.start < 0.02) return fi;
  if (tok.end - t < 0.02) return fi + 1 < L.length ? fi + 1 : -1;
  const right = { ...tok, id: uid('w_'), start: Math.round(t * 1000) / 1000, flags: [...(tok.flags || [])], joinPrev: true };
  tok.end = right.start;
  if (tok.type === 'word') {
    const chars = Array.from(tok.text || '');
    const ratio = (right.start - tok.start) / (right.end - tok.start);
    let k = Math.round(chars.length * ratio);
    if (chars.length >= 2) k = Math.min(chars.length - 1, Math.max(1, k));
    tok.text = chars.slice(0, k).join('');
    right.text = chars.slice(k).join('');
    const oc = Array.from(tok.orig || '');
    const ko = Math.min(oc.length, k);
    tok.orig = oc.slice(0, ko).join('');
    right.orig = oc.slice(ko).join('');
  }
  if (right.keep !== null && right.keep !== undefined) { tok.keep = null; right.keep = null; }
  ent.clip.words.splice(ent.ti + 1, 0, right);
  touch(ent.clip);
  structuralChange();
  return fi + 1;
}

/** Mark everything between t0 and t1 deleted, splitting tokens at both ends (inside an op). */
function cutRangeInternal(t0, t1) {
  if (!(t1 - t0 > 0.02)) return 0;
  splitAtInternal(t0);
  splitAtInternal(t1);
  let n = 0;
  for (const ent of F().list) {
    const tk = ent.tok;
    if (tk.start >= t0 - 0.001 && tk.end <= t1 + 0.001 && !tk.del) { tk.del = true; touch(ent.clip); n++; }
  }
  return n;
}

function mergePair(ci) {
  const clips = clipsArr();
  const a = clips[ci], b = clips[ci + 1];
  if (!a || !b) return false;
  let cap = null;
  if ((a.caption !== null && a.caption !== undefined) || (b.caption !== null && b.caption !== undefined)) {
    cap = (captionOfClip(a) + ' ' + captionOfClip(b)).trim();
  }
  a.words = a.words.concat(b.words);
  a.caption = cap;
  const flags = a.flags.slice();
  for (const f of b.flags || []) if (!flags.includes(f)) flags.push(f);
  a.flags = flags;
  if ((a.ngOf === null || a.ngOf === undefined) && b.ngOf) a.ngOf = b.ngOf;
  if (a.ngOf === a.id || a.ngOf === b.id) {
    a.ngOf = null;
    a.flags = a.flags.filter((f) => f !== 'ng');
  }
  clips.splice(ci + 1, 1);
  for (const c of clips) {
    if (c.ngOf === b.id) {
      c.ngOf = c === a ? null : a.id;
      touch(c);
    }
  }
  touch(a);
  structuralChange([b.id]);
  return true;
}

function flatRange(from, to) {
  const n = F().list.length;
  if (!n) return null;
  let lo = Math.min(from, to), hi = Math.max(from, to);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  lo = Math.max(0, Math.floor(lo));
  hi = Math.min(n - 1, Math.floor(hi));
  return lo <= hi ? [lo, hi] : null;
}

function clipRange(from, to) {
  const nc = clipsArr().length;
  if (!nc) return null;
  let lo = Math.min(from, to), hi = Math.max(from, to);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  lo = Math.max(0, Math.floor(lo));
  hi = Math.min(nc - 1, Math.floor(hi));
  return lo <= hi ? [lo, hi] : null;
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

export const store = {
  project: null,
  dirty: false,
  savedAt: null,
  version: 0,
  ui: { sel: null, clipSel: null, time: 0, playing: false, follow: true, hideDeleted: false, editing: null },

  // ---- events --------------------------------------------------------------------------------
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => store.off(evt, fn);
  },
  off(evt, fn) {
    const set = listeners.get(evt);
    if (set) set.delete(fn);
  },
  emit(evt, payload) {
    emit(evt, payload);
  },

  // ---- lifecycle -----------------------------------------------------------------------------
  load(project) {
    if (project) {
      project.settings = Object.assign({}, DEFAULT_SETTINGS, project.settings || {});
      project.clips = normalizeClips(project.clips);
      if (!Array.isArray(project.markers)) project.markers = [];
    }
    store.project = project || null;
    store.dirty = false;
    store.savedAt = project ? project.updatedAt || null : null;
    undoStack = [];
    redoStack = [];
    batchDepth = 0;
    pending = null;
    jsonCache = new WeakMap();
    store.ui.sel = null;
    store.ui.clipSel = null;
    store.ui.editing = null;
    invalidate(true);
    emit('load', store.project);
  },

  setTime(t) {
    const v = Number(t);
    store.ui.time = Number.isFinite(v) ? v : 0;
    emit('time', store.ui.time);
  },

  setPlaying(playing) {
    const v = !!playing;
    if (store.ui.playing === v) return;
    store.ui.playing = v;
    emit('play', v);
  },

  // ---- queries -------------------------------------------------------------------------------
  flat() {
    return F().list;
  },
  flatIndexOf(tokenId) {
    const i = F().tokIdx.get(tokenId);
    return i === undefined ? -1 : i;
  },
  clipIndexOf(clipId) {
    const i = F().clipIdx.get(clipId);
    return i === undefined ? -1 : i;
  },
  /** Flat index of the first token of clip ci (−1 if out of range). */
  clipFirstFlat(ci) {
    const cf = F().clipFirst;
    return ci >= 0 && ci < cf.length ? cf[ci] : -1;
  },
  tokenAt(t) {
    const list = F().list;
    const n = list.length;
    if (!n) return -1;
    let lo = 0, hi = n - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].tok.start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  },
  clipAt(t) {
    const i = store.tokenAt(t);
    return i < 0 ? -1 : F().list[i].ci;
  },

  keptRanges() {
    return K().ranges;
  },
  outDuration() {
    return K().total;
  },
  srcToOut(t) {
    const k = K();
    const n = k.s.length;
    if (!n) return 0;
    const i = lastLE(k.s, t);
    if (i >= 0 && t <= k.e[i]) return k.cum[i] + (t - k.s[i]);
    return i + 1 < n ? k.cum[i + 1] : k.total;
  },
  outToSrc(o) {
    const k = K();
    const n = k.s.length;
    if (!n) return 0;
    if (!(o > 0)) return k.s[0];
    if (o >= k.total) return k.e[n - 1];
    const i = Math.max(0, lastLE(k.cum, o, n)); // ties → later range start
    return Math.min(k.e[i], k.s[i] + (o - k.cum[i]));
  },
  isKept(t) {
    const k = K();
    const i = lastLE(k.s, t);
    return i >= 0 && t < k.e[i];
  },
  nextKept(t) {
    const k = K();
    const n = k.s.length;
    const i = lastLE(k.s, t);
    if (i >= 0 && t < k.e[i]) return t;
    return i + 1 < n ? k.s[i + 1] : null;
  },

  autoCaption(clip) {
    return clip ? autoCaptionOf(clip.words) : '';
  },
  captionOf(clip) {
    return clip ? captionOfClip(clip) : '';
  },
  isClipDeleted(ci) {
    const c = clipsArr()[ci];
    return !!c && clipFullyDeleted(c);
  },
  /** {start, end, keptStart, keptEnd} in source seconds; kept* are null when nothing of the clip is kept. */
  clipSpan(ci) {
    const clip = clipsArr()[ci];
    if (!clip || !clip.words.length) return null;
    const start = clip.words[0].start;
    const end = clip.words[clip.words.length - 1].end;
    const k = K();
    let keptStart = null, keptEnd = null;
    const ks = store.nextKept(start);
    if (ks !== null && ks < end) {
      keptStart = ks;
      // last range starting before `end`
      const j = lastLE(k.s, end - 1e-9);
      if (j >= 0 && k.e[j] > start) keptEnd = Math.min(k.e[j], end);
    }
    return { start, end, keptStart, keptEnd };
  },
  stats() {
    if (STATS) return STATS;
    const clips = clipsArr();
    const flags = { filler: 0, fillerWeak: 0, repeat: 0, ng: 0, noise: 0, lowconf: 0 };
    let deletedClips = 0, words = 0, deletedWords = 0;
    for (const clip of clips) {
      let allDel = true;
      for (const t of clip.words) {
        if (!t.del) allDel = false;
        if (t.type === 'word') { words++; if (t.del) deletedWords++; }
        if (t.del) continue;
        if (t.type === 'noise') flags.noise++;
        const fl = t.flags;
        if (fl && fl.length) {
          if (fl.includes('filler')) flags.filler++;
          if (fl.includes('filler?')) flags.fillerWeak++;
          if (fl.includes('repeat')) flags.repeat++;
          if (fl.includes('lowconf')) flags.lowconf++;
        }
      }
      if (allDel) deletedClips++;
      else if (clip.flags && clip.flags.includes('ng')) flags.ng++;
    }
    const p = store.project;
    const last = clips.length ? clips[clips.length - 1].words : null;
    const srcDur = p && p.source && p.source.duration ? p.source.duration : (last ? last[last.length - 1].end : 0);
    STATS = { srcDur, outDur: K().total, clips: clips.length, deletedClips, words, deletedWords, flags };
    return STATS;
  },

  // ---- selection -----------------------------------------------------------------------------
  select(a, f = a) {
    const n = F().list.length;
    if (!n || !Number.isFinite(a) || !Number.isFinite(f)) { store.clearSelection(); return; }
    const aa = Math.min(Math.max(0, Math.floor(a)), n - 1);
    const ff = Math.min(Math.max(0, Math.floor(f)), n - 1);
    const ui = store.ui;
    if (ui.sel && ui.sel.a === aa && ui.sel.f === ff && !ui.clipSel) return;
    ui.sel = { a: aa, f: ff };
    ui.clipSel = null;
    emit('selection', { sel: ui.sel, clipSel: null });
  },
  /** Select whole clips (clip numbers). Also sets `sel` to the covered token range. */
  selectClips(a, f = a) {
    const nc = clipsArr().length;
    if (!nc || !Number.isFinite(a) || !Number.isFinite(f)) { store.clearSelection(); return; }
    const aa = Math.min(Math.max(0, Math.floor(a)), nc - 1);
    const ff = Math.min(Math.max(0, Math.floor(f)), nc - 1);
    const fl = F();
    const lo = Math.min(aa, ff), hi = Math.max(aa, ff);
    const first = fl.clipFirst[lo];
    const last = fl.clipFirst[hi] + clipsArr()[hi].words.length - 1;
    const ui = store.ui;
    ui.clipSel = { a: aa, f: ff };
    ui.sel = aa <= ff ? { a: first, f: last } : { a: last, f: first };
    emit('selection', { sel: ui.sel, clipSel: ui.clipSel });
  },
  clearSelection() {
    const ui = store.ui;
    if (!ui.sel && !ui.clipSel) return;
    ui.sel = null;
    ui.clipSel = null;
    emit('selection', { sel: null, clipSel: null });
  },
  selectedRange() {
    const s = store.ui.sel;
    if (!s) return null;
    const n = F().list.length;
    if (!n) return null;
    const from = Math.min(Math.max(0, Math.min(s.a, s.f)), n - 1);
    const to = Math.min(Math.max(0, Math.max(s.a, s.f)), n - 1);
    return { from, to };
  },
  /** Clip range of the selection: the clip selection, or the clips touched by the token selection. */
  selectedClipRange() {
    const ui = store.ui;
    const nc = clipsArr().length;
    if (!nc) return null;
    if (ui.clipSel) {
      return {
        from: Math.min(Math.max(0, Math.min(ui.clipSel.a, ui.clipSel.f)), nc - 1),
        to: Math.min(Math.max(0, Math.max(ui.clipSel.a, ui.clipSel.f)), nc - 1),
      };
    }
    const r = store.selectedRange();
    if (!r) return null;
    const list = F().list;
    return { from: list[r.from].ci, to: list[r.to].ci };
  },

  // ---- ops (each ONE undo step; marks dirty; emits 'change') --------------------------------
  /** Group several ops into one undo step and one 'change' event. Returns fn's result. */
  batch(fn) {
    return op(fn);
  },

  setDeleted(from, to, del) {
    return op(() => {
      const r = flatRange(from, to);
      if (!r) return 0;
      const list = F().list;
      const v = !!del;
      let count = 0;
      for (let i = r[0]; i <= r[1]; i++) {
        const { tok, clip } = list[i];
        if (tok.del !== v) {
          tok.del = v;
          touch(clip);
          count++;
        }
      }
      return count;
    });
  },

  /** Delete/restore the current selection ("영상 삭제" toggle). Returns true if anything changed. */
  toggleDelete() {
    const ui = store.ui;
    if (ui.clipSel) {
      const cr = store.selectedClipRange();
      if (!cr) return false;
      const clips = clipsArr();
      let allDel = true;
      for (let ci = cr.from; ci <= cr.to && allDel; ci++) if (!clipFullyDeleted(clips[ci])) allDel = false;
      return store.setClipsDeleted(cr.from, cr.to, !allDel) > 0;
    }
    const r = store.selectedRange();
    if (!r) return false;
    const list = F().list;
    let allDel = true;
    for (let i = r.from; i <= r.to; i++) if (!list[i].tok.del) { allDel = false; break; }
    return store.setDeleted(r.from, r.to, !allDel) > 0;
  },

  setClipsDeleted(ciFrom, ciTo, del) {
    return op(() => {
      const r = clipRange(ciFrom, ciTo);
      if (!r) return 0;
      const clips = clipsArr();
      const v = !!del;
      let count = 0;
      for (let ci = r[0]; ci <= r[1]; ci++) {
        const clip = clips[ci];
        let changed = false;
        for (const tok of clip.words) {
          if (tok.del !== v) { tok.del = v; changed = true; count++; }
        }
        if (changed) touch(clip);
      }
      return count;
    });
  },

  setWordText(flatIdx, text) {
    return op(() => {
      const ent = F().list[flatIdx];
      if (!ent || ent.tok.type !== 'word') return false;
      const v = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
      if (!v || v === ent.tok.text) return false;
      ent.tok.text = v;
      touch(ent.clip);
      return true;
    });
  },

  setCaption(ci, textOrNull) {
    return op(() => {
      const clip = clipsArr()[ci];
      if (!clip) return false;
      let v = normalizeCaption(textOrNull);
      if (v !== null && v === autoCaptionOf(clip.words)) v = null;
      const cur = clip.caption === undefined ? null : clip.caption;
      if (v === cur) return false;
      clip.caption = v;
      touch(clip);
      return true;
    });
  },

  /** New clip starts at token flatIdx (no-op at the first token of a clip). */
  splitClip(flatIdx) {
    return op(() => {
      const ent = F().list[flatIdx];
      if (!ent || ent.ti === 0) return false;
      const clip = ent.clip;
      const id = newClipId();
      const words = clip.words.splice(ent.ti);
      const nc = { id, caption: null, flags: [], ngOf: null, words };
      clipsArr().splice(ent.ci + 1, 0, nc);
      touch(clip);
      touch(nc);
      structuralChange();
      return true;
    });
  },

  /** Enter inside a caption: split clip ci where the caret is (pos chars into `text`).
   *  A caret inside a word also splits that word's audio proportionally. Returns the new clip index or -1. */
  splitClipAtText(ci, text, pos) {
    return op(() => {
      const clips = clipsArr();
      const clip = clips[ci];
      if (!clip) return -1;
      const auto = autoCaptionOf(clip.words);
      const typed = String(text || '');
      const override = typed.trim() !== auto ? typed : null;
      let p = pos;
      if (override !== null) p = Math.round((pos / Math.max(1, typed.length)) * auto.length);
      // locate the token boundary (or the point inside a word) for char offset p of the auto caption
      let off = 0, first = true, cutTi = -1;
      for (let ti = 0; ti < clip.words.length; ti++) {
        const t = clip.words[ti];
        if (t.type !== 'word' || t.del || !t.text) continue;
        if (!first && !t.joinPrev) off += 1;
        first = false;
        const len = Array.from(t.text).length;
        if (p <= off) { cutTi = ti; break; }
        if (p < off + len) {
          const at = t.start + (t.end - t.start) * ((p - off) / len);
          const fi = splitAtInternal(at);
          const ent = F().list[fi];
          if (ent && ent.clip === clip) cutTi = ent.ti;
          break;
        }
        off += len;
      }
      if (cutTi <= 0) return -1;
      const words = clip.words.splice(cutTi);
      const nc = { id: newClipId(), caption: null, flags: [], ngOf: null, words };
      if (override !== null) {
        clip.caption = typed.slice(0, pos).trim();
        nc.caption = typed.slice(pos).trim();
      } else if (clip.caption !== null && clip.caption !== undefined) {
        clip.caption = null;
      }
      clips.splice(ci + 1, 0, nc);
      touch(clip);
      touch(nc);
      structuralChange();
      return ci + 1;
    });
  },

  /** Move tokens [flatIdx..end of clip] to the start of the next clip (Shift+Enter). */
  splitToNext(flatIdx) {
    return op(() => {
      const ent = F().list[flatIdx];
      if (!ent) return false;
      const clips = clipsArr();
      const clip = ent.clip;
      const next = clips[ent.ci + 1];
      if (!next) {
        if (ent.ti === 0) return false;
        return store.splitClip(flatIdx);
      }
      if (ent.ti === 0) return mergePair(ent.ci);
      const moved = clip.words.splice(ent.ti);
      if (next.caption !== null && next.caption !== undefined) {
        next.caption = (autoCaptionOf(moved) + ' ' + next.caption).trim();
      }
      next.words = moved.concat(next.words);
      touch(clip);
      touch(next);
      structuralChange();
      return true;
    });
  },

  /** Move tokens from the clip's start through flatIdx to the end of the previous clip (Shift+Backspace). */
  // inclusive=false: text-cursor semantics (cursor sits before the token; at the clip start the
  // whole clip joins the previous one, like Backspace at the start of a line).
  joinToPrev(flatIdx, inclusive = false) {
    return op(() => {
      const ent = F().list[flatIdx];
      if (!ent || ent.ci === 0) return false;
      const clips = clipsArr();
      const clip = ent.clip;
      const prev = clips[ent.ci - 1];
      const n = inclusive ? ent.ti + 1 : ent.ti;
      if (n === 0 || n >= clip.words.length) return mergePair(ent.ci - 1);
      const moved = clip.words.splice(0, n);
      if (prev.caption !== null && prev.caption !== undefined) {
        prev.caption = (prev.caption + ' ' + autoCaptionOf(moved)).trim();
      }
      if (clip.caption !== null && clip.caption !== undefined) clip.caption = null;
      prev.words = prev.words.concat(moved);
      touch(clip);
      touch(prev);
      structuralChange();
      return true;
    });
  },

  mergeWithNext(ci) {
    return op(() => mergePair(ci));
  },

  /** Split the token under time t into two (word text is divided by syllables). */
  splitTokenAt(t) {
    return op(() => splitAtInternal(t));
  },

  /** Delete exactly [t0, t1] (one undo step). */
  cutRange(t0, t1) {
    const a = Math.min(t0, t1), b = Math.max(t0, t1);
    return op(() => cutRangeInternal(a, b));
  },

  /** Q / W: cut from the clip start to t, or from t to the clip end. */
  cutClipEdge(t, side) {
    const ci = store.clipAt(t);
    if (ci < 0) return 0;
    const clip = clipsArr()[ci];
    const s = clip.words[0].start, e = clip.words[clip.words.length - 1].end;
    return op(() => (side === 'head' ? cutRangeInternal(s, t) : cutRangeInternal(t, e)));
  },

  /** Give a token (usually silence) its own clip with an empty caption override -> returns clip index. */
  isolateAsCaptionClip(flatIdx) {
    return op(() => {
      let ent = F().list[flatIdx];
      if (!ent) return -1;
      const id = ent.tok.id;
      const clips = clipsArr();
      if (ent.ti > 0) {
        const tail = ent.clip.words.splice(ent.ti);
        clips.splice(ent.ci + 1, 0, { id: newClipId(), caption: null, flags: [], ngOf: null, words: tail });
        touch(ent.clip);
        structuralChange();
      }
      ent = F().list[store.flatIndexOf(id)];
      if (ent.clip.words.length > 1) {
        const rest = ent.clip.words.splice(1);
        clips.splice(ent.ci + 1, 0, { id: newClipId(), caption: ent.clip.caption, flags: [], ngOf: null, words: rest });
        structuralChange();
      }
      ent.clip.caption = '';
      ent.tok.del = false;
      ent.tok.keep = null;
      touch(ent.clip);
      structuralChange();
      return store.clipIndexOf(ent.clip.id);
    });
  },

  mergeWithPrev(ci) {
    return op(() => (ci > 0 ? mergePair(ci - 1) : false));
  },

  /** Merge clips ciFrom..ciTo into the first one (one undo step). */
  mergeClips(ciFrom, ciTo) {
    return op(() => {
      const r = clipRange(ciFrom, ciTo);
      if (!r || r[0] === r[1]) return false;
      for (let k = r[0]; k < r[1]; k++) mergePair(r[0]);
      return true;
    });
  },

  /** Boundary between flat[flatIdx] and flat[flatIdx+1] moves to t (each side keeps >= 0.02 s). */
  moveBoundary(flatIdx, t) {
    return op(() => {
      const list = F().list;
      const A = list[flatIdx], B = list[flatIdx + 1];
      const v = Number(t);
      if (!A || !B || !Number.isFinite(v)) return false;
      const lo = ceil3(A.tok.start + MIN_TOKEN);
      const hi = floor3(B.tok.end - MIN_TOKEN);
      if (hi < lo) return false;
      const nt = r3(Math.min(Math.max(v, lo), hi));
      if (Math.abs(nt - A.tok.end) < 0.0005 && Math.abs(nt - B.tok.start) < 0.0005) return false;
      A.tok.end = nt;
      B.tok.start = nt;
      touch(A.clip);
      touch(B.clip);
      return true;
    });
  },

  /** Move the 'start' or 'end' edge of the selection by delta seconds (shared boundary moves). */
  nudge(edge, delta) {
    const r = store.selectedRange();
    const d = Number(delta);
    if (!r || !Number.isFinite(d) || !d) return false;
    const list = F().list;
    if (edge === 'start') {
      if (r.from === 0) return false;
      return store.moveBoundary(r.from - 1, list[r.from].tok.start + d);
    }
    if (edge === 'end') {
      if (r.to >= list.length - 1) return false;
      return store.moveBoundary(r.to, list[r.to].tok.end + d);
    }
    return false;
  },

  /** Shorten silences: keep = min(keep, dur) for gap (+noise) tokens with dur >= min and not deleted. */
  shortenSilences({ min, keep, includeNoise } = {}) {
    const s = store.project ? store.project.settings || {} : {};
    const vMin = Number.isFinite(Number(min)) && min !== null && min !== '' ? Number(min) : Number(s.silenceMin ?? DEFAULT_SETTINGS.silenceMin);
    const vKeep = Math.max(0, Number.isFinite(Number(keep)) && keep !== null && keep !== '' ? Number(keep) : Number(s.silenceKeep ?? 0));
    const withNoise = includeNoise === undefined ? !!s.includeNoise : !!includeNoise;
    if (!store.project) return { count: 0, savedSec: 0 };
    const before = K().total;
    let count = 0;
    op(() => {
      for (const clip of clipsArr()) {
        let changed = false;
        for (const tok of clip.words) {
          if (tok.del) continue;
          if (!(tok.type === 'gap' || (withNoise && tok.type === 'noise'))) continue;
          const dur = tok.end - tok.start;
          if (dur < vMin - 1e-6) continue;
          count++;
          const nk = Math.min(vKeep, dur);
          if (tok.keep !== nk) { tok.keep = nk; changed = true; }
        }
        if (changed) touch(clip);
      }
    });
    return { count, savedSec: r3(before - K().total) };
  },

  /** Set (number) or clear (null) `keep` on the gap/noise tokens in a flat range. */
  setKeep(from, to, keep) {
    return op(() => {
      const r = flatRange(from, to);
      if (!r) return 0;
      const list = F().list;
      let count = 0;
      for (let i = r[0]; i <= r[1]; i++) {
        const { tok, clip } = list[i];
        if (!isSilence(tok)) continue;
        const dur = tok.end - tok.start;
        const nk = keep === null || keep === undefined ? null : Math.min(Math.max(0, Number(keep) || 0), dur);
        if (tok.keep !== nk) { tok.keep = nk; touch(clip); count++; }
      }
      return count;
    });
  },

  deleteTokens(flatIdxList) {
    return op(() => {
      const list = F().list;
      let count = 0;
      for (const i of flatIdxList || []) {
        const ent = list[i];
        if (ent && !ent.tok.del) { ent.tok.del = true; touch(ent.clip); count++; }
      }
      return count;
    });
  },

  deleteClips(ciList) {
    return op(() => {
      const clips = clipsArr();
      let count = 0;
      for (const ci of ciList || []) {
        const clip = clips[ci];
        if (!clip) continue;
        let changed = false;
        for (const tok of clip.words) if (!tok.del) { tok.del = true; changed = true; count++; }
        if (changed) touch(clip);
      }
      return count;
    });
  },

  /** Substring replace in word texts and/or caption overrides. Returns the number of replacements. */
  replaceAll(find, repl, { words = true, captions = true } = {}) {
    const needle = find == null ? '' : String(find);
    if (!needle || !store.project) return 0;
    const rep = repl == null ? '' : String(repl);
    let count = 0;
    op(() => {
      for (const clip of clipsArr()) {
        let changed = false;
        if (words) {
          for (const tok of clip.words) {
            if (tok.type !== 'word' || !tok.text.includes(needle)) continue;
            const parts = tok.text.split(needle);
            const next = parts.join(rep).replace(/\s+/g, ' ').trim();
            if (!next) continue;
            count += parts.length - 1;
            if (next !== tok.text) { tok.text = next; changed = true; }
          }
        }
        if (captions && clip.caption !== null && clip.caption !== undefined && clip.caption.includes(needle)) {
          const parts = clip.caption.split(needle);
          count += parts.length - 1;
          const next = parts.join(rep);
          if (next !== clip.caption) { clip.caption = next; changed = true; }
        }
        if (changed) touch(clip);
      }
    });
    return count;
  },

  /** Replace all clips (resegment result). One undo step. */
  replaceClips(clips) {
    return op(() => {
      const next = normalizeClips(clips);
      if (!next.length && clipsArr().length) return false;
      store.project.clips = next;
      touchAll();
      structuralChange();
      return true;
    });
  },

  /** Merge flags/ngOf from analyzed clips by id. No undo step; emits 'flags'. */
  applyFlags(clips) {
    if (!store.project || !Array.isArray(clips)) return 0;
    const byId = new Map();
    const tokFlags = new Map();
    for (const c of clips) {
      if (!c) continue;
      byId.set(c.id, c);
      for (const t of c.words || []) if (t && t.id) tokFlags.set(t.id, Array.isArray(t.flags) ? t.flags : []);
    }
    const ids = new Set();
    for (const clip of clipsArr()) {
      let changed = false;
      const inc = byId.get(clip.id);
      if (inc) {
        clip.flags = Array.isArray(inc.flags) ? inc.flags.slice() : [];
        clip.ngOf = inc.ngOf === undefined ? null : inc.ngOf;
        changed = true;
      }
      for (const tok of clip.words) {
        const fl = tokFlags.get(tok.id);
        if (fl) { tok.flags = fl.slice(); changed = true; }
      }
      if (changed) {
        jsonCache.delete(clip);
        ids.add(clip.id);
      }
    }
    STATS = null;
    if (ids.size) {
      markDirty();
      emit('flags', { clipIds: ids });
    }
    return ids.size;
  },

  updateSettings(partial) {
    if (!store.project || !partial) return;
    store.project.settings = Object.assign({}, store.project.settings || {}, partial);
    markDirty();
    emit('settings', store.project.settings);
  },

  // ---- history -------------------------------------------------------------------------------
  undo() {
    if (!store.project || batchDepth || !undoStack.length) return false;
    const target = undoStack.pop();
    const current = snapshot();
    redoStack.push(current);
    if (redoStack.length > MAX_UNDO) redoStack.shift();
    applySnapshot(target, current);
    return true;
  },
  redo() {
    if (!store.project || batchDepth || !redoStack.length) return false;
    const target = redoStack.pop();
    const current = snapshot();
    undoStack.push(current);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    applySnapshot(target, current);
    return true;
  },
  canUndo() {
    return undoStack.length > 0;
  },
  canRedo() {
    return redoStack.length > 0;
  },

  markSaved(savedAt) {
    store.savedAt = savedAt || new Date().toISOString();
    store.dirty = false;
    if (store.project) store.project.updatedAt = store.savedAt;
    emit('saved', store.savedAt);
  },
};

export default store;
