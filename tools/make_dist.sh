#!/bin/bash
# Build the team-shareable zip: dist/Lazy-Cut-<version>.zip
#
#   Lazy-Cut-<version>/
#     install.command  uninstall.command  README.md  requirements.txt
#     assets/  lazycut/  web/
#
# Excluded: tests, research, dist, tools, SPEC.md, run_dev.command, __pycache__, *.pyc,
# .DS_Store, web/test. Exec bits of the .command files are preserved in the zip.
#
# Usage: tools/make_dist.sh [--force]
#   --force   build even if some app files from SPEC §1 are missing (warns instead of failing)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  "") ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac

die()  { echo "make_dist: $*" >&2; exit 1; }
warn() { echo "make_dist: warning: $*" >&2; }

cd "$ROOT"
[ -f lazycut/__init__.py ] || die "lazycut/__init__.py is missing"
VERSION="$(sed -n "s/^__version__[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" lazycut/__init__.py | head -n 1)"
[ -n "$VERSION" ] || die "could not read __version__ from lazycut/__init__.py"
NAME="Lazy-Cut-$VERSION"

# --- sanity checks -----------------------------------------------------------------------
for f in install.command uninstall.command README.md README.ko.md requirements.txt assets/icon.icns assets/icon.png; do
  [ -f "$f" ] || die "$f is missing"
done
bash -n install.command || die "install.command has a syntax error"
bash -n uninstall.command || die "uninstall.command has a syntax error"

# App files every release must contain (SPEC §1).
expected=(
  lazycut/__init__.py lazycut/__main__.py lazycut/config.py lazycut/server.py lazycut/jobs.py
  lazycut/dialogs.py lazycut/settings.py lazycut/project.py lazycut/vad.py lazycut/analysis.py
  lazycut/segment.py lazycut/ffmpeg.py lazycut/media.py lazycut/export.py
  lazycut/transcribe_worker.py
  web/index.html web/css/app.css web/css/panels.css
  web/js/util.js web/js/api.js web/js/commands.js web/js/store.js web/js/editor.js
  web/js/shortcuts.js web/js/main.js web/js/player.js web/js/timeline.js web/js/panels.js
)
missing=()
for f in "${expected[@]}"; do [ -f "$f" ] || missing+=("$f"); done
if [ ${#missing[@]} -gt 0 ]; then
  if [ "$FORCE" = "1" ]; then warn "missing app files: ${missing[*]}"
  else die "missing app files (use --force to build anyway): ${missing[*]}"; fi
fi

# Python sources must parse with the team's Python (3.9, /usr/bin/python3) — no 3.10+ syntax.
PYCHECK="/usr/bin/python3"
if xcode-select -p >/dev/null 2>&1 && "$PYCHECK" -c 'import sys' >/dev/null 2>&1; then
  find lazycut -name '*.py' -not -path '*/__pycache__/*' -print0 \
    | xargs -0 "$PYCHECK" -c '
import ast, sys
bad = 0
for f in sys.argv[1:]:
    try:
        ast.parse(open(f, encoding="utf-8").read(), f)
    except SyntaxError as e:
        bad = 1
        print("make_dist: syntax error (Python %d.%d): %s:%s: %s" % (sys.version_info[0], sys.version_info[1], f, e.lineno, e.msg), file=sys.stderr)
sys.exit(bad)
' || die "fix the Python syntax errors above"
else
  warn "skipped the Python 3.9 syntax check (/usr/bin/python3 not available)"
fi

# --- stage --------------------------------------------------------------------------------
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lazycut-dist.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/$NAME"
mkdir -p "$OUT"

EXCLUDES=(--exclude='__pycache__' --exclude='*.pyc' --exclude='.DS_Store' --exclude='tests'
          --exclude='/test' --exclude='icon_preview.png')
cp install.command uninstall.command README.md README.ko.md requirements.txt "$OUT/"
chmod 755 "$OUT/install.command" "$OUT/uninstall.command"
chmod 644 "$OUT/README.md" "$OUT/README.ko.md" "$OUT/requirements.txt"
for d in assets lazycut web; do
  [ -d "$d" ] || continue
  rsync -a "${EXCLUDES[@]}" "$d/" "$OUT/$d/"
done
# Plain read/write permissions for everything else; no extended attributes in the archive.
find "$OUT" -type d -exec chmod 755 {} +
find "$OUT" -type f ! -name '*.command' -exec chmod 644 {} +
xattr -cr "$OUT" 2>/dev/null || true

# --- zip ----------------------------------------------------------------------------------
mkdir -p "$ROOT/dist"
ZIP="$ROOT/dist/$NAME.zip"
rm -f "$ZIP.tmp"
( cd "$STAGE" && COPYFILE_DISABLE=1 zip -q -r -X "$ZIP.tmp" "$NAME" )
mv -f "$ZIP.tmp" "$ZIP"

files="$(zipinfo -1 "$ZIP" | grep -vc '/$' || true)"
size="$(du -h "$ZIP" | awk '{print $1}')"
echo "make_dist: $NAME — $files files, $size" >&2
echo "$ZIP"
