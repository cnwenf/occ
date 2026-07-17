#!/usr/bin/env bash
# occ-clipboard-watch — local Mac screenshot → dev machine inbox.
#
# Watches a screenshot directory on your Mac and scps each new screenshot to
# a fixed path on the dev machine where OCC's REPL can read it on Ctrl+V.
# This is the reliable, terminal-agnostic half of the SSH image-paste story
# (OSC 52 read is the zero-config half; this watcher is the fallback that
# works on every terminal).
#
# Target path matches DEFAULT_CLIPBOARD_WATCH_PATH in src/utils/imagePaste.ts
# (~/.occ/clipboard-latest.png). Override on either side with
# $OCC_CLIPBOARD_WATCH_PATH (must match on both).
#
# SETUP (one-time, on your Mac):
#   brew install fswatch            # filesystem watcher
#   export OCC_SSH_HOST=dev         # your ~/.ssh/config alias for the dev box
#   ./scripts/occ-clipboard-watch.sh
# Then on the dev box, in the OCC REPL, press Ctrl+V — the latest screenshot
# path is inserted.
#
# Env:
#   OCC_SSH_HOST          (required) SSH alias for the dev machine.
#   OCC_SCREENSHOT_DIR   (optional) Dir to watch. Default: macOS screenshots
#                         dir (Desktop in older macOS, ~/Pictures/Screenshots
#                         in macOS 14+/Sonoma+).
#   OCC_CLIPBOARD_WATCH_PATH (optional) Destination path on the dev machine.
#                         Default: ~/.occ/clipboard-latest.png
#   OCC_SCP_REMOTE_DIR   (optional) Base dir on remote that contains the watch
#                         path's parent (used to mkdir -p). Default: ~/.occ
set -euo pipefail

if [[ -z "${OCC_SSH_HOST:-}" ]]; then
  echo "occ-clipboard-watch: OCC_SSH_HOST is not set." >&2
  echo "  Set it to your SSH alias for the dev machine, e.g.:" >&2
  echo "    export OCC_SSH_HOST=dev" >&2
  exit 2
fi

# Resolve the screenshot directory.
default_shot_dir="$HOME/Pictures/Screenshots"
if [[ ! -d "$default_shot_dir" ]]; then
  default_shot_dir="$HOME/Desktop"
fi
shot_dir="${OCC_SCREENSHOT_DIR:-$default_shot_dir}"
if [[ ! -d "$shot_dir" ]]; then
  echo "occ-clipboard-watch: screenshot dir not found: $shot_dir" >&2
  echo "  Set OCC_SCREENSHOT_DIR to your screenshots folder." >&2
  exit 2
fi

remote_watch_path="${OCC_CLIPBOARD_WATCH_PATH:-\$HOME/.occ/clipboard-latest.png}"
remote_base_dir="${OCC_SCP_REMOTE_DIR:-\$HOME/.occ}"

echo "occ-clipboard-watch: watching $shot_dir"
echo "occ-clipboard-watch: scp target: $OCC_SSH_HOST:$remote_watch_path"
echo "occ-clipboard-watch: ensure the remote dir exists: $remote_base_dir"
# Best-effort: create the remote inbox dir once.
ssh "$OCC_SSH_HOST" "mkdir -p $remote_base_dir" 2>/dev/null || true

# Pick the newest *.png in $1 whose name looks like a screenshot.
latest_screenshot() {
  local dir="$1"
  # macOS: "Screen Shot 2026-...png" (pre-Sonoma) or "Screenshot 2026-...png"
  ls -t "$dir"/*.png 2>/dev/null \
    | grep -iE 'screenshot|screen[ _]shot' \
    | head -1 || true
}

scp_latest() {
  local src
  src="$(latest_screenshot "$shot_dir")"
  if [[ -z "$src" ]]; then
    echo "occ-clipboard-watch: no screenshot found in $shot_dir yet" >&2
    return 1
  fi
  # scp to a temp name then atomically mv, so OCC never reads a half-written
  # file mid-transfer.
  local tmp_remote="$remote_watch_path.$$"
  scp -q "$src" "$OCC_SSH_HOST:$tmp_remote" \
    && ssh "$OCC_SSH_HOST" "mv -f '$tmp_remote' '$remote_watch_path'" \
    && echo "occ-clipboard-watch: pushed $(basename "$src") → $OCC_SSH_HOST:$remote_watch_path"
}

# fswatch: -o coalesces events; --latency caps wakeups. We re-scp on every
# burst — idempotent (same newest file) if no new shot arrived.
if ! command -v fswatch >/dev/null 2>&1; then
  echo "occ-clipboard-watch: fswatch not installed. Run: brew install fswatch" >&2
  exit 2
fi

fswatch --latency 0.5 -o "$shot_dir" | while read -r _; do
  scp_latest || true
done
