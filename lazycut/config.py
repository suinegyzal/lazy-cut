"""Paths and constants shared by the app shell.

Other modules must read the path constants as attributes at call time
(``config.APP_SUPPORT``), never copy them with ``from config import ...``, so
that ``apply_home()`` (used by tests / the LAZYCUT_HOME env var) takes effect
everywhere.

Env overrides:
  LAZYCUT_HOME  -- if set, APP_SUPPORT / CACHE_ROOT / TMP_DIR / LOG_DIR all live
                   under this directory (for tests and portable runs).
"""
from __future__ import annotations

import os

from . import __version__

VERSION = __version__

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PACKAGE_DIR)  # the LazyCut/ folder (parent of the package)
WEB_DIR = os.path.join(ROOT_DIR, "web")
PARITY_JSON = os.path.join(ROOT_DIR, "tests", "fixtures", "parity.json")

DEFAULT_PORT = 48270
PORT_TRIES = 21  # DEFAULT_PORT .. DEFAULT_PORT + 20
IDLE_SHUTDOWN_SEC = 1800
MAX_BODY_BYTES = 50 * 1024 * 1024
MEDIA_CHUNK = 1024 * 1024

PROJECT_EXT = ".lazycut"
VIDEO_EXTS = ("mov", "mp4", "m4v", "mkv", "avi", "webm", "mts", "m2ts", "mxf")

MODEL_REPOS = {
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
MODEL_SIZE_LABELS = {"turbo": "1.5GB", "large-v3": "3GB"}

CHROME_APPS = (
    "/Applications/Google Chrome.app",
    os.path.expanduser("~/Applications/Google Chrome.app"),
)

# --- user-data paths (recomputed by apply_home) ------------------------------
APP_SUPPORT = ""
CACHE_ROOT = ""
TMP_DIR = ""
LOG_DIR = ""
SERVER_STATE = ""
SETTINGS_FILE = ""
RECENT_FILE = ""
LAUNCH_LOCK = ""
HOME_OVERRIDE = None  # type: str | None


def apply_home(home: str | None = None) -> None:
    """(Re)compute every user-data path. ``home=None`` → standard macOS locations."""
    global APP_SUPPORT, CACHE_ROOT, TMP_DIR, LOG_DIR, SERVER_STATE
    global SETTINGS_FILE, RECENT_FILE, LAUNCH_LOCK, HOME_OVERRIDE
    if home:
        home = os.path.abspath(os.path.expanduser(home))
        APP_SUPPORT = os.path.join(home, "Application Support")
        cache_base = os.path.join(home, "Caches")
        LOG_DIR = os.path.join(home, "Logs")
    else:
        lib = os.path.expanduser("~/Library")
        APP_SUPPORT = os.path.join(lib, "Application Support", "LazyCut")
        cache_base = os.path.join(lib, "Caches", "LazyCut")
        LOG_DIR = os.path.join(lib, "Logs", "LazyCut")
    HOME_OVERRIDE = home or None
    CACHE_ROOT = os.path.join(cache_base, "media")
    TMP_DIR = os.path.join(cache_base, "tmp")
    SERVER_STATE = os.path.join(APP_SUPPORT, "server.json")
    SETTINGS_FILE = os.path.join(APP_SUPPORT, "settings.json")
    RECENT_FILE = os.path.join(APP_SUPPORT, "recent.json")
    LAUNCH_LOCK = os.path.join(APP_SUPPORT, "launch.lock")


apply_home(os.environ.get("LAZYCUT_HOME") or None)


def ensure_dirs() -> None:
    """Create the app's own data folders (never touches user media)."""
    for d in (APP_SUPPORT, CACHE_ROOT, TMP_DIR, LOG_DIR):
        os.makedirs(d, exist_ok=True)


def child_env(base: dict | None = None) -> dict:
    """Environment for our own Python subprocesses (server, transcription worker):
    ROOT_DIR first on PYTHONPATH (deduplicated) so ``-m lazycut...`` imports this tree."""
    env = dict(os.environ if base is None else base)
    parts = [p for p in (env.get("PYTHONPATH") or "").split(os.pathsep) if p and p != ROOT_DIR]
    env["PYTHONPATH"] = os.pathsep.join([ROOT_DIR] + parts)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def hf_hub_cache() -> str:
    """Hugging Face hub cache dir, resolved the same way huggingface_hub does
    (without importing it — that import is slow and pulls in torch-adjacent deps)."""
    for var in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        v = os.environ.get(var)
        if v:
            return os.path.expanduser(v)
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return os.path.join(os.path.expanduser(hf_home), "hub")
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = os.path.expanduser(xdg) if xdg else os.path.expanduser("~/.cache")
    return os.path.join(base, "huggingface", "hub")


_WEIGHT_SUFFIXES = (".safetensors", ".npz")


def model_downloaded(model: str) -> bool:
    """True if the model's weights are fully present in the HF cache.

    Layout: <hub>/models--<org>--<name>/snapshots/<rev>/weights.(safetensors|npz),
    where snapshot files are symlinks into blobs/ (os.path.isfile follows them, so a
    dangling link from an interrupted download counts as missing)."""
    repo = MODEL_REPOS.get(model)
    if not repo:
        return False
    snap_root = os.path.join(hf_hub_cache(), "models--" + repo.replace("/", "--"), "snapshots")
    try:
        revisions = os.listdir(snap_root)
    except OSError:
        return False
    for rev in revisions:
        d = os.path.join(snap_root, rev)
        try:
            names = os.listdir(d)
        except OSError:
            continue
        if "config.json" not in names:
            continue
        for n in names:
            if n.endswith(_WEIGHT_SUFFIXES):
                p = os.path.join(d, n)
                try:
                    if os.path.isfile(p) and os.path.getsize(p) > 1024 * 1024:
                        return True
                except OSError:
                    pass
    return False
