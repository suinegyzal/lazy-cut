"""Frame-accurate cut export (mp4) + SRT / edit-map sidecars (SPEC §3.8).

Video: fps filter (frame n == source time n/fps) + select on frame ranges, re-timed to CFR.
Audio: decoded once through a pipe and cut sample-accurately in Python with output lengths derived from
cumulative video frames (zero drift), 3 ms fades at each junction.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import wave

import numpy as np

from . import ffmpeg as ff
from . import project as P

SR = 48000
FADE = int(0.003 * SR)


def default_output_paths(source_path: str):
    d = os.path.dirname(os.path.abspath(source_path))
    stem = os.path.splitext(os.path.basename(source_path))[0]
    stem = stem.replace("녹화 영상", "컷편집") if "녹화 영상" in stem else stem + " 컷편집"
    base, n = os.path.join(d, stem), 1
    cand = base
    while os.path.exists(cand + ".mp4") or os.path.exists(cand + ".srt"):
        n += 1
        cand = "%s (%d)" % (base, n)
    return cand + ".mp4", cand + ".srt"


def export_srt(project: dict, srt_path: str) -> str:
    P.write_srt(P.build_cues(project), srt_path)
    return srt_path


def _cut_audio(src_path: str, frames: list, fps: float, channels: int, out_wav: str, cancel=None, on_progress=None):
    cmd = [ff.ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-i", src_path, "-map", "0:a:0", "-vn",
           "-af", "aresample=async=1:first_pts=0", "-ac", str(channels), "-ar", str(SR), "-f", "s16le", "-"]
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_bytes = 2 * channels
    pos = 0                     # source sample position consumed from the pipe
    buf = b""

    def read_until(n_samples):
        """Return source samples [pos, pos+n) as int16 array [n, ch] (zeros past EOF)."""
        nonlocal pos, buf
        need = n_samples * frame_bytes
        while len(buf) < need:
            chunk = proc.stdout.read(max(1 << 20, need - len(buf)))
            if not chunk:
                break
            buf += chunk
        take, buf = buf[:need], buf[need:]
        pos += n_samples
        a = np.frombuffer(take, dtype=np.int16).reshape(-1, channels)
        if len(a) < n_samples:
            a = np.concatenate([a, np.zeros((n_samples - len(a), channels), dtype=np.int16)])
        return a

    ramp_in = (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, FADE))).astype(np.float32)[:, None]
    ramp_out = ramp_in[::-1]
    total = sum(b - a for a, b in frames)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(SR)
        cum = 0
        try:
            for k, (fs, fe) in enumerate(frames):
                if cancel is not None and cancel.is_set():
                    raise ff.Canceled()
                a_s = int(round(fs / fps * SR))
                L = int(round((cum + fe - fs) / fps * SR)) - int(round(cum / fps * SR))
                cum += fe - fs
                skip = a_s - pos
                while skip > 0:                     # discard samples in deleted parts
                    step = min(skip, SR * 10)
                    read_until(step)
                    skip -= step
                seg = read_until(L).astype(np.float32)
                if len(seg) > 2 * FADE:
                    if k > 0:
                        seg[:FADE] *= ramp_in
                    if k < len(frames) - 1:
                        seg[-FADE:] *= ramp_out
                w.writeframes(np.clip(seg, -32768, 32767).astype(np.int16).tobytes())
                if on_progress and total:
                    on_progress(cum / total)
        finally:
            proc.kill()
            proc.wait()


def _bitrate(src: dict, quality: str, out_h: int) -> int:
    base = src.get("vbitrate") or src.get("bitrate")
    w, h = src.get("width") or 1920, src.get("height") or 1080
    if not base:
        base = 0.15 * w * h * float(src.get("fps") or 30)
    if out_h and h and out_h < min(w, h):
        base *= (out_h / min(w, h)) ** 2
    base = min(base, 50e6)
    return int(base * {"high": 1.0, "medium": 0.6, "small": 0.35}.get(quality, 1.0))


CHUNK_FRAMES_SEC = 90     # output seconds per chunk
PARALLEL = 2              # hardware encoder is shared; 2 keeps decode and encode busy


def _chunks(frames: list, fps: float) -> list:
    """Group kept frame ranges into chunks of ~CHUNK_FRAMES_SEC output seconds (ranges are never split)."""
    out, cur, n = [], [], 0
    lim = int(CHUNK_FRAMES_SEC * fps)
    for r in frames:
        cur.append(r)
        n += r[1] - r[0]
        if n >= lim:
            out.append(cur)
            cur, n = [], 0
    if cur:
        out.append(cur)
    return out


def _encode_chunks(path, frames, num, den, scale, rate, quality, color, tmp_dir, total, on_progress, cancel):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    fps = num / den
    chunks = _chunks(frames, fps)
    done = [0] * len(chunks)
    lock = threading.Lock()
    crf = {"high": "18", "medium": "21", "small": "24"}.get(quality, "18")
    vt = ["-c:v", "h264_videotoolbox", "-b:v", str(rate), "-maxrate", str(int(rate * 1.5)),
          "-bufsize", str(rate * 2), "-profile:v", "high"]

    def one(i):
        ranges = chunks[i]
        f0 = ranges[0][0]
        last = ranges[-1][1]
        n_out = sum(b - a for a, b in ranges)
        sel = "+".join("between(n,%d,%d)" % (a - f0, b - 1 - f0) for a, b in ranges)
        chain = "fps=fps=%d/%d:start_time=0,select='%s',setpts=N/FRAME_RATE/TB" % (num, den, sel)
        out = os.path.join(tmp_dir, "chunk_%04d.mp4" % i)
        seek = ["-ss", "%.6f" % (f0 / fps), "-to", "%.6f" % ((last + 1) / fps)]

        def cb(p):
            with lock:
                done[i] = p * n_out
                if on_progress:
                    on_progress(min(1.0, sum(done) / total))

        tail = ["-map", "0:v:0", "-an", "-r", "%d/%d" % (num, den), "-tag:v", "avc1"] + color
        attempts = []
        if not scale:   # full hardware path: decode + filters on GPU frames + hardware encode
            attempts.append(["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld"] + seek +
                            ["-i", path, "-vf", chain] + tail + vt)
        attempts.append(["-hwaccel", "videotoolbox"] + seek + ["-i", path, "-vf", chain + scale, "-pix_fmt", "yuv420p"]
                        + tail + vt)
        attempts.append(seek + ["-i", path, "-vf", chain + scale, "-pix_fmt", "yuv420p"] + tail +
                        ["-c:v", "libx264", "-preset", "veryfast", "-crf", crf])
        err = None
        for args in attempts:
            try:
                ff.run(args + [out], total_frames=n_out, on_progress=cb, cancel=cancel)
                return out
            except ff.FFmpegError as e:
                err = e
        raise err

    with ThreadPoolExecutor(max_workers=PARALLEL) as ex:
        outs = list(ex.map(one, range(len(chunks))))
    with open(os.path.join(tmp_dir, "chunks.txt"), "w") as f:
        for o in outs:
            f.write("file '%s'\n" % o.replace("'", "'\\''"))


def export_video(project: dict, out_path: str, *, srt: bool = True, srt_path=None, map_json: bool = False,
                 quality: str = "high", resolution: str = "source", overwrite: bool = False,
                 on_progress=None, cancel=None, tmp_dir=None) -> dict:
    src = project["source"]
    path = src["path"]
    if not os.path.isfile(path):
        raise FileNotFoundError("원본 영상을 찾을 수 없어요: " + path)
    srt_path = srt_path or os.path.splitext(out_path)[0] + ".srt"
    map_path = os.path.splitext(out_path)[0] + ".json"
    for t in [out_path] + ([srt_path] if srt else []) + ([map_path] if map_json else []):
        if os.path.exists(t) and not overwrite:
            raise FileExistsError("같은 이름의 파일이 이미 있어요: " + t)
    frames = P.kept_frame_ranges(project)
    if not frames:
        raise ValueError("남은 구간이 없어요. 삭제를 일부 되돌려 주세요.")
    num, den = P._fps(project)
    fps = num / den
    N = sum(b - a for a, b in frames)
    tmp_dir = tmp_dir or os.path.dirname(os.path.abspath(out_path))
    os.makedirs(tmp_dir, exist_ok=True)
    wav = os.path.join(tmp_dir, "cut_audio.wav")
    graph = os.path.join(tmp_dir, "graph.txt")
    part = out_path + ".part.mp4"

    def prog(lo, hi):
        return (lambda p: on_progress(lo + (hi - lo) * p)) if on_progress else None

    try:
        has_audio = bool(src.get("hasAudio"))
        if has_audio:
            ch = 1 if int(src.get("channels") or 2) == 1 else 2
            _cut_audio(path, frames, fps, ch, wav, cancel, prog(0.0, 0.1))

        out_h = 0
        scale = ""
        if resolution in ("1080", "720"):
            out_h = int(resolution)
            w, h = src.get("width") or 0, src.get("height") or 0
            if min(w, h) > out_h:
                scale = (",scale=-2:%d:flags=lanczos" % out_h) if w >= h else (",scale=%d:-2:flags=lanczos" % out_h)
        rate = _bitrate(src, quality, out_h)
        color = []
        if src.get("colorPrimaries") == "bt709":
            color = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
        if src.get("colorRange") == "tv":
            color += ["-color_range", "tv"]
        _encode_chunks(path, frames, num, den, scale, rate, quality, color, tmp_dir, N,
                       prog(0.1, 0.93), cancel)
        # join chunks (stream copy) + mux the cut audio
        lst = os.path.join(tmp_dir, "chunks.txt")
        args = ["-f", "concat", "-safe", "0", "-i", lst] + (["-i", wav] if has_audio else []) + [
            "-map", "0:v"] + (["-map", "1:a", "-c:a", "aac", "-b:a", "192k"] if has_audio else []) + [
            "-c:v", "copy", "-movflags", "+faststart", part]
        ff.run(args, total_frames=N, on_progress=prog(0.93, 0.99), cancel=cancel)

        # verify duration
        info = subprocess.run([ff.ffmpeg_exe(), "-hide_banner", "-nostdin", "-i", part],
                              stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, errors="replace").stderr
        m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", info)
        expect = N / fps
        if m:
            got = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            if abs(got - expect) > 2.0 / fps + 0.05:
                raise ff.FFmpegError("결과 영상 길이가 맞지 않아요 (%.2f초, 예상 %.2f초)" % (got, expect), info)
        os.replace(part, out_path)
        res = {"mp4": out_path, "srt": None, "map": None, "duration": round(expect, 3),
               "size": os.path.getsize(out_path), "frames": N}
        if srt:
            P.write_srt(P.build_cues(project, frames), srt_path)
            res["srt"] = srt_path
        if map_json:
            with open(map_path, "w", encoding="utf-8") as f:
                json.dump(P.export_map(project, frames), f, ensure_ascii=False, indent=1)
            res["map"] = map_path
        if on_progress:
            on_progress(1.0)
        return res
    finally:
        for f in [part, wav, graph, os.path.join(tmp_dir, "chunks.txt")] + [
                os.path.join(tmp_dir, x) for x in os.listdir(tmp_dir) if x.startswith("chunk_")]:
            if os.path.exists(f):
                try:
                    os.unlink(f)
                except OSError:
                    pass
