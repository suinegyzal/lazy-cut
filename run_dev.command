#!/bin/bash
# Run Lazy - Cut straight from this source folder (for development; teammates use install.command).
#
#   ./run_dev.command                 → python -m lazycut (start/reuse the local server, open the window)
#   ./run_dev.command --serve --port 48271 --no-open
#                                     → foreground server with logs in this terminal (Ctrl-C stops it)
#
# Python: $LAZYCUT_PY if set, else ./.venv in this folder.
# Note: an already-running server (e.g. the installed app) is reused by plain `python -m lazycut`;
# quit it first (설정 → Lazy - Cut 종료) to make sure you are running this source tree.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEV_PY="${LAZYCUT_PY:-}"

if [ -x "$DEV_PY" ]; then
  PY="$DEV_PY"
elif [ -x "$ROOT/.venv/bin/python" ]; then
  PY="$ROOT/.venv/bin/python"
else
  echo "개발용 Python을 찾을 수 없어요." >&2
  echo "  $DEV_PY 또는 $ROOT/.venv 가 필요해요." >&2
  echo "  만들기:  /usr/bin/python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi

cd "$ROOT"
export PYTHONPATH="$ROOT"   # the detached server child must import this tree too
export PYTHONUNBUFFERED=1
exec "$PY" -m lazycut "$@"
