// Headless tests for web/js/store.js (plus syntax/load checks of every frontend module D owns).
//
// Run:  cd LazyCut && /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/js/store_test.js
//
// - Parity vectors: tests/fixtures/parity.json (SPEC §2.4) when present, plus inline vectors below.
// - Op tests: every store op keeps the partition invariant, is one undo step, and undo/redo restore
//   the exact previous JSON; randomized fuzzing cross-checks caches against a naive implementation.
// - Performance: 1,500 clips / 12,000 tokens.
// Prints PASS/FAIL lines and a summary; the last line is "ALL PASS" or "FAILED: n".

import { store } from '../../web/js/store.js';

const out = typeof print === 'function' ? print : (...a) => console.log(...a);
const now = () => (typeof preciseTime === 'function' ? preciseTime() * 1000 : Date.now());

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    out(`PASS ${name}`);
  } catch (e) {
    failed++;
    out(`FAIL ${name} — ${e && e.message ? e.message : e}`);
    if (e && e.stack && /^(TypeError|ReferenceError|RangeError)/.test(String(e))) out(String(e.stack).split('\n').slice(0, 4).join('\n'));
  }
}

class AssertError extends Error {}
function assert(cond, msg) { if (!cond) throw new AssertError(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new AssertError(`${msg || 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function near(a, b, eps = 1e-6, msg) {
  if (!(Math.abs(a - b) <= eps)) throw new AssertError(`${msg || 'near'}: expected ${b}, got ${a}`);
}
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new AssertError(`${msg || 'deepEq'}:\n  expected ${sb.slice(0, 400)}\n  got      ${sa.slice(0, 400)}`);
}
function rangesNear(got, exp, eps = 1e-6, msg = 'ranges') {
  if (got.length !== exp.length) throw new AssertError(`${msg}: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`);
  for (let i = 0; i < exp.length; i++) {
    if (Math.abs(got[i][0] - exp[i][0]) > eps || Math.abs(got[i][1] - exp[i][1]) > eps) {
      throw new AssertError(`${msg}[${i}]: expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`);
    }
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

function readText(paths) {
  if (typeof read !== 'function') return null;
  for (const p of paths) {
    try { return read(p); } catch (_) { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------------------------

let idn = 0;
function W(text, start, end, extra = {}) {
  return Object.assign({ id: `w_t${(idn++).toString(36).padStart(6, '0')}`, type: 'word', text, orig: text, start, end, del: false, keep: null, flags: [], p: 0.9 }, extra);
}
function G(start, end, extra = {}) {
  return Object.assign({ id: `w_t${(idn++).toString(36).padStart(6, '0')}`, type: 'gap', text: '', orig: '', start, end, del: false, keep: null, flags: [], p: null }, extra);
}
function N(start, end, extra = {}) {
  return Object.assign({ id: `w_t${(idn++).toString(36).padStart(6, '0')}`, type: 'noise', text: '', orig: '', start, end, del: false, keep: null, flags: [], p: null }, extra);
}
function C(id, words, extra = {}) {
  return Object.assign({ id, caption: null, flags: [], ngOf: null, words }, extra);
}
function P(clips, duration, settings) {
  return {
    app: 'lazycut', format: 1, id: 'p_000000000001', name: 'test', file: '/tmp/test.lazycut',
    createdAt: '2026-10-08T10:00:00+09:00', updatedAt: '2026-10-08T10:00:00+09:00',
    source: { path: '/tmp/test.mov', duration, fps: 30, fpsNum: 30, fpsDen: 1, width: 1920, height: 1080, hasVideo: true, hasAudio: true },
    transcribe: { model: 'turbo', lang: 'ko', doneAt: null },
    settings: Object.assign({ maxChars: 22, silenceMin: 0.2, silenceKeep: 0.0, includeNoise: false }, settings || {}),
    clips, markers: [],
  };
}

/** Small hand-made project (10 s). */
function small() {
  idn = 0;
  return P([
    C('c_aaaaaaa1', [W('안녕하세요', 0, 1.0), G(1.0, 1.6), W('여러분', 1.6, 2.2)]),
    C('c_aaaaaaa2', [W('음', 2.2, 2.5, { flags: ['filler'] }), N(2.5, 3.3), W('오늘은', 3.3, 4.0), G(4.0, 5.2)]),
    C('c_aaaaaaa3', [W('편집을', 5.2, 6.0), W('해볼게요', 6.0, 7.0, { flags: ['repeat'] }), G(7.0, 10.0)]),
  ], 10.0);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYL = ['그래서', '저희는', 'AI', '때문에', '신입을', '뽑습니다', '팀', '제이커브가', '처음으로', '공채를', '엽니다', '음', '어', '진짜', '이게'];
/** Generated project: nClips clips × perClip tokens (mix of words, gaps, noise), contiguous partition. */
function generated(nClips, perClip, seed = 7) {
  const r = rng(seed);
  idn = 0;
  let t = 0;
  const clips = [];
  for (let ci = 0; ci < nClips; ci++) {
    const words = [];
    for (let k = 0; k < perClip; k++) {
      const x = r();
      const dur = Math.round((0.12 + r() * 0.7) * 1000) / 1000;
      const s = t, e = Math.round((t + dur) * 1000) / 1000;
      if (k > 0 && x < 0.18) words.push(G(s, e, r() < 0.2 ? { keep: 0.1 } : {}));
      else if (k > 0 && x < 0.24) words.push(N(s, e, r() < 0.3 ? { flags: ['filler?'] } : {}));
      else {
        const fl = r() < 0.05 ? ['filler'] : r() < 0.05 ? ['repeat'] : r() < 0.04 ? ['lowconf'] : [];
        words.push(W(SYL[Math.floor(r() * SYL.length)], s, e, { flags: fl, del: r() < 0.03 }));
      }
      t = e;
    }
    clips.push(C(`c_g${ci.toString(36).padStart(7, '0')}`, words, r() < 0.03 ? { caption: '수정한 자막' } : r() < 0.03 ? { flags: ['ng'] } : {}));
  }
  return P(clips, t);
}

// ---------------------------------------------------------------------------------------------
// Invariant checker + naive reference implementations
// ---------------------------------------------------------------------------------------------

function checkPartition(p, tokenOrder) {
  const toks = [];
  const clipIds = new Set();
  for (const c of p.clips) {
    assert(c.words.length >= 1, `clip ${c.id} has no tokens`);
    assert(!clipIds.has(c.id), `duplicate clip id ${c.id}`);
    clipIds.add(c.id);
    for (const t of c.words) toks.push(t);
  }
  assert(toks.length > 0, 'no tokens');
  near(toks[0].start, 0, 0.002, 'first start');
  near(toks[toks.length - 1].end, p.source.duration, 0.002, 'last end');
  const ids = new Set();
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    assert(!ids.has(t.id), `duplicate token id ${t.id}`);
    ids.add(t.id);
    assert(t.end > t.start, `token ${t.id} has non-positive duration ${t.start}..${t.end}`);
    if (i + 1 < toks.length) assert(Math.abs(t.end - toks[i + 1].start) <= 0.002, `gap/overlap between ${t.id} and ${toks[i + 1].id}: ${t.end} vs ${toks[i + 1].start}`);
  }
  if (tokenOrder) eq(toks.map((t) => t.id).join(','), tokenOrder, 'token order');
}

function naiveKept(p) {
  const out = [];
  const add = (s, e) => {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  };
  for (const c of p.clips) for (const t of c.words) {
    if (t.del) continue;
    const dur = t.end - t.start;
    if ((t.type === 'gap' || t.type === 'noise') && t.keep != null && t.keep < dur) {
      const k = Math.max(0, t.keep) / 2;
      if (k > 0) { add(t.start, t.start + k); add(t.end - k, t.end); }
    } else add(t.start, t.end);
  }
  return out.filter(([s, e]) => e - s >= 0.001);
}

function naiveSrcToOut(ranges, t) {
  let cum = 0;
  for (const [s, e] of ranges) {
    if (t < s) return cum;
    if (t <= e) return cum + (t - s);
    cum += e - s;
  }
  return cum;
}

function naiveAuto(c) {
  return c.words.filter((t) => t.type === 'word' && !t.del).map((t) => t.text).join(' ').trim();
}

const tokenOrderOf = (p) => p.clips.flatMap((c) => c.words.map((t) => t.id)).join(',');
const stateOf = () => JSON.stringify({ clips: store.project.clips, settings: store.project.settings });

// Record events for assertions.
const events = [];
for (const evt of ['load', 'change', 'flags', 'selection', 'dirty', 'saved', 'settings', 'time', 'play']) {
  store.on(evt, (payload) => events.push({ evt, payload }));
}
const lastEvent = (evt) => { for (let i = events.length - 1; i >= 0; i--) if (events[i].evt === evt) return events[i].payload; return undefined; };

// ---------------------------------------------------------------------------------------------
// 1. Parity vectors (inline + tests/fixtures/parity.json)
// ---------------------------------------------------------------------------------------------

function inlineParityCases() {
  const cases = [];
  const base = small();
  cases.push({ name: 'inline: untouched', project: clone(base), expected: {
    keptRanges: [[0, 10]], outDuration: 10, srcToOut: [[0, 0], [2.3, 2.3], [10, 10]],
    autoCaptions: ['안녕하세요 여러분', '음 오늘은', '편집을 해볼게요'] } });
  let p = clone(base); p.clips[1].words[0].del = true; // "음" 2.2–2.5
  cases.push({ name: 'inline: deleted word', project: p, expected: {
    keptRanges: [[0, 2.2], [2.5, 10]], outDuration: 9.7, srcToOut: [[2.0, 2.0], [2.3, 2.2], [2.5, 2.2], [3.0, 2.7], [10, 9.7]],
    autoCaptions: ['안녕하세요 여러분', '오늘은', '편집을 해볼게요'] } });
  p = clone(base); p.clips[1].words[3].keep = 0.2; // gap 4.0–5.2 → keep 0.2
  cases.push({ name: 'inline: keep-shortened gap', project: p, expected: {
    keptRanges: [[0, 4.1], [5.1, 10]], outDuration: 9.0, srcToOut: [[4.05, 4.05], [4.5, 4.1], [5.15, 4.15], [10, 9.0]],
    autoCaptions: ['안녕하세요 여러분', '음 오늘은', '편집을 해볼게요'] } });
  p = clone(base); p.clips[0].words[1].keep = 1.0; // gap 0.6 s, keep ≥ dur → untouched
  cases.push({ name: 'inline: keep >= dur', project: p, expected: {
    keptRanges: [[0, 10]], outDuration: 10, srcToOut: [[1.3, 1.3]], autoCaptions: ['안녕하세요 여러분', '음 오늘은', '편집을 해볼게요'] } });
  p = clone(base); p.clips[2].words[2].del = true; p.clips[2].words[2].keep = 0.5; // del + keep → deleted
  cases.push({ name: 'inline: del + keep', project: p, expected: {
    keptRanges: [[0, 7]], outDuration: 7, srcToOut: [[8, 7], [6.5, 6.5]], autoCaptions: ['안녕하세요 여러분', '음 오늘은', '편집을 해볼게요'] } });
  p = clone(base); p.clips[0].words[1].keep = 0; // keep 0 → gap removed
  cases.push({ name: 'inline: keep 0', project: p, expected: {
    keptRanges: [[0, 1.0], [1.6, 10]], outDuration: 9.4, srcToOut: [[1.3, 1.0], [1.6, 1.0], [2.0, 1.4]], autoCaptions: ['안녕하세요 여러분', '음 오늘은', '편집을 해볼게요'] } });
  p = clone(base); // all words of clip 2 deleted + caption override on clip 3 + empty override on clip 1
  p.clips[1].words.forEach((t) => { if (t.type === 'word') t.del = true; });
  p.clips[0].caption = '';
  p.clips[2].caption = '바꾼 자막';
  cases.push({ name: 'inline: empty captions & overrides', project: p, expected: {
    keptRanges: [[0, 2.2], [2.5, 3.3], [4.0, 10]], outDuration: 9.0, srcToOut: [[2.4, 2.2], [3.0, 2.7], [3.5, 3.0], [4.5, 3.5]],
    autoCaptions: ['안녕하세요 여러분', '', '편집을 해볼게요'] } });
  p = clone(base); // tiny isolated piece (< 1 ms) is dropped
  p.clips[0].words[0].del = true; p.clips[0].words[2].del = true; p.clips[0].words[1].keep = 0.0008;
  cases.push({ name: 'inline: tiny range dropped', project: p, expected: {
    keptRanges: [[2.2, 10]], outDuration: 7.8, srcToOut: [[0.5, 0], [2.2, 0]], autoCaptions: ['', '음 오늘은', '편집을 해볼게요'] } });
  p = clone(base); // everything deleted
  p.clips.forEach((c) => c.words.forEach((t) => { t.del = true; }));
  cases.push({ name: 'inline: all deleted', project: p, expected: {
    keptRanges: [], outDuration: 0, srcToOut: [[0, 0], [5, 0], [10, 0]], autoCaptions: ['', '', ''] } });
  return cases;
}

function runParityCase(c, label) {
  test(`parity ${label}: ${c.name}`, () => {
    store.load(clone(c.project));
    const exp = c.expected || {};
    if (exp.keptRanges) rangesNear(store.keptRanges(), exp.keptRanges, 1e-6, 'keptRanges');
    if (exp.outDuration !== undefined) near(store.outDuration(), exp.outDuration, 1e-6, 'outDuration');
    for (const [t, o] of exp.srcToOut || []) near(store.srcToOut(t), o, 1e-6, `srcToOut(${t})`);
    if (exp.autoCaptions) {
      const auto = store.project.clips.map((cl) => store.autoCaption(cl));
      const capOf = store.project.clips.map((cl) => store.captionOf(cl));
      const okAuto = JSON.stringify(auto) === JSON.stringify(exp.autoCaptions);
      const okCap = JSON.stringify(capOf) === JSON.stringify(exp.autoCaptions);
      assert(okAuto || okCap, `autoCaptions: expected ${JSON.stringify(exp.autoCaptions)}, got auto=${JSON.stringify(auto)} captionOf=${JSON.stringify(capOf)}`);
    }
  });
}

for (const c of inlineParityCases()) runParityCase(c, 'inline');

{
  const txt = readText(['tests/fixtures/parity.json']);
  if (txt === null) {
    out('INFO tests/fixtures/parity.json not found — only inline parity vectors were used');
  } else {
    let data = null;
    try { data = JSON.parse(txt); } catch (e) { test('parity.json parses', () => { throw e; }); }
    if (data) {
      const cases = Array.isArray(data.cases) ? data.cases : [];
      test('parity.json has cases', () => assert(cases.length > 0, 'no cases'));
      for (const c of cases) runParityCase(c, 'file');
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Queries
// ---------------------------------------------------------------------------------------------

test('load: event, defaults, clean state', () => {
  const p = small();
  delete p.settings.includeNoise;
  store.load(p);
  eq(lastEvent('load'), p, 'load payload');
  eq(store.dirty, false, 'dirty');
  eq(store.canUndo(), false, 'canUndo');
  eq(store.project.settings.includeNoise, false, 'default setting filled');
  eq(store.flat().length, 10, 'flat length');
  checkPartition(store.project);
});

test('flat / flatIndexOf / clipIndexOf / clipFirstFlat', () => {
  store.load(small());
  const L = store.flat();
  eq(L[4].tok.type, 'noise', 'flat[4] is noise');
  eq(L[4].ci, 1, 'ci');
  eq(L[4].ti, 1, 'ti');
  eq(L[4].clip.id, 'c_aaaaaaa2', 'clip');
  eq(store.flatIndexOf(L[7].tok.id), 7, 'flatIndexOf');
  eq(store.flatIndexOf('nope'), -1, 'flatIndexOf missing');
  eq(store.clipIndexOf('c_aaaaaaa3'), 2, 'clipIndexOf');
  eq(store.clipIndexOf('nope'), -1, 'clipIndexOf missing');
  eq(store.clipFirstFlat(1), 3, 'clipFirstFlat');
  assert(store.flat() === L, 'flat() is cached');
});

test('tokenAt / clipAt (binary search, edges)', () => {
  store.load(small());
  eq(store.tokenAt(0), 0, 't=0');
  eq(store.tokenAt(0.99), 0, 't=0.99');
  eq(store.tokenAt(1.0), 1, 'boundary goes to next token');
  eq(store.tokenAt(2.6), 4, 'noise');
  eq(store.tokenAt(9.99), 9, 'last');
  eq(store.tokenAt(50), 9, 'past end');
  eq(store.tokenAt(-3), 0, 'before start');
  eq(store.clipAt(2.6), 1, 'clipAt');
  eq(store.clipAt(7.5), 2, 'clipAt gap');
});

test('srcToOut / outToSrc / isKept / nextKept', () => {
  const p = small();
  p.clips[1].words[0].del = true; // 2.2–2.5
  p.clips[1].words[3].keep = 0.2; // 4.0–5.2 → [4.0,4.1] + [5.1,5.2]
  store.load(p);
  rangesNear(store.keptRanges(), [[0, 2.2], [2.5, 4.1], [5.1, 10]]);
  near(store.outDuration(), 2.2 + 1.6 + 4.9, 1e-9, 'outDuration');
  near(store.srcToOut(2.3), 2.2, 1e-9, 'removed → next start');
  near(store.srcToOut(4.6), 3.8, 1e-9, 'shortened gap middle');
  near(store.srcToOut(5.1), 3.8, 1e-9, 'range start');
  near(store.srcToOut(11), 8.7, 1e-9, 'past end');
  near(store.outToSrc(2.2), 2.5, 1e-9, 'tie → later range start');
  near(store.outToSrc(3.8), 5.1, 1e-9, 'tie → later range start (2)');
  near(store.outToSrc(1.0), 1.0, 1e-9, 'inside first');
  near(store.outToSrc(3.0), 3.3, 1e-9, 'inside second');
  near(store.outToSrc(0), 0, 1e-9, 'zero');
  near(store.outToSrc(100), 10, 1e-9, 'beyond end');
  for (let o = 0; o <= 8.7; o += 0.137) near(store.srcToOut(store.outToSrc(o)), o, 1e-9, `round trip ${o}`);
  eq(store.isKept(2.3), false, 'isKept removed');
  eq(store.isKept(2.5), true, 'isKept range start');
  eq(store.isKept(2.2), false, 'isKept half-open end');
  eq(store.isKept(4.05), true, 'isKept short piece');
  eq(store.isKept(4.5), false, 'isKept shortened middle');
  near(store.nextKept(2.3), 2.5, 1e-9, 'nextKept removed');
  near(store.nextKept(1.5), 1.5, 1e-9, 'nextKept inside');
  near(store.nextKept(4.5), 5.1, 1e-9, 'nextKept gap middle');
  eq(store.nextKept(10), null, 'nextKept at end');
  p.clips[2].words.forEach((t) => { t.del = true; });
  store.load(p);
  eq(store.nextKept(5.5), null, 'nextKept in trailing deleted area');
});

test('autoCaption / captionOf', () => {
  const p = small();
  p.clips[0].words[2].del = true;
  p.clips[2].caption = '직접 쓴 자막';
  p.clips[1].caption = '';
  store.load(p);
  eq(store.autoCaption(p.clips[0]), '안녕하세요', 'deleted word excluded');
  eq(store.captionOf(p.clips[0]), '안녕하세요', 'auto');
  eq(store.captionOf(p.clips[1]), '', 'empty override');
  eq(store.autoCaption(p.clips[1]), '음 오늘은', 'auto ignores override');
  eq(store.captionOf(p.clips[2]), '직접 쓴 자막', 'override');
  for (const c of p.clips) eq(store.autoCaption(c), naiveAuto(c), 'naive auto');
});

test('clipSpan', () => {
  const p = small();
  p.clips[0].words[0].del = true;
  p.clips[0].words[1].keep = 0;
  p.clips[2].words.forEach((t) => { t.del = true; });
  store.load(p);
  const s0 = store.clipSpan(0);
  near(s0.start, 0, 1e-9, 'start');
  near(s0.end, 2.2, 1e-9, 'end');
  near(s0.keptStart, 1.6, 1e-9, 'keptStart skips deleted + keep-0 gap');
  near(s0.keptEnd, 2.2, 1e-9, 'keptEnd');
  const s1 = store.clipSpan(1);
  near(s1.keptStart, 2.2, 1e-9, 'clip 2 keptStart');
  near(s1.keptEnd, 5.2, 1e-9, 'clip 2 keptEnd');
  const s2 = store.clipSpan(2);
  eq(s2.keptStart, null, 'fully deleted keptStart');
  eq(s2.keptEnd, null, 'fully deleted keptEnd');
  eq(store.clipSpan(99), null, 'out of range');
});

test('stats', () => {
  const p = small();
  p.clips[2].words.forEach((t) => { t.del = true; });
  p.clips[1].flags = ['ng'];
  p.clips[0].words[0].flags = ['lowconf'];
  store.load(p);
  const st = store.stats();
  eq(st.clips, 3, 'clips');
  eq(st.deletedClips, 1, 'deletedClips');
  near(st.srcDur, 10, 1e-9, 'srcDur');
  near(st.outDur, 5.2, 1e-9, 'outDur');
  eq(st.flags.filler, 1, 'filler');
  eq(st.flags.repeat, 0, 'repeat on deleted token not counted');
  eq(st.flags.ng, 1, 'ng');
  eq(st.flags.noise, 1, 'noise');
  eq(st.flags.lowconf, 1, 'lowconf');
  eq(st.flags.fillerWeak, 0, 'fillerWeak');
  assert(store.stats() === st, 'stats cached');
  store.setDeleted(0, 0, true);
  assert(store.stats() !== st, 'stats invalidated on change');
  eq(store.stats().flags.lowconf, 0, 'lowconf after delete');
});

// ---------------------------------------------------------------------------------------------
// 3. Selection
// ---------------------------------------------------------------------------------------------

test('select / selectClips / selectedRange / selectedClipRange / clearSelection', () => {
  store.load(small());
  store.select(5, 2);
  deepEq(store.ui.sel, { a: 5, f: 2 }, 'sel');
  deepEq(store.selectedRange(), { from: 2, to: 5 }, 'range');
  deepEq(store.selectedClipRange(), { from: 0, to: 1 }, 'clip range from tokens');
  deepEq(lastEvent('selection').sel, { a: 5, f: 2 }, 'selection event');
  store.select(-4, 99);
  deepEq(store.ui.sel, { a: 0, f: 9 }, 'clamped');
  store.selectClips(2, 1);
  deepEq(store.ui.clipSel, { a: 2, f: 1 }, 'clipSel');
  deepEq(store.ui.sel, { a: 9, f: 3 }, 'sel covers clips (anchor = last token of anchor clip)');
  deepEq(store.selectedClipRange(), { from: 1, to: 2 }, 'selectedClipRange');
  store.select(1);
  eq(store.ui.clipSel, null, 'token select clears clipSel');
  store.clearSelection();
  eq(store.ui.sel, null, 'cleared');
  eq(store.selectedRange(), null, 'no range');
  eq(store.selectedClipRange(), null, 'no clip range');
});

// ---------------------------------------------------------------------------------------------
// 4. Ops
// ---------------------------------------------------------------------------------------------

/** Run an op and verify: invariant, token order, one undo step, undo → exact previous state, redo → exact next. */
function checkOp(label, fn, { expectChange = true } = {}) {
  const order = tokenOrderOf(store.project);
  const before = stateOf();
  const undoBefore = store.canUndo();
  const ver = store.version;
  const res = fn();
  checkPartition(store.project, order);
  const after = stateOf();
  if (!expectChange) {
    eq(after, before, `${label}: no-op must not change state`);
    eq(store.version, ver, `${label}: no-op must not bump version`);
    eq(store.canUndo(), undoBefore, `${label}: no-op must not push undo`);
    return res;
  }
  assert(after !== before, `${label}: expected a change`);
  assert(store.dirty, `${label}: dirty`);
  assert(store.canUndo(), `${label}: undo available`);
  assert(!store.canRedo(), `${label}: redo cleared`);
  assert(store.undo(), `${label}: undo`);
  eq(stateOf(), before, `${label}: undo restores`);
  checkPartition(store.project, order);
  assert(store.redo(), `${label}: redo`);
  eq(stateOf(), after, `${label}: redo re-applies`);
  return res;
}

test('setDeleted / toggleDelete / setClipsDeleted (+ change event payload)', () => {
  store.load(small());
  events.length = 0;
  eq(checkOp('setDeleted', () => store.setDeleted(3, 5, true)), 3, 'count');
  const ch = events.filter((e) => e.evt === 'change')[0].payload;
  assert(ch.clipIds instanceof Set && ch.clipIds.has('c_aaaaaaa2') && ch.clipIds.size === 1, 'clipIds = {c2}');
  eq(ch.structural, false, 'not structural');
  rangesNear(store.keptRanges(), [[0, 2.2], [4.0, 10]]);
  checkOp('setDeleted no-op', () => store.setDeleted(3, 5, true), { expectChange: false });
  store.select(3, 6);
  checkOp('toggleDelete mixed → delete all', () => store.toggleDelete());
  eq(store.flat()[6].tok.del, true, 'token 6 deleted');
  checkOp('toggleDelete all deleted → restore', () => store.toggleDelete());
  eq(store.flat()[3].tok.del, false, 'restored');
  store.selectClips(2);
  checkOp('toggleDelete clips', () => store.toggleDelete());
  assert(store.isClipDeleted(2), 'clip 3 deleted');
  checkOp('toggleDelete clips again → restore', () => store.toggleDelete());
  assert(!store.isClipDeleted(2), 'clip 3 restored');
  checkOp('setClipsDeleted', () => store.setClipsDeleted(0, 1, true));
  assert(store.isClipDeleted(0) && store.isClipDeleted(1), 'clips deleted');
  store.clearSelection();
  eq(store.toggleDelete(), false, 'toggleDelete without selection');
});

test('setWordText (trim, gap no-op, auto caption follows)', () => {
  store.load(small());
  checkOp('setWordText', () => store.setWordText(2, '  여러분들  '));
  eq(store.flat()[2].tok.text, '여러분들', 'trimmed');
  eq(store.flat()[2].tok.orig, '여러분', 'orig kept');
  eq(store.captionOf(store.project.clips[0]), '안녕하세요 여러분들', 'auto caption follows');
  checkOp('setWordText gap', () => store.setWordText(1, 'x'), { expectChange: false });
  checkOp('setWordText noise', () => store.setWordText(4, 'x'), { expectChange: false });
  checkOp('setWordText empty', () => store.setWordText(0, '   '), { expectChange: false });
  checkOp('setWordText same', () => store.setWordText(0, '안녕하세요'), { expectChange: false });
});

test('setCaption (override, "", null, equal-to-auto → null)', () => {
  store.load(small());
  checkOp('override', () => store.setCaption(0, '새 자막\r\n둘째 줄  '));
  eq(store.project.clips[0].caption, '새 자막\n둘째 줄', 'normalized');
  checkOp('empty', () => store.setCaption(1, ''));
  eq(store.project.clips[1].caption, '', 'empty override');
  checkOp('reset', () => store.setCaption(0, null));
  eq(store.project.clips[0].caption, null, 'null');
  checkOp('equal to auto', () => store.setCaption(2, '편집을 해볼게요'), { expectChange: false });
  eq(store.project.clips[2].caption, null, 'still auto');
});

test('splitClip (positions, caption override stays with first part, ids)', () => {
  const p = small();
  p.clips[1].caption = '음 오늘은 직접';
  p.clips[1].flags = ['ng'];
  store.load(p);
  events.length = 0;
  checkOp('split no-op at clip start', () => store.splitClip(3), { expectChange: false });
  checkOp('split', () => store.splitClip(5));
  const cs = store.project.clips;
  eq(cs.length, 4, 'clip count');
  eq(cs[1].id, 'c_aaaaaaa2', 'first part keeps id');
  eq(cs[1].words.length, 2, 'first part tokens');
  eq(cs[2].words.length, 2, 'second part tokens');
  eq(cs[2].words[0].text, '오늘은', 'second part starts at flatIdx');
  eq(cs[1].caption, '음 오늘은 직접', 'override stays with first part');
  eq(cs[2].caption, null, 'second part auto');
  deepEq(cs[2].flags, [], 'second part no flags');
  assert(/^c_[0-9a-z]{8}$/.test(cs[2].id), `new id format ${cs[2].id}`);
  const ch = events.filter((e) => e.evt === 'change')[0].payload;
  eq(ch.structural, true, 'structural');
  assert(ch.clipIds.has('c_aaaaaaa2') && ch.clipIds.has(cs[2].id), 'clipIds include both parts');
  eq(store.clipIndexOf(cs[2].id), 2, 'caches rebuilt');
  eq(store.flat()[5].ci, 2, 'flat ci updated');
  checkOp('split no-op out of range', () => store.splitClip(99), { expectChange: false });
});

test('splitToNext (partial move, at clip start → merge, last clip → split)', () => {
  const p = small();
  p.clips[2].caption = '편집 자막';
  store.load(p);
  checkOp('splitToNext partial', () => store.splitToNext(5)); // "오늘은", gap → start of clip 3
  let cs = store.project.clips;
  eq(cs.length, 3, 'clip count');
  eq(cs[1].words.length, 2, 'remaining');
  eq(cs[2].words[0].text, '오늘은', 'moved to next start');
  eq(cs[2].words.length, 5, 'next clip size');
  eq(cs[2].caption, '오늘은 편집 자막', 'next override gets moved words prepended');
  store.undo();
  checkOp('splitToNext at first token merges', () => store.splitToNext(3)); // clip 2 → into clip 3
  cs = store.project.clips;
  eq(cs.length, 2, 'merged');
  eq(cs[1].id, 'c_aaaaaaa2', 'first id kept');
  eq(cs[1].words.length, 7, 'merged size');
  eq(cs[1].caption, '음 오늘은 편집 자막', 'merge caption rule');
  store.undo();
  checkOp('splitToNext on last clip splits', () => store.splitToNext(8));
  eq(store.project.clips.length, 4, 'split');
  eq(store.project.clips[3].words[0].text, '해볼게요', 'new clip starts at flatIdx');
  checkOp('splitToNext last clip first token no-op', () => store.splitToNext(store.clipFirstFlat(3)), { expectChange: false });
});

test('mergeWithNext / mergeWithPrev / mergeClips (ids, order, captions, flags, ngOf)', () => {
  // no overrides → caption stays auto
  store.load(small());
  const order = tokenOrderOf(store.project);
  checkOp('merge next', () => store.mergeWithNext(0));
  eq(store.project.clips.length, 2, 'count');
  eq(store.project.clips[0].id, 'c_aaaaaaa1', 'first id kept');
  eq(store.project.clips[0].caption, null, 'auto');
  eq(tokenOrderOf(store.project), order, 'token order');
  checkOp('merge next on last clip', () => store.mergeWithNext(1), { expectChange: false });
  checkOp('merge prev on first clip', () => store.mergeWithPrev(0), { expectChange: false });
  checkOp('merge prev', () => store.mergeWithPrev(1));
  eq(store.project.clips.length, 1, 'one clip');

  // overrides
  let p = small();
  p.clips[0].caption = '첫 자막';
  store.load(p);
  store.mergeWithNext(0);
  eq(store.project.clips[0].caption, '첫 자막 음 오늘은', 'a override + auto b');
  p = small();
  p.clips[1].caption = '둘째';
  store.load(p);
  store.mergeWithNext(0);
  eq(store.project.clips[0].caption, '안녕하세요 여러분 둘째', 'auto a + b override');
  p = small();
  p.clips[0].caption = '';
  p.clips[1].caption = '';
  store.load(p);
  store.mergeWithNext(0);
  eq(store.project.clips[0].caption, '', 'both empty → empty override');

  // flags + ngOf remap
  p = small();
  p.clips[0].flags = ['ng'];
  p.clips[0].ngOf = 'c_aaaaaaa3';
  p.clips[1].flags = ['ng'];
  p.clips[1].ngOf = 'c_aaaaaaa3';
  store.load(p);
  store.mergeWithNext(1); // merge c2 + c3 → c2 is NG of itself → cleared; c1.ngOf → c2
  eq(store.project.clips[1].ngOf, null, 'self NG cleared');
  assert(!store.project.clips[1].flags.includes('ng'), 'self ng flag removed');
  eq(store.project.clips[0].ngOf, 'c_aaaaaaa2', 'ngOf remapped to surviving id');

  // range merge = one undo step, pairwise caption semantics
  p = small();
  p.clips[2].caption = '셋째';
  store.load(p);
  checkOp('mergeClips 0..2', () => store.mergeClips(0, 2));
  eq(store.project.clips.length, 1, 'one clip');
  eq(store.project.clips[0].caption, '안녕하세요 여러분 음 오늘은 셋째', 'chained caption');
  checkOp('mergeClips single', () => store.mergeClips(0, 0), { expectChange: false });
});

test('moveBoundary / nudge (clamped to 0.02 s on both sides)', () => {
  store.load(small());
  checkOp('moveBoundary', () => store.moveBoundary(0, 0.8));
  near(store.flat()[0].tok.end, 0.8, 1e-9, 'a.end');
  near(store.flat()[1].tok.start, 0.8, 1e-9, 'b.start');
  checkOp('moveBoundary clamp right', () => store.moveBoundary(0, 5));
  near(store.flat()[0].tok.end, 1.58, 1e-9, 'clamped to b.end - 0.02');
  checkOp('moveBoundary clamp left', () => store.moveBoundary(0, -5));
  near(store.flat()[0].tok.end, 0.02, 1e-9, 'clamped to a.start + 0.02');
  checkOp('moveBoundary same', () => store.moveBoundary(0, 0.02), { expectChange: false });
  checkOp('moveBoundary last token', () => store.moveBoundary(9, 9.5), { expectChange: false });
  checkOp('moveBoundary across clips', () => store.moveBoundary(2, 2.3));
  near(store.project.clips[0].words[2].end, 2.3, 1e-9, 'clip 1 last end');
  near(store.project.clips[1].words[0].start, 2.3, 1e-9, 'clip 2 first start');
  checkOp('moveBoundary NaN', () => store.moveBoundary(2, NaN), { expectChange: false });
  store.select(5);
  checkOp('nudge start -', () => store.nudge('start', -0.05));
  near(store.flat()[5].tok.start, 3.25, 1e-9, 'start nudged');
  checkOp('nudge end +', () => store.nudge('end', 0.05));
  near(store.flat()[5].tok.end, 4.05, 1e-9, 'end nudged');
  store.select(0);
  checkOp('nudge start at 0', () => store.nudge('start', -0.05), { expectChange: false });
  store.clearSelection();
  checkOp('nudge without selection', () => store.nudge('end', 0.05), { expectChange: false });
});

test('shortenSilences ({count, savedSec}, includeNoise, deleted gaps skipped)', () => {
  const p = small();
  p.clips[2].words[2].del = true; // trailing 3 s gap deleted → skipped
  store.load(p);
  const before = store.outDuration();
  const r = checkOp('shorten', () => store.shortenSilences({ min: 0.5, keep: 0.2, includeNoise: false }));
  eq(r.count, 2, 'count (gaps 0.6 and 1.2)');
  near(r.savedSec, (0.6 - 0.2) + (1.2 - 0.2), 1e-6, 'savedSec');
  near(before - store.outDuration(), r.savedSec, 1e-6, 'outDuration consistent');
  near(store.flat()[1].tok.keep, 0.2, 1e-9, 'keep set');
  eq(store.flat()[4].tok.keep, null, 'noise untouched');
  eq(store.flat()[9].tok.keep, null, 'deleted gap untouched');
  const r2 = checkOp('shorten incl. noise, keep > dur', () => store.shortenSilences({ min: 0.5, keep: 1.0, includeNoise: true }));
  eq(r2.count, 3, 'count with noise');
  near(store.flat()[1].tok.keep, 0.6, 1e-9, 'keep = min(keep, dur)');
  near(store.flat()[4].tok.keep, 0.8, 1e-9, 'noise keep = dur');
  const r3 = store.shortenSilences({ min: 0.5, keep: 1.0, includeNoise: true });
  eq(r3.count, 3, 'repeat count');
  eq(r3.savedSec, 0, 'nothing saved');
  const r4 = checkOp('min too large', () => store.shortenSilences({ min: 5, keep: 0 }), { expectChange: false });
  eq(r4.count, 0, 'none');
});

test('setKeep (context menu: silence → 0 s / restore)', () => {
  store.load(small());
  eq(checkOp('setKeep 0', () => store.setKeep(0, 9, 0)), 4, 'gaps + noise');
  rangesNear(store.keptRanges(), [[0, 1.0], [1.6, 2.5], [3.3, 4.0], [5.2, 7.0]]);
  eq(checkOp('setKeep null', () => store.setKeep(1, 1, null)), 1, 'restore one');
  checkOp('setKeep on word', () => store.setKeep(0, 0, 0), { expectChange: false });
});

test('deleteTokens / deleteClips (bulk, one step)', () => {
  store.load(small());
  eq(checkOp('deleteTokens', () => store.deleteTokens([0, 3, 8, 99])), 3, 'count');
  eq(store.flat()[3].tok.del, true, 'deleted');
  eq(checkOp('deleteClips', () => store.deleteClips([2])), 2, 'count (one already deleted)');
  assert(store.isClipDeleted(2), 'clip deleted');
  checkOp('deleteTokens no-op', () => store.deleteTokens([0]), { expectChange: false });
});

test('replaceAll (words + caption overrides, counts, no empty words)', () => {
  const p = small();
  p.clips[2].caption = '편집을 해볼게요 편집';
  store.load(p);
  eq(checkOp('replace', () => store.replaceAll('편집', '컷편집')), 3, 'count = 1 word + 2 caption');
  eq(store.flat()[7].tok.text, '컷편집을', 'word replaced');
  eq(store.project.clips[2].caption, '컷편집을 해볼게요 컷편집', 'caption replaced');
  eq(checkOp('replace words only', () => store.replaceAll('여러분', '모두', { captions: false })), 1, 'words only');
  eq(checkOp('replace captions only', () => store.replaceAll('해볼게요', '해요', { words: false })), 1, 'captions only');
  eq(store.flat()[8].tok.text, '해볼게요', 'word untouched');
  eq(checkOp('replace → empty is skipped', () => store.replaceAll('음', ''), { expectChange: false }), 0, 'no empty word');
  eq(store.replaceAll('', 'x'), 0, 'empty find');
  eq(checkOp('no match', () => store.replaceAll('없는말', 'x'), { expectChange: false }), 0, 'no match');
});

test('replaceClips (resegment result) / applyFlags (no undo, emits flags)', () => {
  store.load(small());
  const flatIds = store.project.clips.flatMap((c) => c.words);
  const re = [C('c_new00001', flatIds.slice(0, 5).map(clone)), C('c_aaaaaaa3', flatIds.slice(5).map(clone))];
  checkOp('replaceClips', () => store.replaceClips(re));
  eq(store.project.clips.length, 2, 'count');
  eq(store.clipIndexOf('c_new00001'), 0, 'index');
  checkOp('replaceClips empty refused', () => store.replaceClips([]), { expectChange: false });
  events.length = 0;
  const canUndo = store.canUndo();
  const analyzed = clone(store.project.clips);
  analyzed[0].flags = ['ng'];
  analyzed[0].ngOf = 'c_aaaaaaa3';
  analyzed[0].words[0].flags = ['repeat'];
  const n = store.applyFlags(analyzed);
  eq(n, 2, 'clips updated');
  eq(store.canUndo(), canUndo, 'no undo step');
  deepEq(store.project.clips[0].flags, ['ng'], 'clip flags');
  eq(store.project.clips[0].ngOf, 'c_aaaaaaa3', 'ngOf');
  deepEq(store.project.clips[0].words[0].flags, ['repeat'], 'token flags');
  assert(events.some((e) => e.evt === 'flags'), 'flags event');
  assert(!events.some((e) => e.evt === 'change'), 'no change event');
  assert(store.dirty, 'dirty (flags are saved)');
  // undo after applyFlags must restore the pre-applyFlags snapshot of the replaced clips, consistently
  const st = stateOf();
  store.setDeleted(0, 0, true);
  store.undo();
  eq(stateOf(), st, 'undo after applyFlags restores flagged state');
});

test('updateSettings / markSaved / version / dirty events', () => {
  store.load(small());
  events.length = 0;
  const v = store.version;
  store.updateSettings({ silenceMin: 0.5 });
  eq(store.project.settings.silenceMin, 0.5, 'setting');
  eq(store.project.settings.maxChars, 22, 'others kept');
  assert(store.dirty && store.version === v + 1, 'dirty + version');
  assert(events.some((e) => e.evt === 'settings') && events.some((e) => e.evt === 'dirty'), 'events');
  eq(store.canUndo(), false, 'settings not undoable');
  store.markSaved('2026-10-08T11:00:00+09:00');
  eq(store.dirty, false, 'clean');
  eq(store.savedAt, '2026-10-08T11:00:00+09:00', 'savedAt');
  eq(lastEvent('saved'), '2026-10-08T11:00:00+09:00', 'saved event');
  store.setTime(3.3);
  eq(store.ui.time, 3.3, 'time');
  eq(lastEvent('time'), 3.3, 'time event');
  store.setPlaying(true);
  eq(lastEvent('play'), true, 'play event');
  store.setPlaying(false);
});

test('undo restores selection; redo cleared by new op; history capped at 100', () => {
  store.load(small());
  store.select(2);
  store.setDeleted(2, 2, true);
  store.select(7);
  store.undo();
  deepEq(store.ui.sel, { a: 2, f: 2 }, 'selection restored');
  assert(store.canRedo(), 'can redo');
  store.setDeleted(0, 0, true);
  assert(!store.canRedo(), 'redo cleared');
  store.load(small());
  for (let i = 0; i < 130; i++) store.moveBoundary(0, i % 2 ? 0.5 : 0.6);
  let n = 0;
  while (store.undo()) n++;
  eq(n, 100, 'max 100 undo steps');
  near(store.flat()[0].tok.end, 0.5, 1e-9, 'oldest kept state');
});

test('batch: several ops = one undo step and one change event', () => {
  store.load(small());
  const before = stateOf();
  events.length = 0;
  store.batch(() => {
    store.setDeleted(0, 0, true);
    store.splitClip(5);
    store.setCaption(0, '묶음');
  });
  eq(events.filter((e) => e.evt === 'change').length, 1, 'one change event');
  eq(events.filter((e) => e.evt === 'change')[0].payload.structural, true, 'structural propagated');
  checkPartition(store.project);
  store.undo();
  eq(stateOf(), before, 'one undo restores all');
  eq(store.canUndo(), false, 'single step');
});

// ---------------------------------------------------------------------------------------------
// 5. Randomized fuzz: invariants, cache consistency, exact undo/redo
// ---------------------------------------------------------------------------------------------

function fuzz(seed, steps) {
  const r = rng(seed);
  store.load(generated(40, 7, seed));
  const order = tokenOrderOf(store.project);
  const history = [stateOf()];
  const ri = (n) => Math.floor(r() * n);
  for (let step = 0; step < steps; step++) {
    const n = store.flat().length;
    const nc = store.project.clips.length;
    const i = ri(n), j = ri(n), ci = ri(nc);
    const k = ri(17);
    const ver = store.version;
    switch (k) {
      case 0: store.setDeleted(i, Math.min(n - 1, i + ri(6)), r() < 0.7); break;
      case 1: store.select(i, Math.min(n - 1, i + ri(4))); store.toggleDelete(); break;
      case 2: store.setClipsDeleted(ci, Math.min(nc - 1, ci + ri(3)), r() < 0.6); break;
      case 3: store.setWordText(i, ['수정', '단어', '말'][ri(3)] + step); break;
      case 4: store.setCaption(ci, r() < 0.3 ? null : r() < 0.2 ? '' : `자막 ${step}`); break;
      case 5: store.splitClip(i); break;
      case 6: store.splitToNext(i); break;
      case 7: store.mergeWithNext(ci); break;
      case 8: store.mergeWithPrev(ci); break;
      case 9: store.mergeClips(ci, Math.min(nc - 1, ci + ri(3))); break;
      case 10: { const t = store.flat()[i].tok; store.moveBoundary(i, t.start + (r() - 0.3) * 1.5); break; }
      case 11: store.select(i); store.nudge(r() < 0.5 ? 'start' : 'end', r() < 0.5 ? -0.05 : 0.05); break;
      case 12: store.shortenSilences({ min: 0.1 + r() * 0.5, keep: [0, 0.1, 0.3][ri(3)], includeNoise: r() < 0.5 }); break;
      case 13: store.setKeep(i, Math.min(n - 1, i + 5), r() < 0.5 ? null : 0); break;
      case 14: store.deleteTokens([i, j]); break;
      case 15: store.replaceAll(SYL[ri(SYL.length)], '바꿈'); break;
      case 16: store.deleteClips([ci]); break;
      default: break;
    }
    checkPartition(store.project, order);
    // caches vs naive
    rangesNear(store.keptRanges(), naiveKept(store.project), 1e-9, `step ${step} kept cache`);
    const L = store.flat();
    const toks = store.project.clips.flatMap((c) => c.words);
    eq(L.length, toks.length, `step ${step} flat length`);
    const probe = ri(L.length);
    assert(L[probe].tok === toks[probe] && L[probe].clip.words[L[probe].ti] === toks[probe], `step ${step} flat entry`);
    eq(store.clipIndexOf(L[probe].clip.id), L[probe].ci, `step ${step} clip index`);
    const t = r() * store.project.source.duration;
    near(store.srcToOut(t), naiveSrcToOut(store.keptRanges(), t), 1e-9, `step ${step} srcToOut`);
    if (store.version !== ver) history.push(stateOf());
  }
  // undo all the way (up to 100 steps), comparing each state exactly
  const steps2 = Math.min(100, history.length - 1);
  for (let s = 0; s < steps2; s++) {
    assert(store.undo(), `undo ${s}`);
    eq(stateOf(), history[history.length - 2 - s], `undo #${s + 1} exact`);
  }
  for (let s = 0; s < steps2; s++) {
    assert(store.redo(), `redo ${s}`);
    eq(stateOf(), history[history.length - 1 - steps2 + s + 1], `redo #${s + 1} exact`);
  }
  return history.length - 1;
}

test('fuzz: 300 random ops × 3 seeds keep invariants; undo/redo exact', () => {
  let changes = 0;
  for (const seed of [11, 23, 97]) {
    // history may exceed 100 → only the last 100 steps are checked; run in chunks of 90 to cover all
    for (let chunk = 0; chunk < 3; chunk++) changes += fuzz(seed * 10 + chunk, 100);
  }
  assert(changes > 300, `enough effective ops (${changes})`);
});

// ---------------------------------------------------------------------------------------------
// 6. Performance (1,500 clips / 12,000 tokens)
// ---------------------------------------------------------------------------------------------

test('performance: 1,500 clips / 12,000 tokens', () => {
  const big = generated(1500, 8, 3);
  let t0 = now();
  store.load(big);
  const L = store.flat();
  const tLoad = now() - t0;
  eq(L.length, 12000, 'token count');
  t0 = now();
  store.keptRanges();
  const tKept = now() - t0;
  const dur = big.source.duration;
  t0 = now();
  let acc = 0;
  for (let i = 0; i < 100000; i++) acc += store.srcToOut((i * 7.31) % dur);
  const tS2O = now() - t0;
  t0 = now();
  for (let i = 0; i < 100000; i++) acc += store.tokenAt((i * 3.17) % dur);
  const tTok = now() - t0;
  t0 = now();
  for (let i = 0; i < 1500; i++) store.clipSpan(i);
  const tSpan = now() - t0;
  // first op pays for the initial per-clip JSON cache
  t0 = now();
  store.setDeleted(10, 10, true);
  const tFirstOp = now() - t0;
  t0 = now();
  for (let i = 0; i < 50; i++) { store.setDeleted(100 + i * 50, 100 + i * 50, true); store.outDuration(); }
  const tOp = (now() - t0) / 50;
  t0 = now();
  for (let i = 0; i < 20; i++) store.undo();
  const tUndo = (now() - t0) / 20;
  t0 = now();
  store.splitClip(store.clipFirstFlat(700) + 3);
  store.flat();
  const tSplit = now() - t0;
  t0 = now();
  const res = store.shortenSilences({ min: 0.2, keep: 0.1, includeNoise: true });
  const tShort = now() - t0;
  t0 = now();
  store.stats();
  const tStats = now() - t0;
  out(`INFO perf: load+flat ${tLoad.toFixed(1)}ms, keptRanges ${tKept.toFixed(1)}ms, 100k srcToOut ${tS2O.toFixed(1)}ms, ` +
    `100k tokenAt ${tTok.toFixed(1)}ms, 1500 clipSpan ${tSpan.toFixed(1)}ms, first op ${tFirstOp.toFixed(1)}ms, ` +
    `op avg ${tOp.toFixed(2)}ms, undo avg ${tUndo.toFixed(2)}ms, split ${tSplit.toFixed(1)}ms, shortenSilences ${tShort.toFixed(1)}ms (${res.count}), stats ${tStats.toFixed(1)}ms`);
  assert(tLoad < 300, 'load too slow');
  assert(tKept < 100, 'keptRanges too slow');
  assert(tS2O < 300, 'srcToOut too slow');
  assert(tTok < 300, 'tokenAt too slow');
  assert(tOp < 40, 'op too slow');
  assert(tUndo < 80, 'undo too slow');
  assert(tSplit < 80, 'split too slow');
  assert(tShort < 200, 'shortenSilences too slow');
  assert(acc > 0, 'sanity');
  checkPartition(store.project);
});

// ---------------------------------------------------------------------------------------------
// 7. Syntax / load checks of every frontend module D owns
// ---------------------------------------------------------------------------------------------

const MODULES = ['util.js', 'api.js', 'commands.js', 'store.js', 'editor.js', 'shortcuts.js', 'main.js'];
const DOM_FREE = new Set(['util.js', 'api.js', 'commands.js', 'store.js']);
for (const name of MODULES) {
  const src = readText([`web/js/${name}`]);
  test(`syntax: web/js/${name}`, () => {
    assert(src !== null, `cannot read web/js/${name} (run from the LazyCut folder)`);
    if (typeof checkModuleSyntax === 'function') {
      try { checkModuleSyntax(src); } catch (e) { throw new AssertError(String(e)); }
    }
  });
}

for (const name of MODULES) {
  let err = null;
  try {
    await import(`../../web/js/${name}`);
  } catch (e) {
    err = e;
  }
  const msg = err ? String(err && err.message ? `${err.name || 'Error'}: ${err.message}` : err) : '';
  if (!err) {
    test(`load: web/js/${name}`, () => {});
  } else if (DOM_FREE.has(name) || (err && err.name === 'SyntaxError' && msg.includes(name))) {
    test(`load: web/js/${name}`, () => { throw new AssertError(msg); });
  } else {
    // DOM modules may need the browser or modules owned by E (player/timeline/panels) — parse is checked above.
    out(`INFO load: web/js/${name} needs the browser or a sibling module (${msg.slice(0, 160)})`);
  }
}

out('');
out(`SUMMARY: ${passed} passed, ${failed} failed`);
out(failed ? `FAILED: ${failed}` : 'ALL PASS');
