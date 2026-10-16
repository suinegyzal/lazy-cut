#!/bin/bash
# Lazy - Cut installer / updater for team Macs (Apple Silicon, macOS 13.5+).
#
# Double-click in Finder (right-click → Open the first time) or run `bash install.command`.
# Builds "${LAZYCUT_APP_DIR:-$HOME/Applications}/Lazy - Cut.app":
#   Contents/Info.plist
#   Contents/MacOS/lazycut          bash launcher → Resources/venv/bin/python -m lazycut
#   Contents/Resources/app/         lazycut/ + web/ (no tests, no __pycache__)
#   Contents/Resources/icon.icns
#   Contents/Resources/venv/        private Python venv (built from /usr/bin/python3)
# Re-running = update: app files are replaced, the venv is kept when requirements.txt and
# python3 are unchanged (hash in venv/.req-hash) and it still imports, otherwise rebuilt
# (the old venv is restored if the rebuild fails).
#
# Optional environment:
#   LAZYCUT_APP_DIR=<dir>         install location (default ~/Applications)
#   LAZYCUT_NONINTERACTIVE=1      never ask; use defaults
#   LAZYCUT_DOWNLOAD_MODEL=0|1    pre-download the speech model when non-interactive (default 1)
#   LAZYCUT_NO_OPEN=1             don't open the app at the end
#   LAZYCUT_LOG_DIR=<dir>         where install.log goes (default ~/Library/Logs/LazyCut)

set -Eeuo pipefail

# Terminal running under Rosetta on an Apple Silicon Mac → restart natively as arm64,
# otherwise pip would pick x86_64 wheels.
if [ "$(uname -m)" != "arm64" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ] \
   && [ -z "${LAZYCUT_REEXEC:-}" ]; then
  export LAZYCUT_REEXEC=1
  exec /usr/bin/arch -arm64 /bin/bash "${BASH_SOURCE[0]}" "$@"
fi

# ---------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_NAME="Lazy - Cut"
BUNDLE_ID="com.teamjcurve.lazy.cut"
MIN_MACOS="13.5"
BASE_PY="/usr/bin/python3"
MODEL_REPO="mlx-community/whisper-large-v3-turbo"
VENV_LAYOUT=1                       # bump to force a venv rebuild on every Mac

APP_DIR="${LAZYCUT_APP_DIR:-$HOME/Applications}"
bundle_paths() {  # derived from APP_DIR (recomputed once APP_DIR is resolved)
  APP="$APP_DIR/$APP_NAME.app"
  CONTENTS="$APP/Contents"
  RES="$CONTENTS/Resources"
  VENV="$RES/venv"
  VENV_OLD="$RES/venv.old"
  VPY="$VENV/bin/python"
}
bundle_paths
STATE_FILE="$HOME/Library/Application Support/LazyCut/server.json"
# LAZYCUT_HOME relocates the app's data folders (see lazycut/config.py) — follow it.
[ -n "${LAZYCUT_HOME:-}" ] && STATE_FILE="$LAZYCUT_HOME/Application Support/server.json"
LOG_DIR="${LAZYCUT_LOG_DIR:-$HOME/Library/Logs/LazyCut}"
LOG_FILE="$LOG_DIR/install.log"

INTERACTIVE=1
[ "${LAZYCUT_NONINTERACTIVE:-0}" = "1" ] && INTERACTIVE=0

unset PYTHONPATH PYTHONHOME          # never let a user's Python setup leak into the build
export PIP_NO_INPUT=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1

# ---------------------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; BLUE=$'\033[38;5;27m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; R=$'\033[0m'; TTY=1
else
  B=""; D=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; R=""; TTY=0
fi
STEP=0
TOTAL_STEPS=7

mkdir -p "$LOG_DIR" 2>/dev/null || { LOG_DIR="${TMPDIR:-/tmp}"; LOG_FILE="$LOG_DIR/lazycut-install.log"; }
log()  { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE" 2>/dev/null || true; }
step() { STEP=$((STEP + 1)); printf '\n%s[%d/%d] %s%s\n' "$B$BLUE" "$STEP" "$TOTAL_STEPS" "$1" "$R"; log "== [$STEP/$TOTAL_STEPS] $1"; }
info() { printf '      %s\n' "$*"; log "   $*"; }
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$R" "$*"; log " ok $*"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$R" "$*"; log " warn $*"; }
fail() {  # fail "headline" ["detail line" ...]
  printf '\n%s✗ %s%s\n' "$B$RED" "$1" "$R"; log "FAIL $1"
  shift
  local line; for line in "$@"; do printf '  %s\n' "$line"; log "     $line"; done
  printf '\n  %s설치 기록: %s%s\n\n' "$D" "$LOG_FILE" "$R"
  exit 1
}

# ask_yes_no "question" y|n  → 0 = yes. Non-interactive (or no answer) → the default.
ask_yes_no() {
  local question="$1" def="$2" hint ans
  if [ "$def" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$INTERACTIVE" != "1" ]; then
    if [ "$def" = "y" ]; then return 0; else return 1; fi
  fi
  printf '      %s%s%s %s ' "$B" "$question" "$R" "$hint"
  if ! IFS= read -r ans; then ans=""; echo; fi
  log "   ask: $question → '${ans}'"
  case "$ans" in
    [Yy]*|ㅛ*|예*|네*|응*) return 0 ;;   # ㅛ/ㅜ = y/n typed on a Korean keyboard layout
    [Nn]*|ㅜ*|아니*)       return 1 ;;
    *) if [ "$def" = "y" ]; then return 0; else return 1; fi ;;
  esac
}

fmt_duration() { local s=$1; if [ "$s" -ge 60 ]; then printf '%d분 %d초' $((s / 60)) $((s % 60)); else printf '%d초' "$s"; fi; }

# rm -rf only ever inside our own app bundle (half-built venv, staging folders).
safe_rm_rf() {
  case "$1" in
    *"/$APP_NAME.app/Contents/Resources/"?*) rm -rf "$1" ;;
    *) log "refused to remove $1" ;;
  esac
}

# ---------------------------------------------------------------------------------------
# Cleanup: roll back a half-built venv / staging dirs on error or Ctrl-C
# ---------------------------------------------------------------------------------------
VENV_BUILDING=0
APP_STAGE=""
cleanup() {
  local code=$?
  if [ "$VENV_BUILDING" = "1" ]; then
    log "rolling back venv"
    [ -d "$VENV" ] && safe_rm_rf "$VENV"
    if [ -d "$VENV_OLD" ]; then mv "$VENV_OLD" "$VENV" 2>/dev/null || true; fi
  fi
  if [ -n "$APP_STAGE" ] && [ -d "$APP_STAGE" ]; then safe_rm_rf "$APP_STAGE"; fi
  log "exit $code"
}
on_error() {
  local code=$? line=$1
  trap - ERR
  log "ERROR at line $line (exit $code)"
  printf '\n%s✗ 설치를 끝내지 못했어요.%s\n' "$B$RED" "$R"
  printf '  인터넷 연결을 확인하고 install.command를 다시 실행해 보세요.\n'
  printf '  계속 안 되면 아래 기록 파일을 팀에 보내 주세요.\n'
  printf '\n  %s설치 기록: %s%s\n\n' "$D" "$LOG_FILE" "$R"
  exit "$code"
}
trap cleanup EXIT
trap 'on_error $LINENO' ERR
trap 'printf "\n"; warn "설치를 멈췄어요. 다시 실행하면 이어서 할 수 있어요."; exit 130' INT TERM

# ---------------------------------------------------------------------------------------
# Running-server handling (an update must not swap files under a live server)
# ---------------------------------------------------------------------------------------
# Prints "pid port token" of the server recorded in server.json if it's alive, else nothing.
# Always returns 0: it runs inside $(...), where a failing command would trip the ERR trap.
running_server() {
  [ -f "$STATE_FILE" ] || return 0
  local pid port token
  pid="$(plutil -extract pid raw -o - "$STATE_FILE" 2>/dev/null || true)"
  port="$(plutil -extract port raw -o - "$STATE_FILE" 2>/dev/null || true)"
  token="$(plutil -extract token raw -o - "$STATE_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  printf '%s %s %s\n' "$pid" "$port" "$token"
}

# True if that server runs from THIS bundle (the launcher exports PYTHONPATH=<bundle>/Resources/app;
# fall back to open files). A server started from source or another copy is left alone.
server_is_ours() {
  local pid="$1"
  case "$(ps -E -ww -o command= -p "$pid" 2>/dev/null || true)" in
    *"PYTHONPATH=$RES/app"*) return 0 ;;
  esac
  lsof -a -p "$pid" -Fn 2>/dev/null | grep -qF "$RES/" && return 0
  return 1
}

# Ask the server to quit (POST /api/shutdown), then TERM/KILL if it doesn't.
stop_server() {
  local pid="$1" port="$2" token="$3" i
  if [ -n "$port" ] && [ -n "$token" ]; then
    curl -s -m 3 --noproxy '*' -o /dev/null -X POST \
      -H "X-LazyCut-Token: $token" -H "Content-Type: application/json" --data '{}' \
      "http://127.0.0.1:$port/api/shutdown" 2>/dev/null || true
  fi
  for i in $(seq 1 24); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 12); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.3
  ! kill -0 "$pid" 2>/dev/null
}

# ---------------------------------------------------------------------------------------
printf '\n%s  Lazy - Cut 설치%s  %s(한눈에 보는 자막·컷편집, 이 Mac 안에서만 동작해요)%s\n' "$B" "$R" "$D" "$R"
log "===== install start: src=$SRC app=$APP interactive=$INTERACTIVE"
START_TS=$SECONDS

# ---------------------------------------------------------------------------------------
step "이 Mac 확인하기"
# ---------------------------------------------------------------------------------------
if [ "$(uname -m)" != "arm64" ]; then
  fail "이 Mac에서는 Lazy - Cut을 쓸 수 없어요." \
       "Lazy - Cut은 Apple Silicon(M1·M2·M3·M4…) Mac에서만 돌아가요." \
       "음성인식을 Apple Silicon 전용 엔진(MLX)으로 돌리기 때문이에요." \
       "확인: 애플 메뉴() → 이 Mac에 관하여 → ‘칩’ 항목이 ‘Apple M…’인지 봐 주세요."
fi
MACOS_VER="$(sw_vers -productVersion 2>/dev/null || echo 0)"
mac_major="${MACOS_VER%%.*}"
mac_minor="$(printf '%s' "$MACOS_VER" | cut -d. -f2)"; mac_minor="${mac_minor:-0}"
case "$mac_major$mac_minor" in *[!0-9]*) mac_major=0; mac_minor=0 ;; esac
if [ "$mac_major" -lt 13 ] || { [ "$mac_major" -eq 13 ] && [ "$mac_minor" -lt 5 ]; }; then
  fail "macOS $MIN_MACOS 이상이 필요해요 (지금: $MACOS_VER)." \
       "시스템 설정 → 일반 → 소프트웨어 업데이트에서 macOS를 올린 뒤 다시 실행해 주세요."
fi
ok "Apple Silicon · macOS $MACOS_VER"

mkdir -p "$APP_DIR" 2>/dev/null || fail "설치 폴더를 만들 수 없어요: $APP_DIR"
# Resolve symlinks so paths match what the launcher sees at runtime (Apple's Python keys its
# bytecode cache by absolute source path).
APP_DIR="$(cd "$APP_DIR" && pwd -P)"
bundle_paths
FREE_KB="$(df -Pk "$APP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
FREE_KB="${FREE_KB:-0}"
FREE_GB="$(awk -v k="$FREE_KB" 'BEGIN { printf "%.1f", k / 1048576 }')"
if [ "$FREE_KB" -lt 1572864 ]; then
  fail "저장 공간이 부족해요 (남은 공간 ${FREE_GB}GB)." \
       "프로그램에 약 1GB, 음성인식 모델에 약 1.5GB가 필요해요. 공간을 비운 뒤 다시 실행해 주세요."
elif [ "$FREE_KB" -lt 4194304 ]; then
  warn "남은 공간이 ${FREE_GB}GB예요. 모델까지 받으려면 4GB 정도 여유가 있으면 좋아요."
else
  ok "남은 저장 공간 ${FREE_GB}GB"
fi

# ---------------------------------------------------------------------------------------
step "Python 확인하기"
# ---------------------------------------------------------------------------------------
# /usr/bin/python3 is a stub until Apple's Command Line Tools are installed; check first so
# the stub doesn't pop its own dialog in the middle of the install.
if ! xcode-select -p >/dev/null 2>&1; then
  warn "Python을 쓰려면 Apple ‘명령어 도구(Command Line Tools)’가 필요해요. 설치 창을 띄울게요."
  xcode-select --install >/dev/null 2>&1 || true
  fail "명령어 도구를 먼저 설치해 주세요." \
       "방금 뜬 창에서 [설치]를 누르고, 설치가 끝나면(5~15분) install.command를 다시 실행해 주세요." \
       "창이 안 보이면 터미널에서  xcode-select --install  을 입력해 주세요."
fi
# (`|| exit $?` keeps a failure away from the ERR trap that $(...) inherits via set -E)
if ! PY_INFO="$("$BASE_PY" -c 'import sys, venv, ensurepip; print("%d.%d.%d" % sys.version_info[:3]); print(sys.executable); print(getattr(sys, "pycache_prefix", None) or "")' 2>&1 || exit $?)"; then
  log "$PY_INFO"
  case "$PY_INFO" in
    *icense*)
      fail "Xcode 사용권 계약에 동의해야 Python을 쓸 수 있어요." \
           "터미널에서  sudo xcodebuild -license  를 실행해 동의한 뒤 다시 실행해 주세요." ;;
    *)
      fail "python3를 실행하지 못했어요." \
           "명령어 도구가 덜 설치됐을 수 있어요. 터미널에서  xcode-select --install  을 실행한 뒤 다시 해 주세요." \
           "오류: $(printf '%s' "$PY_INFO" | tail -n 1)" ;;
  esac
fi
PY_VERSION="$(printf '%s\n' "$PY_INFO" | sed -n 1p)"
PY_EXE="$(printf '%s\n' "$PY_INFO" | sed -n 2p)"
# Apple's python3 writes all bytecode under ~/Library/Caches/com.apple.python/<abs path>.
PYC_PREFIX="$(printf '%s\n' "$PY_INFO" | sed -n 3p)"
py_major="${PY_VERSION%%.*}"; py_minor="$(printf '%s' "$PY_VERSION" | cut -d. -f2)"
if [ "$py_major" != "3" ] || [ "${py_minor:-0}" -lt 9 ]; then
  fail "Python 3.9 이상이 필요해요 (지금: $PY_VERSION)." \
       "소프트웨어 업데이트로 명령어 도구(Command Line Tools)를 최신으로 올린 뒤 다시 실행해 주세요."
fi
ok "Python $PY_VERSION"
[ "$py_minor" = "9" ] || warn "검증된 버전은 Python 3.9예요. 다른 버전이라 설치가 조금 다를 수 있어요."

# ---------------------------------------------------------------------------------------
step "설치 위치 준비하기"
# ---------------------------------------------------------------------------------------
[ -f "$SRC/lazycut/__init__.py" ] || fail "앱 파일(lazycut 폴더)을 찾을 수 없어요." \
  "압축을 푼 폴더 안에 있는 install.command를 실행해 주세요." "지금 위치: $SRC"
[ -f "$SRC/requirements.txt" ] || fail "requirements.txt 파일이 없어요." "압축을 다시 풀고 실행해 주세요."
VERSION="$(sed -n "s/^__version__[[:space:]]*=[[:space:]]*[\"']\([^\"']*\)[\"'].*/\1/p" "$SRC/lazycut/__init__.py" | head -n 1)"
VERSION="${VERSION:-0.0.0}"
missing=""
for f in lazycut/__main__.py web/index.html assets/icon.icns; do
  [ -e "$SRC/$f" ] || missing="$missing $f"
done
[ -z "$missing" ] || warn "빠진 파일이 있어요:$missing (개발 중인 폴더라면 괜찮아요)"

if [ -d "$APP" ]; then
  old_id="$(plutil -extract CFBundleIdentifier raw -o - "$CONTENTS/Info.plist" 2>/dev/null || true)"
  if [ -n "$old_id" ] && [ "$old_id" != "$BUNDLE_ID" ]; then
    fail "같은 이름의 다른 앱이 이미 있어요: $APP" "그 앱의 이름을 바꾸거나 옮긴 뒤 다시 실행해 주세요."
  fi
  old_ver="$(plutil -extract CFBundleShortVersionString raw -o - "$CONTENTS/Info.plist" 2>/dev/null || echo "?")"
  if [ "$old_ver" = "$VERSION" ]; then ok "이미 설치된 Lazy - Cut $VERSION을 새 파일로 다시 맞출게요"
  else ok "이미 설치된 Lazy - Cut($old_ver)을 $VERSION 버전으로 업데이트할게요"; fi
else
  ok "새로 설치해요: $APP"
fi

server_line="$(running_server)"
if [ -n "$server_line" ]; then
  read -r s_pid s_port s_token <<<"$server_line"
  if server_is_ours "$s_pid"; then
    info "Lazy - Cut이 지금 열려 있어요. 업데이트하려면 잠깐 꺼야 해요 (편집 내용은 자동 저장돼요)."
    if ! ask_yes_no "Lazy - Cut을 끄고 계속할까요?" y; then
      fail "설치를 멈췄어요." "Lazy - Cut 창을 닫고(설정 → Lazy - Cut 종료) 다시 실행해 주세요."
    fi
    if stop_server "$s_pid" "$s_port" "$s_token"; then ok "실행 중이던 Lazy - Cut을 껐어요"
    else fail "실행 중인 Lazy - Cut을 끄지 못했어요." "Mac을 다시 시작한 뒤 install.command를 다시 실행해 주세요."; fi
  fi
fi
mkdir -p "$CONTENTS/MacOS" "$RES"

# ---------------------------------------------------------------------------------------
step "필요한 프로그램 설치하기 (Python 패키지)"
# ---------------------------------------------------------------------------------------
REQ_HASH="$( { cat "$SRC/requirements.txt"; printf 'python=%s\nexe=%s\nlayout=%s\narch=%s\n' \
  "$PY_VERSION" "$PY_EXE" "$VENV_LAYOUT" "$(uname -m)"; } | shasum -a 256 | awk '{print $1}')"

venv_ok() {  # the existing venv is reusable: same hash and the key modules still import
  [ -x "$VPY" ] || return 1
  [ "$(cat "$VENV/.req-hash" 2>/dev/null || true)" = "$REQ_HASH" ] || return 1
  "$VPY" -c 'import mlx_whisper, imageio_ffmpeg, numpy, os, sys
sys.exit(0 if os.access(imageio_ffmpeg.get_ffmpeg_exe(), os.X_OK) else 1)' >>"$LOG_FILE" 2>&1
}

# Shows pip's progress as one friendly line (a running list when not on a terminal).
pip_progress() {
  local line n=0 name size
  while IFS= read -r line; do
    printf '%s\n' "$line" >>"$LOG_FILE"
    case "$line" in
      Collecting\ *)
        n=$((n + 1)); name="${line#Collecting }"; name="${name%% *}"; name="${name/==/ }"
        if [ "$TTY" = "1" ]; then printf '\r\033[K      %s· 준비 중 (%d) %s%s' "$D" "$n" "$name" "$R"
        else printf '      · %s\n' "$name"; fi ;;
      *Downloading\ *MB\)*)
        if [ "$TTY" = "1" ]; then size="${line##*(}"; printf '%s  ↓ %s%s' "$D" "${size%)}" "$R"; fi ;;
      Installing\ collected\ packages*)
        [ "$TTY" = "1" ] && printf '\r\033[K'
        printf '      설치하는 중… (1~3분 걸려요)\n' ;;
      "ERROR: Ignored the following versions"*) ;;   # long, harmless noise
      ERROR:*|error:*)
        [ "$TTY" = "1" ] && printf '\r\033[K'
        if [ ${#line} -gt 160 ]; then line="${line:0:160}…"; fi
        printf '      %s%s%s\n' "$RED" "$line" "$R" ;;
    esac
  done
  [ "$TTY" = "1" ] && printf '\r\033[K'
  return 0
}

if venv_ok; then
  ok "이미 설치돼 있어요 (바뀐 게 없어서 그대로 써요)"
else
  if [ -d "$VENV" ]; then
    info "구성이 바뀌어서 새로 설치할게요."
    [ -d "$VENV_OLD" ] && safe_rm_rf "$VENV_OLD"
    mv "$VENV" "$VENV_OLD"
  fi
  # drop the old venv's bytecode mirror (it would only go stale)
  if [ -n "$PYC_PREFIX" ] && [ -d "$PYC_PREFIX$VENV" ]; then safe_rm_rf "$PYC_PREFIX$VENV"; fi
  VENV_BUILDING=1
  venv_start=$SECONDS
  info "인터넷에서 약 300MB를 받아요. 처음에는 5~15분쯤 걸릴 수 있어요."
  log "creating venv with $BASE_PY ($PY_EXE)"
  "$BASE_PY" -m venv "$VENV" >>"$LOG_FILE" 2>&1 || fail "Python 가상환경을 만들지 못했어요."
  # The CLT ships an old pip; a current one handles today's wheels better (best effort).
  "$VPY" -m pip install --upgrade pip >>"$LOG_FILE" 2>&1 || warn "pip 업데이트는 건너뛰었어요."
  pip_status=0
  "$VPY" -m pip install --prefer-binary -r "$SRC/requirements.txt" 2>&1 | pip_progress || pip_status=$?
  if [ "$pip_status" -ne 0 ]; then
    fail "프로그램을 내려받지 못했어요." \
         "인터넷 연결을 확인하고 install.command를 다시 실행해 주세요." \
         "회사 네트워크(프록시)라면 다른 와이파이에서 해 보세요."
  fi
  if ! "$VPY" -c 'import mlx_whisper, imageio_ffmpeg, numpy' >>"$LOG_FILE" 2>&1; then
    fail "설치한 프로그램이 제대로 열리지 않아요." "install.command를 한 번 더 실행해 주세요."
  fi
  printf '%s\n' "$REQ_HASH" >"$VENV/.req-hash"
  VENV_BUILDING=0
  [ -d "$VENV_OLD" ] && safe_rm_rf "$VENV_OLD"
  ok "설치했어요 ($(fmt_duration $((SECONDS - venv_start))))"
fi

# ---------------------------------------------------------------------------------------
step "앱 만들기"
# ---------------------------------------------------------------------------------------
# App code: copy into a staging folder, then swap, so a failed copy never leaves a mix.
APP_STAGE="$RES/app.new"
[ -d "$APP_STAGE" ] && safe_rm_rf "$APP_STAGE"
mkdir -p "$APP_STAGE"
RSYNC_EXCLUDES=(--exclude='__pycache__' --exclude='*.pyc' --exclude='.DS_Store' --exclude='tests' --exclude='/test')
rsync -a "${RSYNC_EXCLUDES[@]}" "$SRC/lazycut/" "$APP_STAGE/lazycut/"
if [ -d "$SRC/web" ]; then rsync -a "${RSYNC_EXCLUDES[@]}" "$SRC/web/" "$APP_STAGE/web/"; fi
if [ -d "$RES/app" ]; then
  [ -d "$RES/app.old" ] && safe_rm_rf "$RES/app.old"
  mv "$RES/app" "$RES/app.old"
fi
mv "$APP_STAGE" "$RES/app"
APP_STAGE=""
[ -d "$RES/app.old" ] && safe_rm_rf "$RES/app.old"
# Precompile in place (doubles as a syntax check; with Apple's Python the .pyc files land in
# its bytecode cache, keyed by this final path).
env -u PYTHONDONTWRITEBYTECODE "$VPY" -m compileall -q "$RES/app/lazycut" >>"$LOG_FILE" 2>&1 \
  || warn "미리 컴파일은 건너뛰었어요 (실행에는 문제없어요)."
ok "앱 파일을 넣었어요"

if [ -f "$SRC/assets/icon.icns" ]; then
  cp -f "$SRC/assets/icon.icns" "$RES/icon.icns"
  ok "아이콘을 넣었어요"
else
  warn "아이콘 파일이 없어서 기본 아이콘으로 보여요."
fi
# Keep a copy of the uninstaller inside the app, in case the zip folder is gone later.
if [ -f "$SRC/uninstall.command" ]; then
  cp -f "$SRC/uninstall.command" "$RES/uninstall.command"
  chmod 755 "$RES/uninstall.command"
fi

# Launcher (CFBundleExecutable). Static text: every path is resolved relative to itself,
# so the app keeps working if it is moved (e.g. to /Applications).
LAUNCHER_TMP="$CONTENTS/MacOS/.lazycut.tmp"
cat >"$LAUNCHER_TMP" <<'LAUNCHER'
#!/bin/bash
# Lazy - Cut app launcher — generated by install.command (overwritten on every update).
# `python -m lazycut` starts (or reuses) the local server in the background, opens the
# editor window and exits right away, so nothing lingers in the Dock (LSUIElement).
#   lazycut --version     print the installed version (quick bundle self-check)
#   lazycut <args>        any arguments → `python -m lazycut <args>` with output on the terminal
set -u

contents="$(cd "$(dirname "$0")/.." && pwd -P)"
res="$contents/Resources"
py="$res/venv/bin/python"
log_dir="$HOME/Library/Logs/LazyCut"
[ -n "${LAZYCUT_HOME:-}" ] && log_dir="$LAZYCUT_HOME/Logs"   # same override as lazycut/config.py
log_file="$log_dir/launcher.log"

mkdir -p "$log_dir" 2>/dev/null
if [ -f "$log_file" ] && [ "$(stat -f %z "$log_file" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$log_file" "$log_file.1" 2>/dev/null   # keep the log small (~1 MB + one old file)
fi
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$log_file" 2>/dev/null; }

# Friendly error dialog for Finder launches (there is no terminal to print to).
alert() {
  /usr/bin/osascript - "$1" "$2" >/dev/null 2>&1 <<'OSA'
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical
end run
OSA
}

# Drop the legacy Finder "-psn_…" argument; anything else means a terminal user.
args=()
for a in "$@"; do case "$a" in -psn_*) ;; *) args+=("$a") ;; esac; done
from_terminal=0
if [ -t 1 ] || [ ${#args[@]} -gt 0 ]; then from_terminal=1; fi

export PYTHONPATH="$res/app"
export PYTHONUNBUFFERED=1
unset PYTHONHOME

if [ ! -x "$py" ]; then
  log "error: bundled python missing or broken: $py"
  msg="앱 안의 Python이 없거나 고장 났어요. macOS나 명령어 도구가 업데이트되면 그럴 수 있어요. 설치 파일(install.command)을 다시 실행해 주세요."
  if [ "$from_terminal" = 1 ]; then echo "Lazy - Cut: $msg" >&2; else alert "Lazy - Cut을 열 수 없어요" "$msg"; fi
  exit 1
fi

if [ "$from_terminal" = 1 ]; then
  log "start (terminal): ${args[*]-}"
  exec "$py" -m lazycut ${args[@]+"${args[@]}"}
fi

log "start"
"$py" -m lazycut >>"$log_file" 2>&1
status=$?
if [ "$status" -ne 0 ]; then
  log "exit status $status"
  alert "Lazy - Cut을 열지 못했어요" "잠시 후 다시 열어 보세요. 계속 안 되면 이 기록 파일을 팀에 보내 주세요.

~/Library/Logs/LazyCut/launcher.log"
fi
exit "$status"
LAUNCHER
chmod 755 "$LAUNCHER_TMP"
mv -f "$LAUNCHER_TMP" "$CONTENTS/MacOS/lazycut"

PLIST_TMP="$CONTENTS/.Info.plist.tmp"
cat >"$PLIST_TMP" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>ko</string>
	<key>CFBundleName</key>
	<string>$APP_NAME</string>
	<key>CFBundleDisplayName</key>
	<string>$APP_NAME</string>
	<key>CFBundleIdentifier</key>
	<string>$BUNDLE_ID</string>
	<key>CFBundleExecutable</key>
	<string>lazycut</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleSignature</key>
	<string>????</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>$MIN_MACOS</string>
	<key>LSUIElement</key>
	<true/>
	<key>LSArchitecturePriority</key>
	<array>
		<string>arm64</string>
	</array>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.video</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>Team J-Curve</string>
</dict>
</plist>
PLIST
plutil -lint -s "$PLIST_TMP" >>"$LOG_FILE" 2>&1 || fail "앱 정보 파일(Info.plist)을 만들지 못했어요."
mv -f "$PLIST_TMP" "$CONTENTS/Info.plist"
printf 'APPL????' >"$CONTENTS/PkgInfo"
ok "앱을 만들었어요: $APP_NAME $VERSION"

# ---------------------------------------------------------------------------------------
step "음성인식 모델 준비하기"
# ---------------------------------------------------------------------------------------
model_cached() {  # a complete snapshot (config + weights) is already in the Hugging Face cache
  "$VPY" - "$MODEL_REPO" >>"$LOG_FILE" 2>&1 <<'PY'
import glob, os, sys
from huggingface_hub.constants import HF_HUB_CACHE
snaps = os.path.join(HF_HUB_CACHE, "models--" + sys.argv[1].replace("/", "--"), "snapshots", "*")
def complete(d):
    return os.path.isfile(os.path.join(d, "config.json")) and any(
        os.path.isfile(os.path.join(d, w)) for w in ("weights.safetensors", "weights.npz"))
sys.exit(0 if any(complete(d) for d in glob.glob(snaps)) else 1)
PY
}

if model_cached; then
  ok "모델이 이미 있어요 (whisper-large-v3-turbo)"
else
  info "받아쓰기에 쓰는 음성인식 모델(약 1.5GB)을 지금 받아 둘 수 있어요."
  info "지금 안 받으면 처음 받아쓰기할 때 자동으로 받아요."
  want_model=1
  free_kb="$(df -Pk "$APP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ "${free_kb:-0}" -lt 2621440 ]; then   # < 2.5 GB left after the packages
    warn "저장 공간이 부족해서 모델은 나중에 받을게요."
    want_model=0
  elif [ "$INTERACTIVE" = "1" ]; then
    ask_yes_no "지금 받을까요?" y || want_model=0
  else
    [ "${LAZYCUT_DOWNLOAD_MODEL:-1}" = "1" ] || want_model=0
  fi
  if [ "$want_model" = "1" ]; then
    model_start=$SECONDS
    info "받는 중… (인터넷 속도에 따라 3~20분)"
    # Progress bars go to the terminal; without one, errors go to the install log.
    if [ "$TTY" = "1" ]; then dl_err=/dev/stderr; else dl_err="$LOG_FILE"; fi
    if "$VPY" -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL_REPO')" \
         2>>"$dl_err"; then
      ok "모델을 받았어요 ($(fmt_duration $((SECONDS - model_start))))"
    else
      warn "모델을 받지 못했어요. 괜찮아요 — 처음 받아쓰기할 때 다시 받아요."
    fi
  else
    info "건너뛰었어요."
  fi
fi

# ---------------------------------------------------------------------------------------
step "마무리하기"
# ---------------------------------------------------------------------------------------
# Files copied out of a downloaded zip carry the quarantine flag; drop it inside our bundle.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
touch "$APP"   # lets Finder, Launchpad and Spotlight notice the new version
if [ -z "${LAZYCUT_APP_DIR:-}" ]; then
  # Refresh the LaunchServices record (icon/name) for the standard install location.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$APP" >/dev/null 2>&1 || true
fi
ok "설치 완료! ($(fmt_duration $((SECONDS - START_TS))))"

printf '\n  %s%s %s%s이 준비됐어요.\n' "$B" "$APP_NAME" "$VERSION" "$R"
printf '  위치: %s\n' "$APP"
printf '  다음부터는 Launchpad나 Spotlight(⌘+스페이스)에서 ‘Lazy - Cut’을 찾아 열면 돼요.\n'
printf '  업데이트할 때는 새 버전의 install.command를 다시 실행하면 돼요.\n'

if [ "${LAZYCUT_NO_OPEN:-0}" != "1" ]; then
  printf '\n  Lazy - Cut을 열게요…\n'
  open "$APP" 2>>"$LOG_FILE" || warn "앱을 자동으로 열지 못했어요. Finder에서 직접 열어 주세요."
fi
printf '\n  %s이 창은 닫아도 돼요.%s\n\n' "$D" "$R"
log "===== install done ($VERSION)"
