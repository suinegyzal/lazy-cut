"""Whisper words -> token partition -> clips (subtitle lines), plus filler / repeat / NG suggestions.

Rules follow a study of a hand-made clean cut of a real episode:
  * silence is measured from audio (VAD), never from whisper's word gaps
  * word tokens keep a small pad (~40 ms before / 60 ms after the voiced core) so cutting every gap to 0 s
    leaves a natural ~0.1 s seam without clipping syllables
  * NG takes: keep the LAST take (R1 restart, R2 correction, R5 repeated sentence); fillers are only marked
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from . import _vadcore as core
from . import segment
from .project import new_id

PAD_BEFORE = 0.04
PAD_AFTER = 0.06
MIN_GAP = 0.08          # gaps shorter than this are absorbed into neighbouring words
MIN_NOISE = 0.15        # voiced run inside a gap shorter than this is just part of the silence
ATTACH_NOISE = 0.05     # voiced run starting within 50 ms of the previous word = that word's tail

STRONG_FILLERS = {"음", "음음", "으음", "어", "어어", "으", "에", "엄", "흠", "아", "어음", "으으", "에에"}
CONNECTIVES = ("그래서", "그리고", "근데", "그런데", "그러니까", "그니까", "자", "아", "어", "음", "그", "이제", "또")
EDIT_DIRECTIVE = re.compile(r"(이건\s*빼|뺍시다|빼고\s*갈|빼\s*주세요|다시\s*할게요|다시\s*하겠습니다|다시\s*갈게요|편집해\s*주세요)")
AUTO_TOKEN_FLAGS = {"filler", "filler?", "repeat", "lowconf"}


def _norm(text: str) -> str:
    return re.sub(r"[^0-9a-zA-Z가-힣]", "", text or "").lower()


def _clean_text(text: str) -> str:
    t = (text or "").strip()
    # user's SRT convention: sentence-final periods dropped, , ? ! kept
    if not t.endswith("..."):
        t = t.rstrip(".")
    return t.strip()


# ---------------------------------------------------------------- build

def build_clips(whisper: dict, vad, duration: float, settings: dict | None = None) -> list:
    settings = settings or {}
    max_chars = int(settings.get("maxChars") or 22)
    vt = vad.as_tuple() if hasattr(vad, "as_tuple") else vad
    mask = vt[2]
    duration = float(duration or (len(mask) / core.FPS))

    segs = whisper.get("segments") or []
    bad_segs = set()
    for i, s in enumerate(segs):
        a, b = int(s["start"] * core.FPS), int(s["end"] * core.FPS)
        if b > a and mask[max(0, a):min(len(mask), b)].mean() < 0.15:
            bad_segs.add(i)   # whisper text over (almost) no voice = hallucination

    words, sounds = [], []
    for w in whisper.get("words") or []:
        if w.get("type") == "sound" or not (w.get("text") or "").strip():
            sounds.append((float(w["start"]), float(w["end"])))
            continue
        if w.get("seg") is not None and w["seg"] in bad_segs:
            continue
        txt = _clean_text(w["text"])
        if not txt:
            continue
        words.append({"text": txt, "start": float(w["start"]), "end": float(w["end"]),
                      "p": w.get("p"), "recovered": bool(w.get("recovered"))})
    words.sort(key=lambda w: w["start"])
    if words:
        words = core.refine(words, vt, pad_before=PAD_BEFORE, pad_after=PAD_AFTER)
        _snap_onsets(words, vt[0], duration)

    tokens = _partition(words, mask, duration)
    word_idx = [i for i, t in enumerate(tokens) if t["type"] == "word"]
    starts = segment.split_lines([tokens[i] for i in word_idx], max_chars=max_chars) if word_idx else [0]
    clip_starts = {word_idx[s] for s in starts if s > 0}
    clips, cur = [], []
    for i, t in enumerate(tokens):
        if i in clip_starts and cur:
            clips.append(cur)
            cur = []
        cur.append(t)
    if cur:
        clips.append(cur)
    out = [{"id": new_id("c_"), "caption": None, "flags": [], "ngOf": None, "words": c} for c in clips]
    return analyze(out)


def _snap_onsets(words: list, db, duration: float) -> None:
    """Move each word start to where its sound actually begins.

    Whisper starts words early (the previous word's tail / the closure before a plosive). Between words
    spoken without a pause there is a short energy dip; the new word starts where energy climbs back
    halfway from that dip to the next peak. The dip itself stays with the previous word.
    """
    import numpy as np
    e = 10 * np.log10(np.power(10.0, db[:, 0] / 10) + np.power(10.0, db[:, 1] / 10))
    n = len(e)
    fps = core.FPS
    for i, w in enumerate(words):
        s = float(w["start"])
        # whisper is usually early (up to ~0.4 s), rarely late: search mostly forward
        lo = max(int((s - 0.1) * fps), int(((words[i - 1]["start"] + 0.08) if i > 0 else 0) * fps))
        hi = min(int((s + 0.45) * fps), int((float(w["end"]) - 0.08) * fps), n - 1)
        if hi - lo < 3:
            continue
        # first point followed by a clear rise (the new word's onset), then slide down into that dip
        k = None
        for f in range(lo, hi):
            if float(e[f:min(n, f + 13)].max()) - e[f] >= 8:
                k = f
                break
        if k is None:
            continue
        while k + 1 < hi and e[k + 1] <= e[k]:
            k += 1
        peak = float(e[k:min(n, k + 13)].max())
        left = float(e[max(0, k - 15):k + 1].max())
        if peak - e[k] < 8 or left - e[k] < 4:      # no clear dip -> keep whisper/VAD timing
            continue
        thr = e[k] + 0.5 * (peak - e[k])
        j = k
        while j < min(n - 1, k + 13) and e[j] < thr:
            j += 1
        t = max(0.0, j / fps - 0.02)
        if i > 0 and words[i - 1]["end"] > s - 0.12:  # contiguous with the previous word: move the shared edge
            if t <= words[i - 1]["start"] + 0.08:
                continue
            words[i - 1]["end"] = t
        w["start"] = t


ALIGN_VERSION = 2


def realign(clips: list, vad) -> int:
    """Snap word starts of an existing (edited) project to their real sound onsets.

    Only shared token edges move; deletions, texts, captions and clip splits stay untouched.
    Returns the number of words moved.
    """
    vt = vad.as_tuple() if hasattr(vad, "as_tuple") else vad
    flat = [t for c in clips for t in c["words"]]
    idx = [i for i, t in enumerate(flat) if t["type"] == "word" and not t.get("joinPrev")]
    words = [{"start": flat[i]["start"], "end": flat[i]["end"]} for i in idx]
    if not words:
        return 0
    _snap_onsets(words, vt[0], flat[-1]["end"])
    moved = 0
    for w, i in zip(words, idx):
        t = round(float(w["start"]), 3)
        tok = flat[i]
        if abs(t - tok["start"]) < 0.015 or i == 0:
            continue
        prev = flat[i - 1]
        if not (prev["start"] + 0.02 < t < tok["end"] - 0.04):
            continue
        prev["end"] = t
        tok["start"] = t
        moved += 1
    return moved


def _tok(typ: str, s: float, e: float, text: str = "", p=None) -> dict:
    return {"id": new_id("w_"), "type": typ, "text": text, "orig": text if typ == "word" else "",
            "start": s, "end": e, "del": False, "keep": None, "flags": [], "p": p}


def _voiced_runs(mask, a: float, b: float) -> list:
    fa, fb = int(round(a * core.FPS)), int(round(b * core.FPS))
    runs, k = [], fa
    while k < fb:
        if k < len(mask) and mask[k]:
            j = k
            while j < fb and j < len(mask) and mask[j]:
                j += 1
            runs.append((k / core.FPS, j / core.FPS))
            k = j
        else:
            k += 1
    return runs


def _partition(words: list, mask, duration: float) -> list:
    toks: list = []
    cursor = 0.0
    for w in words:
        s = max(float(w["start"]), cursor)
        e = max(float(w["end"]), s + 0.02)
        if s - cursor >= MIN_GAP:
            _fill_gap(toks, cursor, s, mask)
        elif toks:
            toks[-1]["end"] = s
        else:
            s = 0.0
        p = w.get("p")
        toks.append(_tok("word", s, e, w["text"], round(float(p), 3) if p is not None else None))
        cursor = e
    if duration - cursor >= MIN_GAP or not toks:
        _fill_gap(toks, cursor, max(duration, cursor + 0.001), mask)
    else:
        toks[-1]["end"] = max(duration, toks[-1]["start"] + 0.001)
    for t in toks:
        t["start"], t["end"] = round(t["start"], 3), round(t["end"], 3)
    for a, b in zip(toks, toks[1:]):
        b["start"] = a["end"]
    toks[0]["start"] = 0.0
    return [t for t in toks if t["end"] > t["start"]] or toks


def _fill_gap(toks: list, a: float, b: float, mask) -> None:
    """Split silence [a,b] into gap / noise tokens; voiced tails touching the previous word extend it."""
    pieces = []
    for rs, re_ in _voiced_runs(mask, a, b):
        if re_ - rs < MIN_NOISE:
            continue
        if toks and toks[-1]["type"] == "word" and rs - a <= ATTACH_NOISE and not pieces:
            a = min(b, re_ + 0.03)          # the word's audible tail: keep it with the word
            toks[-1]["end"] = a
            continue
        pieces.append((max(a, rs - 0.02), min(b, re_ + 0.03)))
    cur = a
    for ns, ne in pieces:
        if ns - cur >= 0.05:
            toks.append(_tok("gap", cur, ns))
        elif toks and ns > cur:
            toks[-1]["end"] = ns
        else:
            ns = cur
        t = _tok("noise", ns, ne)
        t["flags"] = ["filler?"]
        toks.append(t)
        cur = ne
    if b - cur >= 0.03 or not toks:
        toks.append(_tok("gap", cur, b))
    elif toks:
        toks[-1]["end"] = b


# ---------------------------------------------------------------- flags

def analyze(clips: list) -> list:
    """Recompute suggestion flags in place (never deletes anything)."""
    for c in clips:
        c["flags"] = [f for f in c.get("flags") or [] if f != "ng"]
        c["ngOf"] = None
        for t in c["words"]:
            t["flags"] = [f for f in t.get("flags") or [] if f not in AUTO_TOKEN_FLAGS]
            if t["type"] == "noise":
                t["flags"].append("filler?")

    seq = []  # kept words in order with clip index and pause before
    last_end = None
    for ci, c in enumerate(clips):
        for t in c["words"]:
            if t.get("del"):
                continue
            if t["type"] == "word":
                pause = 0.0 if last_end is None else max(0.0, t["start"] - last_end)
                seq.append({"t": t, "ci": ci, "n": _norm(t["text"]), "pause": pause})
                last_end = t["end"]
            elif t["type"] == "noise":
                last_end = last_end  # noise does not break word adjacency
    for w in seq:
        t = w["t"]
        if w["n"] in STRONG_FILLERS:
            t["flags"].append("filler")
        p = t.get("p")
        dur = t["end"] - t["start"]
        if (p is not None and p < 0.5) or (dur >= 1.2 and len(w["n"]) / max(dur, 1e-3) < 2.0):
            t["flags"].append("lowconf")   # R7: whisper swallowed a retake into one long word

    _flag_stutters(seq)
    _flag_ng(seq, clips)
    for c in clips:
        if EDIT_DIRECTIVE.search(" ".join(t["text"] for t in c["words"] if t["type"] == "word")):
            if "ng" not in c["flags"]:
                c["flags"].append("ng")
        for t in c["words"]:
            t["flags"] = list(dict.fromkeys(t["flags"]))
    return clips


def _mark(t: dict, flag: str) -> None:
    if flag not in t["flags"]:
        t["flags"].append(flag)


def _flag_stutters(seq: list) -> None:
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        if not a["n"] or not b["n"]:
            continue
        paused = b["pause"] >= 0.1 or a["t"]["text"].endswith(",")
        same = a["n"] == b["n"]
        prefix = len(a["n"]) <= 3 and len(b["n"]) > len(a["n"]) and b["n"].startswith(a["n"])
        if (same or prefix) and paused:
            _mark(a["t"], "repeat")                       # R1 short: "제가, 제가" / "그러 그러니까"
        elif (b["pause"] >= 0.3 and len(a["n"]) >= 2 and len(b["n"]) >= 2 and a["n"] != b["n"]
              and a["n"][:2] == b["n"][:2] and abs(len(a["n"]) - len(b["n"])) <= 2):
            _mark(a["t"], "repeat")                       # R2 correction: "맥스나 … 맥스를"
    for i in range(len(seq) - 3):                         # 2-word phrase repeated after a pause
        if (seq[i]["n"], seq[i + 1]["n"]) == (seq[i + 2]["n"], seq[i + 3]["n"]) and seq[i + 2]["pause"] >= 0.1 \
                and seq[i]["n"]:
            _mark(seq[i]["t"], "repeat")
            _mark(seq[i + 1]["t"], "repeat")


def _utterances(seq: list) -> list:
    utts, cur = [], []
    for k, w in enumerate(seq):
        if cur and (w["pause"] >= 0.25 or seq[k - 1]["t"]["text"].endswith(",")):
            utts.append(cur)
            cur = []
        cur.append(k)
    if cur:
        utts.append(cur)
    return utts


def _strip_connectives(seq: list, idxs: list) -> list:
    k = 0
    while k < len(idxs) - 1 and seq[idxs[k]]["n"] in CONNECTIVES:
        k += 1
    return idxs[k:]


def _flag_ng(seq: list, clips: list) -> None:
    utts = _utterances(seq)
    texts = []
    for u in utts:
        core_idx = _strip_connectives(seq, u)
        texts.append("".join(seq[k]["n"] for k in core_idx))
    ng_words: dict = {}  # seq index -> clip index of the retake
    for i, u in enumerate(utts):
        A = texts[i]
        if len(A) < 4:
            continue
        a_end = seq[u[-1]]["t"]["end"]
        for j in range(i + 1, len(utts)):
            B = texts[j]
            b_start = seq[utts[j][0]]["t"]["start"]
            if b_start - a_end > 60:
                break
            if not B:
                continue
            sim = SequenceMatcher(None, A, B[:len(A) + 3], autojunk=False).ratio()
            r1 = b_start - a_end <= 12 and A[:2] == B[:2] and sim >= 0.7
            r5 = len(A) >= 6 and sim >= 0.8
            if (r1 or r5) and len(B) >= len(A) * 0.8:
                for k in u:
                    ng_words[k] = seq[utts[j][0]]["ci"]
                break
    for k, ci_retake in ng_words.items():
        _mark(seq[k]["t"], "repeat")
    by_clip: dict = {}
    for k, w in enumerate(seq):
        tot, ng, tgt = by_clip.get(w["ci"], (0, 0, None))
        n = len(w["n"])
        if k in ng_words:
            by_clip[w["ci"]] = (tot + n, ng + n, ng_words[k])
        else:
            by_clip[w["ci"]] = (tot + n, ng, tgt)
    for ci, (tot, ng, tgt) in by_clip.items():
        if tot and ng / tot >= 0.6:
            c = clips[ci]
            if "ng" not in c["flags"]:
                c["flags"].append("ng")
            if tgt is not None and tgt != ci:
                c["ngOf"] = clips[tgt]["id"]


# ---------------------------------------------------------------- resegment

def resegment(clips: list, max_chars: int) -> list:
    tokens = [t for c in clips for t in c["words"]]
    old_by_ids = {tuple(t["id"] for t in c["words"]): c for c in clips}
    word_idx = [i for i, t in enumerate(tokens) if t["type"] == "word" and not t.get("del")]
    if not word_idx:
        return clips
    starts = segment.split_lines([tokens[i] for i in word_idx], max_chars=int(max_chars or 22))
    clip_starts = {word_idx[s] for s in starts if s > 0}
    groups, cur = [], []
    for i, t in enumerate(tokens):
        if i in clip_starts and cur:
            groups.append(cur)
            cur = []
        cur.append(t)
    if cur:
        groups.append(cur)
    out = []
    for g in groups:
        old = old_by_ids.get(tuple(t["id"] for t in g))
        if old:
            out.append(old)
        else:
            out.append({"id": new_id("c_"), "caption": None, "flags": [], "ngOf": None, "words": g})
    return analyze(out)
