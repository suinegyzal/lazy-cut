"""Media preparation: 16 kHz audio, waveform peaks, keyframe thumbnails, preview proxy."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import wave

import numpy as np

from . import ffmpeg as ff

PLAYABLE_CODECS = {"h264", "hevc", "vp9", "av1"}
PLAYABLE_CONTAINERS = {"mov", "mp4", "m4v", "webm"}


def cache_dir_for(video_path: str, root: str) -> str:
    rp = os.path.realpath(video_path)
    st = os.stat(rp)
    key = hashlib.sha1(("%s|%d|%d" % (rp, st.st_size, int(st.st_mtime))).encode("utf-8")).hexdigest()[:16]
    d = os.path.join(root, key)
    os.makedirs(d, exist_ok=True)
    return d


def ensure_audio16k(video_path, cache_dir, on_progress=None, cancel=None) -> str:
    out = os.path.join(cache_dir, "audio16k.wav")
    if os.path.isfile(out) and os.path.getsize(out) > 44:
        return out
    tmp = out + ".part.wav"
    try:
        src = ff.probe(video_path)
        ff.run(["-i", video_path, "-map", "0:a:0", "-vn", "-af", "aresample=async=1:first_pts=0",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", tmp],
               total_seconds=src.get("duration") or None, on_progress=on_progress, cancel=cancel)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return out


def ensure_peaks(wav16k_path, cache_dir) -> str:
    out = os.path.join(cache_dir, "peaks.u8")
    if os.path.isfile(out):
        return out
    vals = []
    with wave.open(wav16k_path, "rb") as w:
        while True:
            buf = w.readframes(160 * 6000)
            if not buf:
                break
            a = np.abs(np.frombuffer(buf, dtype=np.int16).astype(np.float32)) / 32768.0
            n = len(a) // 160
            if n:
                vals.append(a[:n * 160].reshape(n, 160).max(axis=1))
            if len(a) % 160:
                vals.append(np.array([a[n * 160:].max()], dtype=np.float32))
    pk = np.concatenate(vals) if vals else np.zeros(0, dtype=np.float32)
    (np.round(np.sqrt(np.clip(pk, 0, 1)) * 255)).astype(np.uint8).tofile(out + ".part")
    os.replace(out + ".part", out)
    return out


def ensure_thumbs(video_path, cache_dir, on_progress=None, cancel=None) -> str:
    d = os.path.join(cache_dir, "thumbs")
    index = os.path.join(d, "index.json")
    if os.path.isfile(index):
        return index
    tmpd = d + ".part"
    shutil.rmtree(tmpd, ignore_errors=True)
    os.makedirs(tmpd)
    src = ff.probe(video_path)
    # keyframes only (fast); showinfo gives each output frame's pts_time
    err = ff.run(["-hwaccel", "videotoolbox", "-skip_frame", "nokey", "-i", video_path, "-map", "0:v:0",
                  "-vf", "scale=-2:99,showinfo", "-fps_mode", "vfr", "-q:v", "6",
                  os.path.join(tmpd, "%06d.jpg")],
                 total_seconds=src.get("duration") or None, on_progress=on_progress, cancel=cancel,
                 keep_stderr=True)
    times = [float(x) for x in re.findall(r"pts_time:([\d.]+)", err)]
    files = sorted(f for f in os.listdir(tmpd) if f.endswith(".jpg"))
    if len(times) < len(files):   # stderr tail is capped; fall back to even spacing
        dur = src.get("duration") or 0.0
        times = [dur * i / max(1, len(files)) for i in range(len(files))]
    items = [{"t": round(t, 3), "f": f} for t, f in zip(times, files)]
    with open(os.path.join(tmpd, "index.json"), "w") as f:
        json.dump(items, f)
    shutil.rmtree(d, ignore_errors=True)
    os.replace(tmpd, d)
    return index


def browser_playable(source: dict) -> bool:
    return ((source.get("vcodec") or "") in PLAYABLE_CODECS
            and (source.get("container") or "") in PLAYABLE_CONTAINERS)


def ensure_proxy(video_path, cache_dir, source, on_progress=None, cancel=None) -> str:
    out = os.path.join(cache_dir, "proxy.mp4")
    if os.path.isfile(out):
        return out
    tmp = out + ".part.mp4"
    fps = "%d/%d" % (source.get("fpsNum") or 30, source.get("fpsDen") or 1)
    g = str(max(1, int(round(float(source.get("fps") or 30) / 5))))   # keyframe every 0.2 s -> instant seeks
    common = ["-hwaccel", "videotoolbox", "-i", video_path, "-map", "0:v:0", "-map", "0:a:0?",
              "-vf", "scale=-2:'min(540,ih)'",
              "-r", fps, "-g", g, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
              "-movflags", "+faststart"]
    try:
        try:
            ff.run(common + ["-c:v", "h264_videotoolbox", "-b:v", "2M", "-realtime", "0", tmp],
                   total_seconds=source.get("duration"), on_progress=on_progress, cancel=cancel)
        except ff.FFmpegError:
            ff.run(common + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", tmp],
                   total_seconds=source.get("duration"), on_progress=on_progress, cancel=cancel)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return out


def prepare(video_path, source, cache_dir, on_progress=None, cancel=None) -> dict:
    def sub(lo, hi):
        return (lambda p: on_progress(lo + (hi - lo) * p)) if on_progress else None

    res = {"audio16k": None, "peaks": None, "thumbs": None, "proxy": None,
           "playable": browser_playable(source)}
    if source.get("hasAudio"):
        res["audio16k"] = ensure_audio16k(video_path, cache_dir, sub(0.0, 0.4), cancel)
        res["peaks"] = ensure_peaks(res["audio16k"], cache_dir)
    if source.get("hasVideo"):
        try:
            res["thumbs"] = ensure_thumbs(video_path, cache_dir, sub(0.4, 0.7), cancel)
        except ff.Canceled:
            raise
        except Exception:  # noqa: BLE001 — thumbnails are optional
            res["thumbs"] = None
        # light preview copy for smooth skip-playback over cuts (also needed when the codec isn't playable)
        try:
            res["proxy"] = ensure_proxy(video_path, cache_dir, source, sub(0.7, 1.0), cancel)
        except ff.Canceled:
            raise
        except Exception:  # noqa: BLE001 — the original can still be previewed if playable
            if not res["playable"]:
                raise
    if on_progress:
        on_progress(1.0)
    return res
