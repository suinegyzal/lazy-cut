"""Lazy - Cut local HTTP server (stdlib only).

Security model (SPEC §3.10):
  * bound to 127.0.0.1 only; the Host header must be 127.0.0.1:<port> or
    localhost:<port> (blocks DNS-rebinding) → else 403;
  * /api/* needs the per-launch token in X-LazyCut-Token (→ 401); /media/* and
    /api/project/<id>/peaks also accept ?t=<token> (for <video src> / fetch);
  * static files under web/ need no token, are path-traversal safe and never cached.

Module boundaries: project/analysis/vad/segment/media/export/ffmpeg are written
by other engineers and imported lazily (``_mod``) inside handlers and job
functions, so the server starts even while they are incomplete and tests can
substitute fakes through sys.modules.

Assumptions beyond the spec (also listed in the build report):
  * Registry entries carry extra keys: "source" (source dict) and "prep_result".
  * /api/project/open auto-relinks a missing source if a file with the same name
    and size sits next to the .lazycut (shared/moved folders); response has
    "relinked": true. A size/mtime change yields "warning"; the new size/mtime is
    then stored so the warning shows once per change.
  * /api/project/save refuses to overwrite a transcribed project on disk with a
    clip-less copy of the same project (stale autosave racing the transcription
    job) — it answers ok with "skipped": true.
  * Transcription reuses cache/whisper_<model>.json when it exists for the same
    language (same media fingerprint ⇒ same result), skipping the worker.
  * Export: outPath without .mp4/.m4v/.mov gets ".mp4"; the map sidecar is assumed
    to be "<stem>.json" for the overwrite check; exporting onto the source file or
    with nothing kept is refused (400).
"""
from __future__ import annotations

import collections
import errno
import hmac
import http.server
import importlib
import json
import logging
import os
import queue
import re
import secrets
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse

from . import __version__, config
from . import settings as settings_mod
from .jobs import Canceled, Job, JobError, JobManager

log = logging.getLogger("lazycut.server")

_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)


def _mod(name: str):
    """Lazy import of a sibling module (lazycut.<name>); patched via sys.modules in tests."""
    return importlib.import_module("lazycut." + name)


def _is_ffmpeg_error(exc: BaseException) -> bool:
    return any(c.__name__ == "FFmpegError" for c in type(exc).__mro__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra


class RangeNotSatisfiable(Exception):
    pass


# --- helpers ---------------------------------------------------------------------

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".icns": "image/icns",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/mp4",
    ".webm": "video/webm",
    ".wav": "audio/wav",
    ".srt": "text/plain; charset=utf-8",
}


def guess_mime(path: str) -> str:
    return MIME_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")


def video_mime(path: str) -> str:
    # Chrome refuses some video/quicktime responses; mov/mp4/m4v are all ISO-BMFF.
    ext = os.path.splitext(path)[1].lower()
    if ext in (".mov", ".mp4", ".m4v"):
        return "video/mp4"
    if ext == ".webm":
        return "video/webm"
    return "application/octet-stream"


_RANGE_RE = re.compile(r"(\d*)\s*-\s*(\d*)")


def parse_range(header: str, size: int):
    """Parse a single-range ``Range`` header.

    Returns (start, end) inclusive, or None to serve the whole file (multi-range
    requests are answered with a plain 200, which RFC 9110 allows).
    Raises RangeNotSatisfiable for malformed or unsatisfiable ranges.
    """
    h = (header or "").strip()
    if not h.lower().startswith("bytes="):
        raise RangeNotSatisfiable()
    spec = h[6:].strip()
    if "," in spec:
        return None
    m = _RANGE_RE.fullmatch(spec)
    if not m or (m.group(1) == "" and m.group(2) == ""):
        raise RangeNotSatisfiable()
    if size <= 0:
        raise RangeNotSatisfiable()
    first, last = m.group(1), m.group(2)
    if first == "":  # suffix: last N bytes
        n = int(last)
        if n == 0:
            raise RangeNotSatisfiable()
        return max(0, size - n), size - 1
    start = int(first)
    end = int(last) if last != "" else size - 1
    if start >= size or end < start:
        raise RangeNotSatisfiable()
    return start, min(end, size - 1)


def _json_default(o):
    item = getattr(o, "item", None)
    if callable(item):  # numpy scalar (np.ndarray.item raises for size > 1 → tolist)
        try:
            return item()
        except (ValueError, TypeError):
            pass
    tolist = getattr(o, "tolist", None)
    if callable(tolist):
        return tolist()
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return o.decode("utf-8", "replace")
    raise TypeError("not JSON serializable: %s" % type(o).__name__)


def _scrub_nan(o):
    if isinstance(o, float):
        return o if o == o and o not in (float("inf"), float("-inf")) else None
    if isinstance(o, dict):
        return {k: _scrub_nan(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_scrub_nan(v) for v in o]
    return o


def dumps(obj) -> str:
    """JSON for browsers: UTF-8, numpy-tolerant, no NaN/Infinity."""
    try:
        return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                          default=_json_default, allow_nan=False)
    except ValueError:
        log.warning("NaN/Infinity in response; replaced with null")
        return json.dumps(_scrub_nan(json.loads(json.dumps(obj, default=_json_default))),
                          ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def jsonable(obj):
    """Deep copy into plain JSON types (numpy scalars → Python numbers)."""
    return json.loads(dumps(obj))


def norm_path(p) -> str | None:
    """Absolute, user-expanded path from a request field (None if unusable)."""
    if not isinstance(p, str):
        return None
    p = p.strip()
    if not p or "\x00" in p:
        return None
    if p.startswith("file://"):
        p = urllib.parse.unquote(urllib.parse.urlsplit(p).path)
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        return None
    return os.path.abspath(p)


def _same_file(a: str, b: str) -> bool:
    try:
        if os.path.exists(a) and os.path.exists(b):
            return os.path.samefile(a, b)
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _progress_cb(job: Job, lo: float = 0.0, hi: float = 1.0):
    """on_progress callback mapping 0..1 into [lo, hi]; tolerant of extra args."""
    def cb(p=None, *args, **kwargs):
        try:
            x = float(p)
        except (TypeError, ValueError):
            return
        job.update(progress=lo + (hi - lo) * min(1.0, max(0.0, x)))
    return cb


def _int_in(v, lo: int, hi: int, default: int) -> int:
    try:
        x = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return min(hi, max(lo, x))


def _validate_project(p, need_source: bool = True) -> dict:
    if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not p["id"]:
        raise ApiError(400, "bad_project", "프로젝트 정보가 올바르지 않아요.")
    if not isinstance(p.get("clips", []), list):
        raise ApiError(400, "bad_project", "프로젝트 정보가 올바르지 않아요.")
    if need_source:
        src = p.get("source")
        if not isinstance(src, dict) or not isinstance(src.get("path"), str):
            raise ApiError(400, "bad_project", "프로젝트에 원본 영상 정보가 없어요.")
    return p


def _has_kept(project: dict) -> bool:
    for clip in project.get("clips") or []:
        for tok in clip.get("words") or []:
            if not tok.get("del"):
                return True
    return False


# --- application core (no HTTP here) --------------------------------------------------

class AppCore:
    """Business logic behind the API: project registry, jobs, module calls."""

    def __init__(self, server: "LazyCutServer"):
        self.server = server
        self.jobs = JobManager()
        self.projects = {}  # type: dict[str, dict]
        self._lock = threading.RLock()
        self._save_lock = threading.Lock()
        self._dialog_lock = threading.Lock()

    # -- registry -------------------------------------------------------------------
    def register(self, project: dict, file: str, cache_dir: str | None = None) -> dict:
        source = project.get("source") or {}
        src = source.get("path")
        if cache_dir is None and src and os.path.isfile(src):
            cache_dir = self._cache_dir_for(src)
        with self._lock:
            old = self.projects.get(project["id"])
            entry = {
                "file": file,
                "source_path": src,
                "cache_dir": cache_dir,
                "prep_job": None,
                "source": source,
                "prep_result": None,
            }
            # Keep a running/finished prep for the same media (re-open of the same project).
            if old and old.get("cache_dir") == cache_dir and cache_dir:
                entry["prep_job"] = old.get("prep_job")
                entry["prep_result"] = old.get("prep_result")
            self.projects[project["id"]] = entry
        return entry

    def entry(self, pid: str) -> dict:
        with self._lock:
            e = self.projects.get(pid)
        if e is None:
            raise ApiError(404, "unknown_project", "열려 있는 프로젝트가 아니에요. 프로젝트를 다시 열어 주세요.")
        return e

    @staticmethod
    def _cache_dir_for(video: str) -> str | None:
        return _mod("media").cache_dir_for(video, config.CACHE_ROOT)

    def _ensure_cache_dir(self, entry: dict) -> str:
        if not entry.get("cache_dir"):
            entry["cache_dir"] = self._cache_dir_for(entry["source_path"])
        return entry["cache_dir"]

    def _prep_info(self, entry: dict) -> dict:
        info = {}
        job = entry.get("prep_job")
        if job is not None and job.state == "done" and isinstance(job.result, dict):
            info.update(job.result)
        if isinstance(entry.get("prep_result"), dict):
            info.update(entry["prep_result"])
        return info

    @staticmethod
    def _prep_files_ok(job: Job) -> bool:
        res = job.result if isinstance(job.result, dict) else {}
        wav = res.get("audio16k")
        if not (isinstance(wav, str) and os.path.isfile(wav)):
            return False
        if "proxy" in res:   # older preps made no light preview copy -> run prep again (fast: rest is cached)
            px = res.get("proxy")
            return isinstance(px, str) and os.path.isfile(px)
        return True

    def start_prep(self, pid: str) -> Job | None:
        entry = self.entry(pid)
        src = entry.get("source_path")
        if not src or not os.path.isfile(src):
            return None
        cache_dir = self._ensure_cache_dir(entry)
        with self._lock:
            cur = entry.get("prep_job")
            if cur is not None and (not cur.finished or (cur.state == "done" and self._prep_files_ok(cur))):
                return cur
            # One prep per media cache dir: never run two writers on the same files.
            for e in self.projects.values():
                j = e.get("prep_job")
                if j is not None and not j.finished and e.get("cache_dir") == cache_dir:
                    entry["prep_job"] = j
                    return j
            source = dict(entry.get("source") or {})

            def prep(job: Job):
                job.update(progress=0.0, stage="prep", message="영상을 준비하고 있어요")
                res = _mod("media").prepare(src, source, cache_dir,
                                            on_progress=_progress_cb(job), cancel=job.cancel)
                return jsonable(res) if res is not None else {}

            job = self.jobs.submit("prep", prep, heavy=False, project_id=pid)
            entry["prep_job"] = job
            return job

    def _probe(self, video: str) -> dict:
        ff = _mod("ffmpeg")
        try:
            source = ff.probe(video)
        except Exception as e:  # noqa: BLE001 — classify probe failures for the user
            if _is_ffmpeg_error(e):
                log.warning("probe failed for %s: %s", video, e)
                raise ApiError(422, "probe_failed",
                               "영상 정보를 읽지 못했어요. 지원하지 않는 형식이거나 손상된 파일일 수 있어요.")
            raise
        if not isinstance(source, dict):
            raise ApiError(422, "probe_failed", "영상 정보를 읽지 못했어요.")
        return jsonable(source)

    def _save_file(self, project: dict, path: str) -> None:
        P = _mod("project")
        project["file"] = path
        with self._save_lock:
            try:
                # Only matters for the ~/Documents fallback folder; a video's own folder exists.
                os.makedirs(os.path.dirname(path), exist_ok=True)
                P.save(project, path)
            except PermissionError:
                raise ApiError(403, "save_failed", "이 폴더에는 저장할 수 없어요. 권한을 확인해 주세요.")
            except OSError as e:
                if e.errno == errno.ENOSPC:
                    raise ApiError(507, "disk_full", "저장 공간이 부족해서 프로젝트를 저장하지 못했어요.")
                raise ApiError(500, "save_failed", "프로젝트를 저장하지 못했어요: %s" % e)

    # -- simple endpoints -------------------------------------------------------------
    def api_health(self, body):
        return {"version": __version__, "pid": os.getpid()}

    def api_bootstrap(self, body):
        models = {
            name: {"downloaded": config.model_downloaded(name),
                   "sizeLabel": config.MODEL_SIZE_LABELS.get(name, "")}
            for name in config.MODEL_REPOS
        }
        return {
            "version": __version__,
            "settings": settings_mod.load_settings(),
            "recent": settings_mod.recent_list(),
            "models": models,
            "jobs": [j.to_dict() for j in self.jobs.active()],
        }

    def api_settings(self, body):
        partial = body.get("settings")
        if not isinstance(partial, dict):
            raise ApiError(400, "bad_request", "설정 값이 올바르지 않아요.")
        return {"settings": settings_mod.save_settings(partial)}

    # -- dialogs ----------------------------------------------------------------------
    def _dialog(self, fn, *args):
        if not self._dialog_lock.acquire(blocking=False):
            raise ApiError(409, "dialog_open", "이미 창이 열려 있어요. 그 창을 먼저 닫아 주세요.")
        try:
            return {"path": fn(*args)}
        finally:
            self._dialog_lock.release()

    def api_dialog_open_video(self, body):
        from . import dialogs
        return self._dialog(lambda: dialogs.choose_video())

    def api_dialog_open_project(self, body):
        from . import dialogs
        return self._dialog(lambda: dialogs.choose_project())

    def api_dialog_save(self, body):
        from . import dialogs
        name = body.get("defaultName") if isinstance(body.get("defaultName"), str) else ""
        folder = norm_path(body.get("defaultDir"))
        return self._dialog(lambda: dialogs.choose_save(name, folder))

    def api_dialog_locate(self, body):
        from . import dialogs
        name = body.get("name") if isinstance(body.get("name"), str) else ""
        prompt = ("‘%s’ 영상을 찾아 주세요" % name.strip()) if name.strip() else "원본 영상을 찾아 주세요"
        return self._dialog(lambda: dialogs.choose_any(prompt))

    # -- projects ---------------------------------------------------------------------
    def api_project_create(self, body):
        video = norm_path(body.get("videoPath"))
        if not video:
            raise ApiError(400, "bad_request", "영상 경로가 없어요.")
        if video.lower().endswith(config.PROJECT_EXT):
            return self.api_project_open({"path": video})
        if not os.path.isfile(video):
            raise ApiError(404, "not_found", "영상 파일을 찾을 수 없어요.")
        P = _mod("project")
        ppath = P.project_path_for(video)
        if os.path.exists(ppath) and not body.get("force"):
            return {"exists": True, "projectPath": ppath}
        source = self._probe(video)
        if source.get("hasAudio") is False:
            raise ApiError(422, "no_audio", "이 영상에는 소리가 없어서 받아쓸 수 없어요.")
        st = settings_mod.load_settings()
        proj_settings = {k: st[k] for k in ("maxChars", "silenceMin", "silenceKeep", "includeNoise")}
        project = P.new_project(source, proj_settings)
        tr = project.get("transcribe")
        if isinstance(tr, dict) and not tr.get("doneAt"):
            tr["model"], tr["lang"] = st["model"], st["lang"]
        self._save_file(project, ppath)
        self.register(project, ppath)
        job = self.start_prep(project["id"])
        settings_mod.touch_recent(project)
        log.info("created project %s for %s", project["id"], video)
        return {"project": project, "prepJob": job.to_dict() if job else None}

    def _load_project(self, ppath: str) -> dict:
        P = _mod("project")
        try:
            project = P.load(ppath)
        except ImportError:
            raise
        except FileNotFoundError:
            raise ApiError(404, "not_found", "프로젝트 파일을 찾을 수 없어요.")
        except PermissionError:
            raise ApiError(403, "no_permission", "프로젝트 파일을 열 권한이 없어요.")
        except Exception as e:  # noqa: BLE001 — corrupt/foreign JSON
            log.warning("could not load project %s: %r", ppath, e)
            raise ApiError(422, "bad_project", "프로젝트 파일을 읽지 못했어요. 파일이 손상됐을 수 있어요.")
        if not isinstance(project, dict) or not project.get("id"):
            raise ApiError(422, "bad_project", "Lazy - Cut 프로젝트 파일이 아니에요.")
        project["file"] = ppath
        return project

    def api_project_open(self, body):
        path = norm_path(body.get("path"))
        if not path:
            raise ApiError(400, "bad_request", "파일 경로가 없어요.")
        if path.lower().endswith(config.PROJECT_EXT):
            ppath = path
        else:
            ppath = _mod("project").project_path_for(path)
            if not os.path.isfile(ppath):
                raise ApiError(404, "no_project", "이 영상으로 만든 프로젝트가 없어요.")
        if not os.path.isfile(ppath):
            raise ApiError(404, "not_found", "프로젝트 파일을 찾을 수 없어요.")
        project = self._load_project(ppath)
        source = project.get("source")
        if not isinstance(source, dict):
            raise ApiError(422, "bad_project", "프로젝트에 원본 영상 정보가 없어요.")
        src = source.get("path") or ""
        resp = {"project": project, "prepJob": None, "missingSource": False}
        dirty = False

        if not os.path.isfile(src):
            # Moved/shared folder: the video may sit right next to the project file.
            cand = os.path.join(os.path.dirname(ppath), os.path.basename(src)) if src else ""
            try:
                if cand and os.path.isfile(cand) and os.path.getsize(cand) == source.get("size"):
                    source["path"] = src = cand
                    source["mtime"] = os.path.getmtime(cand)
                    resp["relinked"] = True
                    dirty = True
            except OSError:
                pass

        if not os.path.isfile(src):
            self.register(project, ppath)
            settings_mod.touch_recent(project)
            resp["missingSource"] = True
            return resp

        try:
            st = os.stat(src)
            size_changed = source.get("size") is not None and int(source["size"]) != st.st_size
            mtime_changed = (source.get("mtime") is not None
                             and abs(float(source["mtime"]) - st.st_mtime) > 2.0)
        except (OSError, TypeError, ValueError):
            size_changed = mtime_changed = False
        if size_changed or mtime_changed:
            resp["warning"] = "영상 파일이 처음 불러올 때와 달라졌어요. 편집한 위치가 맞는지 확인해 주세요."
            source["size"], source["mtime"] = st.st_size, st.st_mtime
            dirty = True
        if dirty:
            try:
                self._save_file(project, ppath)
            except ApiError as e:  # read-only location: still open it
                log.warning("could not update %s: %s", ppath, e.message)

        self.register(project, ppath)
        self._maybe_realign(project, ppath)
        job = self.start_prep(project["id"])
        resp["prepJob"] = job.to_dict() if job else None
        settings_mod.touch_recent(project)
        return resp

    def _maybe_realign(self, project: dict, ppath: str) -> None:
        """Projects transcribed before onset snapping: fix word starts once, keeping every edit."""
        try:
            analysis = _mod("analysis")
            if not project.get("clips") or int(project.get("alignVer") or 0) >= analysis.ALIGN_VERSION:
                return
            entry = self.entry(project["id"])
            wav = os.path.join(self._ensure_cache_dir(entry), "audio16k.wav")
            if not os.path.isfile(wav):
                return
            vad = _mod("vad")
            n = analysis.realign(project["clips"], vad.analyze(vad.load_wav16k(wav)))
            project["alignVer"] = analysis.ALIGN_VERSION
            self._save_file(project, ppath)
            log.info("realigned %d word starts in %s", n, ppath)
        except Exception:  # noqa: BLE001 — never block opening a project
            log.exception("realign failed")

    def api_project_relink(self, body):
        pid = body.get("projectId")
        entry = self.entry(pid if isinstance(pid, str) else "")
        video = norm_path(body.get("videoPath"))
        if not video or not os.path.isfile(video):
            raise ApiError(404, "not_found", "영상 파일을 찾을 수 없어요.")
        project = self._load_project(entry["file"])
        old = project.get("source") or {}
        source = self._probe(video)
        resp = {}
        try:
            old_d, new_d = float(old.get("duration") or 0), float(source.get("duration") or 0)
        except (TypeError, ValueError):
            old_d = new_d = 0.0
        if abs(old_d - new_d) > 0.5:
            resp["warning"] = ("영상 길이가 원래와 달라요 (원래 %s, 새 영상 %s). 다른 영상일 수 있어요."
                               % (_fmt_dur(old_d), _fmt_dur(new_d)))
        project["source"] = source
        if resp.get("warning"):
            try:  # duration changed → keep the partition invariant valid
                for w in _mod("project").repair(project) or []:
                    log.info("relink repair: %s", w)
            except Exception:  # noqa: BLE001
                log.exception("repair after relink failed")
        self._save_file(project, entry["file"])
        self.register(project, entry["file"])
        job = self.start_prep(project["id"])
        settings_mod.touch_recent(project)
        resp.update({"project": project, "prepJob": job.to_dict() if job else None})
        return resp

    def api_project_save(self, body):
        project = _validate_project(body.get("project"))
        pid = project["id"]
        with self._lock:
            entry = self.projects.get(pid)
        if entry:
            path = entry["file"]
            # A save queued before a relink must not point the project back at the missing file.
            reg_src = entry.get("source_path")
            if (reg_src and reg_src != project["source"]["path"] and os.path.isfile(reg_src)
                    and not os.path.isfile(project["source"]["path"]) and entry.get("source")):
                project["source"] = dict(entry["source"])
        else:
            path = _mod("project").project_path_for(project["source"]["path"])
        if not project.get("clips") and self._disk_has_clips(path, pid):
            log.warning("ignored stale clip-less save of %s", pid)
            return {"path": path, "savedAt": settings_mod.now_iso(), "skipped": True}
        self._save_file(project, path)
        if not entry:
            src = project["source"]["path"]
            cache = None
            if os.path.isfile(src):
                try:
                    cache = self._cache_dir_for(src)
                except Exception:  # noqa: BLE001 — media module not ready; prep will retry
                    cache = None
            self.register(project, path, cache_dir=cache)
        settings_mod.touch_recent(project)
        return {"path": path, "savedAt": project.get("updatedAt") or settings_mod.now_iso()}

    @staticmethod
    def _disk_has_clips(path: str, pid: str) -> bool:
        try:
            with open(path, "r", encoding="utf-8") as f:
                disk = json.load(f)
        except (OSError, ValueError):
            return False
        return isinstance(disk, dict) and disk.get("id") == pid and bool(disk.get("clips"))

    def api_project_resegment(self, body):
        project = _validate_project(body.get("project"), need_source=False)
        st = project.get("settings") or {}
        max_chars = _int_in(body.get("maxChars", st.get("maxChars", 22)), 8, 60, 22)
        clips = _mod("analysis").resegment(project.get("clips") or [], max_chars)
        return {"clips": jsonable(clips)}

    def api_project_analyze(self, body):
        project = _validate_project(body.get("project"), need_source=False)
        clips = _mod("analysis").analyze(project.get("clips") or [])
        return {"clips": jsonable(clips)}

    def api_project_status(self, body, pid):
        entry = self.entry(pid)
        job = entry.get("prep_job")
        return {
            "prep": job.to_dict() if job else None,
            "playable": self._playable(entry),
            "hasProxy": self._proxy_path(entry, pid) is not None,
        }

    def _playable(self, entry: dict) -> bool:
        info = self._prep_info(entry)
        if "playable" in info:
            return bool(info["playable"])
        try:
            return bool(_mod("media").browser_playable(entry.get("source") or {}))
        except Exception:  # noqa: BLE001 — unknown → let the browser try
            return True

    def _proxy_path(self, entry: dict, pid: str) -> str | None:
        """Finished proxy file, or None (missing / still being written)."""
        prep = entry.get("prep_job")
        if self.jobs.find(kind="proxy", project_id=pid) or (prep is not None and not prep.finished):
            return None
        info = self._prep_info(entry)
        cands = [info.get("proxy")]
        if entry.get("cache_dir"):
            cands.append(os.path.join(entry["cache_dir"], "proxy.mp4"))
        for p in cands:
            if isinstance(p, str) and os.path.isfile(p):
                return p
        return None

    def api_project_proxy(self, body, pid):
        entry = self.entry(pid)
        src = entry.get("source_path")
        if not src or not os.path.isfile(src):
            raise ApiError(409, "missing_source", "원본 영상을 찾을 수 없어요.")
        running = self.jobs.find(kind="proxy", project_id=pid)
        if running:
            return {"job": running[0].to_dict()}
        cache_dir = self._ensure_cache_dir(entry)
        source = dict(entry.get("source") or {})

        def make_proxy(job: Job):
            job.update(progress=0.0, stage="proxy", message="재생용 영상을 만들고 있어요")
            path = _mod("media").ensure_proxy(src, cache_dir, source,
                                              on_progress=_progress_cb(job), cancel=job.cancel)
            with self._lock:
                pr = dict(entry.get("prep_result") or {})
                pr["proxy"] = path
                entry["prep_result"] = pr
            return {"proxy": path}

        job = self.jobs.submit("proxy", make_proxy, heavy=True, project_id=pid)
        return {"job": job.to_dict()}

    def peaks_path(self, pid: str) -> str:
        entry = self.entry(pid)
        prep = entry.get("prep_job")
        if prep is not None and not prep.finished:
            raise ApiError(404, "not_ready", "아직 파형을 준비하고 있어요.")
        info = self._prep_info(entry)
        cands = [info.get("peaks")]
        if entry.get("cache_dir"):
            cands.append(os.path.join(entry["cache_dir"], "peaks.u8"))
        for p in cands:
            if isinstance(p, str) and os.path.isfile(p):
                return p
        raise ApiError(404, "not_ready", "아직 파형을 준비하고 있어요.")

    def thumbs_dir(self, pid: str) -> str | None:
        entry = self.entry(pid)
        if entry.get("cache_dir"):
            d = os.path.join(entry["cache_dir"], "thumbs")
            if os.path.isfile(os.path.join(d, "index.json")):
                return d
        return None

    def api_project_thumbs(self, body, pid):
        d = self.thumbs_dir(pid)
        if not d:
            return {"thumbs": [], "code": "not_ready"}
        try:
            with open(os.path.join(d, "index.json")) as f:
                items = json.load(f)
        except (OSError, ValueError):
            return {"thumbs": [], "code": "not_ready"}
        return {"thumbs": [{"t": it["t"], "url": "/media/%s/thumb/%s" % (pid, it["f"])} for it in items
                           if isinstance(it, dict) and re.fullmatch(r"\d+\.jpg", str(it.get("f", "")))]}

    def media_path(self, pid: str, want_proxy: bool) -> str:
        entry = self.entry(pid)
        proxy = self._proxy_path(entry, pid)
        if want_proxy:
            if not proxy:
                raise ApiError(404, "not_ready", "재생용 영상이 아직 없어요.")
            return proxy
        src = entry.get("source_path")
        if proxy and not self._playable(entry):
            return proxy
        if not src or not os.path.isfile(src):
            raise ApiError(404, "missing_source", "원본 영상을 찾을 수 없어요.")
        return src

    # -- transcription -------------------------------------------------------------------
    def worker_cmd(self, wav: str, model: str, lang: str, out: str) -> list:
        return [sys.executable, "-m", "lazycut.transcribe_worker", "--audio", wav, "--model", model,
                "--lang", lang, "--out", out, "--recover", "1"]

    def api_project_transcribe(self, body):
        pid = body.get("projectId")
        entry = self.entry(pid if isinstance(pid, str) else "")
        st = settings_mod.load_settings()
        model = body.get("model") or st["model"]
        if model not in config.MODEL_REPOS:
            raise ApiError(400, "bad_model", "알 수 없는 음성인식 모델이에요.")
        lang = body.get("lang") or st["lang"]
        if not isinstance(lang, str) or not re.fullmatch(r"[A-Za-z-]{2,10}", lang.strip()):
            raise ApiError(400, "bad_lang", "언어 설정이 올바르지 않아요.")
        lang = lang.strip().lower()
        max_chars = _int_in(body.get("maxChars", st["maxChars"]), 8, 60, st["maxChars"])
        src = entry.get("source_path")
        if not src or not os.path.isfile(src):
            raise ApiError(409, "missing_source", "원본 영상을 찾을 수 없어요.")
        running = self.jobs.find(kind="transcribe", project_id=pid)
        if running:  # double click / reloaded window: hand back the running job
            return {"job": running[0].to_dict()}
        job = self.jobs.submit(
            "transcribe", lambda j: self._transcribe_job(j, pid, model, lang, max_chars),
            heavy=True, project_id=pid)
        return {"job": job.to_dict()}

    def _transcribe_job(self, job: Job, pid: str, model: str, lang: str, max_chars: int):
        entry = self.entry(pid)
        job.update(progress=0.0, stage="prep", message="소리를 준비하고 있어요")
        wav = self._ensure_audio(job, entry)
        job.check_cancel()
        out = os.path.join(self._ensure_cache_dir(entry), "whisper_%s.json" % model)
        whisper = self._cached_whisper(out, lang)
        if whisper is None:
            job.update(progress=0.03, stage="transcribe", message="받아쓰기를 시작해요")
            self._run_worker(job, wav, model, lang, out, lo=0.03, hi=0.93)
            whisper = self._cached_whisper(out, None)
            if whisper is None:
                raise JobError("받아쓰기 결과를 읽지 못했어요. 다시 시도해 주세요.")
        else:
            log.info("reusing cached transcription %s", out)
        job.check_cancel()

        job.update(progress=0.94, stage="analyze", message="자막 줄을 나누고 있어요")
        vad, analysis = _mod("vad"), _mod("analysis")
        vres = vad.analyze(vad.load_wav16k(wav))
        job.check_cancel()
        # Reload from disk now: picks up anything the window saved while we worked.
        try:
            project = self._load_project(entry["file"])
        except ApiError as e:
            raise JobError("프로젝트 파일을 다시 읽지 못했어요: " + e.message)
        proj_settings = dict(project.get("settings") or {})
        proj_settings["maxChars"] = max_chars
        duration = float((project.get("source") or {}).get("duration") or 0.0)
        clips = analysis.build_clips(whisper, vres, duration, proj_settings)
        del vres
        job.check_cancel()
        project["clips"] = jsonable(clips)
        project["settings"] = proj_settings
        project["transcribe"] = {"model": model, "lang": lang, "doneAt": settings_mod.now_iso()}
        project["alignVer"] = getattr(analysis, "ALIGN_VERSION", 0)
        try:
            self._save_file(project, entry["file"])
        except ApiError as e:
            raise JobError(e.message)
        settings_mod.touch_recent(project)
        settings_mod.save_settings({"model": model, "lang": lang, "maxChars": max_chars})
        job.update(progress=1.0, stage="done", message="받아쓰기를 마쳤어요")
        return {"project": project}

    def _ensure_audio(self, job: Job, entry: dict) -> str:
        """Wait for the project's prep job; fall back to extracting audio ourselves."""
        prep = entry.get("prep_job")
        ready = os.path.join(self._ensure_cache_dir(entry), "audio16k.wav")
        if prep is not None and not prep.finished:
            # only the audio is needed: don't wait for thumbnails / the preview proxy
            job.update(message="소리를 꺼내고 있어요")
            while not prep.finished and not os.path.isfile(ready):
                self.jobs.wait(prep.id, timeout=0.25)
                job.check_cancel()
            if os.path.isfile(ready):
                return ready
        info = self._prep_info(entry)
        wav = info.get("audio16k")
        if isinstance(wav, str) and os.path.isfile(wav):
            return wav
        media = _mod("media")
        cache_dir = self._ensure_cache_dir(entry)
        wav = media.ensure_audio16k(entry["source_path"], cache_dir,
                                    on_progress=_progress_cb(job, 0.0, 0.03), cancel=job.cancel)
        result = {"audio16k": wav}
        try:
            result["peaks"] = media.ensure_peaks(wav, cache_dir)
        except Exception:  # noqa: BLE001 — waveform is optional for transcription
            log.exception("peaks failed")
        with self._lock:
            pr = dict(entry.get("prep_result") or {})
            pr.update(result)
            entry["prep_result"] = pr
        return wav

    @staticmethod
    def _cached_whisper(path: str, lang: str | None):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("words"), list):
            return None
        if lang is not None and data.get("lang") != lang:
            return None
        return data

    def _run_worker(self, job: Job, wav: str, model: str, lang: str, out: str,
                    lo: float = 0.0, hi: float = 1.0) -> None:
        cmd = self.worker_cmd(wav, model, lang, out)
        env = config.child_env()
        log.info("starting transcribe worker: %s", " ".join(cmd))
        try:
            proc = subprocess.Popen(cmd, cwd=config.ROOT_DIR, env=env, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, encoding="utf-8", errors="replace", bufsize=1)
        except OSError as e:
            raise JobError("받아쓰기 프로그램을 시작하지 못했어요: %s" % e)

        lines = queue.Queue()  # type: queue.Queue
        err_tail = collections.deque(maxlen=40)

        def pump_stdout():
            try:
                for ln in proc.stdout:
                    lines.put(ln)
            except (OSError, ValueError):  # pipe closed under us after a cancel
                pass
            finally:
                lines.put(None)

        def pump_stderr():
            try:
                for ln in proc.stderr:
                    ln = ln.rstrip()
                    if ln:
                        err_tail.append(ln)
                        log.debug("worker: %s", ln)
            except (OSError, ValueError):
                pass

        pumps = [threading.Thread(target=pump_stdout, name="worker-stdout", daemon=True),
                 threading.Thread(target=pump_stderr, name="worker-stderr", daemon=True)]
        for t in pumps:
            t.start()

        error_msg = None
        last_msg = None
        exited_at = None
        try:
            while True:
                if job.cancel.is_set():
                    raise Canceled()
                try:
                    ln = lines.get(timeout=0.2)
                except queue.Empty:
                    if proc.poll() is not None:  # exited but a grandchild may hold stdout open
                        exited_at = exited_at or time.monotonic()
                        if time.monotonic() - exited_at > 2.0:
                            break
                    continue
                if ln is None:
                    break
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    msg = json.loads(ln)
                except ValueError:
                    log.debug("worker (non-JSON): %s", ln)
                    continue
                if not isinstance(msg, dict):
                    continue
                stage = msg.get("stage")
                text = msg.get("message")
                if stage == "error":
                    error_msg = text or error_msg
                    continue
                if isinstance(text, str) and text:
                    last_msg = text
                prog = msg.get("progress")
                p = None
                if isinstance(prog, (int, float)) and not isinstance(prog, bool):
                    p = lo + (hi - lo) * min(1.0, max(0.0, float(prog)))
                job.update(progress=p, stage=stage if isinstance(stage, str) else None,
                           message=text if isinstance(text, str) and text else None)
            try:
                rc = proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                raise JobError("받아쓰기 프로그램이 응답하지 않아요. 다시 시도해 주세요.")
        finally:
            _terminate(proc)  # no-op if it already exited
            for t in pumps:
                t.join(timeout=2)
            for pipe in (proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass
        if job.cancel.is_set():
            raise Canceled()
        if rc != 0:
            detail = error_msg or (err_tail[-1] if err_tail else None) or last_msg or ("종료 코드 %s" % rc)
            log.error("transcribe worker failed (rc=%s): %s\n%s", rc, detail, "\n".join(err_tail))
            raise JobError("받아쓰기에 실패했어요: %s" % detail)
        if not os.path.isfile(out):
            raise JobError("받아쓰기 결과 파일이 만들어지지 않았어요.")

    # -- export ------------------------------------------------------------------------
    def api_export(self, body):
        project = _validate_project(body.get("project"))
        opts = body.get("options") if isinstance(body.get("options"), dict) else {}
        src = project["source"]["path"]
        if not os.path.isfile(src):
            raise ApiError(409, "missing_source", "원본 영상을 찾을 수 없어요.")
        if not _has_kept(project):
            raise ApiError(400, "nothing_to_export", "남은 구간이 없어요. 삭제한 부분을 일부 되돌려 주세요.")
        out = norm_path(opts.get("outPath"))
        if not out:
            raise ApiError(400, "bad_path", "저장할 위치를 골라 주세요.")
        if os.path.splitext(out)[1].lower() not in (".mp4", ".m4v", ".mov"):
            out += ".mp4"
        self._check_target_dir(out)
        if _same_file(out, src):
            raise ApiError(400, "same_as_source", "원본 영상과 같은 파일에는 저장할 수 없어요.")
        stem = os.path.splitext(out)[0]
        st = settings_mod.load_settings()
        srt_on = bool(opts.get("srt", st["exportSrt"]))
        map_on = bool(opts.get("map", st["exportMap"]))
        quality = opts.get("quality") if opts.get("quality") in ("high", "medium", "small") else st["exportQuality"]
        resolution = str(opts.get("resolution") or st["exportResolution"])
        if resolution not in ("source", "1080", "720"):
            resolution = "source"
        overwrite = bool(opts.get("overwrite"))
        srt_path = stem + ".srt"
        targets = [out] + ([srt_path] if srt_on else []) + ([stem + ".json"] if map_on else [])
        if _same_file(srt_path, src):
            raise ApiError(400, "same_as_source", "원본 영상과 같은 파일에는 저장할 수 없어요.")
        if not overwrite:
            existing = [p for p in targets if os.path.exists(p)]
            if existing:
                raise ApiError(409, "exists", "같은 이름의 파일이 이미 있어요. 덮어쓸까요?",
                               path=existing[0], paths=existing)
        pid = project["id"]

        def do_export(job: Job):
            job.update(progress=0.0, stage="export", message="영상을 만들고 있어요")
            tmp = os.path.join(config.TMP_DIR, "export_" + job.id)
            os.makedirs(tmp, exist_ok=True)
            try:
                res = _mod("export").export_video(
                    project, out, srt=srt_on, srt_path=srt_path if srt_on else None, map_json=map_on,
                    quality=quality, resolution=resolution, overwrite=overwrite,
                    on_progress=_progress_cb(job), cancel=job.cancel, tmp_dir=tmp)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            job.update(progress=1.0, message="다 됐어요")
            return jsonable(res) if res is not None else {"mp4": out}

        job = self.jobs.submit("export", do_export, heavy=True, project_id=pid)
        return {"job": job.to_dict()}

    @staticmethod
    def _check_target_dir(path: str) -> None:
        folder = os.path.dirname(path)
        if not os.path.isdir(folder):
            raise ApiError(400, "bad_path", "저장할 폴더가 없어요.")
        if not os.access(folder, os.W_OK):
            raise ApiError(403, "not_writable", "이 폴더에는 저장할 수 없어요. 다른 위치를 골라 주세요.")

    def api_export_srt(self, body):
        project = _validate_project(body.get("project"))
        out = norm_path(body.get("outPath"))
        if not out:
            raise ApiError(400, "bad_path", "저장할 위치를 골라 주세요.")
        if os.path.splitext(out)[1].lower() != ".srt":
            out += ".srt"
        self._check_target_dir(out)
        if _same_file(out, project["source"]["path"]):
            raise ApiError(400, "same_as_source", "원본 영상과 같은 파일에는 저장할 수 없어요.")
        if os.path.exists(out) and not body.get("overwrite"):
            raise ApiError(409, "exists", "같은 이름의 파일이 이미 있어요. 덮어쓸까요?", path=out, paths=[out])
        path = _mod("export").export_srt(project, out)
        return {"path": path or out}

    def api_export_default_paths(self, body):
        project = _validate_project(body.get("project"))
        mp4, srt = _mod("export").default_output_paths(project["source"]["path"])
        return {"mp4": mp4, "srt": srt, "dir": os.path.dirname(mp4)}

    # -- jobs / misc ---------------------------------------------------------------------
    def api_job_get(self, body, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", "작업을 찾을 수 없어요.")
        return {"job": job.to_dict()}

    def api_job_cancel(self, body, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise ApiError(404, "not_found", "작업을 찾을 수 없어요.")
        return {"canceled": self.jobs.cancel(job_id), "job": job.to_dict()}

    def api_reveal(self, body):
        path = norm_path(body.get("path"))
        if not path or not (os.path.exists(path) or os.path.isdir(os.path.dirname(path))):
            raise ApiError(404, "not_found", "파일을 찾을 수 없어요.")
        reveal(path if os.path.exists(path) else os.path.dirname(path))
        return {}

    def api_shutdown(self, body):
        log.info("shutdown requested by the window")
        self.server.stop(delay=0.5)
        return {}


def _fmt_dur(sec: float) -> str:
    sec = int(round(sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


def _terminate(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
    except OSError:
        pass


def reveal(path: str) -> None:
    """Show a file in Finder (module-level so tests can replace it)."""
    subprocess.Popen(["open", "-R", path], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# --- routing -------------------------------------------------------------------------

_ID = r"([A-Za-z0-9_-]{1,64})"
# (method, path regex, AppCore method, ?t= token allowed)
ROUTES = [(m, re.compile(rx), name, qtok) for m, rx, name, qtok in [
    ("GET", r"/api/health", "api_health", False),
    ("GET", r"/api/bootstrap", "api_bootstrap", False),
    ("POST", r"/api/settings", "api_settings", False),
    ("POST", r"/api/dialog/open-video", "api_dialog_open_video", False),
    ("POST", r"/api/dialog/open-project", "api_dialog_open_project", False),
    ("POST", r"/api/dialog/save", "api_dialog_save", False),
    ("POST", r"/api/dialog/locate", "api_dialog_locate", False),
    ("POST", r"/api/project/create", "api_project_create", False),
    ("POST", r"/api/project/open", "api_project_open", False),
    ("POST", r"/api/project/relink", "api_project_relink", False),
    ("POST", r"/api/project/save", "api_project_save", False),
    ("POST", r"/api/project/transcribe", "api_project_transcribe", False),
    ("POST", r"/api/project/resegment", "api_project_resegment", False),
    ("POST", r"/api/project/analyze", "api_project_analyze", False),
    ("GET", r"/api/project/%s/peaks" % _ID, "peaks", True),
    ("GET", r"/api/project/%s/thumbs" % _ID, "api_project_thumbs", False),
    ("POST", r"/api/project/%s/proxy" % _ID, "api_project_proxy", False),
    ("GET", r"/api/project/%s/status" % _ID, "api_project_status", False),
    ("POST", r"/api/export", "api_export", False),
    ("POST", r"/api/export/srt", "api_export_srt", False),
    ("POST", r"/api/export/default-paths", "api_export_default_paths", False),
    ("GET", r"/api/jobs/%s" % _ID, "api_job_get", False),
    ("POST", r"/api/jobs/%s/cancel" % _ID, "api_job_cancel", False),
    ("POST", r"/api/reveal", "api_reveal", False),
    ("POST", r"/api/shutdown", "api_shutdown", False),
]]

_MEDIA_RE = re.compile(r"/media/%s/video" % _ID)
_STATIC_PREFIXES = ("/css/", "/js/", "/img/", "/test/", "/fonts/")


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LazyCut/" + __version__
    timeout = 120  # seconds of socket inactivity (idle keep-alive, stalled media reads)

    # -- entry points -------------------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def log_request(self, code="-", size="-"):
        try:
            c = int(code)
        except (TypeError, ValueError):
            c = 0
        path = self.path.split("?", 1)[0]
        (log.info if c >= 400 else log.debug)("%s %s → %s", self.command, path, code)

    # -- dispatch -----------------------------------------------------------------------
    def _dispatch(self, method: str) -> None:
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        self._query = urllib.parse.parse_qs(url.query)
        self._body = b""
        try:
            if not self._host_ok():
                self.close_connection = True
                raise ApiError(403, "forbidden_host", "허용되지 않은 접근이에요.")
            if method == "POST":
                self._body = self._read_body()
            if path.startswith("/api/"):
                self._handle_api(method, path)
            elif path.startswith("/media/"):
                self._handle_media(method, path)
            elif method == "POST":
                raise ApiError(405, "method_not_allowed", "지원하지 않는 요청이에요.")
            else:
                self._handle_static(method, path)
        except ApiError as e:
            payload = {"ok": False, "error": e.message, "code": e.code}
            payload.update(e.extra)
            self._send_json(e.status, payload, head=(method == "HEAD"))
        except _DISCONNECT_ERRORS:
            self.close_connection = True
        except ImportError as e:
            log.exception("module import failed")
            self._send_json(500, {"ok": False, "code": "module_missing",
                                  "error": "앱 구성 요소를 불러오지 못했어요 (%s). 앱을 다시 설치해 주세요." % (e.name or e)})
        except Exception as e:  # noqa: BLE001 — last-resort 500 with a log entry
            log.exception("unhandled error on %s %s", method, path)
            try:
                self._send_json(500, {"ok": False, "code": "server_error",
                                      "error": "서버에서 문제가 생겼어요: %s" % (str(e) or type(e).__name__)})
            except _DISCONNECT_ERRORS:
                self.close_connection = True

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        port = self.server.server_port
        return host in ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def _token_ok(self, allow_query: bool) -> bool:
        expected = self.server.token.encode()
        got = self.headers.get("X-LazyCut-Token")
        if got is None and allow_query:
            got = (self._query.get("t") or [None])[0]
        if not got:
            return False
        return hmac.compare_digest(got.encode("utf-8", "replace"), expected)

    def _read_body(self) -> bytes:
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            raise ApiError(411, "length_required", "요청 길이가 필요해요.")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            raise ApiError(400, "bad_request", "요청을 이해하지 못했어요.")
        if length < 0:
            self.close_connection = True
            raise ApiError(400, "bad_request", "요청을 이해하지 못했어요.")
        if length > config.MAX_BODY_BYTES:
            self.close_connection = True  # don't read 50 MB+ just to discard it
            raise ApiError(413, "too_large", "요청이 너무 커요.")
        data = b""
        while len(data) < length:
            chunk = self.rfile.read(length - len(data))
            if not chunk:
                self.close_connection = True
                raise ApiError(400, "bad_request", "요청이 중간에 끊겼어요.")
            data += chunk
        return data

    def _json_body(self) -> dict:
        if not self._body:
            return {}
        try:
            body = json.loads(self._body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "bad_json", "요청을 이해하지 못했어요.")
        if not isinstance(body, dict):
            raise ApiError(400, "bad_json", "요청을 이해하지 못했어요.")
        return body

    # -- API ----------------------------------------------------------------------------
    def _handle_api(self, method: str, path: str) -> None:
        self.server.touch()
        lookup = "GET" if method == "HEAD" else method
        route, groups, allowed = None, (), set()
        for r_method, rx, name, qtok in ROUTES:
            m = rx.fullmatch(path)
            if not m:
                continue
            if r_method == lookup:
                route, groups = (r_method, rx, name, qtok), m.groups()
                break
            allowed.add(r_method)
        if not self._token_ok(allow_query=bool(route and route[3])):
            raise ApiError(401, "unauthorized", "인증이 필요해요. Lazy - Cut을 다시 열어 주세요.")
        if route is None:
            if allowed:
                raise ApiError(405, "method_not_allowed", "지원하지 않는 요청이에요.")
            raise ApiError(404, "not_found", "없는 기능이에요.")
        name = route[2]
        core = self.server.app
        if name == "peaks":
            p = core.peaks_path(groups[0])
            self._send_file(p, "application/octet-stream", head=(method == "HEAD"), allow_range=False)
            return
        body = self._json_body()
        result = getattr(core, name)(body, *groups)
        payload = {"ok": True}
        if result:
            payload.update(result)
        self._send_json(200, payload, head=(method == "HEAD"))

    # -- media --------------------------------------------------------------------------
    def _handle_media(self, method: str, path: str) -> None:
        self.server.touch()
        if not self._token_ok(allow_query=True):
            raise ApiError(401, "unauthorized", "인증이 필요해요. Lazy - Cut을 다시 열어 주세요.")
        mt = re.fullmatch(r"/media/([A-Za-z0-9_]+)/thumb/(\d+\.jpg)", path)
        if mt and method in ("GET", "HEAD"):
            d = self.server.app.thumbs_dir(mt.group(1))
            f = os.path.join(d, mt.group(2)) if d else None
            if not f or not os.path.isfile(f):
                raise ApiError(404, "not_found", "없는 파일이에요.")
            self._send_file(f, "image/jpeg", head=(method == "HEAD"), allow_range=False)
            return
        m = _MEDIA_RE.fullmatch(path)
        if not m:
            raise ApiError(404, "not_found", "없는 파일이에요.")
        if method not in ("GET", "HEAD"):
            raise ApiError(405, "method_not_allowed", "지원하지 않는 요청이에요.")
        want_proxy = (self._query.get("proxy") or ["0"])[0] in ("1", "true")
        file = self.server.app.media_path(m.group(1), want_proxy)
        self._send_file(file, video_mime(file), head=(method == "HEAD"), allow_range=True)

    # -- static -------------------------------------------------------------------------
    def _handle_static(self, method: str, path: str) -> None:
        web = self.server.web_dir
        if path in ("/", "/index.html"):
            file = os.path.join(web, "index.html")
        elif path == "/test/parity.json":
            file = self.server.parity_path
        elif path == "/favicon.ico":
            file = next((p for p in (os.path.join(web, "favicon.ico"),
                                     os.path.join(web, "img", "favicon.png"),
                                     os.path.join(web, "img", "icon.png"),
                                     os.path.join(config.ROOT_DIR, "assets", "icon.png"))
                         if os.path.isfile(p)), None)
            if file is None:  # avoid a console 404 in the window
                self.send_response(204)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        elif path.startswith(_STATIC_PREFIXES):
            file = safe_join(web, path)
        else:
            file = None
        if not file or not os.path.isfile(file):
            raise ApiError(404, "not_found", "없는 파일이에요.")
        self._send_file(file, guess_mime(file), head=(method == "HEAD"), allow_range=False)

    # -- responses ------------------------------------------------------------------------
    def _send_json(self, status: int, obj, head: bool = False) -> None:
        data = dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def _send_file(self, path: str, ctype: str, head: bool, allow_range: bool) -> None:
        try:
            f = open(path, "rb")
        except FileNotFoundError:
            raise ApiError(404, "not_found", "없는 파일이에요.")
        except PermissionError:
            raise ApiError(403, "no_permission", "파일을 읽을 권한이 없어요.")
        with f:
            size = os.fstat(f.fileno()).st_size
            status, start, end = 200, 0, size - 1
            rng = self.headers.get("Range") if allow_range else None
            if rng:
                try:
                    r = parse_range(rng, size)
                except RangeNotSatisfiable:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    return
                if r is not None:
                    status, (start, end) = 206, r
            length = max(0, end - start + 1)
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if allow_range:
                self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            if head or length == 0:
                return
            f.seek(start)
            remaining = length
            try:
                while remaining > 0:
                    chunk = f.read(min(config.MEDIA_CHUNK, remaining))
                    if not chunk:  # file shrank under us; we can't fix Content-Length now
                        self.close_connection = True
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except _DISCONNECT_ERRORS:
                # The player aborted a range (seek) or the window closed — normal.
                self.close_connection = True


def safe_join(root: str, url_path: str) -> str | None:
    """Map a URL path onto a file inside ``root``; None if it would escape it."""
    rel = urllib.parse.unquote(url_path).lstrip("/")
    if not rel or "\x00" in rel or "\\" in rel:
        return None
    parts = rel.split("/")
    if any(p in ("", ".", "..") or p.startswith(".") for p in parts):
        return None
    root_real = os.path.realpath(root)
    full = os.path.realpath(os.path.join(root_real, *parts))
    if not full.startswith(root_real + os.sep):
        return None
    return full


# --- server ----------------------------------------------------------------------------

class LazyCutServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(self, port: int, token: str | None = None, web_dir: str | None = None):
        self.token = token or secrets.token_urlsafe(24)
        self.web_dir = web_dir or config.WEB_DIR
        self.parity_path = config.PARITY_JSON
        self.last_activity = time.monotonic()
        self.stopping = threading.Event()
        super().__init__(("127.0.0.1", port), Handler)
        self.app = AppCore(self)

    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), which can stall for seconds on macOS.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    @property
    def jobs(self) -> JobManager:
        return self.app.jobs

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def idle_seconds(self) -> float:
        return time.monotonic() - self.last_activity

    def stop(self, delay: float = 0.0) -> None:
        """Stop serve_forever() from another thread (safe to call from a handler)."""
        if self.stopping.is_set():
            return
        self.stopping.set()

        def _later():
            if delay:
                time.sleep(delay)
            self.shutdown()

        threading.Thread(target=_later, name="lazycut-stop", daemon=True).start()

    def close(self) -> None:
        """Cancel jobs and release the socket (after serve_forever returned)."""
        self.stopping.set()
        try:
            self.app.jobs.shutdown(timeout=5.0)
        finally:
            self.server_close()


def bind_server(preferred: int, token: str | None = None, tries: int = config.PORT_TRIES,
                web_dir: str | None = None) -> LazyCutServer:
    """Bind on ``preferred`` or the next free port (up to ``tries`` ports)."""
    last = None
    for port in range(preferred, preferred + max(1, tries)):
        try:
            return LazyCutServer(port, token, web_dir=web_dir)
        except OSError as e:
            if e.errno not in (errno.EADDRINUSE, errno.EACCES):
                raise
            last = e
    raise last or OSError(errno.EADDRINUSE, "no free port")


def start_watchdog(server: LazyCutServer, idle_sec: float | None = None,
                   interval: float = 30.0) -> threading.Thread:
    """Shut the server down after ``idle_sec`` without API/media hits and no active jobs."""
    limit = config.IDLE_SHUTDOWN_SEC if idle_sec is None else idle_sec

    def loop():
        while not server.stopping.wait(interval):
            if server.jobs.active():
                server.touch()  # idle time counts from the end of the last job
                continue
            if server.idle_seconds() >= limit:
                log.info("idle for %.0f s with no jobs — shutting down", server.idle_seconds())
                server.stop()
                return

    t = threading.Thread(target=loop, name="lazycut-watchdog", daemon=True)
    t.start()
    return t
