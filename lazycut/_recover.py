from __future__ import annotations
"""제이컷 - missed-speech recovery pass prototype (mlx-whisper).

After the main transcription + VAD refinement, voiced regions that no word covers are re-transcribed
one by one (whisper tends to silently drop repeated takes / false starts / short phrases between pauses).

    from vad_refine_proto import analyze, refine, uncovered_regions
    vad = analyze(audio)
    words = refine(words, vad)
    new_words, report = recover(audio, words, vad)        # new_words: recovered words (seg = -1 - region index)
    words = refine(sorted(words + new_words, key=lambda w: w["start"]), vad)   # (refine raw times again)

Rules (see research/whisper_settings.md for the measurements behind them):
  * candidates: VAD-voiced regions >= 0.40 s (gaps < 0.25 s merged) not overlapped by any word core (+-50 ms)
  * snippet = region +- 0.25 s, transcribed alone with the same model, condition_on_previous_text=False,
    no initial prompt, word_timestamps=True, temperature fallback default
  * segment filters: avg_logprob < -1.0 | no_speech_prob > 0.6 and avg_logprob < -0.5 | compression_ratio > 2.4
    | blacklist (YouTube outro / broadcaster hallucinations)
    NOTE: large-v3-turbo reports no_speech_prob ~0.00 even on pure car noise, so that rule rarely fires.
  * keep only words whose midpoint lies inside the region (+-0.1 s) - the 0.25 s padding may re-hear neighbours
  * region-level rejects -> "sound" block instead of text:
      - whole recovered text is a stock phrase ("감사합니다" etc.; turbo outputs "감사합니다." for 28/30
        pure-noise snippets with avg_logprob -0.4..-0.95 and compression 0.64, so no score filter catches it)
      - mean avg_logprob of the used segments < -0.70 (real dropped phrases measured -0.12..-0.52)
      - result of <= 2 syllables with mean avg_logprob < -0.50 (filler / breath read as "멀", "하자", "그럼")
      - > 9 syllables per second of region, or < 1 syllable per 1.2 s
  * a candidate that survives no filter becomes a "sound" pseudo-word (text "", type "sound"), like
    type-3 blocks, so the user can still see and delete the filler/breath/noise in the editor.
"""
import re
import numpy as np

SR = 16000

BLACKLIST = re.compile(
    r"(시청\s*해\s*주셔서|시청해주셔서|구독|좋아요|알림\s*설정|MBC|KBS|SBS|JTBC|YTN|뉴스|자막|제공|"
    r"끝까지\s*시청|다음\s*영상|영상\s*편집|Thank you|thanks for watching|ご視聴|字幕|www\.|\.com)",
    re.IGNORECASE)

# whole-snippet outputs that are whisper's stock hallucinations on noise (compared after removing spaces/punct.)
STOCK = {"감사합니다", "감사합니다감사합니다", "고맙습니다", "시청해주셔서감사합니다", "구독과좋아요부탁드립니다",
         "다음영상에서만나요", "안녕히계세요", "아멘"}

RECOVER_DEFAULTS = dict(
    min_dur=0.40, merge_gap=0.25, cover_pad=0.05, snippet_pad=0.25,
    max_logprob=-1.0, nsp=0.6, nsp_logprob=-0.5, max_cr=2.4,
    min_region_logprob=-0.70,
    short_logprob=-0.50,          # 1-2 syllable results need avg_logprob >= -0.5 (filler/noise -> "멀", "하자")
    max_syl_per_s=9.0, min_syl_per_s=1 / 1.2,
)


def _syl(text):
    k = sum(1 for c in text if "가" <= c <= "힣")
    o = sum(1 for c in text if c.isalnum() and not ("가" <= c <= "힣"))
    return k + 0.6 * o


def segment_ok(seg, region_dur, p):
    t = seg["text"].strip()
    if not t:
        return False, "empty"
    if seg["avg_logprob"] < p["max_logprob"]:
        return False, "logprob"
    if seg["no_speech_prob"] > p["nsp"] and seg["avg_logprob"] < p["nsp_logprob"]:
        return False, "no_speech"
    if seg["compression_ratio"] > p["max_cr"]:
        return False, "compression"
    if BLACKLIST.search(t):
        return False, "blacklist"
    return True, "ok"


def recover(audio, words, vad, transcribe_kw, uncovered_fn, regions=None, **kw):
    """audio: float32 16k; words: refined words; transcribe_kw: kwargs for mlx_whisper.transcribe.
    regions: optional explicit list of (start, end) to test instead of the uncovered voiced regions."""
    import mlx_whisper
    p = dict(RECOVER_DEFAULTS, **kw)
    if regions is None:
        regions = uncovered_fn(words, vad, min_dur=p["min_dur"], cover_pad=p["cover_pad"], merge_gap=p["merge_gap"])
    out, report = [], []
    for ri, (a, b) in enumerate(regions):
        s0 = max(0.0, a - p["snippet_pad"]); s1 = min(len(audio) / SR, b + p["snippet_pad"])
        snip = audio[int(s0 * SR):int(s1 * SR)]
        r = mlx_whisper.transcribe(snip, **transcribe_kw)
        kept_words, reasons, used_lp = [], [], []
        for seg in r["segments"]:
            ok, why = segment_ok(seg, b - a, p)
            reasons.append(why)
            if not ok:
                continue
            n_before = len(kept_words)
            for w in seg.get("words", []):
                ws, we = w["start"] + s0, w["end"] + s0
                mid = 0.5 * (ws + we)
                if a - 0.1 <= mid <= b + 0.1:
                    kept_words.append(dict(text=w["word"].strip(), start=ws, end=we, p=float(w["probability"]),
                                           seg=-1 - ri, recovered=True))
            if len(kept_words) > n_before:
                used_lp.append(seg["avg_logprob"])
        syl = sum(_syl(w["text"]) for w in kept_words)
        rate = syl / max(b - a, 1e-3)
        flat = re.sub(r"[\s\.\,\!\?~]", "", "".join(w["text"] for w in kept_words))
        hint = " ".join(w["text"] for w in kept_words)
        verdict = "recovered"
        if kept_words and flat in STOCK:
            verdict, kept_words = "stock_phrase", []
        elif kept_words and np.mean(used_lp) < p["min_region_logprob"]:
            verdict, kept_words = "low_confidence", []
        elif kept_words and syl <= 2 and np.mean(used_lp) < p["short_logprob"]:
            verdict, kept_words = "short_low_confidence", []
        elif kept_words and rate > p["max_syl_per_s"]:
            verdict, kept_words = "too_dense", []
        elif kept_words and rate < p["min_syl_per_s"]:
            verdict, kept_words = "too_sparse", []
        elif not kept_words:
            verdict = "sound"
        if verdict != "recovered":
            kept_words = [dict(text="", hint=hint, start=a, end=b, p=0.0, seg=-1 - ri, recovered=True, type="sound")]
        out.extend(kept_words)
        report.append(dict(region=(round(a, 2), round(b, 2)), raw_text=" ".join(s["text"].strip() for s in r["segments"]),
                           seg_checks=reasons[:5], verdict=verdict, hint=hint, text=" ".join(w["text"] for w in kept_words),
                           segs=[dict(lp=round(s["avg_logprob"], 3), nsp=round(s["no_speech_prob"], 3),
                                      cr=round(s["compression_ratio"], 2)) for s in r["segments"][:5]]))
    return out, report
