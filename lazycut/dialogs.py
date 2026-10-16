"""Native macOS file dialogs via osascript.

Every function returns a POSIX path, or None if the user canceled (or the dialog
failed / timed out after 600 s). User-provided strings are passed as osascript
``argv`` items — never spliced into the script source — so quotes or
backslashes in names cannot break or inject AppleScript.

Bringing the dialog to the front: ``activate`` without a ``tell`` target
activates osascript itself, which needs no Automation/Accessibility permission
(unlike ``tell application "System Events" to activate``, which is not allowed).
"""
from __future__ import annotations

import logging
import os
import subprocess

from . import config

log = logging.getLogger("lazycut.dialogs")

TIMEOUT_SEC = 600
_USER_CANCELED = "-128"


def _type_list(exts) -> str:
    # Our own constants only (safe to inline into the script).
    return "{" + ", ".join('"%s"' % e for e in exts) + "}"


def _run(script_lines: list, args: list) -> str | None:
    cmd = ["osascript"]
    for line in script_lines:
        cmd += ["-e", line]
    cmd += [str(a) for a in args]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        log.warning("dialog timed out after %ss", TIMEOUT_SEC)
        return None
    except OSError as e:
        log.error("osascript failed to start: %s", e)
        return None
    if p.returncode != 0:
        if _USER_CANCELED not in (p.stderr or ""):
            log.warning("osascript error (%s): %s", p.returncode, (p.stderr or "").strip())
        return None
    out = (p.stdout or "").strip()
    return out or None


def _choose_file(prompt: str, exts=None) -> str | None:
    type_clause = (" of type " + _type_list(exts)) if exts else ""
    script = [
        "on run argv",
        "activate",
        "set f to choose file with prompt (item 1 of argv)" + type_clause,
        "return POSIX path of f",
        "end run",
    ]
    return _run(script, [prompt])


def choose_video() -> str | None:
    return _choose_file("편집할 영상을 골라 주세요", config.VIDEO_EXTS)


def choose_project() -> str | None:
    return _choose_file("열 프로젝트(.lazycut)를 골라 주세요", (config.PROJECT_EXT.lstrip("."),))


def choose_any(prompt: str) -> str | None:
    return _choose_file(prompt or "파일을 골라 주세요")


def choose_save(default_name: str, default_dir: str | None = None) -> str | None:
    """Save panel. The system panel itself asks before replacing an existing file."""
    name = (default_name or "").strip() or "Lazy - Cut 내보내기"
    folder = default_dir if default_dir and os.path.isdir(default_dir) else ""
    script = [
        "on run argv",
        "activate",
        "set p to item 1 of argv",
        "set n to item 2 of argv",
        "set d to item 3 of argv",
        "if d is \"\" then",
        "set f to choose file name with prompt p default name n",
        "else",
        "set f to choose file name with prompt p default name n default location (POSIX file d as alias)",
        "end if",
        "return POSIX path of f",
        "end run",
    ]
    return _run(script, ["저장할 위치를 골라 주세요", name, folder])


def alert(message: str, title: str = "Lazy - Cut") -> None:
    """Blocking error alert, used by the launcher when the app can't start (no window yet)."""
    script = [
        "on run argv",
        "activate",
        "display alert (item 1 of argv) message (item 2 of argv) as critical",
        "end run",
    ]
    _run(script, [title, message])
