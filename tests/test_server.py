"""Tests for the app shell: HTTP server, auth, static, media Range, projects, jobs, launcher.

Run:  cd LazyCut && $PY -m unittest tests.test_server -v

Everything runs against a server in a background thread on a free port with
LAZYCUT_HOME in a temp dir. The A/B modules (project, ffmpeg, media, export,
vad, analysis, segment) are replaced by small fakes via sys.modules, so these
tests only exercise the server's own logic. The real web/ folder is never
written: static tests use a temp copy.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types
import unittest
import uuid
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from lazycut import config  # noqa: E402

TOKEN = "test-token-" + uuid.uuid4().hex
_TMP = None
_PATCH = None


# --- fakes for modules owned by other engineers ------------------------------------------

def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S+09:00")


def _make_fakes() -> dict:
    ffmpeg = types.ModuleType("lazycut.ffmpeg")

    class FFmpegError(Exception):
        stderr_tail = ""

    class Canceled(Exception):
        pass

    def probe(path):
        if path.endswith(".bad"):
            raise FFmpegError("Invalid data found when processing input")
        st = os.stat(path)
        return {"path": path, "size": st.st_size, "mtime": st.st_mtime, "duration": 10.0,
                "fps": 30.0, "fpsNum": 30, "fpsDen": 1, "width": 640, "height": 360, "rotation": 0,
                "vcodec": "h264", "acodec": "aac", "sampleRate": 44100, "channels": 2,
                "bitrate": 1000000, "vbitrate": 900000, "hasVideo": True,
                "hasAudio": not path.endswith(".silent.mov"), "container": "mov"}

    ffmpeg.FFmpegError, ffmpeg.Canceled, ffmpeg.probe = FFmpegError, Canceled, probe
    ffmpeg.ffmpeg_exe = lambda: "/nonexistent/ffmpeg"

    project = types.ModuleType("lazycut.project")

    def new_project(source, settings=None):
        return {"app": "lazycut", "format": 1, "id": "p_" + uuid.uuid4().hex[:12],
                "name": os.path.splitext(os.path.basename(source["path"]))[0], "file": None,
                "createdAt": _now(), "updatedAt": _now(), "source": source,
                "transcribe": {"model": "turbo", "lang": "ko", "doneAt": None},
                "settings": dict(settings or {}), "clips": [], "markers": []}

    def project_path_for(video):
        return os.path.splitext(video)[0] + ".lazycut"

    def load(path):
        with open(path, "r", encoding="utf-8") as f:
            d = json.load(f)
        d["file"] = path
        return d

    def save(proj, path):
        proj["updatedAt"] = _now()
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(proj, f, ensure_ascii=False)
        os.replace(tmp, path)

    project.new_project, project.project_path_for = new_project, project_path_for
    project.load, project.save, project.repair = load, save, (lambda p: [])

    media = types.ModuleType("lazycut.media")
    media.prepare_calls = []

    def cache_dir_for(video, root):
        st = os.stat(video)
        key = hashlib.sha1(("%s|%d|%f" % (os.path.realpath(video), st.st_size, st.st_mtime)).encode()).hexdigest()
        d = os.path.join(root, key[:16])
        os.makedirs(d, exist_ok=True)
        return d

    def ensure_audio16k(video, cache_dir, on_progress=None, cancel=None):
        p = os.path.join(cache_dir, "audio16k.wav")
        with open(p, "wb") as f:
            f.write(b"RIFF....WAVE")
        return p

    def ensure_peaks(wav, cache_dir):
        p = os.path.join(cache_dir, "peaks.u8")
        with open(p, "wb") as f:
            f.write(bytes(range(100)))
        return p

    def prepare(video, source, cache_dir, on_progress=None, cancel=None):
        media.prepare_calls.append(video)
        if on_progress:
            on_progress(0.5)
        wav = ensure_audio16k(video, cache_dir)
        peaks = ensure_peaks(wav, cache_dir)
        if on_progress:
            on_progress(1.0)
        return {"audio16k": wav, "peaks": peaks, "proxy": None, "playable": True}

    def ensure_proxy(video, cache_dir, source, on_progress=None, cancel=None):
        p = os.path.join(cache_dir, "proxy.mp4")
        with open(p, "wb") as f:
            f.write(b"PROXY" * 100)
        return p

    media.cache_dir_for, media.ensure_audio16k, media.ensure_peaks = cache_dir_for, ensure_audio16k, ensure_peaks
    media.prepare, media.ensure_proxy = prepare, ensure_proxy
    media.browser_playable = lambda source: True

    export = types.ModuleType("lazycut.export")
    export.calls = []

    def default_output_paths(src):
        stem = os.path.splitext(src)[0]
        return stem + " 컷편집.mp4", stem + " 컷편집.srt"

    def export_video(proj, out_path, *, srt=True, srt_path=None, map_json=False, quality="high",
                     resolution="source", overwrite=False, on_progress=None, cancel=None, tmp_dir=None):
        export.calls.append({"out": out_path, "srt": srt, "srt_path": srt_path, "map": map_json,
                             "quality": quality, "resolution": resolution, "overwrite": overwrite,
                             "tmp_dir": tmp_dir, "tmp_exists": bool(tmp_dir and os.path.isdir(tmp_dir))})
        for i in range(3):
            if on_progress:
                on_progress((i + 1) / 3)
        with open(out_path, "wb") as f:
            f.write(b"MP4")
        if srt and srt_path:
            with open(srt_path, "w", encoding="utf-8-sig") as f:
                f.write("1\n00:00:00,000 --> 00:00:01,000\n안녕\n\n")
        return {"mp4": out_path, "srt": srt_path if srt else None, "map": None,
                "duration": 1.0, "size": 3, "frames": 30}

    def export_srt(proj, srt_path):
        with open(srt_path, "w", encoding="utf-8-sig") as f:
            f.write("1\n00:00:00,000 --> 00:00:01,000\n안녕\n\n")
        return srt_path

    export.default_output_paths, export.export_video, export.export_srt = default_output_paths, export_video, export_srt

    vad = types.ModuleType("lazycut.vad")
    vad.load_wav16k = lambda path: [0.0] * 16
    vad.analyze = lambda samples, sr=16000: {"fake_vad": True}

    analysis = types.ModuleType("lazycut.analysis")

    def build_clips(whisper, vres, duration, settings):
        words = whisper["words"]
        toks = []
        t = 0.0
        for i, w in enumerate(words):
            if w["start"] > t:
                toks.append({"id": "w_gap%05d" % i, "type": "gap", "text": "", "orig": "", "start": t,
                             "end": w["start"], "del": False, "keep": None, "flags": [], "p": None})
            toks.append({"id": "w_wrd%05d" % i, "type": "word", "text": w["text"], "orig": w["text"],
                         "start": w["start"], "end": w["end"], "del": False, "keep": None, "flags": [],
                         "p": w.get("p")})
            t = w["end"]
        if t < duration:
            toks.append({"id": "w_tail0000", "type": "gap", "text": "", "orig": "", "start": t,
                         "end": duration, "del": False, "keep": None, "flags": [], "p": None})
        return [{"id": "c_00000001", "caption": None, "flags": [], "ngOf": None, "words": toks,
                 "maxChars": settings.get("maxChars")}]

    def resegment(clips, max_chars):
        for c in clips:
            c["resegmentedWith"] = max_chars
        return clips

    def analyze_clips(clips):
        for c in clips:
            c["flags"] = ["ng"]
        return clips

    analysis.build_clips, analysis.resegment, analysis.analyze = build_clips, resegment, analyze_clips

    segment = types.ModuleType("lazycut.segment")
    segment.split_lines = lambda words, max_chars=22, **o: [0] if words else []

    return {"lazycut.ffmpeg": ffmpeg, "lazycut.project": project, "lazycut.media": media,
            "lazycut.export": export, "lazycut.vad": vad, "lazycut.analysis": analysis,
            "lazycut.segment": segment}


FAKES = {}

FAKE_WORKER = textwrap.dedent('''
    import argparse, json, os, sys, time
    import lazycut  # must be importable through PYTHONPATH set by the server
    ap = argparse.ArgumentParser()
    for a in ("--mode", "--audio", "--model", "--lang", "--out", "--recover"):
        ap.add_argument(a)
    a = ap.parse_args()
    def say(**kw):
        print(json.dumps(kw, ensure_ascii=False), flush=True)
    if a.mode == "fail":
        print("Traceback: something broke", file=sys.stderr, flush=True)
        say(stage="error", message="모델을 불러오지 못했어요")
        sys.exit(1)
    say(stage="model", progress=0.0, message="모델을 불러오는 중이에요")
    n = 400 if a.mode == "slow" else 4
    for i in range(n):
        say(stage="transcribe", progress=(i + 1) / n * 0.85, message="받아쓰는 중이에요")
        time.sleep(0.05 if a.mode == "slow" else 0.01)
    data = {"model": "fake/" + a.model, "lang": a.lang, "elapsed": 0.1,
            "segments": [{"start": 0.5, "end": 2.0, "text": "안녕하세요 여러분"}],
            "words": [{"text": "안녕하세요", "start": 0.5, "end": 1.2, "p": 0.9, "seg": 0, "recovered": False},
                      {"text": "여러분", "start": 1.3, "end": 2.0, "p": 0.8, "seg": 0, "recovered": False}]}
    tmp = a.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, a.out)
    say(stage="done", progress=1.0, message="끝났어요")
''')


def setUpModule():
    global _TMP, _PATCH
    _TMP = tempfile.mkdtemp(prefix="lazycut_test_")
    os.environ["LAZYCUT_HOME"] = os.path.join(_TMP, "home")
    config.apply_home(os.environ["LAZYCUT_HOME"])
    config.ensure_dirs()
    # Keep expected warnings/tracebacks out of the test output (they go to a temp log).
    handler = logging.FileHandler(os.path.join(config.LOG_DIR, "test.log"), encoding="utf-8")
    logging.getLogger("lazycut").addHandler(handler)
    logging.getLogger("lazycut").propagate = False
    FAKES.update(_make_fakes())
    _PATCH = mock.patch.dict(sys.modules, FAKES)
    _PATCH.start()


def tearDownModule():
    if _PATCH:
        _PATCH.stop()
    lg = logging.getLogger("lazycut")
    for h in list(lg.handlers):
        lg.removeHandler(h)
        h.close()
    lg.propagate = True
    os.environ.pop("LAZYCUT_HOME", None)
    config.apply_home(None)
    if _TMP:
        shutil.rmtree(_TMP, ignore_errors=True)


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ServerCase(unittest.TestCase):
    """Starts one server per test class."""

    @classmethod
    def setUpClass(cls):
        from lazycut import server as srv
        cls.srv_mod = srv
        cls.dir = tempfile.mkdtemp(prefix="case_", dir=_TMP)
        cls.web = cls._make_web_dir(os.path.join(cls.dir, "web"))
        cls.server = srv.LazyCutServer(0, token=TOKEN, web_dir=cls.web)
        cls.port = cls.server.server_port
        cls.thread = threading.Thread(target=cls.server.serve_forever, kwargs={"poll_interval": 0.05},
                                      daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.close()
        cls.thread.join(5)

    @staticmethod
    def _make_web_dir(web: str) -> str:
        # A temp copy: never write into the real web/ folder (owned by the frontend).
        if os.path.isdir(config.WEB_DIR):
            shutil.copytree(config.WEB_DIR, web)
        else:
            os.makedirs(web)
        if not os.path.isfile(os.path.join(web, "index.html")):
            with open(os.path.join(web, "index.html"), "w", encoding="utf-8") as f:
                f.write("<!doctype html><title>Lazy Cut</title><div id=app>레이지컷</div>")
        for sub, name, text in (("js", "__probe.js", "export const probe = 1;\n"),
                                ("css", "__probe.css", "body{}\n"),
                                ("js", ".hidden.js", "secret\n")):
            os.makedirs(os.path.join(web, sub), exist_ok=True)
            with open(os.path.join(web, sub, name), "w", encoding="utf-8") as f:
                f.write(text)
        return web

    # -- http helpers --------------------------------------------------------------------
    def req(self, method, path, body=None, token=True, headers=None, conn=None):
        own = conn is None
        conn = conn or http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        h = dict(headers or {})
        if token:
            h["X-LazyCut-Token"] = TOKEN if token is True else token
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        raw = r.read()
        if own:
            conn.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, raw

    def api(self, method, path, body=None, expect=200, **kw):
        status, headers, raw = self.req(method, path, body, **kw)
        data = json.loads(raw.decode("utf-8")) if raw else None
        self.assertEqual(status, expect, "%s %s → %s %s" % (method, path, status, raw[:300]))
        return data

    def wait_job(self, job_id, timeout=15.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.api("GET", "/api/jobs/" + job_id)["job"]
            if job["state"] in ("done", "error", "canceled"):
                return job
            time.sleep(0.03)
        self.fail("job %s did not finish" % job_id)

    def make_video(self, name="영상 녹화.mov", size=3 * 1024 * 1024, folder=None) -> str:
        folder = folder or tempfile.mkdtemp(prefix="media_", dir=self.dir)
        path = os.path.join(folder, name)
        with open(path, "wb") as f:
            f.write(os.urandom(size))
        return path

    def create_project(self, video=None, wait_prep=True):
        video = video or self.make_video()
        data = self.api("POST", "/api/project/create", {"videoPath": video})
        self.assertTrue(data["ok"])
        if wait_prep and data.get("prepJob"):
            job = self.wait_job(data["prepJob"]["id"])
            self.assertEqual(job["state"], "done", job)
        return video, data["project"]


# --- pure unit tests -----------------------------------------------------------------------

class UnitTests(unittest.TestCase):
    def test_parse_range(self):
        from lazycut.server import RangeNotSatisfiable, parse_range
        self.assertEqual(parse_range("bytes=0-99", 1000), (0, 99))
        self.assertEqual(parse_range("bytes=100-", 1000), (100, 999))
        self.assertEqual(parse_range("bytes=-100", 1000), (900, 999))
        self.assertEqual(parse_range("bytes=-5000", 1000), (0, 999))
        self.assertEqual(parse_range("bytes=990-5000", 1000), (990, 999))
        self.assertIsNone(parse_range("bytes=0-1,5-9", 1000))
        for bad in ("bytes=1000-", "bytes=5-1", "bytes=-0", "bytes=-", "items=0-1", "bytes=a-b", ""):
            with self.assertRaises(RangeNotSatisfiable, msg=bad):
                parse_range(bad, 1000)
        with self.assertRaises(RangeNotSatisfiable):
            parse_range("bytes=0-", 0)

    def test_safe_join(self):
        from lazycut.server import safe_join
        root = tempfile.mkdtemp(dir=_TMP)
        os.makedirs(os.path.join(root, "js"))
        open(os.path.join(root, "js", "a.js"), "w").close()
        self.assertEqual(safe_join(root, "/js/a.js"), os.path.join(os.path.realpath(root), "js", "a.js"))
        for bad in ("/js/../../etc/passwd", "/js/%2e%2e/%2e%2e/x", "/js/..%2f..%2fx", "/js/.hidden",
                    "/js//a.js", "/js/a.js%00.png", "/js\\..\\x", "/"):
            self.assertIsNone(safe_join(root, bad), bad)

    def test_settings_validation_and_recent(self):
        from lazycut import settings
        s = settings.save_settings({"maxChars": "30", "exportQuality": "ultra", "includeNoise": True,
                                    "silenceMin": -1, "model": "large-v3", "uiZoom": 1.25,
                                    "nested": {"no": 1}})
        self.assertEqual(s["maxChars"], 30)
        self.assertEqual(s["exportQuality"], "high")
        self.assertTrue(s["includeNoise"])
        self.assertEqual(s["silenceMin"], 0.15)
        self.assertEqual(s["model"], "large-v3")
        self.assertEqual(s["uiZoom"], 1.25)
        self.assertNotIn("nested", s)
        self.assertEqual(settings.load_settings()["maxChars"], 30)
        settings.save_settings({"maxChars": 22, "model": "turbo", "includeNoise": False})
        for i in range(25):
            settings.touch_recent({"file": os.path.join(_TMP, "p%d.lazycut" % i), "name": "p%d" % i,
                                   "source": {"duration": i}})
        rec = settings.recent_list()
        self.assertEqual(len(rec), settings.MAX_RECENT)
        self.assertEqual(rec[0]["name"], "p24")
        self.assertFalse(rec[0]["exists"])
        settings.touch_recent({"file": os.path.join(_TMP, "p10.lazycut"), "name": "p10", "source": {}})
        self.assertEqual(settings.recent_list()[0]["name"], "p10")
        self.assertEqual(len([r for r in settings.recent_list() if r["name"] == "p10"]), 1)

    def test_job_manager_serial_heavy_and_cancel(self):
        from lazycut.jobs import JobManager
        jm = JobManager()
        gate = threading.Event()
        order = []

        def first(job):
            order.append("first-start")
            gate.wait(5)
            order.append("first-end")
            return {"n": 1}

        def second(job):
            order.append("second")
            return {"n": 2}

        j1 = jm.submit("export", first, heavy=True)
        j2 = jm.submit("export", second, heavy=True)
        j3 = jm.submit("export", second, heavy=True)
        time.sleep(0.1)
        self.assertEqual(j1.state, "running")
        self.assertEqual(j2.state, "queued")
        self.assertTrue(jm.cancel(j3.id))  # queued → canceled at once, never runs
        self.assertEqual(j3.state, "canceled")
        gate.set()
        jm.wait(j2.id, 5)
        self.assertEqual(order, ["first-start", "first-end", "second"])
        self.assertEqual(j2.to_dict()["result"], {"n": 2})
        self.assertEqual(j2.to_dict()["progress"], 1.0)
        self.assertFalse(jm.cancel(j2.id))
        jm.shutdown()

    def test_job_error_mapping(self):
        from lazycut.jobs import JobManager
        jm = JobManager()
        FFmpegError = FAKES["lazycut.ffmpeg"].FFmpegError
        Canceled = FAKES["lazycut.ffmpeg"].Canceled

        def ff(job):
            raise FFmpegError("Conversion failed!")

        def cancel_like(job):
            raise Canceled()

        def boom(job):
            raise ValueError("bad value")

        def no_space(job):
            raise OSError(28, "No space left on device")

        cases = [(ff, "error", "영상 처리 중 문제가 생겼어요: Conversion failed!"),
                 (cancel_like, "canceled", None),
                 (boom, "error", "작업 중 문제가 생겼어요: bad value"),
                 (no_space, "error", "저장 공간이 부족해요. 디스크 공간을 확보하고 다시 해 주세요.")]
        for fn, state, err in cases:
            j = jm.wait(jm.submit("t", fn, heavy=False).id, 5)
            self.assertEqual(j.state, state, fn.__name__)
            self.assertEqual(j.error, err, fn.__name__)
        jm.shutdown()

    def test_child_env_pythonpath(self):
        env = config.child_env({"PYTHONPATH": config.ROOT_DIR + os.pathsep + "/x" + os.pathsep + config.ROOT_DIR})
        self.assertEqual(env["PYTHONPATH"], config.ROOT_DIR + os.pathsep + "/x")
        self.assertEqual(config.child_env({})["PYTHONPATH"], config.ROOT_DIR)

    def test_model_downloaded(self):
        hub = os.path.join(_TMP, "hf", "hub")
        snap = os.path.join(hub, "models--mlx-community--whisper-large-v3-turbo", "snapshots", "abc")
        os.makedirs(snap)
        with mock.patch.dict(os.environ, {"HF_HUB_CACHE": hub}):
            self.assertFalse(config.model_downloaded("turbo"))
            with open(os.path.join(snap, "config.json"), "w") as f:
                f.write("{}")
            with open(os.path.join(snap, "weights.safetensors"), "wb") as f:
                f.truncate(2 * 1024 * 1024)
            self.assertTrue(config.model_downloaded("turbo"))
            self.assertFalse(config.model_downloaded("large-v3"))
            self.assertFalse(config.model_downloaded("nope"))


# --- HTTP: auth + static ---------------------------------------------------------------------

class AuthStaticTests(ServerCase):
    def test_host_header(self):
        for host in ("evil.example:%d" % self.port, "127.0.0.1:1", "localhost", "127.0.0.1.nip.io:%d" % self.port):
            status, _, raw = self.req("GET", "/api/health", headers={"Host": host})
            self.assertEqual(status, 403, host)
            self.assertEqual(json.loads(raw)["code"], "forbidden_host")
            status, _, _ = self.req("GET", "/", headers={"Host": host}, token=False)
            self.assertEqual(status, 403, host)
        data = self.api("GET", "/api/health", headers={"Host": "localhost:%d" % self.port})
        self.assertTrue(data["ok"])

    def test_token(self):
        for tok in (False, "wrong"):
            data = self.api("GET", "/api/health", token=tok, expect=401)
            self.assertFalse(data["ok"])
            self.assertEqual(data["code"], "unauthorized")
            self.assertTrue(data["error"])
        # ?t= is only accepted for media/peaks, not for general API calls
        self.api("GET", "/api/health?t=" + TOKEN, token=False, expect=401)
        data = self.api("GET", "/api/health")
        self.assertEqual(data["version"], "1.0.0")
        self.assertEqual(data["pid"], os.getpid())
        # unknown routes and wrong methods also require the token first
        self.api("GET", "/api/nope", token=False, expect=401)
        self.assertEqual(self.api("GET", "/api/nope", expect=404)["code"], "not_found")
        self.assertEqual(self.api("GET", "/api/project/create", expect=405)["code"], "method_not_allowed")

    def test_static(self):
        status, h, raw = self.req("GET", "/?t=whatever", token=False)
        self.assertEqual(status, 200)
        self.assertTrue(h["content-type"].startswith("text/html"))
        self.assertEqual(h["cache-control"], "no-store")
        with open(os.path.join(self.web, "index.html"), "rb") as f:
            self.assertEqual(raw, f.read())
        status, h, raw = self.req("HEAD", "/", token=False)
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")
        self.assertGreater(int(h["content-length"]), 0)
        status, h, raw = self.req("GET", "/js/__probe.js", token=False)
        self.assertEqual(status, 200)
        self.assertTrue(h["content-type"].startswith("text/javascript"))
        self.assertEqual(raw, b"export const probe = 1;\n")
        status, h, _ = self.req("GET", "/css/__probe.css", token=False)
        self.assertTrue(h["content-type"].startswith("text/css"))
        for bad in ("/js/../../lazycut/server.py", "/js/%2e%2e/%2e%2e/SPEC.md", "/js/..%2f..%2fSPEC.md",
                    "/js/.hidden.js", "/css/missing.css", "/SPEC.md", "/lazycut/server.py", "/js/",
                    "/etc/passwd", "/test/../../SPEC.md"):
            status, _, raw = self.req("GET", bad, token=False)
            self.assertEqual(status, 404, bad)
        status, _, _ = self.req("POST", "/js/__probe.js", body={}, token=False)
        self.assertEqual(status, 405)
        status, _, _ = self.req("GET", "/favicon.ico", token=False)
        self.assertIn(status, (200, 204))

    def test_parity_route(self):
        p = os.path.join(self.dir, "parity.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump({"cases": []}, f)
        old = self.server.parity_path
        self.server.parity_path = p
        try:
            status, h, raw = self.req("GET", "/test/parity.json", token=False)
            self.assertEqual(status, 200)
            self.assertTrue(h["content-type"].startswith("application/json"))
            self.assertEqual(json.loads(raw), {"cases": []})
        finally:
            self.server.parity_path = old

    def test_bad_bodies(self):
        status, _, raw = self.req("POST", "/api/settings", body=b"{not json")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)["code"], "bad_json")
        self.assertEqual(self.api("POST", "/api/settings", body=[1, 2], expect=400)["code"], "bad_json")
        with mock.patch.object(config, "MAX_BODY_BYTES", 10):
            status, _, raw = self.req("POST", "/api/settings", body={"settings": {"maxChars": 30}})
        self.assertEqual(status, 413)

    def test_keepalive_after_errors(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            s1, _, _ = self.req("POST", "/api/settings", body={"settings": {}}, token="bad", conn=conn)
            s2, _, raw = self.req("POST", "/api/settings", body={"settings": {"showCaptions": True}}, conn=conn)
        finally:
            conn.close()
        self.assertEqual((s1, s2), (401, 200))
        self.assertTrue(json.loads(raw)["settings"]["showCaptions"])

    def test_bootstrap_and_settings(self):
        data = self.api("POST", "/api/settings", {"settings": {"maxChars": 18, "exportResolution": 1080}})
        self.assertEqual(data["settings"]["maxChars"], 18)
        self.assertEqual(data["settings"]["exportResolution"], "1080")
        boot = self.api("GET", "/api/bootstrap")
        self.assertEqual(boot["version"], "1.0.0")
        self.assertEqual(boot["settings"]["maxChars"], 18)
        self.assertEqual(set(boot["models"]), {"turbo", "large-v3"})
        self.assertEqual(boot["models"]["turbo"]["sizeLabel"], "1.5GB")
        self.assertIsInstance(boot["models"]["turbo"]["downloaded"], bool)
        self.assertIsInstance(boot["recent"], list)
        self.assertIsInstance(boot["jobs"], list)
        self.api("POST", "/api/settings", {"settings": {"maxChars": 22, "exportResolution": "source"}})

    def test_dialogs(self):
        from lazycut import dialogs
        with mock.patch.object(dialogs, "choose_video", return_value="/Users/x/a.mov"), \
                mock.patch.object(dialogs, "choose_project", return_value=None), \
                mock.patch.object(dialogs, "choose_save", return_value="/Users/x/out.mp4") as cs, \
                mock.patch.object(dialogs, "choose_any", return_value="/Users/x/b.mov") as ca:
            self.assertEqual(self.api("POST", "/api/dialog/open-video")["path"], "/Users/x/a.mov")
            self.assertIsNone(self.api("POST", "/api/dialog/open-project")["path"])
            self.assertEqual(self.api("POST", "/api/dialog/save",
                                      {"defaultName": "a 컷편집.mp4", "defaultDir": self.dir})["path"],
                             "/Users/x/out.mp4")
            cs.assert_called_with("a 컷편집.mp4", self.dir)
            self.assertEqual(self.api("POST", "/api/dialog/locate", {"name": "a.mov"})["path"], "/Users/x/b.mov")
            self.assertIn("a.mov", ca.call_args[0][0])


# --- HTTP: projects, media, jobs, export --------------------------------------------------------

class ProjectTests(ServerCase):
    def test_create_open_save(self):
        video, proj = self.create_project()
        ppath = os.path.splitext(video)[0] + ".lazycut"
        self.assertTrue(os.path.isfile(ppath))
        self.assertEqual(proj["file"], ppath)
        self.assertEqual(proj["source"]["path"], video)
        from lazycut import settings
        self.assertEqual(proj["settings"]["maxChars"], settings.load_settings()["maxChars"])
        pid = proj["id"]

        # second create → exists; force → a new project
        data = self.api("POST", "/api/project/create", {"videoPath": video})
        self.assertEqual((data["exists"], data["projectPath"]), (True, ppath))
        self.assertNotIn("project", data)
        forced = self.api("POST", "/api/project/create", {"videoPath": video, "force": True})["project"]
        self.assertNotEqual(forced["id"], pid)

        # open by .lazycut path and by video path
        for path in (ppath, video):
            data = self.api("POST", "/api/project/open", {"path": path})
            self.assertFalse(data["missingSource"])
            self.assertEqual(data["project"]["id"], forced["id"])
            self.assertNotIn("warning", data)
            self.assertEqual(self.wait_job(data["prepJob"]["id"])["state"], "done")
        pid = forced["id"]

        # save: edits land in the registry's file even if the client sends another "file"
        proj = data["project"]
        proj["clips"] = [{"id": "c_aaaaaaaa", "caption": "자막", "flags": [], "ngOf": None,
                          "words": [{"id": "w_aaaaaaaa", "type": "word", "text": "안녕", "orig": "안녕",
                                     "start": 0, "end": 10.0, "del": False, "keep": None, "flags": [], "p": 1}]}]
        proj["file"] = os.path.join(self.dir, "elsewhere.lazycut")
        data = self.api("POST", "/api/project/save", {"project": proj})
        self.assertEqual(data["path"], ppath)
        self.assertTrue(data["savedAt"])
        self.assertFalse(os.path.exists(os.path.join(self.dir, "elsewhere.lazycut")))
        with open(ppath, encoding="utf-8") as f:
            disk = json.load(f)
        self.assertEqual(disk["clips"][0]["caption"], "자막")
        self.assertEqual(disk["file"], ppath)

        # a stale clip-less save must not wipe the transcription on disk
        stale = dict(proj, clips=[])
        data = self.api("POST", "/api/project/save", {"project": stale})
        self.assertTrue(data.get("skipped"))
        with open(ppath, encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["clips"]), 1)

        recent = self.api("GET", "/api/bootstrap")["recent"]
        self.assertEqual(recent[0]["path"], ppath)
        self.assertTrue(recent[0]["exists"])

        # status + peaks (header token and ?t= token)
        st = self.api("GET", "/api/project/%s/status" % pid)
        self.assertEqual(st["prep"]["state"], "done")
        self.assertTrue(st["playable"])
        self.assertFalse(st["hasProxy"])
        status, h, raw = self.req("GET", "/api/project/%s/peaks?t=%s" % (pid, TOKEN), token=False)
        self.assertEqual(status, 200)
        self.assertEqual(h["content-type"], "application/octet-stream")
        self.assertEqual(raw, bytes(range(100)))
        status, _, _ = self.req("GET", "/api/project/%s/peaks?t=nope" % pid, token=False)
        self.assertEqual(status, 401)
        self.assertEqual(self.api("GET", "/api/project/p_unknown/peaks", expect=404)["code"], "unknown_project")

    def test_save_unregistered_uses_project_path_for(self):
        video = self.make_video("unreg.mov", size=1000)
        proj = FAKES["lazycut.project"].new_project(FAKES["lazycut.ffmpeg"].probe(video))
        proj["file"] = "/somewhere/else.lazycut"
        data = self.api("POST", "/api/project/save", {"project": proj})
        self.assertEqual(data["path"], os.path.splitext(video)[0] + ".lazycut")
        self.assertTrue(os.path.isfile(data["path"]))
        self.assertEqual(self.api("POST", "/api/project/save", {"project": {"id": 1}}, expect=400)["code"],
                         "bad_project")

    def test_open_missing_changed_and_relocated_sources(self):
        video, proj = self.create_project(self.make_video("moved.mov", size=4096))
        ppath = proj["file"]
        # 1) changed size → still opens, with a warning (shown once per change)
        with open(video, "ab") as f:
            f.write(b"more")
        data = self.api("POST", "/api/project/open", {"path": ppath})
        self.assertIn("warning", data)
        self.assertFalse(data["missingSource"])
        self.wait_job(data["prepJob"]["id"])
        data = self.api("POST", "/api/project/open", {"path": ppath})
        self.assertNotIn("warning", data)
        self.wait_job(data["prepJob"]["id"])
        # 2) the absolute path is stale but the video sits next to the project → auto relink
        with open(ppath, encoding="utf-8") as f:
            disk = json.load(f)
        disk["source"]["path"] = "/Volumes/OtherMac/moved.mov"
        with open(ppath, "w", encoding="utf-8") as f:
            json.dump(disk, f)
        data = self.api("POST", "/api/project/open", {"path": ppath})
        self.assertTrue(data.get("relinked"))
        self.assertEqual(data["project"]["source"]["path"], video)
        self.wait_job(data["prepJob"]["id"])
        # 3) source really gone → missingSource, no prep; relink to a new file
        os.remove(video)
        data = self.api("POST", "/api/project/open", {"path": ppath})
        self.assertTrue(data["missingSource"])
        self.assertIsNone(data["prepJob"])
        status, _, raw = self.req("GET", "/media/%s/video?t=%s" % (proj["id"], TOKEN), token=False)
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw)["code"], "missing_source")
        new_video = self.make_video("새 위치.mov", size=2048)
        data = self.api("POST", "/api/project/relink", {"projectId": proj["id"], "videoPath": new_video})
        self.assertEqual(data["project"]["source"]["path"], new_video)
        self.assertNotIn("warning", data)  # same duration
        self.wait_job(data["prepJob"]["id"])
        with open(ppath, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["source"]["path"], new_video)
        status, _, _ = self.req("GET", "/media/%s/video?t=%s" % (proj["id"], TOKEN), token=False)
        self.assertEqual(status, 200)
        # an autosave queued before the relink (old, missing source path) keeps the new source
        stale = json.loads(json.dumps(proj))
        stale["clips"] = [{"id": "c_1", "caption": None, "flags": [], "ngOf": None, "words": []}]
        self.api("POST", "/api/project/save", {"project": stale})
        with open(ppath, encoding="utf-8") as f:
            disk = json.load(f)
        self.assertEqual(disk["source"]["path"], new_video)
        self.assertEqual(len(disk["clips"]), 1)

    def test_create_errors(self):
        self.assertEqual(self.api("POST", "/api/project/create", {}, expect=400)["code"], "bad_request")
        self.assertEqual(self.api("POST", "/api/project/create", {"videoPath": "relative.mov"},
                                  expect=400)["code"], "bad_request")
        self.assertEqual(self.api("POST", "/api/project/create", {"videoPath": "/nonexistent/x.mov"},
                                  expect=404)["code"], "not_found")
        bad = self.make_video("broken.bad", size=10)
        data = self.api("POST", "/api/project/create", {"videoPath": bad}, expect=422)
        self.assertEqual(data["code"], "probe_failed")
        self.assertIn("영상 정보를 읽지 못했어요", data["error"])
        silent = self.make_video("x.silent.mov", size=10)
        self.assertEqual(self.api("POST", "/api/project/create", {"videoPath": silent}, expect=422)["code"],
                         "no_audio")
        self.assertEqual(self.api("POST", "/api/project/open", {"path": "/nonexistent/x.lazycut"},
                                  expect=404)["code"], "not_found")
        lonely = self.make_video("lonely.mov", size=10)
        self.assertEqual(self.api("POST", "/api/project/open", {"path": lonely}, expect=404)["code"],
                         "no_project")
        corrupt = os.path.join(self.dir, "corrupt.lazycut")
        with open(corrupt, "w") as f:
            f.write("{oops")
        self.assertEqual(self.api("POST", "/api/project/open", {"path": corrupt}, expect=422)["code"],
                         "bad_project")

    def test_media_range(self):
        video, proj = self.create_project(self.make_video("range.mov", size=3 * 1024 * 1024 + 123))
        with open(video, "rb") as f:
            data = f.read()
        size = len(data)
        url = "/media/%s/video?t=%s" % (proj["id"], TOKEN)
        status, h, raw = self.req("GET", url, token=False)
        self.assertEqual(status, 200)
        self.assertEqual(raw, data)
        self.assertEqual(h["accept-ranges"], "bytes")
        self.assertEqual(h["content-type"], "video/mp4")
        self.assertEqual(int(h["content-length"]), size)

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:  # several ranges over one keep-alive connection: lengths must be exact
            cases = [("bytes=100-199", 100, 199), ("bytes=%d-" % (size - 10), size - 10, size - 1),
                     ("bytes=-500", size - 500, size - 1), ("bytes=0-", 0, size - 1),
                     ("bytes=1048570-2097160", 1048570, 2097160), ("bytes=%d-99999999" % (size - 3), size - 3, size - 1)]
            for rng, s, e in cases:
                status, h, raw = self.req("GET", url, token=False, headers={"Range": rng}, conn=conn)
                self.assertEqual(status, 206, rng)
                self.assertEqual(raw, data[s:e + 1], rng)
                self.assertEqual(h["content-range"], "bytes %d-%d/%d" % (s, e, size), rng)
                self.assertEqual(int(h["content-length"]), e - s + 1)
            for rng in ("bytes=%d-" % size, "bytes=abc", "bytes=200-100", "bytes=-0", "lines=1-2"):
                status, h, raw = self.req("GET", url, token=False, headers={"Range": rng}, conn=conn)
                self.assertEqual(status, 416, rng)
                self.assertEqual(h["content-range"], "bytes */%d" % size)
                self.assertEqual(raw, b"")
        finally:
            conn.close()
        # header token works too; HEAD sends headers only
        status, h, raw = self.req("HEAD", "/media/%s/video" % proj["id"], headers={"Range": "bytes=0-9"})
        self.assertEqual((status, raw, h["content-length"]), (206, b"", "10"))
        # auth
        for u in ("/media/%s/video" % proj["id"], "/media/%s/video?t=bad" % proj["id"]):
            self.assertEqual(self.req("GET", u, token=False)[0], 401)
        self.assertEqual(self.req("GET", "/media/p_nope/video?t=" + TOKEN, token=False)[0], 404)
        # proxy: not ready → 404; after the proxy job → served
        self.assertEqual(self.req("GET", url + "&proxy=1", token=False)[0], 404)
        job = self.api("POST", "/api/project/%s/proxy" % proj["id"])["job"]
        self.assertEqual(self.wait_job(job["id"])["state"], "done")
        status, _, raw = self.req("GET", url + "&proxy=1", token=False)
        self.assertEqual((status, raw), (200, b"PROXY" * 100))
        self.assertTrue(self.api("GET", "/api/project/%s/status" % proj["id"])["hasProxy"])

    def test_disconnect_mid_stream_is_harmless(self):
        video, proj = self.create_project(self.make_video("drop.mov", size=4 * 1024 * 1024))
        s = socket.create_connection(("127.0.0.1", self.port))
        s.sendall(("GET /media/%s/video?t=%s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\n\r\n"
                   % (proj["id"], TOKEN, self.port)).encode())
        s.recv(1000)
        s.close()  # abort while the server is still streaming
        time.sleep(0.2)
        self.assertTrue(self.api("GET", "/api/health")["ok"])

    def test_resegment_and_analyze(self):
        clips = [{"id": "c_1", "words": []}]
        data = self.api("POST", "/api/project/resegment", {"project": {"id": "p_x", "clips": clips}, "maxChars": 18})
        self.assertEqual(data["clips"][0]["resegmentedWith"], 18)
        data = self.api("POST", "/api/project/analyze", {"project": {"id": "p_x", "clips": clips}})
        self.assertEqual(data["clips"][0]["flags"], ["ng"])


class JobTests(ServerCase):
    def test_poll_and_cancel_fake_job(self):
        started = threading.Event()

        def long_job(job):
            started.set()
            i = 0
            while not job.cancel.is_set():
                i += 1
                job.update(progress=min(0.9, i / 100), stage="work", message="일하는 중이에요")
                time.sleep(0.01)
            job.check_cancel()

        job = self.server.jobs.submit("fake", long_job, heavy=True, project_id="p_x")
        self.assertTrue(started.wait(5))
        time.sleep(0.05)
        j = self.api("GET", "/api/jobs/" + job.id)["job"]
        self.assertEqual(j["state"], "running")
        self.assertEqual(j["kind"], "fake")
        self.assertEqual(j["projectId"], "p_x")
        self.assertEqual(j["stage"], "work")
        self.assertGreater(j["progress"], 0)
        for key in ("id", "kind", "projectId", "state", "progress", "stage", "message", "result", "error"):
            self.assertIn(key, j)
        self.assertIn(job.id, [x["id"] for x in self.api("GET", "/api/bootstrap")["jobs"]])
        data = self.api("POST", "/api/jobs/%s/cancel" % job.id)
        self.assertTrue(data["canceled"])
        self.assertEqual(self.wait_job(job.id)["state"], "canceled")
        self.assertEqual(self.api("GET", "/api/jobs/j_missing", expect=404)["code"], "not_found")

        done = self.server.jobs.submit("fake", lambda job: {"answer": 42}, heavy=False)
        j = self.wait_job(done.id)
        self.assertEqual((j["state"], j["result"], j["progress"]), ("done", {"answer": 42}, 1.0))

        def failing(job):
            raise RuntimeError("kaboom")

        j = self.wait_job(self.server.jobs.submit("fake", failing, heavy=False).id)
        self.assertEqual(j["state"], "error")
        self.assertIn("kaboom", j["error"])

    def _worker(self, mode):
        script = os.path.join(self.dir, "fake_worker.py")
        with open(script, "w", encoding="utf-8") as f:
            f.write(FAKE_WORKER)
        return lambda wav, model, lang, out: [sys.executable, script, "--mode", mode, "--audio", wav,
                                              "--model", model, "--lang", lang, "--out", out, "--recover", "1"]

    def test_transcribe_with_fake_worker(self):
        from lazycut import settings
        app = self.server.app
        before = settings.load_settings()
        self.addCleanup(settings.save_settings, {k: before[k] for k in ("model", "lang", "maxChars")})
        video, proj = self.create_project(self.make_video("talk.mov", size=2048), wait_prep=False)
        pid = proj["id"]
        # failing worker → error carrying the worker's own message
        with mock.patch.object(app, "worker_cmd", self._worker("fail")):
            job = self.api("POST", "/api/project/transcribe",
                           {"projectId": pid, "model": "turbo", "lang": "ko", "maxChars": 20})["job"]
            j = self.wait_job(job["id"])
        self.assertEqual(j["state"], "error")
        self.assertEqual(j["error"], "받아쓰기에 실패했어요: 모델을 불러오지 못했어요")

        # slow worker → cancel kills it
        with mock.patch.object(app, "worker_cmd", self._worker("slow")):
            job = self.api("POST", "/api/project/transcribe", {"projectId": pid, "model": "turbo"})["job"]
            deadline = time.time() + 10
            while time.time() < deadline:
                j = self.api("GET", "/api/jobs/" + job["id"])["job"]
                if j["stage"] == "transcribe":
                    break
                time.sleep(0.03)
            self.assertEqual(j["stage"], "transcribe")
            again = self.api("POST", "/api/project/transcribe", {"projectId": pid, "model": "turbo"})["job"]
            self.assertEqual(again["id"], job["id"])  # no duplicate job while one runs
            self.api("POST", "/api/jobs/%s/cancel" % job["id"])
            t0 = time.time()
            self.assertEqual(self.wait_job(job["id"])["state"], "canceled")
            self.assertLess(time.time() - t0, 5)

        # working worker → clips built, project saved, result carries the project
        with mock.patch.object(app, "worker_cmd", self._worker("ok")):
            job = self.api("POST", "/api/project/transcribe",
                           {"projectId": pid, "model": "turbo", "lang": "ko", "maxChars": 20})["job"]
            j = self.wait_job(job["id"])
        self.assertEqual(j["state"], "done", j)
        result = j["result"]["project"]
        self.assertEqual(result["id"], pid)
        self.assertEqual(result["clips"][0]["maxChars"], 20)
        self.assertEqual([t["text"] for t in result["clips"][0]["words"] if t["type"] == "word"],
                         ["안녕하세요", "여러분"])
        self.assertEqual(result["transcribe"]["model"], "turbo")
        self.assertTrue(result["transcribe"]["doneAt"])
        self.assertEqual(result["settings"]["maxChars"], 20)
        with open(proj["file"], encoding="utf-8") as f:
            disk = json.load(f)
        self.assertEqual(len(disk["clips"]), 1)
        self.assertTrue(os.path.isfile(os.path.join(app.entry(pid)["cache_dir"], "whisper_turbo.json")))

        # same model + language again → cached transcription, the (failing) worker is not run
        with mock.patch.object(app, "worker_cmd", self._worker("fail")):
            job = self.api("POST", "/api/project/transcribe", {"projectId": pid, "model": "turbo", "lang": "ko"})["job"]
            self.assertEqual(self.wait_job(job["id"])["state"], "done")

        self.assertEqual(self.api("POST", "/api/project/transcribe", {"projectId": pid, "model": "tiny"},
                                  expect=400)["code"], "bad_model")
        self.assertEqual(self.api("POST", "/api/project/transcribe", {"projectId": "p_nope"},
                                  expect=404)["code"], "unknown_project")


class ExportTests(ServerCase):
    def test_export_flow(self):
        video, proj = self.create_project(self.make_video("녹화 영상.mov", size=1000))
        proj["clips"] = [{"id": "c_1", "caption": None, "flags": [], "ngOf": None,
                          "words": [{"id": "w_1", "type": "word", "text": "a", "orig": "a", "start": 0,
                                     "end": 10.0, "del": False, "keep": None, "flags": [], "p": 1}]}]
        paths = self.api("POST", "/api/export/default-paths", {"project": proj})
        self.assertEqual(paths["dir"], os.path.dirname(video))
        self.assertTrue(paths["mp4"].endswith("컷편집.mp4"))
        out = paths["mp4"]
        srt = os.path.splitext(out)[0] + ".srt"
        options = {"outPath": out, "srt": True, "map": False, "quality": "medium", "resolution": "720",
                   "overwrite": False}

        # mp4 exists → 409 before any job starts
        with open(out, "wb") as f:
            f.write(b"old")
        n_jobs = len(self.server.jobs.find(kind="export", active_only=False))
        data = self.api("POST", "/api/export", {"project": proj, "options": options}, expect=409)
        self.assertEqual(data["code"], "exists")
        self.assertEqual(data["path"], out)
        self.assertEqual(len(self.server.jobs.find(kind="export", active_only=False)), n_jobs)
        os.remove(out)
        # only the .srt exists → also 409
        with open(srt, "w") as f:
            f.write("old")
        self.assertEqual(self.api("POST", "/api/export", {"project": proj, "options": options},
                                  expect=409)["path"], srt)
        # overwrite → job runs with the right arguments
        job = self.api("POST", "/api/export", {"project": proj, "options": dict(options, overwrite=True)})["job"]
        j = self.wait_job(job["id"])
        self.assertEqual(j["state"], "done", j)
        self.assertEqual(j["result"]["mp4"], out)
        call = FAKES["lazycut.export"].calls[-1]
        self.assertEqual((call["srt_path"], call["quality"], call["resolution"], call["overwrite"]),
                         (srt, "medium", "720", True))
        self.assertTrue(call["tmp_exists"])
        self.assertFalse(os.path.exists(call["tmp_dir"]))  # temp dir cleaned up

        # safety checks
        bad = dict(options, outPath=video)
        self.assertEqual(self.api("POST", "/api/export", {"project": proj, "options": bad},
                                  expect=400)["code"], "same_as_source")
        bad = dict(options, outPath="/nonexistent-dir/x.mp4")
        self.assertEqual(self.api("POST", "/api/export", {"project": proj, "options": bad},
                                  expect=400)["code"], "bad_path")
        all_deleted = json.loads(json.dumps(proj))
        all_deleted["clips"][0]["words"][0]["del"] = True
        self.assertEqual(self.api("POST", "/api/export", {"project": all_deleted, "options": options},
                                  expect=400)["code"], "nothing_to_export")

        # SRT only
        srt_only = os.path.join(os.path.dirname(video), "자막만")
        data = self.api("POST", "/api/export/srt", {"project": proj, "outPath": srt_only})
        self.assertEqual(data["path"], srt_only + ".srt")
        self.assertEqual(self.api("POST", "/api/export/srt", {"project": proj, "outPath": srt_only + ".srt"},
                                  expect=409)["code"], "exists")
        self.api("POST", "/api/export/srt", {"project": proj, "outPath": srt_only + ".srt", "overwrite": True})

    def test_reveal(self):
        from lazycut import server as srv
        with mock.patch.object(srv, "reveal") as rv:
            self.api("POST", "/api/reveal", {"path": self.dir})
            rv.assert_called_once_with(self.dir)
            self.assertEqual(self.api("POST", "/api/reveal", {"path": "/nonexistent/a/b"}, expect=404)["code"],
                             "not_found")


class LifecycleTests(unittest.TestCase):
    def test_idle_watchdog_and_shutdown_endpoint(self):
        from lazycut import server as srv
        s = srv.LazyCutServer(0, token=TOKEN, web_dir=_TMP)
        t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        srv.start_watchdog(s, idle_sec=0.3, interval=0.05)
        t.join(5)
        self.assertFalse(t.is_alive(), "watchdog should stop an idle server")
        s.close()

        s = srv.LazyCutServer(0, token=TOKEN, web_dir=_TMP)
        t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        conn = http.client.HTTPConnection("127.0.0.1", s.server_port, timeout=5)
        conn.request("POST", "/api/shutdown", body=b"{}", headers={"X-LazyCut-Token": TOKEN})
        r = conn.getresponse()
        self.assertEqual(r.status, 200)
        self.assertTrue(json.loads(r.read())["ok"])
        conn.close()
        t.join(5)
        self.assertFalse(t.is_alive(), "/api/shutdown should stop the server")
        s.close()

    def test_launcher_replaces_outdated_idle_server(self):
        from lazycut import __main__ as main_mod
        from lazycut import server as srv
        s = srv.LazyCutServer(0, token=TOKEN, web_dir=_TMP)
        t = threading.Thread(target=s.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        state = {"port": s.server_port, "token": TOKEN, "pid": os.getpid(), "version": "1.0.0"}
        try:
            self.assertTrue(main_mod.health_ok(state))
            self.assertFalse(main_mod._replace_outdated(state))  # same version → keep
            gate = threading.Event()
            busy = s.jobs.submit("export", lambda job: gate.wait(5), heavy=True)
            old = dict(state, version="0.9.0")
            self.assertFalse(main_mod._replace_outdated(old))  # busy → keep
            gate.set()
            s.jobs.wait(busy.id, 5)
            self.assertTrue(main_mod._replace_outdated(old))  # idle + outdated → stopped
            t.join(5)
            self.assertFalse(t.is_alive())
        finally:
            if t.is_alive():
                s.shutdown()
            s.close()

    def _env(self, home):
        env = dict(os.environ)
        env["LAZYCUT_HOME"] = home
        env["PYTHONPATH"] = ROOT
        return env

    def _health(self, st):
        conn = http.client.HTTPConnection("127.0.0.1", st["port"], timeout=3)
        conn.request("GET", "/api/health", headers={"X-LazyCut-Token": st["token"]})
        r = conn.getresponse()
        data = json.loads(r.read())
        conn.close()
        return r.status, data

    def _shutdown(self, st):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", st["port"], timeout=3)
            conn.request("POST", "/api/shutdown", body=b"{}", headers={"X-LazyCut-Token": st["token"]})
            conn.getresponse().read()
            conn.close()
        except OSError:
            pass

    def test_main_version(self):
        out = subprocess.run([sys.executable, "-m", "lazycut", "--version"], cwd=ROOT, capture_output=True,
                             text=True, env=self._env(os.path.join(_TMP, "home_v")), timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "1.0.0")

    def test_serve_foreground_process(self):
        home = os.path.join(_TMP, "home_serve")
        port = _free_port()
        proc = subprocess.Popen([sys.executable, "-m", "lazycut", "--serve", "--no-open", "--port", str(port)],
                                cwd=ROOT, env=self._env(home), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        state_file = os.path.join(home, "Application Support", "server.json")
        st = None
        try:
            deadline = time.time() + 20
            while time.time() < deadline and st is None:
                try:
                    with open(state_file) as f:
                        st = json.load(f)
                except (OSError, ValueError):
                    time.sleep(0.1)
            self.assertIsNotNone(st, "server.json was not written")
            self.assertEqual(oct(os.stat(state_file).st_mode & 0o777), "0o600")
            self.assertEqual((st["port"], st["pid"], st["version"]), (port, proc.pid, "1.0.0"))
            status, data = self._health(st)
            self.assertEqual((status, data["pid"]), (200, proc.pid))
            self._shutdown(st)
            proc.wait(15)
            self.assertEqual(proc.returncode, 0)
            self.assertFalse(os.path.exists(state_file), "server.json should be removed on shutdown")
            self.assertTrue(os.path.isfile(os.path.join(home, "Logs", "server.log")))
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(5)
            proc.stdout.close()
            proc.stderr.close()

    def test_launcher_spawns_detached_server_and_reuses_it(self):
        home = os.path.join(_TMP, "home_launch")
        port = _free_port()
        env = self._env(home)
        state_file = os.path.join(home, "Application Support", "server.json")
        st = None
        try:
            out = subprocess.run([sys.executable, "-m", "lazycut", "--no-open", "--port", str(port)], cwd=ROOT,
                                 env=env, capture_output=True, text=True, timeout=40)
            self.assertEqual(out.returncode, 0, out.stderr)
            with open(state_file) as f:
                st = json.load(f)
            self.assertEqual(out.stdout.strip(), "http://127.0.0.1:%d/?t=%s" % (st["port"], st["token"]))
            self.assertEqual(self._health(st)[0], 200)
            # second launch reuses the same server
            out2 = subprocess.run([sys.executable, "-m", "lazycut", "--no-open"], cwd=ROOT, env=env,
                                  capture_output=True, text=True, timeout=40)
            self.assertEqual(out2.returncode, 0, out2.stderr)
            self.assertEqual(out2.stdout.strip(), out.stdout.strip())
        finally:
            if st:
                self._shutdown(st)
                deadline = time.time() + 10
                while time.time() < deadline:
                    try:
                        os.kill(st["pid"], 0)
                    except OSError:
                        break
                    time.sleep(0.1)
                else:
                    try:
                        os.kill(st["pid"], 9)
                    except OSError:
                        pass


if __name__ == "__main__":
    unittest.main()
