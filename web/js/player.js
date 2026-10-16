// player.js [E] — video player: skip-playback over deleted parts, caption overlay, transport bar.
//
// Assumptions (not fixed by SPEC):
// - Skip mode / caption visibility live in `store.ui.skipDeleted` / `store.ui.showCaptions` (added by this
//   module) and are persisted as the global settings `skipDeleted` / `showCaptions`. panels.js passes the
//   bootstrap settings in via `player.applySettings()`.
// - Other modules may "seek" either by calling `player.seek(t)` or by calling `store.setTime(t)` directly;
//   a 'time' event whose value differs from the last time this module pushed is treated as a seek.
// - `store.keptRanges()` may return `[[s,e],…]` or `[{s,e}|{start,end},…]`; both are accepted.
// - `store.clipSpan(ci).keptStart` is null/undefined when the clip is fully deleted.
// - Before transcription (no tokens yet) nothing can be "deleted", so skipping is inactive.
import { store } from './store.js';
import { register } from './commands.js';
import { api } from './api.js';
import { fmtTime, clamp, toast } from './util.js';

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const END_EPS = 0.004;      // seconds: treat "almost at the end" as the end
const MAX_LOOKAHEAD = 0.03; // seconds: jump at most this early over a cut

let video = null;
let wrap = null;
let overlay = null;
let msgEl = null;
let ui = null;              // transport elements

let projectId = null;
let loadedSourcePath = null;
let loadGen = 0;
let usingProxy = false;
let proxyTask = null;
let sourceMissing = false;
let onLocate = null;
let pendingTime = null;
let metaReady = false;

// play mode: 'normal' (follows skip setting), 'clip' (always skips, stops at `end`), 'range' (no skip, stops at `end`)
let mode = { kind: 'normal', end: Infinity };
let rafId = 0;
let lastFrameTs = 0;
let frameDt = 1 / 60;
let lastPushed = -1;
let lastCaption = null;
let lastTexts = { out: '', total: '', src: '' };

// ---------------------------------------------------------------- kept ranges (shared with timeline.js)

let keptRaw = null;
let keptCache = { n: 0, starts: new Float64Array(0), ends: new Float64Array(0) };

/** Kept ranges as parallel typed arrays, rebuilt only when the store's (cached) result changes. */
export function keptRangeList() {
  let raw = null;
  try { raw = store.project ? store.keptRanges() : null; } catch (e) { raw = null; }
  if (!raw) raw = [];
  if (raw === keptRaw && keptCache) return keptCache;
  const n = raw.length;
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    starts[i] = Array.isArray(r) ? +r[0] : +(r.s != null ? r.s : r.start);
    ends[i] = Array.isArray(r) ? +r[1] : +(r.e != null ? r.e : r.end);
  }
  keptRaw = raw;
  keptCache = { n, starts, ends };
  return keptCache;
}

/** Index of the last kept range whose start <= t, or -1. */
export function rangeIndexAt(K, t) {
  let lo = 0, hi = K.n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (K.starts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function hasTokens() {
  const p = store.project;
  return !!(p && Array.isArray(p.clips) && p.clips.length > 0);
}

function skipActive() {
  return store.ui.skipDeleted !== false && hasTokens();
}

function duration() {
  if (video && isFinite(video.duration) && video.duration > 0) return video.duration;
  const p = store.project;
  return (p && p.source && p.source.duration) || 0;
}

// ---------------------------------------------------------------- time plumbing

function pushTime(t) {
  if (!isFinite(t)) return;
  lastPushed = t;
  store.setTime(t);
}

function onStoreTime() {
  const t = +store.ui.time || 0;
  // A time we did not push ourselves = an external seek (e.g. the editor called store.setTime).
  if (Math.abs(t - lastPushed) > 0.02 && video && projectId) {
    mode = { kind: 'normal', end: Infinity };
    lastPushed = t;
    applyCurrentTime(t);
  }
  updateCaption(t);
  updateTimes(t);
}

function applyCurrentTime(t) {
  if (!video) return;
  if (metaReady) {
    try { video.currentTime = t; } catch (e) { pendingTime = t; }
  } else {
    pendingTime = t;
  }
}

// ---------------------------------------------------------------- playback loop

function startLoop() {
  if (!rafId) { lastFrameTs = 0; rafId = requestAnimationFrame(tick); }
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function tick(ts) {
  rafId = 0;
  if (!video || video.paused) return;
  if (lastFrameTs) frameDt = clamp((ts - lastFrameTs) / 1000, 0.004, 0.1);
  lastFrameTs = ts;
  if (step()) rafId = requestAnimationFrame(tick);
}

/** One playback step: enforce skip / stop points. Returns false when playback stopped. */
function step() {
  if (video.seeking) return true;   // a jump is in flight: don't judge (and re-jump) on a stale frame
  let t = video.currentTime;
  if (mode.kind === 'range') {
    if (t >= mode.end - END_EPS) { stopAt(mode.end); return false; }
    pushTime(t);
    return true;
  }
  const clipMode = mode.kind === 'clip';
  if (clipMode || skipActive()) {
    const K = keptRangeList();
    if (!K.n) { stopAt(t); return false; }
    const k = rangeIndexAt(K, t);
    const inside = k >= 0 && t < K.ends[k];
    // Inside a kept range: jump slightly early (¾ of a frame) so no audio of the cut part leaks in before
    // the next frame — hearing a sliver of a deleted "음" is worse than losing a few ms of kept audio.
    // Outside (e.g. a seek while playing landed in a deleted part): jump right away.
    const look = inside ? Math.min(MAX_LOOKAHEAD, frameDt * (video.playbackRate || 1) * 0.75) : 0;
    if (!inside || t >= K.ends[k] - look) {
      const next = k + 1 < K.n ? K.starts[k + 1] : null;
      if (next == null) {
        const lastEnd = K.ends[K.n - 1];
        if (clipMode) { stopAt(Math.min(mode.end, lastEnd)); return false; }
        if (!inside || lastEnd < duration() - END_EPS) { stopAt(lastEnd); return false; }
        // The last kept range runs to the end of the file: let the video end naturally.
      } else if (clipMode && next >= mode.end - END_EPS) {
        stopAt(mode.end);
        return false;
      } else if (!inside && next - t < 0.015) {
        // A seek landed a hair before the next kept start (seek precision): don't re-seek every frame.
      } else {
        jumpTo(next);
        t = next;
      }
    }
  }
  if (clipMode && t >= mode.end - END_EPS) { stopAt(mode.end); return false; }
  pushTime(t);
  return true;
}

function jumpTo(t) {
  try { video.currentTime = t; } catch (e) { /* ignore; next tick retries */ }
}

function stopAt(t) {
  mode = { kind: 'normal', end: Infinity };
  if (video) {
    video.pause();
    if (isFinite(t)) jumpTo(t);
  }
  stopLoop();
  pushTime(isFinite(t) ? t : (video ? video.currentTime : 0));
}

// ---------------------------------------------------------------- media loading

function setMessage(text, opts = {}) {
  if (!msgEl) return;
  msgEl.replaceChildren();
  if (!text) { msgEl.hidden = true; return; }
  msgEl.hidden = false;
  if (opts.spinner) {
    const sp = document.createElement('div');
    sp.className = 'lp-spinner lp-spinner-light';
    msgEl.append(sp);
  }
  const p = document.createElement('div');
  p.className = 'lp-player-msg-text';
  p.textContent = text;
  msgEl.append(p);
  if (opts.button) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-btn lp-btn-light small';
    b.textContent = opts.button.label;
    b.addEventListener('click', opts.button.onClick);
    msgEl.append(b);
  }
}

function setSrc(proxy) {
  metaReady = false;
  usingProxy = !!proxy;
  try {
    video.src = api.mediaUrl(projectId, { proxy: !!proxy });
    video.load();
  } catch (e) {
    console.error('[player] could not set media source', e);
    setMessage('영상을 불러오지 못했어요');
  }
}

function unloadMedia() {
  if (!video) return;
  stopLoop();
  try { video.pause(); } catch (e) { /* ignore */ }
  video.removeAttribute('src');
  try { video.load(); } catch (e) { /* ignore */ }
  metaReady = false;
}

async function load(id) {
  if (!video) return;
  // A proxy is being prepared for this very project (the <video> has no src meanwhile, which makes
  // main.js's "no media yet" fallback call load() again): keep waiting instead of starting over.
  if (id && id === projectId && proxyTask && !sourceMissing) return;
  const gen = ++loadGen;
  projectId = id || null;
  proxyTask = null;
  usingProxy = false;
  mode = { kind: 'normal', end: Infinity };
  pendingTime = +store.ui.time || 0;
  const p = store.project;
  loadedSourcePath = p && p.source ? p.source.path : null;
  if (!projectId) { unloadMedia(); setMessage(''); return; }
  if (sourceMissing) {
    unloadMedia();
    setMessage('원본 영상을 찾을 수 없어요', onLocate ? { button: { label: '영상 찾기', onClick: () => onLocate && onLocate() } } : {});
    return;
  }
  setMessage('');
  let status = null;
  try { status = await api.get(`/api/project/${projectId}/status`); } catch (e) { status = null; }
  if (gen !== loadGen) return;
  if (status && status.playable === false) {
    if (status.hasProxy) setSrc(true);
    else await buildProxy(gen, status);
    return;
  }
  if (status && status.hasProxy) { setSrc(true); return; }
  setSrc(false);
  waitForLightProxy(gen);
}

/** The original plays but seeks slowly; switch to the light preview copy once prep has made it. */
async function waitForLightProxy(gen) {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    if (gen !== loadGen || usingProxy || !projectId) return;
    let st = null;
    try { st = await api.get(`/api/project/${projectId}/status`); } catch (e) { st = null; }
    if (gen !== loadGen || usingProxy) return;
    if (st && st.hasProxy) {
      while (video && !video.paused) {          // never swap the source under a playing video
        await new Promise((r) => setTimeout(r, 1000));
        if (gen !== loadGen) return;
      }
      pendingTime = video ? video.currentTime : (+store.ui.time || 0);
      setSrc(true);
      return;
    }
    if (st && st.prep && ['error', 'canceled'].includes(st.prep.state)) return;
  }
}

/** Make (or wait for) the browser-playable proxy, then switch to it keeping the current time. */
function buildProxy(gen, status) {
  if (proxyTask) return proxyTask;
  const id = projectId;
  const keep = metaReady && video ? video.currentTime : (pendingTime != null ? pendingTime : +store.ui.time || 0);
  toast('이 영상은 미리보기용 사본을 만들고 있어요', 'info', 4000);
  setMessage('미리보기용 사본을 만들고 있어요…', { spinner: true });
  unloadMedia();
  const onUpdate = (job) => {
    if (gen !== loadGen || !job) return;
    if (job.state === 'queued') setMessage('다른 작업이 끝나면 사본을 만들어요', { spinner: true });
    else setMessage(`미리보기용 사본을 만들고 있어요… ${Math.round((job.progress || 0) * 100)}%`, { spinner: true });
  };
  proxyTask = (async () => {
    try {
      let st = status;
      if (!st) { try { st = await api.get(`/api/project/${id}/status`); } catch (e) { st = null; } }
      // The prep job builds the proxy itself when the source is not playable; wait for it first.
      const prep = st && st.prep;
      if (prep && prep.id && (prep.state === 'running' || prep.state === 'queued')) {
        try { await api.pollJob(prep.id, onUpdate, 800); } catch (e) { /* fall through to an explicit proxy job */ }
        if (gen !== loadGen) return;
        try { st = await api.get(`/api/project/${id}/status`); } catch (e) { st = null; }
      }
      if (!(st && st.hasProxy)) {
        const res = await api.post(`/api/project/${id}/proxy`);
        if (res && res.job) {
          onUpdate(res.job);
          await api.pollJob(res.job.id, onUpdate, 800);
        }
      }
      if (gen !== loadGen) return;
      pendingTime = keep;
      setMessage('');
      setSrc(true);
    } catch (e) {
      if (gen !== loadGen) return;
      console.error('[player] proxy failed', e);
      const msg = (e && e.job && e.job.error) || (e && e.message) || '';
      setMessage('이 영상은 미리 볼 수 없어요', { button: { label: '다시 시도', onClick: () => { proxyTask = null; buildProxy(loadGen, null); } } });
      toast(msg ? `미리보기용 사본을 만들지 못했어요: ${msg}` : '미리보기용 사본을 만들지 못했어요', 'error', 5000);
    } finally {
      if (gen === loadGen) proxyTask = null;
    }
  })();
  return proxyTask;
}

function onMediaError() {
  if (!video || !projectId || sourceMissing) return;
  const err = video.error;
  if (!video.getAttribute('src')) return;     // we unloaded on purpose
  console.warn('[player] media error', err && err.code, err && err.message);
  if (usingProxy) {
    setMessage('이 영상은 미리 볼 수 없어요');
    toast('영상을 재생하지 못했어요', 'error');
    return;
  }
  // MEDIA_ERR_DECODE (3) / MEDIA_ERR_SRC_NOT_SUPPORTED (4) → codec problem; network errors also fall back,
  // because a proxy is the most likely fix for anything the browser cannot read.
  buildProxy(loadGen, null);
}

function checkVideoTrack() {
  // Chrome can play the audio of a file whose video codec it cannot decode (videoWidth stays 0).
  const p = store.project;
  if (!video || usingProxy || !p || !p.source || p.source.hasVideo === false) return;
  if (metaReady && video.videoWidth === 0 && video.readyState >= 1) buildProxy(loadGen, null);
}

// ---------------------------------------------------------------- caption overlay

function updateCaption(t) {
  if (!overlay) return;
  let text = '';
  if (store.ui.showCaptions !== false && hasTokens()) {
    try {
      const fi = store.tokenAt(t);
      const f = fi != null && fi >= 0 ? store.flat()[fi] : null;
      if (f && !f.tok.del) {
        const clip = f.clip || store.project.clips[f.ci];
        text = clip ? (store.captionOf(clip) || '') : '';
      }
    } catch (e) { text = ''; }
  }
  if (text === lastCaption) return;
  lastCaption = text;
  overlay.textContent = text;
  overlay.classList.toggle('lp-empty', !text.trim());
}

/** Place the overlay inside the area the video actually covers (object-fit: contain → letterboxing). */
function layoutOverlay() {
  if (!overlay || !wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  let vw = video && video.videoWidth, vh = video && video.videoHeight;
  if (!vw || !vh) {
    const s = store.project && store.project.source;
    vw = (s && s.width) || 16; vh = (s && s.height) || 9;
    if (s && (s.rotation === 90 || s.rotation === 270 || s.rotation === -90)) { const x = vw; vw = vh; vh = x; }
  }
  const ar = vw / vh;
  let rw = W, rh = W / ar;
  if (rh > H) { rh = H; rw = H * ar; }
  const ox = (W - rw) / 2, oy = (H - rh) / 2;
  const st = overlay.style;
  st.left = `${Math.round(ox + rw * 0.04)}px`;
  st.width = `${Math.round(rw * 0.92)}px`;
  st.bottom = `${Math.round(oy + rh * 0.07)}px`;
  st.fontSize = `${Math.max(10, rh * 0.052).toFixed(1)}px`;
}

// ---------------------------------------------------------------- transport bar

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';

function renderTransport() {
  const host = document.getElementById('transport');
  if (!host) return;
  host.replaceChildren();
  host.classList.add('lp-transport');

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'lp-play';
  playBtn.title = '재생 (Space)';
  playBtn.setAttribute('aria-label', '재생');
  playBtn.innerHTML = ICON_PLAY;
  playBtn.addEventListener('click', () => { toggle(); playBtn.blur(); });

  const times = document.createElement('div');
  times.className = 'lp-times';
  const main = document.createElement('div');
  main.className = 'lp-time-main';
  main.title = '편집 후 시간 / 편집 후 전체 길이';
  const out = document.createElement('span'); out.className = 'lp-time-out'; out.textContent = '00:00.0';
  const sep = document.createElement('span'); sep.className = 'lp-time-sep'; sep.textContent = ' / ';
  const total = document.createElement('span'); total.className = 'lp-time-total'; total.textContent = '00:00';
  main.append(out, sep, total);
  const src = document.createElement('div');
  src.className = 'lp-time-src';
  src.title = '원본 영상 기준 시간';
  src.textContent = '원본 00:00.0';
  times.append(main, src);

  const spacer = document.createElement('div');
  spacer.className = 'lp-spacer';

  const rate = document.createElement('select');
  rate.className = 'lp-rate';
  rate.title = '재생 속도 (⌘, / ⌘.)';
  rate.setAttribute('aria-label', '재생 속도');
  for (const r of RATES) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${r}x`;
    if (r === 1) o.selected = true;
    rate.append(o);
  }
  rate.addEventListener('change', () => { setRate(+rate.value); rate.blur(); });

  const mkSwitch = (label, title, checked, onChange) => {
    const l = document.createElement('label');
    l.className = 'lp-switch';
    l.title = title;
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = checked;
    i.addEventListener('change', () => { onChange(i.checked); i.blur(); });
    const knob = document.createElement('span'); knob.className = 'lp-switch-ui';
    const s = document.createElement('span'); s.className = 'lp-switch-label'; s.textContent = label;
    l.append(i, knob, s);
    return { l, i };
  };
  const skip = mkSwitch('삭제 부분 건너뛰기', '지운 부분을 건너뛰고 재생해요', store.ui.skipDeleted !== false, (v) => setSkip(v, true));
  const caps = mkSwitch('자막 보기', '영상 위에 자막을 보여줘요', store.ui.showCaptions !== false, (v) => setShowCaptions(v, true));

  const toggles = document.createElement('div');
  toggles.className = 'lp-toggles';
  toggles.append(skip.l, caps.l);

  host.append(playBtn, times, spacer, rate, toggles);
  ui = { playBtn, out, total, src, rate, skip: skip.i, caps: caps.i };
  lastTexts = { out: '', total: '', src: '' };
}

function updatePlayButton() {
  if (!ui) return;
  const playing = !!(video && !video.paused);
  ui.playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  ui.playBtn.title = playing ? '일시정지 (Space)' : '재생 (Space)';
  ui.playBtn.setAttribute('aria-label', playing ? '일시정지' : '재생');
  ui.playBtn.classList.toggle('is-playing', playing);
}

function updateTimes(t) {
  if (!ui) return;
  let outT = t, total = duration();
  if (hasTokens()) {
    try { outT = store.srcToOut(t); total = store.outDuration(); } catch (e) { /* keep source values */ }
  }
  const o = fmtTime(Math.max(0, outT || 0), { ms: true });
  const tt = fmtTime(Math.max(0, total || 0));
  const s = `원본 ${fmtTime(Math.max(0, t || 0), { ms: true })}`;
  if (o !== lastTexts.out) { ui.out.textContent = o; lastTexts.out = o; }
  if (tt !== lastTexts.total) { ui.total.textContent = tt; lastTexts.total = tt; }
  if (s !== lastTexts.src) { ui.src.textContent = s; lastTexts.src = s; }
}

function syncRateSelect() {
  if (!ui || !video) return;
  const r = video.playbackRate;
  const v = String(RATES.includes(r) ? r : 1);
  if (ui.rate.value !== v) ui.rate.value = v;
}

// ---------------------------------------------------------------- settings toggles

function persist(partial) {
  api.post('/api/settings', { settings: partial }).catch((e) => console.warn('[player] settings not saved', e));
}

function setSkip(on, save) {
  store.ui.skipDeleted = !!on;
  if (ui && ui.skip.checked !== !!on) ui.skip.checked = !!on;
  if (save) {
    persist({ skipDeleted: !!on });
    toast(on ? '지운 부분을 건너뛰고 재생해요' : '지운 부분도 재생해요', 'info', 1600);
  }
}

function setShowCaptions(on, save) {
  store.ui.showCaptions = !!on;
  if (ui && ui.caps.checked !== !!on) ui.caps.checked = !!on;
  lastCaption = null;
  updateCaption(+store.ui.time || 0);
  if (save) persist({ showCaptions: !!on });
}

// ---------------------------------------------------------------- public API

function seek(t) {
  const d = duration();
  t = clamp(+t || 0, 0, d > 0 ? d : Math.max(0, +t || 0));
  mode = { kind: 'normal', end: Infinity };
  applyCurrentTime(t);
  pushTime(t);
}

function firstKeptTime() {
  const K = keptRangeList();
  return K.n ? K.starts[0] : 0;
}

function lastKeptEnd() {
  const K = keptRangeList();
  return K.n ? K.ends[K.n - 1] : duration();
}

function play() {
  if (!video || !projectId || sourceMissing) return;
  if (!metaReady && !video.getAttribute('src')) return;
  if (skipActive() || mode.kind === 'clip') {
    const K = keptRangeList();
    if (!K.n) { toast('모두 지워서 재생할 부분이 없어요', 'warn'); return; }
    const t = metaReady ? video.currentTime : (pendingTime || 0);
    if (mode.kind === 'normal' && t >= K.ends[K.n - 1] - END_EPS) applyCurrentTime(K.starts[0]);   // at the end → restart
  } else if (metaReady && video.currentTime >= duration() - END_EPS) {
    applyCurrentTime(0);
  }
  const pr = video.play();
  if (pr && pr.catch) pr.catch((e) => { if (e && e.name !== 'AbortError') console.warn('[player] play failed', e); });
}

function pause() {
  if (!video) return;
  mode = { kind: 'normal', end: Infinity };
  video.pause();
}

function toggle() {
  if (!video) return;
  if (video.paused) { mode = { kind: 'normal', end: Infinity }; play(); } else pause();
}

/** Play [s, e) of the source once, ignoring skip mode; pauses at e. */
function playRange(s, e) {
  if (!video || !projectId) return;
  const d = duration();
  s = clamp(+s || 0, 0, d || +s || 0);
  e = clamp(+e || 0, s, d || +e || 0);
  if (e - s < 0.01) return;
  applyCurrentTime(s);
  pushTime(s);
  mode = { kind: 'range', end: e };
  const pr = video.play();
  if (pr && pr.catch) pr.catch(() => {});
}

/** Play the kept content of clip ci, then pause. A fully deleted clip plays as-is. */
function playClip(ci) {
  if (!video || !projectId || !hasTokens()) return;
  const clips = store.project.clips;
  if (ci == null || ci < 0 || ci >= clips.length) return;
  let span = null;
  try { span = store.clipSpan(ci); } catch (e) { span = null; }
  if (!span) return;
  if (span.keptStart == null || span.keptEnd == null || !(span.keptEnd > span.keptStart)) {
    playRange(span.start, span.end);
    return;
  }
  applyCurrentTime(span.keptStart);
  pushTime(span.keptStart);
  mode = { kind: 'clip', end: span.keptEnd };
  const pr = video.play();
  if (pr && pr.catch) pr.catch(() => {});
}

function setRate(r) {
  const v = clamp(+r || 1, RATES[0], RATES[RATES.length - 1]);
  if (video) video.playbackRate = v;
  syncRateSelect();
}

function stepRate(dir) {
  const cur = video ? video.playbackRate : 1;
  let i = RATES.findIndex((x) => Math.abs(x - cur) < 1e-6);
  if (i < 0) i = RATES.indexOf(1);
  const j = clamp(i + dir, 0, RATES.length - 1);
  setRate(RATES[j]);
  toast(`재생 속도 ${RATES[j]}x`, 'info', 1200);
}

/** Clip index the "current" commands act on: selection first, else the clip under the playhead. */
function currentClipIndex() {
  const u = store.ui;
  if (u.clipSel) return Math.min(u.clipSel.a, u.clipSel.f);
  if (u.sel) {
    const f = store.flat()[Math.min(u.sel.a, u.sel.f)];
    if (f) return f.ci;
  }
  const ci = store.clipAt(+u.time || 0);
  return ci != null && ci >= 0 ? ci : 0;
}

function selectionStartTime() {
  const u = store.ui;
  if (u.sel) {
    const f = store.flat()[Math.min(u.sel.a, u.sel.f)];
    if (f) return f.tok.start;
  }
  if (u.clipSel) {
    try { return store.clipSpan(Math.min(u.clipSel.a, u.clipSel.f)).start; } catch (e) { /* ignore */ }
  }
  return null;
}

export const player = {
  load,
  seek,
  play,
  pause,
  toggle,
  playClip,
  playRange,
  setRate,
  get time() { return video && metaReady ? video.currentTime : (+store.ui.time || 0); },
  get playing() { return !!(video && !video.paused); },
  get rate() { return video ? video.playbackRate : 1; },
  /** Apply persisted settings ({skipDeleted, showCaptions}) without saving them again. */
  applySettings(s) {
    if (!s) return;
    if (s.skipDeleted != null) setSkip(!!s.skipDeleted, false);
    if (s.showCaptions != null) setShowCaptions(!!s.showCaptions, false);
  },
  setSkip: (on) => setSkip(on, true),
  setShowCaptions: (on) => setShowCaptions(on, true),
  /** Mark the source as missing (before store.load) so the player shows a "find video" prompt. */
  setMissing(missing, locateFn) {
    sourceMissing = !!missing;
    if (locateFn) onLocate = locateFn;
    if (!missing && msgEl && !proxyTask) setMessage('');
  },
  /** Force a reload of the media for the current project (e.g. after relinking). */
  reload() { if (store.project) load(store.project.id); },
};

// ---------------------------------------------------------------- init

export function initPlayer() {
  video = document.getElementById('video');
  wrap = document.getElementById('player-wrap');
  overlay = document.getElementById('caption-overlay');
  if (!video || !wrap) { console.error('[player] #video / #player-wrap missing'); return player; }

  if (store.ui.skipDeleted == null) store.ui.skipDeleted = true;
  if (store.ui.showCaptions == null) store.ui.showCaptions = true;

  video.playsInline = true;
  video.preload = 'auto';
  video.controls = false;
  video.disablePictureInPicture = true;

  msgEl = document.createElement('div');
  msgEl.className = 'lp-player-msg';
  msgEl.hidden = true;
  wrap.append(msgEl);
  if (overlay) overlay.classList.add('lp-empty');

  video.addEventListener('loadedmetadata', () => {
    metaReady = true;
    if (pendingTime != null) {
      const t = clamp(pendingTime, 0, duration() || pendingTime);
      pendingTime = null;
      try { video.currentTime = t; } catch (e) { /* ignore */ }
      pushTime(t);
    }
    layoutOverlay();
    updateTimes(+store.ui.time || 0);
    checkVideoTrack();
  });
  video.addEventListener('loadeddata', () => { setTimeout(checkVideoTrack, 1200); });
  video.addEventListener('play', () => { store.setPlaying(true); updatePlayButton(); startLoop(); });
  video.addEventListener('playing', () => { startLoop(); });
  video.addEventListener('pause', () => {
    stopLoop();
    mode = { kind: 'normal', end: Infinity };
    store.setPlaying(false);
    updatePlayButton();
    pushTime(video.currentTime);
  });
  video.addEventListener('ended', () => { stopLoop(); store.setPlaying(false); updatePlayButton(); pushTime(video.currentTime); });
  video.addEventListener('seeked', () => { if (video.paused) pushTime(video.currentTime); });
  video.addEventListener('timeupdate', () => {
    if (video.paused) { if (Math.abs(video.currentTime - lastPushed) > 0.001 && !video.seeking) pushTime(video.currentTime); return; }
    // rAF does not run in hidden windows; keep skipping working there.
    if (document.hidden && step() === false) updatePlayButton();
  });
  video.addEventListener('ratechange', syncRateSelect);
  video.addEventListener('error', onMediaError);

  renderTransport();
  updatePlayButton();

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => layoutOverlay()).observe(wrap);
  window.addEventListener('resize', layoutOverlay);

  store.on('time', onStoreTime);
  store.on('load', () => {
    const p = store.project;
    lastCaption = null;
    // Re-loading the same project (e.g. after transcription finished) must not interrupt the video.
    const same = p && p.id === projectId && p.source && p.source.path === loadedSourcePath && !sourceMissing
      && (metaReady || proxyTask);
    if (!same) load(p ? p.id : null);
    layoutOverlay();
    updateCaption(+store.ui.time || 0);
    updateTimes(+store.ui.time || 0);
  });
  store.on('change', () => {
    lastCaption = null;
    updateCaption(+store.ui.time || 0);
    lastTexts.total = '';
    updateTimes(+store.ui.time || 0);
  });
  store.on('play', () => {
    // Someone else flipped store.ui.playing → follow it.
    if (!video) return;
    const want = !!store.ui.playing;
    if (want && video.paused) play();
    else if (!want && !video.paused) pause();
  });

  register('play-toggle', () => toggle(), { label: '재생/일시정지', keys: 'Space' });
  register('play-clip', () => {
    if (video && !video.paused && mode.kind === 'clip') { pause(); return; }
    playClip(currentClipIndex());
  }, { label: '현재 클립 재생', keys: 'Tab' });
  register('play-all', () => {
    if (video && !video.paused) { pause(); return; }
    const s = selectionStartTime();
    if (s != null) seek(s);
    play();
  }, { label: '선택한 곳부터 재생', keys: '⇧Tab' });
  register('speed-up', () => stepRate(+1), { label: '빠르게 재생', keys: '⌘.' });
  register('speed-down', () => stepRate(-1), { label: '느리게 재생', keys: '⌘,' });
  register('jump-start', () => seek(skipActive() ? firstKeptTime() : 0), { label: '처음으로', keys: 'Home' });
  register('jump-end', () => seek(skipActive() ? lastKeptEnd() : duration()), { label: '끝으로', keys: 'End' });
  register('toggle-skip', () => setSkip(store.ui.skipDeleted === false, true), { label: '삭제 부분 건너뛰기' });

  return player;
}
