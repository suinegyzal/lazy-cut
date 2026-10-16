#!/bin/bash
# Lazy - Cut uninstaller — moves the app and its caches / settings / logs to the Trash
# (never rm -rf: everything stays recoverable until the Trash is emptied).
# Never touches projects (.lazycut files next to the videos) or any video.
#
# Double-click in Finder or run `bash uninstall.command`.
# Optional environment:
#   LAZYCUT_APP_DIR=<dir>          where the app was installed (default ~/Applications; then
#                                  /Applications is checked too)
#   LAZYCUT_NONINTERACTIVE=1       never ask → default answers (No), so nothing is removed
#   LAZYCUT_DRY_RUN=1              only list what would be moved to the Trash
#   LAZYCUT_TRASH_METHOD=auto|trash|finder|mv
#                                  auto (default): macOS `trash` tool (14+), else Finder, else mv

set -uo pipefail   # no -e: keep going item by item and report what could not be moved

APP_NAME="Lazy - Cut"
BUNDLE_ID="com.dnoms.lazy.cut"
SUPPORT_DIR="$HOME/Library/Application Support/LazyCut"
CACHE_DIR="$HOME/Library/Caches/LazyCut"
LOGS_DIR="$HOME/Library/Logs/LazyCut"
if [ -n "${LAZYCUT_HOME:-}" ]; then   # same relocation as lazycut/config.py
  SUPPORT_DIR="$LAZYCUT_HOME/Application Support"; CACHE_DIR="$LAZYCUT_HOME/Caches"; LOGS_DIR="$LAZYCUT_HOME/Logs"
fi
STATE_FILE="$SUPPORT_DIR/server.json"
HF_CACHE="${HF_HUB_CACHE:-${HF_HOME:-$HOME/.cache/huggingface}/hub}"
DRY_RUN="${LAZYCUT_DRY_RUN:-0}"
METHOD="${LAZYCUT_TRASH_METHOD:-auto}"
INTERACTIVE=1
[ "${LAZYCUT_NONINTERACTIVE:-0}" = "1" ] && INTERACTIVE=0

if [ -t 1 ]; then
  B=$'\033[1m'; D=$'\033[2m'; BLUE=$'\033[38;5;27m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RED=$'\033[31m'; R=$'\033[0m'
else
  B=""; D=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; R=""
fi
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$R" "$*"; }

# ask_yes_no "question" y|n → 0 = yes. Non-interactive or no answer → the default.
ask_yes_no() {
  local question="$1" def="$2" hint ans
  if [ "$def" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$INTERACTIVE" != "1" ]; then
    if [ "$def" = "y" ]; then return 0; else return 1; fi
  fi
  printf '  %s%s%s %s ' "$B" "$question" "$R" "$hint"
  if ! IFS= read -r ans; then ans=""; echo; fi
  case "$ans" in
    [Yy]*|ㅛ*|예*|네*|응*) return 0 ;;   # ㅛ/ㅜ = y/n typed on a Korean keyboard layout
    [Nn]*|ㅜ*|아니*)       return 1 ;;
    *) if [ "$def" = "y" ]; then return 0; else return 1; fi ;;
  esac
}

size_of() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }
pretty()  { case "$1" in "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }

# Move one file/folder to the Trash. Returns non-zero if it is still there afterwards.
trash_item() {
  local p="$1" base name ext dest n
  [ -e "$p" ] || return 0
  if [ "$DRY_RUN" = "1" ]; then info "(시험) 휴지통으로 옮길 항목: $p"; return 0; fi
  if { [ "$METHOD" = "auto" ] || [ "$METHOD" = "trash" ]; } && [ -x /usr/bin/trash ]; then
    /usr/bin/trash -s "$p" >/dev/null 2>&1
    [ -e "$p" ] || return 0
  fi
  if [ "$METHOD" = "auto" ] || [ "$METHOD" = "finder" ]; then
    /usr/bin/osascript - "$p" >/dev/null 2>&1 <<'OSA'
on run argv
  set f to POSIX file (item 1 of argv) as alias
  tell application "Finder" to delete f
end run
OSA
    [ -e "$p" ] || return 0
  fi
  if [ "$METHOD" = "auto" ] || [ "$METHOD" = "mv" ]; then
    # Last resort: move it into ~/.Trash ourselves (unique name, like Finder does).
    base="$(basename "$p")"; name="${base%.*}"; ext="${base##*.}"
    dest="$HOME/.Trash/$base"
    n=1
    while [ -e "$dest" ]; do   # "LazyCut 2", "Lazy - Cut 2.app", … (never mv *into* an existing folder)
      n=$((n + 1))
      if [ "$name" != "$base" ] && [ -n "$name" ]; then dest="$HOME/.Trash/$name $n.$ext"
      else dest="$HOME/.Trash/$base $n"; fi
    done
    mkdir -p "$HOME/.Trash" 2>/dev/null
    mv "$p" "$dest" 2>/dev/null
  fi
  [ ! -e "$p" ]
}

# Stop a running Lazy - Cut server (POST /api/shutdown with its token, else TERM/KILL its pid).
stop_running_server() {
  [ -f "$STATE_FILE" ] || return 0
  local pid port token i
  pid="$(plutil -extract pid raw -o - "$STATE_FILE" 2>/dev/null || true)"
  port="$(plutil -extract port raw -o - "$STATE_FILE" 2>/dev/null || true)"
  token="$(plutil -extract token raw -o - "$STATE_FILE" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  kill -0 "$pid" 2>/dev/null || return 0
  # make sure the pid really is Lazy - Cut (pids get reused)
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in *lazycut*) ;; *) return 0 ;; esac
  if [ "$DRY_RUN" = "1" ]; then info "(시험) 실행 중인 Lazy - Cut(pid $pid)을 끌 거예요"; return 0; fi
  if [ -n "$port" ] && [ -n "$token" ]; then
    curl -s -m 3 --noproxy '*' -o /dev/null -X POST \
      -H "X-LazyCut-Token: $token" -H "Content-Type: application/json" --data '{}' \
      "http://127.0.0.1:$port/api/shutdown" 2>/dev/null
  fi
  for i in $(seq 1 24); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for i in $(seq 1 12); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null
    sleep 0.3
  fi
  if kill -0 "$pid" 2>/dev/null; then warn "실행 중인 Lazy - Cut을 끄지 못했어요 (pid $pid)."
  else ok "실행 중이던 Lazy - Cut을 껐어요"; fi
}

# ---------------------------------------------------------------------------------------
failed=0
moved=0
printf '\n%s  Lazy - Cut 제거%s\n\n' "$B$BLUE" "$R"
[ "$DRY_RUN" = "1" ] && info "${D}(시험 모드: 실제로는 아무것도 옮기지 않아요)${R}"

# Installed app(s) — only bundles that are really ours.
apps=()
if [ -n "${LAZYCUT_APP_DIR:-}" ]; then
  candidates=("$LAZYCUT_APP_DIR/$APP_NAME.app")
else
  candidates=("$HOME/Applications/$APP_NAME.app" "/Applications/$APP_NAME.app")
fi
for a in "${candidates[@]}"; do
  [ -d "$a" ] || continue
  id="$(plutil -extract CFBundleIdentifier raw -o - "$a/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$id" = "$BUNDLE_ID" ]; then apps+=("$(cd "$a" && pwd -P)")
  else warn "이름은 같지만 Lazy - Cut이 아닌 앱이라 그대로 둘게요: $a"; fi
done

data=()
for d in "$CACHE_DIR" "$SUPPORT_DIR" "$LOGS_DIR"; do
  [ -e "$d" ] && data+=("$d")
done
# Apple's python3 keeps the app's compiled bytecode (~120 MB) in a mirror of its path.
for a in ${apps[@]+"${apps[@]}"}; do
  d="$HOME/Library/Caches/com.apple.python$a"
  [ -d "$d" ] && data+=("$d")
done

models=()
for m in "$HF_CACHE"/models--mlx-community--whisper-large-v3-*; do
  [ -d "$m" ] && models+=("$m")
done

if [ ${#apps[@]} -eq 0 ] && [ ${#data[@]} -eq 0 ] && [ ${#models[@]} -eq 0 ]; then
  ok "지울 게 없어요. Lazy - Cut이 설치돼 있지 않아요."
  echo
  exit 0
fi

if [ $(( ${#apps[@]} + ${#data[@]} )) -gt 0 ]; then
  info "아래 항목을 휴지통으로 옮겨요 (휴지통을 비우기 전까지는 되살릴 수 있어요):"
  for p in ${apps[@]+"${apps[@]}"} ${data[@]+"${data[@]}"}; do
    printf '    · %s %s(%s)%s\n' "$(pretty "$p")" "$D" "$(size_of "$p")" "$R"
  done
  info "${D}만든 프로젝트(.lazycut 파일)와 영상, 내보낸 파일은 그대로 남아요.${R}"
  echo
  if ! ask_yes_no "Lazy - Cut을 제거할까요?" n; then
    echo; info "아무것도 지우지 않았어요."; echo
    exit 0
  fi
  echo
  stop_running_server
  for p in ${apps[@]+"${apps[@]}"} ${data[@]+"${data[@]}"}; do
    if trash_item "$p"; then
      [ "$DRY_RUN" = "1" ] || { ok "휴지통으로 옮겼어요: $(pretty "$p")"; moved=$((moved + 1)); }
    else
      warn "옮기지 못했어요: $(pretty "$p")"; failed=1
    fi
  done
else
  info "Lazy - Cut 앱은 이미 지워져 있어요."
fi

if [ ${#models[@]} -gt 0 ]; then
  echo
  info "음성인식 모델도 남아 있어요:"
  for m in "${models[@]}"; do printf '    · %s %s(%s)%s\n' "$(pretty "$m")" "$D" "$(size_of "$m")" "$R"; done
  info "${D}다른 프로그램(예: 다른 받아쓰기 도구)도 이 모델을 같이 쓸 수 있어요. 잘 모르면 남겨 두세요.${R}"
  if ask_yes_no "모델도 휴지통으로 옮길까요?" n; then
    for m in "${models[@]}"; do
      if trash_item "$m"; then [ "$DRY_RUN" = "1" ] || { ok "휴지통으로 옮겼어요: $(basename "$m")"; moved=$((moved + 1)); }
      else warn "옮기지 못했어요: $(pretty "$m")"; failed=1; fi
    done
  else
    info "모델은 그대로 둘게요."
  fi
fi

echo
if [ "$failed" = "1" ]; then
  warn "일부 항목은 옮기지 못했어요. Finder에서 직접 휴지통으로 옮겨 주세요."
elif [ "$moved" -gt 0 ]; then
  ok "제거를 마쳤어요. 열려 있는 Lazy - Cut 창이 있으면 닫아 주세요."
elif [ "$DRY_RUN" != "1" ]; then
  info "옮긴 항목은 없어요."
fi
printf '\n  %s이 창은 닫아도 돼요.%s\n\n' "$D" "$R"
exit "$failed"
