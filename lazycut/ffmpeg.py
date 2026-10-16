"""ffmpeg helpers: binary path, probe (parses `ffmpeg -i`), run with progress + cancel."""
from __future__ import annotations

import collections
import os
import re
import subprocess
import threading
import time


class FFmpegError(Exception):
    def __init__(self, message: str, stderr_tail: str = ""):
        super().__init__(message)
        self.stderr_tail = stderr_tail


class Canceled(Exception):
    pass


_EXE = None


def ffmpeg_exe() -> str:
    global _EXE
    if _EXE is None:
        import imageio_ffmpeg
        _EXE = imageio_ffmpeg.get_ffmpeg_exe()
    return _EXE


def _parse_rate(s: str):
    """'30', '29.97', '30000/1001' -> (num, den)."""
    s = s.strip()
    if "/" in s:
        a, b = s.split("/", 1)
        return int(a), int(b)
    f = float(s)
    for num, den in ((24000, 1001), (30000, 1001), (60000, 1001)):
        if abs(f - num / den) < 0.005:
            return num, den
    if abs(f - round(f)) < 0.001:
        return int(round(f)), 1
    return int(round(f * 1000)), 1000


def probe(path: str) -> dict:
    p = subprocess.run([ffmpeg_exe(), "-hide_banner", "-nostdin", "-i", path],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                       errors="replace")
    err = p.stderr
    st = os.stat(path)
    src = {"path": os.path.abspath(path), "size": st.st_size, "mtime": st.st_mtime,
           "duration": 0.0, "fps": 30.0, "fpsNum": 30, "fpsDen": 1, "width": 0, "height": 0, "rotation": 0,
           "vcodec": None, "acodec": None, "sampleRate": 0, "channels": 0, "bitrate": None, "vbitrate": None,
           "hasVideo": False, "hasAudio": False,
           "container": os.path.splitext(path)[1].lower().lstrip("."),
           "colorPrimaries": None, "colorTrc": None, "colorSpace": None, "colorRange": None}
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if m:
        src["duration"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    m = re.search(r"Duration:.*?bitrate: (\d+) kb/s", err)
    if m:
        src["bitrate"] = int(m.group(1)) * 1000
    for line in err.splitlines():
        if "Stream #" not in line:
            continue
        if ": Video:" in line and not src["hasVideo"] and "attached pic" not in line:
            src["hasVideo"] = True
            body = line.split(": Video:", 1)[1]
            src["vcodec"] = body.strip().split()[0].rstrip(",")
            m = re.search(r", (\d{2,5})x(\d{2,5})", body)
            if m:
                src["width"], src["height"] = int(m.group(1)), int(m.group(2))
            m = re.search(r"([\d.]+(?:/\d+)?) fps", body) or re.search(r"([\d.]+) tbr", body)
            if m:
                num, den = _parse_rate(m.group(1))
                src["fpsNum"], src["fpsDen"], src["fps"] = num, den, round(num / den, 4)
            m = re.search(r"(\d+) kb/s", body)
            if m:
                src["vbitrate"] = int(m.group(1)) * 1000
            m = re.search(r"\((tv|pc), ([a-z0-9]+)(?:/([a-z0-9-]+))?(?:/([a-z0-9-]+))?", body)
            if m:
                src["colorRange"] = m.group(1)
                src["colorSpace"] = m.group(2)
                src["colorPrimaries"] = m.group(3) or m.group(2)
                src["colorTrc"] = m.group(4) or m.group(3) or m.group(2)
        elif ": Audio:" in line and not src["hasAudio"]:
            src["hasAudio"] = True
            body = line.split(": Audio:", 1)[1]
            src["acodec"] = body.strip().split()[0].rstrip(",")
            m = re.search(r"(\d+) Hz", body)
            if m:
                src["sampleRate"] = int(m.group(1))
            src["channels"] = 1 if "mono" in body else 2
    m = re.search(r"rotation of (-?[\d.]+) degrees", err)
    if m:
        src["rotation"] = int(round(-float(m.group(1)))) % 360
    if not src["hasVideo"] and not src["hasAudio"]:
        raise FFmpegError("영상/소리 스트림을 찾지 못했어요", "\n".join(err.splitlines()[-20:]))
    return src


def run(args: list, *, total_frames=None, total_seconds=None, on_progress=None, cancel=None, timeout=None,
        keep_stderr: bool = False) -> str:
    """Run ffmpeg; returns stderr text (last 40 lines, or all with keep_stderr). Raises Canceled / FFmpegError."""
    cmd = [ffmpeg_exe(), "-nostdin", "-hide_banner", "-y", "-progress", "pipe:1", "-nostats"] + list(args)
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace", bufsize=1)
    tail = collections.deque(maxlen=40)
    full = []

    def pump_err():
        for ln in proc.stderr:
            tail.append(ln.rstrip())
            if keep_stderr:
                full.append(ln.rstrip())

    th = threading.Thread(target=pump_err, daemon=True)
    th.start()
    t0 = time.monotonic()
    try:
        for ln in proc.stdout:
            if cancel is not None and cancel.is_set():
                raise Canceled()
            if timeout and time.monotonic() - t0 > timeout:
                raise FFmpegError("ffmpeg 시간 초과", "\n".join(tail))
            if on_progress is None:
                continue
            k, _, v = ln.strip().partition("=")
            try:
                if k == "frame" and total_frames:
                    on_progress(min(1.0, int(v) / total_frames))
                elif k == "out_time_us" and total_seconds and not total_frames:
                    on_progress(min(1.0, int(v) / 1e6 / total_seconds))
            except ValueError:
                pass
        while proc.poll() is None:
            if cancel is not None and cancel.is_set():
                raise Canceled()
            time.sleep(0.1)
    except BaseException:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise
    th.join(timeout=2)
    if proc.returncode != 0:
        raise FFmpegError("ffmpeg 실패 (코드 %s): %s" % (proc.returncode, tail[-1] if tail else ""), "\n".join(tail))
    return "\n".join(full if keep_stderr else tail)
