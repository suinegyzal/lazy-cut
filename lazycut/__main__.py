"""Entry point: ``python -m lazycut``.

Modes:
  (default)   launcher — reuse a live server (server.json + /api/health) or start
              one detached, then open the app window and exit.
  --serve     run the HTTP server in this process (foreground; logs also go to stderr).
  --port N    preferred port (default 48270; the next free one up to +20 is used).
  --no-open   don't open a window (launcher: just make sure the server runs).
  --version   print the version.
  --daemon    (internal) set by the launcher for the detached server: no stderr log
              handler, because its stdout/stderr already go to server.log.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import logging
import logging.handlers
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request

from . import __version__, config

log = logging.getLogger("lazycut.main")

HEALTH_TIMEOUT = 1.0
START_TIMEOUT = 20.0


# --- logging -----------------------------------------------------------------------

def setup_logging(log_name: str = "server.log", stderr: bool = False) -> None:
    root = logging.getLogger("lazycut")
    if getattr(root, "_lazycut_configured", False):
        return
    level = logging.DEBUG if os.environ.get("LAZYCUT_DEBUG") else logging.INFO
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(threadName)s] %(message)s")
    try:
        os.makedirs(config.LOG_DIR, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            os.path.join(config.LOG_DIR, log_name), maxBytes=1_000_000, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        root.addHandler(fh)
    except OSError as e:
        print("Lazy - Cut: 로그 파일을 열 수 없어요: %s" % e, file=sys.stderr)
    if stderr:
        sh = logging.StreamHandler(sys.stderr)
        sh.setFormatter(fmt)
        root.addHandler(sh)
    root.propagate = False
    root._lazycut_configured = True


# --- server.json ---------------------------------------------------------------------

def read_state() -> dict | None:
    try:
        with open(config.SERVER_STATE, "r", encoding="utf-8") as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict) or not isinstance(st.get("port"), int) or not st.get("token"):
        return None
    return st


def write_state(state: dict) -> None:
    """Atomic write with mode 600 (the token grants full API access)."""
    os.makedirs(os.path.dirname(config.SERVER_STATE), exist_ok=True)
    tmp = "%s.tmp%d" % (config.SERVER_STATE, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, config.SERVER_STATE)


def remove_state_if_ours() -> None:
    st = read_state()
    if st and st.get("pid") == os.getpid():
        with contextlib.suppress(OSError):
            os.remove(config.SERVER_STATE)


def window_url(state: dict) -> str:
    return "http://127.0.0.1:%d/?t=%s" % (state["port"], state["token"])


def health_ok(state: dict, timeout: float = HEALTH_TIMEOUT) -> bool:
    url = "http://127.0.0.1:%d/api/health" % state["port"]
    req = urllib.request.Request(url, headers={"X-LazyCut-Token": state["token"]})
    # Never route localhost through a system/env proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        return bool(data.get("ok"))
    except Exception:  # noqa: BLE001 — anything means "not alive"
        return False


# --- window ---------------------------------------------------------------------------

def open_window(url: str) -> None:
    """Chrome in app mode (no tabs/address bar) if installed, else the default browser."""
    chrome = next((p for p in config.CHROME_APPS if os.path.isdir(p)), None)
    if chrome:
        cmd = ["open", "-na", chrome, "--args", "--app=" + url, "--window-size=1500,920"]
    else:
        cmd = ["open", url]
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        log.error("could not open window: %s", e)


# --- launcher -------------------------------------------------------------------------

@contextlib.contextmanager
def _launch_lock():
    """Serialize concurrent launches (double-clicks) so only one server gets spawned."""
    import fcntl
    os.makedirs(os.path.dirname(config.LAUNCH_LOCK), exist_ok=True)
    with open(config.LAUNCH_LOCK, "a") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def spawn_server(port: int | None = None) -> subprocess.Popen:
    args = [sys.executable, "-m", "lazycut", "--serve", "--no-open", "--daemon"]
    if port:
        args += ["--port", str(port)]
    os.makedirs(config.LOG_DIR, exist_ok=True)
    with open(os.path.join(config.LOG_DIR, "server.log"), "ab") as out:
        return subprocess.Popen(args, cwd=config.ROOT_DIR, env=config.child_env(), stdin=subprocess.DEVNULL,
                                stdout=out, stderr=out, start_new_session=True, close_fds=True)


def wait_for_server(proc: subprocess.Popen, timeout: float = START_TIMEOUT) -> dict | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        st = read_state()
        if st and st.get("pid") == proc.pid and health_ok(st):
            return st
        if proc.poll() is not None:
            log.error("server exited early with code %s", proc.returncode)
            return None
        time.sleep(0.2)
    return None


def _api(state: dict, method: str, path: str, timeout: float = 2.0) -> dict | None:
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (state["port"], path), method=method,
                                 data=b"{}" if method == "POST" else None,
                                 headers={"X-LazyCut-Token": state["token"], "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _replace_outdated(state: dict) -> bool:
    """After an app update, stop an old idle server so the new code is used.
    Returns True if the old server is gone (caller should spawn a new one)."""
    if state.get("version") == __version__:
        return False
    boot = _api(state, "GET", "/api/bootstrap")
    if boot and boot.get("jobs"):
        log.info("old server %s is busy; reusing it", state.get("version"))
        return False
    log.info("stopping old server %s (we are %s)", state.get("version"), __version__)
    _api(state, "POST", "/api/shutdown")
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if not health_ok(state, timeout=0.5):
            return True
        time.sleep(0.2)
    return False


def launch(port: int | None = None, no_open: bool = False) -> int:
    config.ensure_dirs()
    setup_logging("launcher.log")
    with _launch_lock():
        st = read_state()
        if st and health_ok(st) and not _replace_outdated(st):
            log.info("reusing server on port %s", st["port"])
        else:
            proc = spawn_server(port)
            log.info("spawned server pid %s", proc.pid)
            st = wait_for_server(proc)
    if not st:
        msg = ("Lazy - Cut을 시작하지 못했어요. 잠시 후 다시 열어 보세요.\n"
               "계속 안 되면 이 로그를 팀에 보내 주세요:\n%s" % os.path.join(config.LOG_DIR, "server.log"))
        print(msg, file=sys.stderr)
        if not no_open and not sys.stderr.isatty():  # started from Finder: no terminal to read it
            from . import dialogs
            dialogs.alert(msg)
        return 1
    url = window_url(st)
    if no_open:
        print(url)
    else:
        open_window(url)
    return 0


# --- server ----------------------------------------------------------------------------

def serve(port: int | None = None, no_open: bool = False, daemon: bool = False) -> int:
    config.ensure_dirs()
    setup_logging("server.log", stderr=not daemon)
    from .server import bind_server, start_watchdog

    token = secrets.token_urlsafe(24)
    try:
        server = bind_server(port or config.DEFAULT_PORT, token)
    except OSError as e:
        log.error("could not bind a port: %s", e)
        return 1
    state = {"port": server.server_port, "token": token, "pid": os.getpid(), "version": __version__}
    write_state(state)

    def on_signal(signum, frame):
        if server.stopping.is_set():  # second Ctrl+C: stop waiting for jobs
            remove_state_if_ours()
            os._exit(1)
        log.info("signal %s — shutting down", signum)
        server.stop()

    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    start_watchdog(server)
    url = window_url(state)
    log.info("Lazy - Cut %s listening on 127.0.0.1:%d (pid %d)", __version__, server.server_port, os.getpid())
    if not daemon:
        print("Lazy - Cut 서버가 켜졌어요: %s" % url, flush=True)
    if not no_open:
        threading.Timer(0.3, open_window, args=(url,)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        try:
            server.close()
        finally:
            remove_state_if_ours()
            log.info("server stopped")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="lazycut", description="Lazy - Cut — 텍스트로 하는 컷 편집")
    ap.add_argument("--serve", action="store_true", help="이 터미널에서 서버를 실행해요")
    ap.add_argument("--port", type=int, default=None, help="사용할 포트 (기본 %d)" % config.DEFAULT_PORT)
    ap.add_argument("--no-open", action="store_true", help="창을 열지 않아요")
    ap.add_argument("--version", action="store_true", help="버전을 보여 줘요")
    ap.add_argument("--daemon", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.port is not None and not (1024 <= args.port <= 65535):
        ap.error("포트는 1024~65535 사이여야 해요")
    if args.serve:
        return serve(args.port, no_open=args.no_open, daemon=args.daemon)
    return launch(args.port, no_open=args.no_open)


if __name__ == "__main__":
    sys.exit(main())
