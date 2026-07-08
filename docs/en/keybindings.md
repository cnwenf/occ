# Keybindings

OCC's input system is a config-driven layer on top of Ink's `useInput` hook. Keystrokes are parsed (`src/ink/parse-keypress.ts`), matched against bindings in the active context plus `Global`, and dispatched to action handlers. The system supports chord sequences (e.g. `ctrl+x ctrl+k`).

## Quick reference (default bindings)

### Global (active everywhere)

| Key | Action | Notes |
|---|---|---|
| `Ctrl+C` | Interrupt / double-press to exit | Non-rebindable; first press interrupts the current turn |
| `Ctrl+D` | Exit (double-press to confirm) | Non-rebindable |
| `Ctrl+T` | Toggle task list | |
| `Ctrl+O` | Toggle verbose/transcript view | Shows full tool output + thinking |
| `Ctrl+R` | Reverse search through history | |
| `Ctrl+Shift+B` | Toggle brief | |

### Chat (prompt input focused)

| Key | Action | Notes |
|---|---|---|
| `Enter` | Submit message | |
| `Shift+Enter` | Newline (multiline input) | Also `Meta+Enter` / `Option+Enter` / `Ctrl+J` / `\` + Enter |
| `Esc` | Cancel / interrupt | Double-tap `Esc` to clear the input buffer |
| `Shift+Tab` | Cycle permission/auto-accept modes | `Meta+M` on Windows without VT mode |
| `Alt+P` (`Meta+P`) | Open model picker | |
| `Alt+O` (`Meta+O`) | Toggle fast mode | |
| `Alt+T` (`Meta+T`) | Toggle thinking mode | |
| `Ctrl+L` | Clear the whole input buffer | |
| `Ctrl+J` | Insert a newline | |
| `Ctrl+K` (`Cmd+K`) | Clear terminal screen + scrollback | |
| `Up` / `Down` | Previous / next history entry | |
| `Ctrl+_` | Undo last edit | Legacy terminals send `\x1f` |
| `Ctrl+X Ctrl+E` | Edit message in `$EDITOR` | Chord (readline-native) |
| `Ctrl+G` | Edit message in `$EDITOR` | Alternative chord |
| `Ctrl+S` | Stash / unstash the prompt | |
| `Ctrl+V` | Paste image from clipboard | `Alt+V` on Windows |
| `Ctrl+X Ctrl+K` | Kill agents | Chord to avoid shadowing readline keys |

### Autocomplete (menu visible)

| Key | Action |
|---|---|
| `Tab` | Accept suggestion |
| `Esc` | Dismiss |
| `Up` / `Down` | Previous / next suggestion |

### Scroll (message history)

| Key | Action |
|---|---|
| `PageUp` / `PageDown` | Page up / down |
| `Ctrl+Up` / `Ctrl+Down` | Line up / down |
| `Ctrl+U` / `Ctrl+D` | Half page up / down |
| `Ctrl+B` / `Ctrl+F` | Full page up / down |
| `Ctrl+Home` / `Ctrl+End` | Top / bottom |
| `Ctrl+Shift+C` (`Cmd+C`) | Copy selection |

### Transcript (verbose mode, `Ctrl+O`)

A less-style pager with raw handlers:

| Key | Action |
|---|---|
| `q` / `Esc` / `Ctrl+C` | Exit transcript |
| `Ctrl+E` | Expand/collapse all |
| `j` / `k` / `g` / `G` | Modal pager motions |
| `Ctrl+U` / `Ctrl+D` / `Ctrl+B` / `Ctrl+F` | Page motions |
| `/` | Open search bar |
| `n` / `N` | Next / previous search match |
| `v` | Open transcript in `$EDITOR` |

### Confirmation / permission dialogs

| Key | Action |
|---|---|
| `y` / `n` | Yes / no |
| `Enter` | Yes |
| `Esc` | No |
| `Up` / `Down` | Previous / next option |
| `Tab` | Next field |
| `Space` | Toggle |
| `Shift+Tab` | Cycle mode |
| `Ctrl+E` | Toggle explanation |
| `Ctrl+D` | Toggle debug |

### Settings panel (`/config`, `/model`, `/resume`, etc.)

| Key | Action |
|---|---|
| `Up` / `Down` / `k` / `j` / `Ctrl+P` / `Ctrl+N` | Navigate |
| `Space` | Toggle setting |
| `Enter` | Save & close |
| `/` | Search |
| `g` / `Shift+G` | First / last |
| `Esc` | Dismiss |

### Task (foreground task running)

| Key | Action | Notes |
|---|---|---|
| `Ctrl+B` | Move task to background | In tmux, press `Ctrl+B` twice |

## Ctrl+C / Ctrl+D double-press

These use a time-based double-press (not the chord system), so the first `Ctrl+C` can still fire an interrupt. First press shows "Press Ctrl-C again to exit"; a second press within the timeout exits. These keys are hardcoded and cannot be rebound.

## Multiline input

`Shift+Enter`, `Meta+Enter` (Option+Enter), `Ctrl+J`, or `\` + Enter all insert a newline. Some terminals don't support `Shift+Enter` natively — run `/terminal-setup` to install a keybinding for them. iTerm2, WezTerm, Ghostty, Kitty, and Warp support it natively; Apple Terminal uses native modifier detection.

## Customizing keybindings

Custom keybindings live in `~/.claude/keybindings.json`. The `/keybindings` command creates the file from a template and opens it in `$EDITOR`.

> **Note:** In OCC, keybinding customization is gated behind a GrowthBook flag (`tengu_keybinding_customization_release`) that returns `false` in the stubbed analytics layer. External OCC users use defaults only. The `/keybindings` command reports "Keybinding customization is not enabled" when the flag is off.

When enabled, the config format is:

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "ctrl+k": "chat:clearScreen",
        "ctrl+g": "chat:externalEditor",
        "ctrl+s": "chat:stash"
      }
    }
  ]
}
```

- `context` is one of the valid contexts (`Global`, `Chat`, `Autocomplete`, `Scroll`, `Transcript`, `HistorySearch`, `Confirmation`, `Settings`, `Tabs`, `Select`, `Doctor`, etc.).
- Each binding maps a keystroke to an action ID, `null` (to unbind a default), or `"command:<name>"` (runs a slash command — `Chat` context only).
- The file is hot-reloaded (chokidar watcher, 500ms stability).

### Keystroke syntax

- Modifiers joined by `+`: `ctrl`/`control`, `alt`/`opt`/`option`, `meta`, `cmd`/`command`/`super`/`win`, `shift`.
- Special keys: `esc`/`escape`, `return`/`enter`, `space`, `up`/`down`/`left`/`right`, `pageup`/`pagedown`, `home`/`end`, `tab`, `backspace`, `delete`.
- Chords are space-separated steps: `"ctrl+x ctrl+k"`.

### Reserved shortcuts

- **Non-rebindable (error):** `Ctrl+C`, `Ctrl+D`, `Ctrl+M` (identical to Enter).
- **Terminal-reserved (warning):** `Ctrl+Z` (suspend), `Ctrl+\` (SIGQUIT).
- **macOS-reserved (error on macOS):** `Cmd+C`, `Cmd+V`, `Cmd+X`, `Cmd+Q`, `Cmd+W`, `Cmd+Tab`, `Cmd+Space`.

## Vim mode

Enable vim-style input by setting `editorMode` to `"vim"` (default is `"normal"`):

```
/config editorMode=vim
```

Or via the ConfigTool: `{"setting": "editorMode", "value": "vim"}`.

Vim mode implements INSERT, NORMAL, VISUAL, and VISUAL LINE modes with operators (`d`, `c`, `y`, `p`, `x`, `r`, `~`, `>`, `<`), motions (`h/j/k/l`, `f/F/t/T` with `;`/`,` repeat), dot-repeat (`.`), undo (`u`), and `/` for reverse history search. `Esc` exits to NORMAL (hardcoded). The mode indicator (`INSERT`/`NORMAL`/`VISUAL`) shows in the footer.

Implementation: `src/hooks/useVimInput.ts`, `src/components/VimTextInput.tsx`, `src/vim/` (operators, transitions, motions, textObjects).

> There is no `/vim` slash command. Vim is a config setting.

## Input hints

Press `?` (or the help button) to open the help overlay (`PromptInputHelpMenu`), which shows shortcut hints: `!` for bash mode, `/` for commands, `@` for file paths, `&` for background, `/btw` for side questions, plus all the keybindings listed above. Hints reflect your configured bindings (falling back to defaults).

## Related

- [Slash Commands](./slash-commands.md) — commands you invoke with `/`
- [Settings](./settings.md) — `editorMode`, `wheelScrollAccelerationEnabled`, etc.
- [Troubleshooting](./troubleshooting.md) — keybinding warnings in `/doctor`
