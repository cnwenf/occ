# Keybindings

OCC's keybinding system is context-aware, supports chords, and ships a vim
mode. Bindings are resolved through a priority stack of active contexts, with
user customizations in `~/.claude/keybindings.json` overriding defaults.

## Architecture

```
~/.claude/keybindings.json   (user overrides)
        │
        ▼
loadKeybindings()  ──merge──►  [...DEFAULT_BINDINGS, ...userParsed]
        │
        ▼
parseBindings()  →  ParsedBinding[]
        │
        ▼
KeybindingProvider  (React context)
   ├─ activeContexts: Set<KeybindingContextName>
   ├─ resolve(input, key, activeContexts)  →  ChordResolveResult
   └─ registerHandler / invokeAction
        │
        ▼
useKeybinding(action, handler, {context})   (component-level)
```

## Contexts — `src/keybindings/defaultBindings.ts`

`DEFAULT_BINDINGS: KeybindingBlock[]` defines 19 contexts. Each block is
`{ context: string, bindings: Record<string, string> }`:

`Global`, `Chat`, `Autocomplete`, `Settings`, `Confirmation`, `Tabs`,
`Transcript`, `HistorySearch`, `Task`, `ThemePicker`, `Scroll`, `Help`,
`Attachments`, `Footer`, `MessageSelector`, `MessageActions` (feature-gated),
`DiffDialog`, `ModelPicker`, `Select`, `Plugin`, `Doctor`.

Components register their active context via `useRegisterKeybindingContext`
(`KeybindingContext.tsx`). The resolver walks `[...activeContexts, context,
'Global']` (deduped) and returns the first match.

## Default bindings (selected)

| Context | Key | Action |
|---|---|---|
| Global | `ctrl+c` | `app:interrupt` (reserved, non-rebindable) |
| Global | `ctrl+d` | `app:exit` (reserved, non-rebindable) |
| Global | `ctrl+t` | `app:toggleTodos` |
| Global | `ctrl+o` | `app:toggleTranscript` |
| Global | `ctrl+r` | `history:search` |
| Chat | `enter` | `chat:submit` |
| Chat | `escape` | `chat:cancel` |
| Chat | `shift+tab` | `chat:cycleMode` (or `meta+m` on Windows without VT) |
| Chat | `ctrl+l` | `chat:clearInput` |
| Chat | `ctrl+j` | `chat:newline` |
| Chat | `ctrl+k` / `cmd+k` | `chat:clearScreen` |
| Chat | `ctrl+x ctrl+e` / `ctrl+g` | `chat:externalEditor` |
| Chat | `ctrl+s` | `chat:stash` |
| Scroll | `pageup`/`pagedown`/`ctrl+u`/`ctrl+d` | scroll |

### Recent interaction fixes (2.1.204 catchup)

A few input behaviors were aligned/fixed without adding new bindings:
`left-arrow` now dismisses the active view/overlay (aligned to `escape`, #41);
`Ctrl+R` history-search no longer crashes when accepting or cancelling
mid-scan (#4); scroll-up through a long transcript holds its anchor instead of
jumping (#35); and the bash-mode shell-history ghost-text suggestion no longer
flickers while typing (#36). These are behavioral fixes in the prompt-input and
scroll renderers.

### Platform-aware shortcuts

- `IMAGE_PASTE_KEY` — `ctrl+v` (or `alt+v` on Windows, since `ctrl+v` is
  system paste).
- `MODE_CYCLE_KEY` — `shift+tab` (or `meta+m` on Windows without VT mode).
- `SUPPORTS_TERMINAL_VT_MODE` — checks Bun >= 1.2.23 / Node >= 22.17.0;
  Windows Terminal VT mode is required for modifier-only chords like
  `shift+tab`.

### Feature-gated bindings

- `QUICK_SEARCH` (off) — `ctrl+shift+f`/`cmd+shift+f` → `app:globalSearch`,
  `ctrl+shift+p` → `app:quickOpen`.
- `TERMINAL_PANEL` (off) — `meta+j` → `app:toggleTerminal`.
- `MESSAGE_ACTIONS` (off) — `shift+up`.
- `VOICE_MODE` (off) — `space`.

## Chord resolution — `src/keybindings/resolver.ts`

`resolveKeyWithChordState` returns a `ChordResolveResult`:

- `match` — a complete binding matched; fire the handler.
- `chord_started` — a chord prefix matched (e.g. `ctrl+x`); wait for the next
  key.
- `chord_cancelled` — the chord was abandoned.
- `unbound` — the key has no binding in any active context.
- `none` — no input.

`pendingChord` state is tracked in the `KeybindingProvider`. `getBindingDisplayText`
produces the human-readable form for hints.

## User customization — `src/keybindings/loadUserBindings.ts`

- `getKeybindingsPath()` → `~/.claude/keybindings.json`.
- `isKeybindingCustomizationEnabled()` — gated on GrowthBook
  `tengu_keybinding_customization_release` (external users get defaults only
  in upstream; in OCC this returns based on the setting).
- `loadKeybindings()` / `loadKeybindingsSync[WithWarnings]()` — parse
  `{ "bindings": [...] }`, merge `[...defaultBindings, ...userParsed]`
  (user overrides default).
- `initializeKeybindingWatcher()` — chokidar with `awaitWriteFinish` (500ms
  stability); emits via `keybindingsChanged` signal.
- `subscribeToKeybindingChanges` — for hot-reload.

## Reserved shortcuts — `src/keybindings/reservedShortcuts.ts`

`NON_REBINDABLE` = `ctrl+c`, `ctrl+d` (validation rejects user overrides).
Plus `TERMAL_RESERVED`, `MACOS_RESERVED`, `getReservedShortcuts()`,
`normalizeKeyForComparison()`.

## `useKeybinding` — `src/keybindings/useKeybinding.ts`

```ts
// pattern
useKeybinding(action: string, handler: (event) => void, {
  context: KeybindingContextName = 'Global',
  isActive: boolean = true,
})
useKeybindings(handlers, options)  // batch
```

Builds the context list `[...activeContexts, context, 'Global']` (deduped),
calls `keybindingContext.resolve`, switches on `result.type`; on `match` +
handler-not-false → `event.stopImmediatePropagation()`.

## Vim mode — `src/vim/`

A full vim state machine in the prompt input:

- **`types.ts`** (258 lines) — `VimState` union: `{ mode: 'INSERT';
  insertedText } | { mode: 'NORMAL'; command: CommandState } | { mode:
  'VISUAL'; ... }`. `Operator = 'delete'|'change'|'yank'`. `CommandState`
  is the NORMAL-mode state machine. `OPERATORS`/`VISUAL_KINDS` maps.
- **`motions.ts`** — cursor motions.
- **`operators.ts`** (959 lines) — delete/change/yank/case operators.
- **`textObjects.ts`** — text-object selection (word, paragraph, quote).
- **`transitions.ts`** (745 lines) — mode transitions keyed on input.

Wired into the prompt via `PromptInputFooter.tsx`/
`PromptInputFooterLeftSide.tsx` which take `vimMode: VimMode | undefined` and
call `isVimModeEnabled`. `VimMode` type lives in
`src/types/textInputTypes.ts`.

## `/keybindings` command — `src/commands/keybindings/`

`call()` (53 lines): if `!isKeybindingCustomizationEnabled()` returns a
"not enabled" message. Else `getKeybindingsPath()`, `mkdir -p` the dir,
`writeFile` with `flag: 'wx'` (exclusive create; EEXIST → fileExists=true),
then `editFileInEditor(keybindingsPath)` to open in `$EDITOR`. The template
comes from `src/keybindings/template.ts` (`generateKeybindingsTemplate`).

## Key files

| File | Role |
|---|---|
| `src/keybindings/defaultBindings.ts` | `DEFAULT_BINDINGS` — all contexts/keys |
| `src/keybindings/KeybindingContext.tsx` | `KeybindingProvider`, `useKeybindingContext` |
| `src/keybindings/useKeybinding.ts` | `useKeybinding` / `useKeybindings` |
| `src/keybindings/resolver.ts` | `resolveKeyWithChordState`, chord state |
| `src/keybindings/parser.ts` | `parseBindings` |
| `src/keybindings/loadUserBindings.ts` | `loadKeybindings`, watcher, `getKeybindingsPath` |
| `src/keybindings/reservedShortcuts.ts` | Non-rebindable keys |
| `src/keybindings/validate.ts` | `validateBindings`, `KeybindingWarning` |
| `src/keybindings/schema.ts` | `KeybindingBlockSchema` (Zod) |
| `src/keybindings/template.ts` | `generateKeybindingsTemplate` |
| `src/vim/` | Vim-mode state machine |
| `src/commands/keybindings/` | `/keybindings` command |

## How it differs from Claude Code

OCC's keybinding system is a faithful reimplementation of Claude Code's
context-aware resolver with chords, vim mode, and `~/.claude/keybindings.json`
customization. The `types.ts` is an auto-generated stub
(`KeybindingContextName = any`), but the real context names and bindings are
fully defined in `defaultBindings.ts`. The GrowthBook gate on customization
is present but effectively permissive in OCC (no Statsig).
