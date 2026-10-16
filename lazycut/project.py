"""Project schema (.lazycut), load/save, kept ranges, output mapping and SRT (SPEC §2)."""
from __future__ import annotations

import datetime as _dt
import json
import math
import os
import secrets
import tempfile

FORMAT = 1
EXT = ".lazycut"
DEFAULT_SETTINGS = {"maxChars": 22, "silenceMin": 0.15, "silenceKeep": 0.0, "includeNoise": True}


def now_iso() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix: str, n: int = 8) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    return prefix + "".join(secrets.choice(alphabet) for _ in range(n))


# ---------------------------------------------------------------- create / io

def new_project(source: dict, settings: dict | None = None) -> dict:
    stem = os.path.splitext(os.path.basename(source.get("path", "")))[0]
    st = dict(DEFAULT_SETTINGS)
    st.update(settings or {})
    return {
        "app": "lazycut", "format": FORMAT,
        "id": "p_" + secrets.token_hex(6),
        "name": stem,
        "file": None,
        "createdAt": now_iso(), "updatedAt": now_iso(),
        "source": dict(source),
        "transcribe": {"model": None, "lang": "ko", "doneAt": None},
        "settings": st,
        "clips": [],
        "markers": [],
    }


def project_path_for(video_path: str) -> str:
    d = os.path.dirname(os.path.abspath(video_path))
    stem = os.path.splitext(os.path.basename(video_path))[0]
    if os.access(d, os.W_OK):
        return os.path.join(d, stem + EXT)
    alt = os.path.join(os.path.expanduser("~/Documents"), "Lazy - Cut 프로젝트")
    os.makedirs(alt, exist_ok=True)
    return os.path.join(alt, stem + EXT)


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        p = json.load(f)
    if p.get("app") != "lazycut":
        raise ValueError("Lazy - Cut 프로젝트 파일이 아니에요.")
    p.setdefault("settings", {})
    for k, v in DEFAULT_SETTINGS.items():
        p["settings"].setdefault(k, v)
    p.setdefault("clips", [])
    p.setdefault("markers", [])
    p["file"] = path
    repair(p)
    return p


def save(project: dict, path: str) -> None:
    project["updatedAt"] = now_iso()
    project["file"] = path
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".lazycut-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(project, f, ensure_ascii=False, separators=(",", ":"))
        if os.path.exists(path):
            try:
                os.replace(path, path + ".bak")
            except OSError:
                pass
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def repair(project: dict) -> list:
    """Restore the partition invariant (sorted, contiguous, [0, duration]); drop empty clips."""
    warnings = []
    clips = [c for c in project.get("clips") or [] if c.get("words")]
    if len(clips) != len(project.get("clips") or []):
        warnings.append("빈 클립을 정리했어요")
    project["clips"] = clips
    toks = [t for c in clips for t in c["words"]]
    if not toks:
        return warnings
    dur = float((project.get("source") or {}).get("duration") or toks[-1]["end"])
    for c in clips:
        c.setdefault("caption", None)
        c.setdefault("flags", [])
        c.setdefault("ngOf", None)
        if not c.get("id"):
            c["id"] = new_id("c_")
    prev = 0.0
    for t in toks:
        t.setdefault("del", False)
        t.setdefault("keep", None)
        t.setdefault("flags", [])
        t.setdefault("text", "")
        if not t.get("id"):
            t["id"] = new_id("w_")
        s, e = float(t.get("start", prev)), float(t.get("end", prev))
        if abs(s - prev) > 0.002:
            warnings.append("단어 시간 %.3f 보정" % s)
        s = prev
        e = max(e, s)
        t["start"], t["end"] = round(s, 3), round(e, 3)
        prev = e
    if abs(toks[-1]["end"] - dur) > 0.002 and dur > toks[-1]["start"]:
        toks[-1]["end"] = round(dur, 3)
    return warnings


# ---------------------------------------------------------------- derived values

def iter_tokens(project: dict):
    for c in project.get("clips") or []:
        for t in c.get("words") or []:
            yield t


def auto_caption(clip: dict) -> str:
    out = ""
    for t in clip.get("words") or []:
        if t.get("type") != "word" or t.get("del") or not t.get("text"):
            continue
        out += (" " if out and not t.get("joinPrev") else "") + t["text"]
    return out.strip()


def caption_of(clip: dict) -> str:
    c = clip.get("caption")
    return auto_caption(clip) if c is None else c


def kept_ranges(project: dict) -> list:
    out: list = []

    def add(s, e):
        if e - s <= 0:
            return
        if out and s <= out[-1][1] + 1e-6:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])

    for t in iter_tokens(project):
        if t.get("del"):
            continue
        s, e = float(t["start"]), float(t["end"])
        keep = t.get("keep")
        if t.get("type") in ("gap", "noise") and keep is not None and keep < e - s:
            k = max(0.0, float(keep)) / 2
            if k > 0:
                add(s, s + k)
                add(e - k, e)
        else:
            add(s, e)
    return [(a, b) for a, b in out if b - a >= 0.001]


def _fps(project: dict):
    src = project.get("source") or {}
    num, den = int(src.get("fpsNum") or 0), int(src.get("fpsDen") or 0)
    if num <= 0 or den <= 0:
        f = float(src.get("fps") or 30.0)
        num, den = int(round(f * 1000)), 1000
    return num, den


def kept_frame_ranges(project: dict) -> list:
    num, den = _fps(project)
    fps = num / den
    dur = float((project.get("source") or {}).get("duration") or 0.0)
    total = int(math.floor(dur * fps + 1e-6)) if dur > 0 else None
    out: list = []
    for s, e in kept_ranges(project):
        fs, fe = int(round(s * fps)), int(round(e * fps))
        fs = max(0, fs)
        if total is not None:
            fe = min(fe, total)
        if fe <= fs:
            continue
        if out and fs <= out[-1][1]:
            out[-1][1] = max(out[-1][1], fe)
        else:
            out.append([fs, fe])
    return [(a, b) for a, b in out]


def output_duration(project: dict) -> float:
    num, den = _fps(project)
    return sum(b - a for a, b in kept_frame_ranges(project)) * den / num


class _FrameMap:
    """Maps source times to output times through kept frame ranges."""

    def __init__(self, frames: list, fps: float):
        self.frames, self.fps = frames, fps
        self.cum = []
        c = 0
        for a, b in frames:
            self.cum.append(c)
            c += b - a
        self.total = c

    def start(self, t: float):
        """Output time of the first kept frame whose source time >= t (frame f covers [f/fps,(f+1)/fps))."""
        f = int(math.ceil(t * self.fps - 1e-6))
        for (a, b), c in zip(self.frames, self.cum):
            if f < b:
                return (c + max(0, f - a)) / self.fps
        return None

    def end(self, t: float):
        """Output time just after the last kept frame whose start < t."""
        f = int(math.ceil(t * self.fps - 1e-6))  # frames with index < f start before t
        best = None
        for (a, b), c in zip(self.frames, self.cum):
            if a >= f:
                break
            best = (c + min(b, f) - a) / self.fps
        return best


def build_cues(project: dict, frame_ranges=None, gap_fill: float = 1.0, min_dur: float = 0.3) -> list:
    num, den = _fps(project)
    fm = _FrameMap(frame_ranges if frame_ranges is not None else kept_frame_ranges(project), num / den)
    cues = []
    for clip in project.get("clips") or []:
        text = caption_of(clip).strip()
        if not text:
            continue
        speech = [t for t in clip.get("words") or [] if t.get("type") in ("word", "noise") and not t.get("del")]
        if not speech and clip.get("caption"):   # user-added subtitle over silence (T key)
            speech = [t for t in clip.get("words") or [] if not t.get("del")]
        if not speech:
            continue
        os_, oe = fm.start(speech[0]["start"]), fm.end(speech[-1]["end"])
        if os_ is None or oe is None or oe <= os_:
            continue
        cues.append({"start": os_, "end": oe, "text": text})
    for i in range(len(cues) - 1):
        a, b = cues[i], cues[i + 1]
        if b["start"] - a["end"] <= gap_fill or b["start"] < a["end"]:
            a["end"] = b["start"]
    for i, c in enumerate(cues):
        if c["end"] - c["start"] < min_dur:
            limit = cues[i + 1]["start"] if i + 1 < len(cues) else fm.total * den / num
            c["end"] = max(c["end"], min(c["start"] + min_dur, limit))
    out = []
    for c in cues:
        s, e = round(c["start"], 3), round(c["end"], 3)
        if e > s:
            out.append({"start": s, "end": e, "text": c["text"]})
    return out


def _ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d,%03d" % (h, m, s, ms)


def srt_text(cues: list) -> str:
    parts = []
    for i, c in enumerate(cues, 1):
        parts.append("%d\n%s --> %s\n%s\n" % (i, _ts(c["start"]), _ts(c["end"]), c["text"].replace("\r", "")))
    return "\n".join(parts) + ("\n" if parts else "")


def write_srt(cues: list, path: str) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write(srt_text(cues))


def export_map(project: dict, frame_ranges=None) -> dict:
    num, den = _fps(project)
    fps = num / den
    frames = frame_ranges if frame_ranges is not None else kept_frame_ranges(project)
    fm = _FrameMap(frames, fps)
    words = []
    for ci, clip in enumerate(project.get("clips") or []):
        for t in clip.get("words") or []:
            if t.get("type") != "word" or t.get("del"):
                continue
            os_, oe = fm.start(t["start"]), fm.end(t["end"])
            if os_ is None or oe is None or oe <= os_:
                continue
            words.append({"text": t["text"], "src_start": t["start"], "src_end": t["end"],
                          "out_start": round(os_, 3), "out_end": round(oe, 3), "clip": ci})
    return {"source": (project.get("source") or {}).get("path"), "fps": fps,
            "kept_frames": [list(f) for f in frames],
            "kept_ranges": [[round(a / fps, 3), round(b / fps, 3)] for a, b in frames],
            "words": words}
