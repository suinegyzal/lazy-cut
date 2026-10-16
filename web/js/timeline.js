// timeline.js [E] — canvas timeline (#timeline) + minimap (#minimap).
//
// Layout of #timeline (CSS px, top → bottom): ruler (source time) · token band (word labels, boundary
// handles) · waveform. Removed parts (complement of the kept ranges) get a red hatch, kept gaps a gray
// shade, unrecognized speech (noise) a purple tint. Everything static is cached in an offscreen canvas;
// per frame only the cache is blitted and the playhead / hover / drag guides are drawn on top.
//
// Assumptions: api.peaks() rejects with an Error whose `.code` is "not_ready" (or `.status` 404) while the
// waveform is being prepared; any other failure is retried a few times, then the waveform is left out.
import { store } from './store.js';
import { api } from './api.js';
import { fmtTime, clamp } from './util.js';
import { player, keptRangeList, rangeIndexAt } from './player.js';

const MIN_VIEW = 5;
const MAX_VIEW = 120;
const DEFAULT_VIEW = 20;
const HANDLE_MAX_VIEW = 60;     // boundary handles only when zoomed in this far (seconds in view)
const HANDLE_PX = 5;            // hit distance for a boundary handle
const RULER_H = 18;
const TOK_Y = 21;
const TOK_H = 20;
const WAVE_TOP = TOK_Y + TOK_H + 4;
const FOLLOW_PAUSE_MS = 2500;   // after a manual pan/zoom, don't auto-follow the playhead for a moment
const PEAKS_PER_SEC = 100;

let cv = null, ctx = null, mm = null, mctx = null;
let dpr = 1, W = 0, H = 0, MW = 0, MH = 0;
let stat = null, sctx = null, mstat = null, msctx = null;   // offscreen caches
let staticValid = false, miniValid = false;
let drawQueued = false;

let viewStart = 0;
let viewDur = DEFAULT_VIEW;
let lastUserNav = -Infinity;   // performance.now() of the last manual pan/zoom
let projectId = null;

let peaks = null;
let peaksState = 'idle';        // idle | loading | ready | none
let peaksGen = 0;
let peaksTimer = 0;

let drag = null;                // {kind:'seek'|'boundary'|'mini', ...}
let hover = null;               // {i, t} boundary under the pointer
let colors = null;
let fontFamily = '"Pretendard", -apple-system, "Apple SD Gothic Neo", sans-serif';
const textCache = new Map();

// ---------------------------------------------------------------- helpers

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
  colors = {
    ink: v('--ink', '#0A1317'), blue: v('--blue', '#2450F5'), blue2: v('--blue-2', '#6F9BFF'),
    bg: v('--bg', '#F4F6F9'), panel: v('--panel', '#FFFFFF'), border: v('--border', '#E6EBEF'),
    gray: v('--gray', '#8595A4'), purple: v('--purple', '#6D28D9'), danger: v('--danger', '#E5484D'),
    dangerBg: v('--danger-bg', '#FDECEC'), warn: v('--warn', '#B7791F'), warnBg: v('--warn-bg', '#FFF4CC'),
    orange: v('--orange', '#F76808'),
  };
  const f = v('--font', '');
  if (f) fontFamily = f;
  textCache.clear();
}

function srcDuration() {
  const p = store.project;
  const d = p && p.source && p.source.duration;
  if (d > 0) return d;
  const fl = flatList();
  return fl.length ? fl[fl.length - 1].tok.end : 0;
}

function flatList() {
  if (!store.project) return [];
  try { return store.flat() || []; } catch (e) { return []; }
}

/** Last flat index whose token starts at or before t (0 if t is before the first token). */
function findTok(fl, t) {
  let lo = 0, hi = fl.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fl[mid].tok.start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const X = (t) => (t - viewStart) * W / viewDur;
const timeAtX = (x) => clamp(viewStart + x * viewDur / W, 0, srcDuration());

function setViewStart(s) {
  const d = srcDuration();
  const maxStart = Math.max(0, d - viewDur * 0.9);
  const ns = clamp(s, 0, maxStart);
  if (ns !== viewStart) { viewStart = ns; staticValid = false; }
}

function setViewDur(dur, anchorT, anchorX) {
  const nd = clamp(dur, MIN_VIEW, MAX_VIEW);
  if (nd === viewDur) return;
  viewDur = nd;
  staticValid = false;
  if (anchorT != null && W > 0) setViewStart(anchorT - anchorX * viewDur / W);
  else setViewStart(viewStart);
  textCache.clear();
}

function fitText(c, text, maxW) {
  if (maxW <= 4 || !text) return '';
  const key = `${c.font}|${maxW | 0}|${text}`;
  const hit = textCache.get(key);
  if (hit !== undefined) return hit;
  let out = text;
  if (c.measureText(text).width > maxW) {
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1;
    }
    out = lo > 0 ? text.slice(0, lo) + '…' : '';
  }
  if (textCache.size > 4000) textCache.clear();
  textCache.set(key, out);
  return out;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

function selRange() {
  try {
    const r = store.selectedRange && store.selectedRange();
    if (r && r.from != null && r.to != null) return { from: Math.min(r.from, r.to), to: Math.max(r.from, r.to) };
  } catch (e) { /* ignore */ }
  return null;
}

function hasFlag(tok, f) { return Array.isArray(tok.flags) && tok.flags.indexOf(f) >= 0; }

// ---------------------------------------------------------------- sizing

function ensureCanvas(c, w, h) {
  const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; return true; }
  return false;
}

function resize() {
  if (!cv || !mm) return;
  dpr = Math.max(1, window.devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  MW = mm.clientWidth; MH = mm.clientHeight;
  if (W > 0 && H > 0) {
    ensureCanvas(cv, W, H);
    if (!stat) { stat = document.createElement('canvas'); sctx = stat.getContext('2d'); }
    ensureCanvas(stat, W, H);
  }
  if (MW > 0 && MH > 0) {
    ensureCanvas(mm, MW, MH);
    if (!mstat) { mstat = document.createElement('canvas'); msctx = mstat.getContext('2d'); }
    ensureCanvas(mstat, MW, MH);
  }
  staticValid = false;
  miniValid = false;
  draw();
}

// ---------------------------------------------------------------- static layer

function drawStatic() {
  const c = sctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  c.fillStyle = colors.panel;
  c.fillRect(0, 0, W, H);

  const dur = srcDuration();
  const vEnd = viewStart + viewDur;
  const fl = flatList();
  const tokens = fl.length > 0;
  const K = tokens ? keptRangeList() : null;
  const ov = drag && drag.kind === 'boundary' ? drag : null;

  // Past the end of the video.
  if (dur < vEnd) {
    const xe = Math.max(0, X(dur));
    c.fillStyle = colors.bg;
    c.fillRect(xe, RULER_H, W - xe, H - RULER_H);
  }

  // Removed parts: complement of the kept ranges.
  if (tokens) {
    const lo = Math.max(0, viewStart), hi = Math.min(dur, vEnd);
    let k = Math.max(0, rangeIndexAt(K, lo));
    let cursor = lo;
    if (K.n && K.starts[k] <= lo && K.ends[k] > lo) { cursor = K.ends[k]; k++; } else if (K.n && K.ends[k] <= lo) k++;
    while (cursor < hi) {
      const ns = k < K.n ? Math.min(K.starts[k], hi) : hi;
      if (ns > cursor) hatch(c, X(cursor), X(ns));
      if (k >= K.n) break;
      cursor = K.ends[k];
      k++;
    }
  }

  // Token-type shading (kept gaps gray, noise purple) and clip separators.
  let i0 = tokens ? findTok(fl, viewStart) : 0;
  if (tokens) {
    c.save();
    for (let i = i0; i < fl.length; i++) {
      const { tok, ti } = fl[i];
      let s = tok.start, e = tok.end;
      if (ov) { if (i === ov.i) e = ov.t; else if (i === ov.i + 1) s = ov.t; }
      if (s > vEnd) break;
      if (e < viewStart) continue;
      const x0 = X(s), x1 = X(e);
      if (!tok.del && tok.type === 'gap') {
        c.globalAlpha = 0.07; c.fillStyle = colors.ink; c.fillRect(x0, RULER_H, x1 - x0, H - RULER_H);
      } else if (!tok.del && tok.type === 'noise') {
        c.globalAlpha = 0.07; c.fillStyle = colors.purple; c.fillRect(x0, RULER_H, x1 - x0, H - RULER_H);
      }
      if (ti === 0 && i > 0) {
        c.globalAlpha = 0.22; c.fillStyle = colors.ink;
        c.fillRect(Math.round(x0) - 0.5, RULER_H, 1, H - RULER_H);
      }
    }
    c.restore();

    // Selection.
    const sr = selRange();
    if (sr && fl[sr.from] && fl[sr.to]) {
      const xs = X(fl[sr.from].tok.start), xe = X(fl[sr.to].tok.end);
      if (xe > 0 && xs < W) {
        c.save();
        c.globalAlpha = 0.10; c.fillStyle = colors.blue; c.fillRect(xs, RULER_H, xe - xs, H - RULER_H);
        c.restore();
      }
    }
  }

  drawWave(c, K, dur);
  if (tokens) {
    drawTokens(c, fl, i0, vEnd, ov);
    drawClipNumbers(c, fl, i0, vEnd);
  }
  drawRuler(c, dur);
}

/** Small "#n" at each clip start in the waveform lane (same numbering as the editor). */
function drawClipNumbers(c, fl, i0, vEnd) {
  // Start from the clip that is already running at the left edge.
  let i = i0;
  while (i > 0 && fl[i].ti !== 0) i--;
  const starts = [];
  for (; i < fl.length; i++) {
    const f = fl[i];
    if (f.tok.start > vEnd) break;
    if (f.ti === 0) starts.push({ ci: f.ci, x: X(f.tok.start) });
  }
  c.save();
  c.font = `600 10px ${fontFamily}`;
  c.textBaseline = 'top';
  c.textAlign = 'left';
  for (let k = 0; k < starts.length; k++) {
    const x = Math.max(2, starts[k].x + 3);
    const nextX = k + 1 < starts.length ? starts[k + 1].x : W + 40;
    const label = `#${starts[k].ci + 1}`;
    const w = c.measureText(label).width;
    if (nextX - x < w + 6 || x > W) continue;
    c.globalAlpha = 0.85;
    c.fillStyle = colors.panel;
    c.fillRect(x - 2, WAVE_TOP + 1, w + 4, 12);
    c.globalAlpha = 1;
    c.fillStyle = colors.gray;
    c.fillText(label, x, WAVE_TOP + 2);
  }
  c.restore();
}

function hatch(c, x0, x1) {
  x0 = Math.max(0, x0); x1 = Math.min(W, x1);
  if (x1 - x0 < 0.5) return;
  const y0 = RULER_H, y1 = H;
  c.save();
  c.fillStyle = colors.dangerBg;
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  c.beginPath();
  c.rect(x0, y0, x1 - x0, y1 - y0);
  c.clip();
  c.globalAlpha = 0.28;
  c.strokeStyle = colors.danger;
  c.lineWidth = 1;
  c.beginPath();
  const step = 7, hgt = y1 - y0;
  // Anchor stripes to absolute time (x ≡ X(0) mod step) so they don't "crawl" while panning.
  const phase = ((X(0) % step) + step) % step;
  let xs = x0 - hgt;
  xs -= (((xs - phase) % step) + step) % step;
  for (let x = xs; x < x1; x += step) {
    c.moveTo(x, y1); c.lineTo(x + hgt, y0);
  }
  c.stroke();
  c.restore();
}

function drawWave(c, K, dur) {
  const top = WAVE_TOP, bottom = H - 3;
  const mid = (top + bottom) / 2, half = (bottom - top) / 2;
  if (!peaks) {
    c.save();
    c.fillStyle = colors.gray;
    c.globalAlpha = 0.8;
    c.font = `11px ${fontFamily}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const msg = !store.project ? '' : peaksState === 'none' ? '파형을 불러오지 못했어요' : '파형을 준비하는 중이에요…';
    if (msg) c.fillText(msg, W / 2, mid);
    c.globalAlpha = 0.35; c.fillStyle = colors.border; c.fillRect(0, Math.round(mid), Math.max(0, Math.min(W, X(dur))), 1);
    c.restore();
    return;
  }
  const spp = viewDur / W;
  const keptPath = new Path2D(), cutPath = new Path2D();
  let k = 0;
  const useK = K && K.n >= 0 && flatList().length > 0;
  if (useK) k = Math.max(0, rangeIndexAt(K, viewStart));
  const n = peaks.length;
  for (let x = 0; x < W; x++) {
    const t0 = viewStart + x * spp;
    if (t0 >= dur) break;
    const t1 = t0 + spp;
    let i0 = Math.floor(t0 * PEAKS_PER_SEC), i1 = Math.ceil(t1 * PEAKS_PER_SEC);
    if (i1 <= i0) i1 = i0 + 1;
    if (i0 >= n) break;
    let m = 0;
    for (let i = Math.max(0, i0); i < i1 && i < n; i++) if (peaks[i] > m) m = peaks[i];
    const a = Math.max(0.5, (m / 255) * half);
    let kept = true;
    if (useK) {
      const tc = t0 + spp / 2;
      while (k < K.n && K.ends[k] <= tc) k++;
      kept = k < K.n && K.starts[k] <= tc;
    }
    (kept ? keptPath : cutPath).rect(x, mid - a, 1, a * 2);
  }
  c.save();
  c.fillStyle = colors.blue2;
  c.fill(keptPath);
  c.globalAlpha = 0.45;
  c.fillStyle = colors.gray;
  c.fill(cutPath);
  c.restore();
}

function drawTokens(c, fl, i0, vEnd, ov) {
  const sr = selRange();
  const y = TOK_Y, h = TOK_H;
  c.save();
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  for (let i = i0; i < fl.length; i++) {
    const { tok } = fl[i];
    let s = tok.start, e = tok.end;
    if (ov) { if (i === ov.i) e = ov.t; else if (i === ov.i + 1) s = ov.t; }
    if (s > vEnd) break;
    if (e < viewStart) continue;
    const x0 = X(s), x1 = X(e), w = x1 - x0;
    const sel = !!(sr && i >= sr.from && i <= sr.to);
    if (tok.type === 'word') drawWord(c, tok, x0, w, y, h, sel);
    else if (tok.type === 'noise') drawNoise(c, tok, x0, w, y, h, sel);
    else drawGapLabel(c, tok, x0, w, y, h, sel);
  }
  c.restore();
}

function drawWord(c, tok, x0, w, y, h, sel) {
  const bx = x0 + 1, bw = w - 2;
  if (bw < 1.5) {
    c.fillStyle = tok.del ? colors.danger : colors.gray;
    c.fillRect(x0, y + 4, 1, h - 8);
    return;
  }
  const strong = hasFlag(tok, 'filler'), weak = hasFlag(tok, 'filler?');
  roundRect(c, bx, y, bw, h, 4);
  c.fillStyle = sel ? colors.blue : tok.del ? colors.dangerBg : strong ? colors.warnBg : colors.panel;
  c.fill();
  c.lineWidth = 1;
  c.strokeStyle = sel ? colors.blue : tok.del ? colors.danger : colors.border;
  c.globalAlpha = tok.del && !sel ? 0.5 : 1;
  c.stroke();
  c.globalAlpha = 1;
  if (bw >= 10) {
    c.font = `${w > 40 ? 12 : 11}px ${fontFamily}`;
    const label = fitText(c, tok.text || '', bw - 6);
    if (label) {
      c.fillStyle = sel ? '#fff' : tok.del ? colors.danger : strong ? colors.warn : colors.ink;
      c.fillText(label, bx + 3, y + h / 2 + 0.5);
      if (tok.del) {
        const tw = Math.min(bw - 6, c.measureText(label).width);
        c.fillRect(bx + 3, Math.round(y + h / 2), tw, 1);
      }
    }
  }
  // Flag underlines.
  const uy = y + h - 2.5;
  if (hasFlag(tok, 'repeat')) {
    c.fillStyle = colors.orange; c.fillRect(bx + 2, uy, bw - 4, 2);
  } else if (weak || hasFlag(tok, 'lowconf')) {
    c.fillStyle = weak ? colors.warn : colors.gray;
    for (let x = bx + 2; x < bx + bw - 3; x += 3) c.fillRect(x, uy + 0.5, 1.5, 1.5);
  }
}

function drawNoise(c, tok, x0, w, y, h, sel) {
  const bx = x0 + 1, bw = w - 2;
  if (bw < 1.5) return;
  c.save();
  roundRect(c, bx, y + 1, bw, h - 2, 4);
  if (sel) { c.fillStyle = colors.blue; c.fill(); }
  else if (tok.del) { c.fillStyle = colors.dangerBg; c.fill(); }
  c.setLineDash([3, 2]);
  c.lineWidth = 1;
  c.strokeStyle = sel ? colors.blue : tok.del ? colors.danger : colors.purple;
  c.globalAlpha = tok.del && !sel ? 0.55 : 0.9;
  c.stroke();
  c.restore();
  if (bw >= 30) {
    c.font = `11px ${fontFamily}`;
    const label = fitText(c, '(음성)', bw - 6);
    if (label) {
      c.fillStyle = sel ? '#fff' : tok.del ? colors.danger : colors.purple;
      c.fillText(label, bx + 3, y + h / 2 + 0.5);
    }
  }
}

function drawGapLabel(c, tok, x0, w, y, h, sel) {
  if (sel && w >= 2) {
    c.save(); c.globalAlpha = 0.18; c.fillStyle = colors.blue;
    roundRect(c, x0 + 1, y + 3, w - 2, h - 6, 4); c.fill(); c.restore();
  }
  if (w < 34) return;
  const dur = tok.end - tok.start;
  const short = tok.keep != null && tok.keep < dur;
  const txt = short ? `${dur.toFixed(1)}→${Math.max(0, tok.keep).toFixed(1)}초` : `${dur.toFixed(1)}초`;
  c.font = `10px ${fontFamily}`;
  const label = fitText(c, txt, w - 6);
  if (!label) return;
  c.save();
  c.textAlign = 'center';
  c.fillStyle = tok.del ? colors.danger : short ? colors.blue : colors.gray;
  c.globalAlpha = 0.9;
  c.fillText(label, x0 + w / 2, y + h / 2 + 0.5);
  c.restore();
}

function drawRuler(c, dur) {
  c.save();
  c.fillStyle = colors.bg;
  c.fillRect(0, 0, W, RULER_H);
  c.fillStyle = colors.border;
  c.fillRect(0, RULER_H - 1, W, 1);
  const pps = W / viewDur;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pps >= 64) || 600;
  const div = [5, 4, 2].find((d) => (major / d) * pps >= 7) || 1;
  const minor = major / div;
  const n0 = Math.floor(viewStart / minor), n1 = Math.ceil((viewStart + viewDur) / minor);
  c.font = `10px ${fontFamily}`;
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  for (let n = n0; n <= n1; n++) {
    const t = n * minor;
    if (t < 0 || t > dur + 1e-6) continue;
    const x = Math.round(X(t)) + 0.5;
    const isMajor = n % div === 0;
    c.fillStyle = colors.gray;
    c.globalAlpha = isMajor ? 0.9 : 0.45;
    c.fillRect(x - 0.5, isMajor ? RULER_H - 7 : RULER_H - 4, 1, isMajor ? 6 : 3);
    if (isMajor) {
      c.globalAlpha = 1;
      c.fillText(fmtTime(t, { ms: major < 1 }), x + 3, 7.5);
    }
  }
  c.restore();
}

// ---------------------------------------------------------------- minimap

function drawMiniStatic() {
  const c = msctx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, MW, MH);
  c.fillStyle = colors.bg;
  c.fillRect(0, 0, MW, MH);
  const dur = srcDuration();
  if (!(dur > 0)) return;
  const y = 4, h = MH - 8;
  const tokens = flatList().length > 0;
  c.save();
  if (!tokens) {
    c.globalAlpha = 0.5; c.fillStyle = colors.blue2; c.fillRect(0, y, MW, h);
  } else {
    c.globalAlpha = 0.55; c.fillStyle = colors.danger; c.fillRect(0, y, MW, h);
    c.globalAlpha = 1; c.fillStyle = colors.blue2;
    const K = keptRangeList();
    const sx = MW / dur;
    // Merge ranges per pixel so thousands of tiny ranges stay cheap.
    let curS = -1, curE = -1;
    for (let k = 0; k < K.n; k++) {
      const a = K.starts[k] * sx, b = K.ends[k] * sx;
      if (curE >= 0 && a - curE < 0.5) { curE = Math.max(curE, b); continue; }
      if (curE >= 0) c.fillRect(curS, y, Math.max(0.6, curE - curS), h);
      curS = a; curE = b;
    }
    if (curE >= 0) c.fillRect(curS, y, Math.max(0.6, curE - curS), h);
  }
  c.restore();
}

function drawMini() {
  if (!mm || MW <= 0 || MH <= 0) return;
  if (!miniValid) { drawMiniStatic(); miniValid = true; }
  const c = mctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, mm.width, mm.height);
  c.drawImage(mstat, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dur = srcDuration();
  if (!(dur > 0) || !store.project) return;
  const sx = MW / dur;
  const vx = viewStart * sx, vw = Math.max(4, Math.min(viewDur, dur) * sx);
  c.save();
  c.globalAlpha = 0.16; c.fillStyle = colors.blue; c.fillRect(vx, 1, vw, MH - 2);
  c.globalAlpha = 1; c.strokeStyle = colors.blue; c.lineWidth = 1.5;
  roundRect(c, vx + 0.75, 1, Math.max(1, vw - 1.5), MH - 2, 3); c.stroke();
  const px = Math.round(clamp(+store.ui.time || 0, 0, dur) * sx) + 0.5;
  c.fillStyle = colors.ink; c.fillRect(px - 0.75, 0, 1.5, MH);
  c.restore();
}

// ---------------------------------------------------------------- frame

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function invalidate() { staticValid = false; miniValid = false; scheduleDraw(); }

function draw() {
  if (!cv || !ctx || W <= 0 || H <= 0 || !colors) { drawMini(); return; }
  if (!staticValid) { drawStatic(); staticValid = true; }
  const c = ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(stat, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  const p = store.project;
  if (p) {
    const t = +store.ui.time || 0;
    const fl = flatList();
    // Playing token outline.
    if (fl.length && store.ui.playing) {
      const i = findTok(fl, t);
      const tok = fl[i] && fl[i].tok;
      if (tok && tok.type === 'word' && t < tok.end) {
        const x0 = X(tok.start), x1 = X(tok.end);
        if (x1 > 0 && x0 < W && x1 - x0 > 3) {
          c.save(); c.strokeStyle = colors.blue; c.lineWidth = 1.5;
          roundRect(c, x0 + 1, TOK_Y - 0.5, x1 - x0 - 2, TOK_H + 1, 4); c.stroke(); c.restore();
        }
      }
    }
    // Boundary hover / drag guide.
    const guide = drag && drag.kind === 'boundary' ? drag.t : (hover && !drag ? hover.t : null);
    if (guide != null) {
      const gx = Math.round(X(guide)) + 0.5;
      c.save();
      c.fillStyle = colors.blue;
      c.fillRect(gx - 1, TOK_Y - 3, 2, H - TOK_Y + 3);
      c.fillRect(gx - 3, TOK_Y - 3, 6, 3);
      if (drag && drag.kind === 'boundary') {
        const label = fmtTime(drag.t, { ms: true });
        c.font = `600 10px ${fontFamily}`;
        const tw = c.measureText(label).width + 10;
        const lx = clamp(gx - tw / 2, 1, W - tw - 1);
        roundRect(c, lx, 1, tw, RULER_H - 3, 4);
        c.fill();
        c.fillStyle = '#fff'; c.textBaseline = 'middle'; c.textAlign = 'left';
        c.fillText(label, lx + 5, RULER_H / 2 - 0.5);
      }
      c.restore();
    }
    // Playhead.
    const px = X(t);
    if (px >= -2 && px <= W + 2) {
      const x = Math.round(px) + 0.5;
      c.save();
      c.fillStyle = colors.blue;
      c.fillRect(x - 1, 0, 2, H);
      c.beginPath(); c.moveTo(x - 5, 0); c.lineTo(x + 5, 0); c.lineTo(x, 7); c.closePath(); c.fill();
      c.restore();
    }
    // Zoom indicator.
    c.save();
    c.font = `10px ${fontFamily}`;
    const z = `${Math.round(viewDur)}초 보기`;
    const zw = c.measureText(z).width + 10;
    c.fillStyle = colors.bg; c.fillRect(W - zw - 2, 0, zw + 2, RULER_H - 1);
    c.fillStyle = colors.gray; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText(z, W - zw + 3, 8);
    c.restore();
  }
  drawMini();
}

// ---------------------------------------------------------------- follow playhead

function onTime() {
  const t = +store.ui.time || 0;
  if (!drag && performance.now() - lastUserNav > FOLLOW_PAUSE_MS && W > 0) {
    const vEnd = viewStart + viewDur;
    if (store.ui.playing) {
      // Page flip once the playhead leaves the view.
      if (t > viewStart + viewDur * 0.98 || t < viewStart) setViewStart(t - viewDur * 0.05);
    } else if (t < viewStart || t > vEnd) {
      // A seek from elsewhere (editor click, panel jump): bring it into view.
      setViewStart(t - viewDur * 0.3);
    }
  }
  scheduleDraw();
}

// ---------------------------------------------------------------- peaks

function loadPeaks(id) {
  const gen = ++peaksGen;
  clearTimeout(peaksTimer);
  peaks = null;
  peaksState = id ? 'loading' : 'idle';
  staticValid = false;
  if (!id) return;
  let failures = 0;
  const started = Date.now();
  const attempt = async () => {
    if (gen !== peaksGen) return;
    try {
      const data = await api.peaks(id);
      if (gen !== peaksGen) return;
      peaks = data instanceof Uint8Array ? data : new Uint8Array(data || []);
      peaksState = 'ready';
      invalidate();
    } catch (e) {
      if (gen !== peaksGen) return;
      // 'not_ready' = prep still running → keep polling. Anything else (unknown project after a server
      // restart, network hiccup) gets a few slower retries, then the waveform is left out.
      const notReady = !!e && (e.code === 'not_ready' || e.code === 'http_404');
      if (notReady && Date.now() - started < 30 * 60 * 1000) {
        peaksTimer = setTimeout(attempt, 2000);
      } else if (!notReady && ++failures < 6) {
        peaksTimer = setTimeout(attempt, 5000);
      } else {
        console.warn('[timeline] waveform unavailable', e);
        peaksState = 'none';
        invalidate();
      }
    }
  };
  attempt();
}

// ---------------------------------------------------------------- interaction

function local(e, el) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function boundaryNear(x) {
  if (viewDur > HANDLE_MAX_VIEW) return null;
  const fl = flatList();
  if (fl.length < 2) return null;
  const t = viewStart + x * viewDur / W;
  const i = findTok(fl, t);
  let best = null, bestD = HANDLE_PX + 0.01;
  const consider = (idx) => {
    if (idx < 0 || idx + 1 >= fl.length) return;
    const bt = fl[idx].tok.end;
    const d = Math.abs(X(bt) - x);
    if (d < bestD) { bestD = d; best = idx; }
  };
  consider(i - 1);
  consider(i);
  if (best == null) return null;
  const min = fl[best].tok.start + 0.02, max = fl[best + 1].tok.end - 0.02;
  if (!(max > min)) return null;
  return { i: best, t: fl[best].tok.end, min, max };
}

function selectAt(t) {
  const fl = flatList();
  if (!fl.length) return;
  let fi = -1;
  try { fi = store.tokenAt(t); } catch (e) { fi = -1; }
  if (fi == null || fi < 0) fi = findTok(fl, t);
  try { store.select(fi); } catch (e) { /* ignore */ }
}

let seekRaf = 0, seekTarget = 0;
function seekSoon(t) {
  seekTarget = t;
  if (seekRaf) return;
  seekRaf = requestAnimationFrame(() => { seekRaf = 0; player.seek(seekTarget); });
}

function onPointerDown(e) {
  if (e.button !== 0 || !store.project || W <= 0) return;
  const { x, y } = local(e, cv);
  try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  e.preventDefault();
  const b = y >= TOK_Y - 3 && y <= TOK_Y + TOK_H + 3 ? boundaryNear(x) : null;
  if (b) {
    drag = { kind: 'boundary', i: b.i, t0: b.t, t: b.t, min: b.min, max: b.max };
    hover = null;
    invalidate();
    return;
  }
  drag = { kind: 'seek', x };
  player.seek(timeAtX(x));
}

function onPointerMove(e) {
  if (!cv || W <= 0) return;
  const { x, y } = local(e, cv);
  if (!drag) {
    const b = store.project && y >= TOK_Y - 3 && y <= TOK_Y + TOK_H + 3 ? boundaryNear(x) : null;
    const prev = hover;
    hover = b ? { i: b.i, t: b.t } : null;
    cv.style.cursor = b ? 'col-resize' : 'pointer';
    if ((prev && prev.i) !== (hover && hover.i)) scheduleDraw();
    return;
  }
  if (drag.kind === 'boundary') {
    const t = clamp(viewStart + x * viewDur / W, drag.min, drag.max);
    if (t !== drag.t) { drag.t = t; staticValid = false; scheduleDraw(); }
  } else if (drag.kind === 'seek') {
    seekSoon(timeAtX(x));
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (d.kind === 'boundary') {
    if (e.type !== 'pointercancel' && Math.abs(d.t - d.t0) > 0.004) {
      try { store.moveBoundary(d.i, Math.round(d.t * 1000) / 1000); } catch (err) { console.error('[timeline] moveBoundary', err); }
    }
    invalidate();
    return;
  }
  if (d.kind === 'seek' && e.type !== 'pointercancel') {
    const { x } = local(e, cv);
    const t = timeAtX(x);
    if (seekRaf) { cancelAnimationFrame(seekRaf); seekRaf = 0; }
    player.seek(t);
    selectAt(t);
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape' && drag && drag.kind === 'boundary') {
    e.preventDefault();
    e.stopImmediatePropagation();
    drag = null;
    invalidate();
  }
}

function onWheel(e) {
  if (!store.project || W <= 0) return;
  e.preventDefault();
  lastUserNav = performance.now();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? W : 1;
  if (e.metaKey || e.ctrlKey) {
    // ⌘+wheel, or trackpad pinch (reported as ctrl+wheel with small deltas).
    const k = e.ctrlKey && !e.metaKey ? 0.01 : 0.0025;
    const factor = Math.exp(clamp(e.deltaY * unit * k, -0.5, 0.5));
    const el = e.currentTarget;
    let ax, at;
    if (el === mm) { at = +store.ui.time || viewStart + viewDur / 2; ax = clamp(X(at), 0, W); }
    else { ax = local(e, cv).x; at = viewStart + ax * viewDur / W; }
    setViewDur(viewDur * factor, at, ax);
  } else {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const scale = e.currentTarget === mm ? srcDuration() / Math.max(1, MW) : viewDur / W;
    setViewStart(viewStart + d * unit * scale);
  }
  scheduleDraw();
}

// Minimap: drag the viewport; a click without movement seeks there.
function onMiniDown(e) {
  if (e.button !== 0 || !store.project || MW <= 0) return;
  const dur = srcDuration();
  if (!(dur > 0)) return;
  e.preventDefault();
  try { mm.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const { x } = local(e, mm);
  const t = x / MW * dur;
  const inside = t >= viewStart && t <= viewStart + viewDur;
  drag = { kind: 'mini', x0: x, moved: false, grab: inside ? t - viewStart : viewDur / 2 };
  lastUserNav = performance.now();
  if (!inside) { setViewStart(t - drag.grab); scheduleDraw(); }
}

function onMiniMove(e) {
  if (!drag || drag.kind !== 'mini') return;
  const { x } = local(e, mm);
  if (Math.abs(x - drag.x0) > 3) drag.moved = true;
  const dur = srcDuration();
  lastUserNav = performance.now();
  setViewStart(x / MW * dur - drag.grab);
  scheduleDraw();
}

function onMiniUp(e) {
  if (!drag || drag.kind !== 'mini') return;
  const d = drag;
  drag = null;
  try { mm.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (!d.moved && e.type !== 'pointercancel') {
    const { x } = local(e, mm);
    const t = clamp(x / MW * srcDuration(), 0, srcDuration());
    player.seek(t);
    selectAt(t);
  }
}

// ---------------------------------------------------------------- public

export const timeline = {
  /** Seconds visible in the timeline. */
  get viewDur() { return viewDur; },
  zoomTo(sec) { setViewDur(sec, +store.ui.time || 0, W / 2); scheduleDraw(); },
  reloadPeaks() { loadPeaks(store.project ? store.project.id : null); },
  redraw: invalidate,
};

export function initTimeline() {
  cv = document.getElementById('timeline');
  mm = document.getElementById('minimap');
  if (!cv || !mm) { console.error('[timeline] #timeline / #minimap missing'); return timeline; }
  ctx = cv.getContext('2d');
  mctx = mm.getContext('2d');
  readColors();

  cv.addEventListener('pointerdown', onPointerDown);
  // double-click on the timeline: cut the word in two right there
  cv.addEventListener('dblclick', (e) => {
    if (!store.project || W <= 0) return;
    const { x } = local(e, cv);
    const t = timeAtX(x);
    const fi = store.splitTokenAt(t);
    if (fi >= 0) store.select(fi);
    try { player.seek(t); } catch (err) { /* ignore */ }
  });
  cv.addEventListener('pointermove', onPointerMove);
  cv.addEventListener('pointerup', onPointerUp);
  cv.addEventListener('pointercancel', onPointerUp);
  cv.addEventListener('pointerleave', () => { if (hover && !drag) { hover = null; scheduleDraw(); } });
  cv.addEventListener('wheel', onWheel, { passive: false });
  mm.addEventListener('pointerdown', onMiniDown);
  mm.addEventListener('pointermove', onMiniMove);
  mm.addEventListener('pointerup', onMiniUp);
  mm.addEventListener('pointercancel', onMiniUp);
  mm.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDown, true);
  cv.style.cursor = 'pointer';
  mm.style.cursor = 'pointer';

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resize());
    ro.observe(cv);
    ro.observe(mm);
  }
  window.addEventListener('resize', resize);
  // devicePixelRatio changes when the window moves to another display.
  const watchDpr = () => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const fn = () => { resize(); watchDpr(); };
    if (mq.addEventListener) mq.addEventListener('change', fn, { once: true });
  };
  watchDpr();

  store.on('time', onTime);
  store.on('change', invalidate);
  store.on('flags', invalidate);
  store.on('selection', () => { staticValid = false; scheduleDraw(); });
  store.on('play', scheduleDraw);
  store.on('load', () => {
    const p = store.project;
    const id = p ? p.id : null;
    readColors();
    if (id !== projectId) {
      projectId = id;
      viewStart = 0;
      viewDur = DEFAULT_VIEW;
      loadPeaks(id);
    } else if (peaksState !== 'ready' && peaksState !== 'loading') {
      loadPeaks(id);
    }
    hover = null;
    drag = null;
    invalidate();
  });

  resize();
  return timeline;
}
