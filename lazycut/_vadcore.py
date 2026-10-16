from __future__ import annotations
"""제이컷 - energy VAD + whisper word-boundary refinement prototype (numpy only).

In-car talking-head recordings: engine/road noise is concentrated below ~500 Hz and its level drifts by
~15 dB over a 15-minute drive, so a single global threshold fails. We therefore
  * measure energy in two bands: LOW 150-2500 Hz (vowels / voiced consonants) and HIGH 2500-7500 Hz
    (fricative / aspirated onsets such as ㅅ ㅆ ㅊ ㅎ ㅌ ㅋ, which carry almost no low-band energy);
  * per band, estimate a *local* noise floor (P10 over a +-10 s window) and a local speech level
    (P95 over a +-30 s window) and put the threshold a fixed fraction of the way between them;
  * use hysteresis (on / off thresholds), fill short gaps (stop closures) and drop isolated clicks.

API (as requested):
    vad = analyze(samples)                      # samples: float32 mono 16 kHz in [-1, 1]
    frame_db, threshold, voiced_mask = vad      # frame_db/threshold: [n_frames, 2] (LOW, HIGH); mask: [n_frames] bool
    words = refine(words, vad)                  # words: [{"text","start","end",...}] -> new list, adds "core_start/core_end/vad_flag"
Helpers:
    voiced_regions(vad, min_dur) -> [(start, end)]
    uncovered_regions(words, vad, min_dur, cover_pad) -> voiced regions not covered by any word (missed-speech candidates)
"""
import numpy as np

SR = 16000
HOP = 160          # 10 ms
WIN = 400          # 25 ms Hann
NFFT = 512
FPS = SR // HOP    # 100 frames / s
BANDS = ((150.0, 2500.0), (2500.0, 7500.0))

# --- default VAD parameters (tuned on real in-car talking-head recordings) ---
DEFAULTS = dict(
    floor_pct=10.0, floor_win_s=20.0,     # local noise floor = P10 over +-10 s
    peak_pct=95.0, peak_win_s=60.0,       # local speech level = P95 over +-30 s
    k_on=0.30, k_off=0.20,                # LOW band: threshold = floor + k * (peak - floor)
    k_on_high=0.45, k_off_high=0.30,      # HIGH band needs ~19 dB over floor to start (breath stays below)
    fric_lead_s=0.15,                     # HIGH-only frames count as speech only <=150 ms before a LOW island
    fric_lag_s=0.10,                      # ... or <=100 ms after it (breathy release); else breath/noise
    min_margin_db=6.0,                    # threshold is at least floor + 6 dB
    gap_fill_s=0.08,                      # fill unvoiced gaps shorter than 80 ms (stop closures)
    min_island_s=0.04,                    # drop isolated voiced islands shorter than 40 ms (clicks) ...
    click_iso_s=0.15,                     # ... when they are >150 ms away from other voiced frames
)

REFINE_DEFAULTS = dict(
    pad_before=0.06,      # s added before the first voiced frame of a word (after silence-cut)
    pad_after=0.10,       # s added after the last voiced frame of a word
    max_extend=0.30,      # max s a boundary may grow beyond whisper's original span (into voiced audio,
                          # only towards a pause; segment-final words are cut ~0.1 s early by whisper)
    split_gap=0.30,       # unvoiced gap inside a word span that splits it into separate clusters
    sliver=0.25,          # a voiced island overlapping the span start by <=0.25 s ...
    coda_gap=0.12,        # ... and followed by >=120 ms unvoiced is the previous word's coda (or a filler)
    max_base=0.35, max_per_syl=0.30,   # plausible max word duration (s) = 0.35 + 0.30 * syllables
    min_word=0.08,        # minimum core duration kept for a word
)


def _frame_band_db(samples):
    x = np.asarray(samples, dtype=np.float32)
    if len(x) < WIN:
        x = np.pad(x, (0, WIN - len(x)))
    n = (len(x) - WIN) // HOP + 1
    win = np.hanning(WIN).astype(np.float32)
    f = np.fft.rfftfreq(NFFT, 1.0 / SR)
    masks = [(f >= lo) & (f < hi) for lo, hi in BANDS]
    out = np.empty((n, len(BANDS)), dtype=np.float32)
    step = 20000
    base = np.arange(WIN)[None, :]
    for s0 in range(0, n, step):
        idx = base + HOP * np.arange(s0, min(n, s0 + step))[:, None]
        spec = np.abs(np.fft.rfft(x[idx] * win[None, :], NFFT, axis=1)) ** 2
        for b, m in enumerate(masks):
            out[s0:s0 + len(idx), b] = 10.0 * np.log10(spec[:, m].sum(1) + 1e-10)
    return out


def _rolling_pct(v, pct, win_frames, grid=100):
    """Percentile of v over a centered window, evaluated every `grid` frames and linearly interpolated."""
    n = len(v)
    centers = np.arange(0, n, grid)
    vals = np.empty(len(centers), dtype=np.float32)
    h = win_frames // 2
    for k, c in enumerate(centers):
        vals[k] = np.percentile(v[max(0, c - h):min(n, c + h + 1)], pct)
    return np.interp(np.arange(n), centers, vals).astype(np.float32)


def _runs(mask):
    """Return list of (start_idx, end_idx_exclusive) of True runs."""
    if not len(mask):
        return []
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def _hysteresis(x, on, off):
    above_on = x >= on
    above_off = x >= off
    mask = np.zeros(len(x), dtype=bool)
    for s, e in _runs(above_off):
        if above_on[s:e].any():
            mask[s:e] = True
    return mask


def analyze(samples, **kw):
    p = dict(DEFAULTS, **kw)
    db = _frame_band_db(samples)
    # light smoothing (3-frame median) to suppress single-frame spikes
    sm = db.copy()
    if len(db) > 2:
        sm[1:-1] = np.median(np.stack([db[:-2], db[1:-1], db[2:]]), axis=0)
    n = len(sm)
    thr_on = np.empty_like(sm)
    thr_off = np.empty_like(sm)
    band_masks = []
    for b in range(sm.shape[1]):
        k_on, k_off = (p["k_on"], p["k_off"]) if b == 0 else (p["k_on_high"], p["k_off_high"])
        floor = _rolling_pct(sm[:, b], p["floor_pct"], int(p["floor_win_s"] * FPS))
        peak = _rolling_pct(sm[:, b], p["peak_pct"], int(p["peak_win_s"] * FPS))
        rng = np.maximum(peak - floor, 1.0)
        thr_on[:, b] = floor + np.maximum(k_on * rng, p["min_margin_db"])
        thr_off[:, b] = floor + np.maximum(k_off * rng, p["min_margin_db"])
        band_masks.append(_hysteresis(sm[:, b], thr_on[:, b], thr_off[:, b]))
    low, high = band_masks
    # HIGH-band-only frames are accepted only right before / after LOW (vowel) energy:
    # a fricative/aspirated onset leads into a vowel within ~150 ms; breath does not.
    allowed = low.copy()
    lead, lag = int(round(p["fric_lead_s"] * FPS)), int(round(p["fric_lag_s"] * FPS))
    for s, e in _runs(low):
        allowed[max(0, s - lead):s] = True
        allowed[e:min(n, e + lag)] = True
    mask = low | (high & allowed)
    # fill short gaps
    g = int(round(p["gap_fill_s"] * FPS))
    for s, e in _runs(~mask):
        if s > 0 and e < n and (e - s) <= g:
            mask[s:e] = True
    # drop isolated clicks
    mi = int(round(p["min_island_s"] * FPS)); iso = int(round(p["click_iso_s"] * FPS))
    runs = _runs(mask)
    for k, (s, e) in enumerate(runs):
        if e - s < mi:
            gl = s - runs[k - 1][1] if k > 0 else 10 ** 9
            gr = runs[k + 1][0] - e if k + 1 < len(runs) else 10 ** 9
            if gl > iso and gr > iso:
                mask[s:e] = False
    return sm, thr_off, mask


def voiced_regions(vad, min_dur=0.0):
    _, _, mask = vad
    return [(s / FPS, e / FPS) for s, e in _runs(mask) if (e - s) / FPS >= min_dur]


def _islands_in(mask, t0, t1):
    n = len(mask)
    a = max(0, int(np.floor(t0 * FPS))); b = min(n, int(np.ceil(t1 * FPS)))
    if b <= a:
        return []
    return [((s + a) / FPS, (e + a) / FPS) for s, e in _runs(mask[a:b])]


def _syllables(text):
    k = sum(1 for c in text if "가" <= c <= "힣")
    other = sum(1 for c in text if c.isalnum() and not ("가" <= c <= "힣"))
    return k + 0.6 * other  # latin letters / digits ~ 0.6 syllable each (AI = "에이아이")


def refine(words, vad, **kw):
    """Trim/extend each word to voiced audio, then pad. Returns new list (input untouched).

    Pass 1 (per word): voiced islands inside whisper's span -> clusters split at >=split_gap pauses ->
        drop neighbour slivers -> keep the LAST cluster -> cap implausible duration (keep the end).
    Pass 2 (neighbour-aware): grow a boundary into still-voiced audio (towards a pause only), never past
        the neighbour's core and at most max_extend beyond whisper's original span.
    Pass 3: add pad_before / pad_after, resolve overlaps between neighbours.
    Added keys: core_start/core_end (voiced extent), orig_start/orig_end (whisper's values),
        vad_flag in {"ok","shifted","split","capped","novoice"}.
    """
    p = dict(REFINE_DEFAULTS, **kw)
    _, _, mask = vad
    n = len(mask)
    T = n / FPS
    W = sorted((dict(w) for w in words), key=lambda w: w["start"])
    # ---- pass 1
    for i, w in enumerate(W):
        s, e = float(w["start"]), float(w["end"])
        w["orig_start"], w["orig_end"] = s, e
        prev_end = W[i - 1]["orig_end"] if i > 0 else 0.0
        next_start = W[i + 1]["start"] if i + 1 < len(W) else T
        isl = _islands_in(mask, s, e)
        flag = "ok"
        if not isl:
            # whisper placed the word on unvoiced audio: look a little outside the span
            isl = _islands_in(mask, max(prev_end, s - p["max_extend"]), min(next_start, e + p["max_extend"]))
            if not isl:
                w.update(core_start=s, core_end=e, vad_flag="novoice")
                continue
            flag = "shifted"
        # (a) leading coda: whisper ends phrase-final words ~0.1 s early, so the previous word's tail (or a
        #     filler right after it) often sits at the start of this span. If the first island touches the
        #     span start, continues from before it, is short, and is followed by a pause -> not this word.
        k0 = int(round(s * FPS))
        if (len(isl) > 1 and isl[0][0] <= s + 0.011 and k0 > 0 and mask[k0 - 1]
                and isl[0][1] - s <= p["sliver"] and isl[1][0] - isl[0][1] >= p["coda_gap"]):
            isl = isl[1:]
            flag = "split"
        clusters = [[isl[0]]]
        for a, b in isl[1:]:
            if a - clusters[-1][-1][1] >= p["split_gap"]:
                clusters.append([(a, b)])
            else:
                clusters[-1].append((a, b))
        if len(clusters) > 1:
            # (b) whisper absorbs preceding pauses / dropped retakes / fillers into the *start* of a word
            #     (measured: start-early >0.3 s in ~25% of phrase-initial words, end-late >0.3 s in <1%),
            #     so the real word is the LAST cluster.
            flag = "split"
        cs, ce = clusters[-1][0][0], clusters[-1][-1][1]
        # (c) cap implausibly long words (reference data: dur <= 0.35 + 0.30*syllables for 99.7% of words);
        #     keep the END, the dropped head becomes an uncovered voiced region -> recovery pass.
        max_core = p["max_base"] + p["max_per_syl"] * max(_syllables(w["text"]), 1.0)
        if ce - cs > max_core:
            cs = ce - max_core
            flag = "capped"
        if ce - cs < p["min_word"]:
            mid = 0.5 * (cs + ce); cs, ce = mid - p["min_word"] / 2, mid + p["min_word"] / 2
        w.update(core_start=cs, core_end=ce, vad_flag=flag)
    # ---- pass 2: grow into voiced audio up to the neighbours' cores
    for i, w in enumerate(W):
        if w["vad_flag"] == "novoice":
            continue
        lo = max(W[i - 1]["core_end"] if i > 0 else 0.0, w["orig_start"] - p["max_extend"])
        hi = min(W[i + 1]["core_start"] if i + 1 < len(W) else T, w["orig_end"] + p["max_extend"])
        if w["core_start"] <= w["orig_start"] + 0.011:
            k = int(round(w["core_start"] * FPS)) - 1
            while k >= 0 and k / FPS >= lo and mask[k]:
                k -= 1
            w["core_start"] = min(w["core_start"], (k + 1) / FPS)
        if w["core_end"] >= w["orig_end"] - 0.011:
            k = int(round(w["core_end"] * FPS))
            while k < n and (k + 1) / FPS <= hi and mask[k]:
                k += 1
            w["core_end"] = max(w["core_end"], k / FPS)
    # ---- pass 3: padding + overlap resolution between neighbours
    for w in W:
        w["start"] = max(0.0, w["core_start"] - p["pad_before"])
        w["end"] = min(T, w["core_end"] + p["pad_after"])
    for i in range(len(W) - 1):
        a, b = W[i], W[i + 1]
        if a["end"] > b["start"]:
            if a["core_end"] <= b["core_start"]:
                gap = b["core_start"] - a["core_end"]
                tot = p["pad_after"] + p["pad_before"]
                cut = a["core_end"] + gap * (p["pad_after"] / tot if tot > 0 else 0.5)
            else:
                cut = 0.5 * (a["core_end"] + b["core_start"])
            a["end"] = max(cut, a["start"] + 0.01)
            b["start"] = min(cut, b["end"] - 0.01)
    return W


def uncovered_regions(words, vad, min_dur=0.3, cover_pad=0.05, merge_gap=0.25):
    """Voiced regions (>= min_dur after merging gaps < merge_gap) not overlapped by any word core."""
    _, _, mask = vad
    n = len(mask)
    cov = np.zeros(n, dtype=bool)
    for w in words:
        a = int(max(0, (w.get("core_start", w["start"]) - cover_pad) * FPS))
        b = int(min(n, (w.get("core_end", w["end"]) + cover_pad) * FPS))
        cov[a:b] = True
    m = mask & ~cov
    regs = [(s / FPS, e / FPS) for s, e in _runs(m)]
    merged = []
    for a, b in regs:
        if merged and a - merged[-1][1] < merge_gap:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    return [(a, b) for a, b in merged if b - a >= min_dur]
