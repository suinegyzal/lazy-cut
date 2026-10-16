"""Global app settings and the recent-projects list (JSON files in APP_SUPPORT).

- Known keys are validated/coerced; invalid values are ignored (old value kept).
- Unknown keys are accepted if they are short JSON scalars, so the frontend can
  persist small UI preferences without a server change.
- Writes are atomic (tmp + os.replace) and serialized with a process-wide lock.
"""
from __future__ import annotations

import datetime
import json
import logging
import os
import threading

from . import config

log = logging.getLogger("lazycut.settings")

DEFAULTS = {
    "model": "turbo",
    "lang": "ko",
    "maxChars": 22,
    "silenceMin": 0.15,
    "silenceKeep": 0.0,
    "includeNoise": True,
    "exportQuality": "high",
    "exportResolution": "source",
    "exportSrt": True,
    "exportMap": False,
    "skipDeleted": True,
    "showCaptions": True,
}

MAX_RECENT = 20

_lock = threading.RLock()


def now_iso() -> str:
    """Local time with UTC offset, e.g. 2026-10-08T10:00:00+09:00."""
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# --- validation ----------------------------------------------------------------

class _Invalid(Exception):
    pass


def _as_bool(v):
    if isinstance(v, bool):
        return v
    if v in (0, 1):
        return bool(v)
    raise _Invalid()


def _num(lo, hi, integer=False):
    def conv(v):
        if isinstance(v, bool) or not isinstance(v, (int, float, str)):
            raise _Invalid()
        try:
            x = float(v)
        except ValueError:
            raise _Invalid()
        if x != x or not (lo <= x <= hi):  # NaN or out of range
            raise _Invalid()
        return int(round(x)) if integer else round(x, 3)
    return conv


def _choice(*options):
    def conv(v):
        s = str(v)
        if s not in options:
            raise _Invalid()
        return s
    return conv


def _lang(v):
    if not isinstance(v, str):
        raise _Invalid()
    s = v.strip().lower()
    if not (2 <= len(s) <= 10) or not all(c.isalpha() or c == "-" for c in s):
        raise _Invalid()
    return s


_VALIDATORS = {
    "model": lambda v: _choice(*config.MODEL_REPOS.keys())(v),
    "lang": _lang,
    "maxChars": _num(8, 60, integer=True),
    "silenceMin": _num(0.0, 30.0),
    "silenceKeep": _num(0.0, 30.0),
    "includeNoise": _as_bool,
    "exportQuality": _choice("high", "medium", "small"),
    "exportResolution": _choice("source", "1080", "720"),
    "exportSrt": _as_bool,
    "exportMap": _as_bool,
    "skipDeleted": _as_bool,
    "showCaptions": _as_bool,
}


def _clean_extra(key, value) -> bool:
    """Whether an unknown key/value may be stored."""
    if not isinstance(key, str) or not (0 < len(key) <= 64):
        return False
    if value is None or isinstance(value, (bool, int, float)):
        return True
    return isinstance(value, str) and len(value) <= 1000


def _validated(partial: dict, base: dict) -> dict:
    out = dict(base)
    for k, v in (partial or {}).items():
        conv = _VALIDATORS.get(k)
        if conv is None:
            if _clean_extra(k, v):
                out[k] = v
            continue
        try:
            out[k] = conv(v)
        except _Invalid:
            log.info("ignored invalid setting %s=%r", k, v)
    return out


# --- file helpers ----------------------------------------------------------------

def _read_json(path: str, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except (OSError, ValueError) as e:
        log.warning("could not read %s: %s", path, e)
        return default


def _write_json_atomic(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp%d" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# --- settings API ------------------------------------------------------------------

def load_settings() -> dict:
    with _lock:
        stored = _read_json(config.SETTINGS_FILE, {})
        if not isinstance(stored, dict):
            stored = {}
        return _validated(stored, DEFAULTS)


def save_settings(partial: dict) -> dict:
    """Merge ``partial`` into the stored settings and return the full result."""
    if not isinstance(partial, dict):
        partial = {}
    with _lock:
        merged = _validated(partial, load_settings())
        try:
            _write_json_atomic(config.SETTINGS_FILE, merged)
        except OSError as e:
            log.error("could not save settings: %s", e)
        return merged


# --- recent projects ---------------------------------------------------------------

def _same_path(a: str, b: str) -> bool:
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except (OSError, ValueError):
        return a == b


def _read_recent() -> list:
    data = _read_json(config.RECENT_FILE, [])
    if not isinstance(data, list):
        return []
    return [e for e in data if isinstance(e, dict) and isinstance(e.get("path"), str)]


def recent_list() -> list:
    """Recent projects, newest first, each with a freshly computed ``exists``."""
    with _lock:
        items = _read_recent()
    out = []
    for e in items[:MAX_RECENT]:
        entry = {
            "path": e["path"],
            "name": e.get("name") or os.path.splitext(os.path.basename(e["path"]))[0],
            "duration": e.get("duration"),
            "updatedAt": e.get("updatedAt"),
        }
        entry["exists"] = os.path.isfile(entry["path"])
        out.append(entry)
    return out


def touch_recent(project: dict) -> None:
    """Move/insert ``project`` (by its saved file path) to the top of the list."""
    path = (project or {}).get("file")
    if not path:
        return
    source = project.get("source") or {}
    entry = {
        "path": path,
        "name": project.get("name") or os.path.splitext(os.path.basename(path))[0],
        "duration": source.get("duration"),
        "updatedAt": project.get("updatedAt") or now_iso(),
    }
    with _lock:
        items = [e for e in _read_recent() if not _same_path(e["path"], path)]
        items.insert(0, entry)
        try:
            _write_json_atomic(config.RECENT_FILE, items[:MAX_RECENT])
        except OSError as e:
            log.error("could not save recent list: %s", e)


def remove_recent(path: str) -> None:
    with _lock:
        items = [e for e in _read_recent() if not _same_path(e["path"], path)]
        try:
            _write_json_atomic(config.RECENT_FILE, items)
        except OSError as e:
            log.error("could not save recent list: %s", e)
