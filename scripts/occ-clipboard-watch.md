# occ-clipboard-watch

Reliable, terminal-agnostic SSH image-paste for the OCC REPL.

## Why

When you SSH into a dev machine and press **Ctrl+V** (or **Cmd+V** on Mac),
the screenshot in your *local* clipboard can't reach the remote OCC process
as image bytes — the terminal paste channel only carries text. OCC 2.1.272
tries two zero-config mechanisms under SSH:

1. **OSC 52 read** — the terminal is asked for the clipboard contents. Works
   on iTerm2/kitty/wezterm (opt-in), refuses or ignores on Alacritty and
   Windows Terminal, and is unreliable under tmux without `allow-passthrough`.
2. **Local clipboard** — `xclip`/`wl-paste` on the dev machine. Useless on a
   headless SSH box (no clipboard, no graphical session).

When both fail, OCC falls back to this watcher path: a local script pushes
each new screenshot to a fixed file on the dev machine, and OCC's Ctrl+V
reads that file. **Terminal-agnostic. Works everywhere.**

## One-time setup (on your Mac)

```bash
brew install fswatch
git clone <this repo> ~/occ && cd ~/occ
chmod +x scripts/occ-clipboard-watch.sh
# Set your SSH alias (must match a Host in ~/.ssh/config):
export OCC_SSH_HOST=dev
```

## Run it

```bash
~/occ/scripts/occ-clipboard-watch.sh
```

Take a screenshot (Cmd+Shift+3 / 4). You'll see:

```
occ-clipboard-watch: pushed Screenshot 2026-07-17 at 12.34.56.png → dev:~/.occ/clipboard-latest.png
```

On the dev machine, in the OCC REPL, press **Ctrl+V** — the path
`~/.occ/clipboard-latest.png` is inserted into the input box for the agent to
read.

## Environment

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OCC_SSH_HOST` | yes | — | SSH alias for the dev machine |
| `OCC_SCREENSHOT_DIR` | no | `~/Pictures/Screenshots` (or `~/Desktop`) | Local dir to watch |
| `OCC_CLIPBOARD_WATCH_PATH` | no | `~/.occ/clipboard-latest.png` | Destination path on dev machine (must match the OCC side) |
| `OCC_SCP_REMOTE_DIR` | no | `~/.occ` | Parent dir to `mkdir -p` on the dev machine |

If you override `OCC_CLIPBOARD_WATCH_PATH` on the watcher side, set the same
value (or the env var `OCC_CLIPBOARD_WATCH_PATH`) when launching OCC so both
sides agree.

## Run at login (launchd)

Save as `~/Library/LaunchAgents/com.cnwenf.occ.clipboard-watch.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cnwenf.occ.clipboard-watch</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOU/occ/scripts/occ-clipboard-watch.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCC_SSH_HOST</key>
    <string>dev</string>
    <!-- <key>OCC_SCREENSHOT_DIR</key><string>/Users/YOU/Pictures/Screenshots</string> -->
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/occ-clipboard-watch.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/occ-clipboard-watch.err</string>
</dict>
</plist>
```

Then:

```bash
launchctl load ~/Library/LaunchAgents/com.cnwenf.occ.clipboard-watch.plist
tail -f /tmp/occ-clipboard-watch.log
```

Replace `/Users/YOU/occ` with the absolute path to your OCC clone and `dev`
with your SSH alias.

## Troubleshooting

- **"no screenshot found"** — your macOS saves screenshots with a different
  filename pattern, or to a non-default dir. Set `OCC_SCREENSHOT_DIR` and
  check the files match `*screenshot*.png` (case-insensitive). The script's
  `latest_screenshot` filter can be loosened in a pinch.
- **scp fails** — verify `ssh $OCC_SSH_HOST echo ok` works (SSH config,
  keys, host reachability).
- **Ctrl+V still says "No image found"** — confirm the file exists on the
  dev machine: `ssh $OCC_SSH_HOST ls -la ~/.occ/clipboard-latest.png`. OCC
  only reads the watch path when no override and no OSC 52 read succeeded,
  so the file must be present *before* you press Ctrl+V.

## See also

- `src/utils/imagePaste.ts` — `saveClipboardImageToTempFile` (read order:
  override → OSC 52 → watch path → local clipboard).
- `src/utils/osc52ClipboardRead.ts` — the zero-config OSC 52 path.
