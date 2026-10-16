import { coerce } from 'semver'
import type { Writable } from 'stream'
import { env } from '../utils/env.js'
import { gte } from '../utils/semver.js'
import { getClearTerminalSequence } from './clearTerminal.js'
import type { Diff } from './frame.js'
import type { WriteBackpressureGate } from './stdout-backpressure.js'
import { cursorMove, cursorTo, eraseLines } from './termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js'
import { link } from './termio/osc.js'

export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

/**
 * Checks if the terminal supports OSC 9;4 progress reporting.
 * Supported terminals:
 * - ConEmu (Windows) - all versions
 * - Ghostty 1.2.0+
 * - iTerm2 3.6.6+
 *
 * Note: Windows Terminal interprets OSC 9;4 as notifications, not progress.
 */
export function isProgressReportingAvailable(): boolean {
  // Only available if we have a TTY (not piped)
  if (!process.stdout.isTTY) {
    return false
  }

  // Explicitly exclude Windows Terminal, which interprets OSC 9;4 as
  // notifications rather than progress indicators
  if (process.env.WT_SESSION) {
    return false
  }

  // ConEmu supports OSC 9;4 for progress (all versions)
  if (
    process.env.ConEmuANSI ||
    process.env.ConEmuPID ||
    process.env.ConEmuTask
  ) {
    return true
  }

  const version = coerce(process.env.TERM_PROGRAM_VERSION)
  if (!version) {
    return false
  }

  // Ghostty 1.2.0+ supports OSC 9;4 for progress
  // https://ghostty.org/docs/install/release-notes/1-2-0
  if (process.env.TERM_PROGRAM === 'ghostty') {
    return gte(version.version, '1.2.0')
  }

  // iTerm2 3.6.6+ supports OSC 9;4 for progress
  // https://iterm2.com/downloads.html
  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    return gte(version.version, '3.6.6')
  }

  return false
}

/**
 * Checks if the terminal supports DEC mode 2026 (synchronized output).
 * When supported, BSU/ESU sequences prevent visible flicker during redraws.
 */
export function isSynchronizedOutputSupported(): boolean {
  // 2.1.129: CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 force-enables synchronized
  // output on terminals that auto-detection misses (e.g. Emacs eat).
  if (process.env.CLAUDE_CODE_FORCE_SYNC_OUTPUT === '1') return true

  // tmux parses and proxies every byte but doesn't implement DEC 2026.
  // BSU/ESU pass through to the outer terminal but tmux has already
  // broken atomicity by chunking. Skip to save 16 bytes/frame + parser work.
  if (process.env.TMUX) return false

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  // Modern terminals with known DEC 2026 support
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }

  // kitty sets TERM=xterm-kitty or KITTY_WINDOW_ID
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true

  // Ghostty may set TERM=xterm-ghostty without TERM_PROGRAM
  if (term === 'xterm-ghostty') return true

  // foot sets TERM=foot or TERM=foot-extra
  if (term?.startsWith('foot')) return true

  // Alacritty may set TERM containing 'alacritty'
  if (term?.includes('alacritty')) return true

  // Zed uses the alacritty_terminal crate which supports DEC 2026
  if (process.env.ZED_TERM) return true

  // Windows Terminal
  if (process.env.WT_SESSION) return true

  // VTE-based terminals (GNOME Terminal, Tilix, etc.) since VTE 0.68
  const vteVersion = process.env.VTE_VERSION
  if (vteVersion) {
    const version = parseInt(vteVersion, 10)
    if (version >= 6800) return true
  }

  return false
}

// -- XTVERSION-detected terminal name (populated async at startup) --
//
// TERM_PROGRAM is not forwarded over SSH by default, so env-based detection
// fails when claude runs remotely inside a VS Code integrated terminal.
// XTVERSION (CSI > 0 q → DCS > | name ST) goes through the pty — the query
// reaches the *client* terminal and the reply comes back through stdin.
// App.tsx fires the query when raw mode enables; setXtversionName() is called
// from the response handler. Readers should treat undefined as "not yet known"
// and fall back to env-var detection.

let xtversionName: string | undefined

/** Record the XTVERSION response. Called once from App.tsx when the reply
 *  arrives on stdin. No-op if already set (defend against re-probe). */
export function setXtversionName(name: string): void {
  if (xtversionName === undefined) xtversionName = name
}

/** True if running in an xterm.js-based terminal (VS Code, Cursor, Windsurf
 *  integrated terminals). Combines TERM_PROGRAM env check (fast, sync, but
 *  not forwarded over SSH) with the XTVERSION probe result (async, survives
 *  SSH — query/reply goes through the pty). Early calls may miss the probe
 *  reply — call lazily (e.g. in an event handler) if SSH detection matters. */
export function isXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode') return true
  return xtversionName?.startsWith('xterm.js') ?? false
}

// Terminals known to correctly implement the Kitty keyboard protocol
// (CSI >1u) and/or xterm modifyOtherKeys (CSI >4;2m) for ctrl+shift+<letter>
// disambiguation. We previously enabled unconditionally (#23350), assuming
// terminals silently ignore unknown CSI — but some terminals honor the enable
// and emit codepoints our input parser doesn't handle (notably over SSH and
// in xterm.js-based terminals like VS Code). tmux is allowlisted because it
// accepts modifyOtherKeys and doesn't forward the kitty sequence to the outer
// terminal.
const EXTENDED_KEYS_TERMINALS = [
  'iTerm.app',
  'kitty',
  'WezTerm',
  'ghostty',
  'tmux',
  'windows-terminal',
]

/** True if this terminal correctly handles extended key reporting
 *  (Kitty keyboard protocol + xterm modifyOtherKeys). */
export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(env.terminal ?? '')
}

// -- CC 2.1.301 (occ160 WP-H): VTE < 0.53 unknown-sequence printing bug --
//
// VTE before 0.53 (e.g. MATE Terminal on RHEL 8 ships 0.52) does not silently
// ignore unrecognized `CSI >` private sequences — it prints them as literal
// text. Two strays were user-visible: the XTVERSION probe (`CSI > 0 q`)
// showed as `>0q` covering the folder-trust prompt at startup, and the
// modifyOtherKeys reset (`CSI > 4 m`) showed as `>4m` before the shell
// prompt at exit. Official 2.1.301 adds
// TerminalCapabilities.hasUnknownSequencePrintingBug (@220859789) exposed via
// the b6()/printsUnknownSequences accessor (@224563183), and gates (a) the
// startup XTVERSION send (@231943057: `R=!b6()`), (b) every extended-keys
// OFF sequence (@231683280: `lvt(){return b6()?"":CSI>4m}`,
// `o0e(){return !b6()&&…?CSI<u:""}`, wired through the mode registry's
// `off` getters @231688928 and the exit cleanup `vre()=o0e()+pvt+lvt()`),
// and (c) capability resolution — programStatus/extendedKeys/kittyKeyboard
// report `settled:!1` with source "VTE before 0.53 (shows the query as
// text)" (@104825940/@231674646). Zero call sites exist in 2.1.300.

/** VTE encodes VTE_VERSION as major*10000 + minor*100 (+ patch); the
 *  unknown-sequence printing bug was fixed in VTE 0.53 → 5300.
 *  Official literal @220859907. */
const VTE_PRINT_BUG_FIXED_VERSION = 5300

/** Injectable detection context (same pure-predicate pattern as the
 *  OCC-113 VteOsc52GuardContext in termio/osc.ts): every signal is a
 *  parameter so tests don't mutate memoized/frozen module state. */
export interface SequencePrintingBugContext {
  /** Detected terminal flavor (env.terminal), e.g. 'vte-based' or
   *  'gnome-terminal'. Official passes `a.terminal` (env.terminal). */
  terminal: string | undefined
  env: {
    // Index signature so `process.env` (NodeJS.ProcessEnv) is directly
    // assignable; the named keys below document the signals the official
    // detection reads.
    [key: string]: string | undefined
    VTE_VERSION?: string
    TERM?: string
    TMUX?: string
    STY?: string
    ZELLIJ?: string
    XTERM_VERSION?: string
    ALACRITTY_WINDOW_ID?: string
    ALACRITTY_LOG?: string
    KITTY_WINDOW_ID?: string
    WEZTERM_PANE?: string
    INSIDE_EMACS?: string
    VIM_TERMINAL?: string
    NVIM?: string
  }
}

/** Official `g(r){return(r??"").trim()!==""}` (helper inside
 *  isVteBasedTerminal, @220859789 region). */
function isEnvSet(value: string | undefined): boolean {
  return (value ?? '').trim() !== ''
}

/**
 * Official `isVteBasedTerminal(name)` (@220859789): VTE_VERSION set
 * (non-empty after trim), flavor is vte-based/gnome-terminal, TERM starts
 * with "xterm", and none of the escape-hatch vars that prove a different
 * terminal is really driving the pty. Unlike the OCC-113 OSC 52 guard, this
 * conjunction additionally excludes ZELLIJ (official checks `=== void 0` —
 * ANY defined value counts as inside Zellij, even empty) and the embedded
 * pty owners INSIDE_EMACS / VIM_TERMINAL / NVIM, which forward VTE_VERSION
 * but parse sequences themselves.
 */
export function isVteBasedTerminal(ctx: SequencePrintingBugContext): boolean {
  return (
    isEnvSet(ctx.env.VTE_VERSION) &&
    (ctx.terminal === 'vte-based' || ctx.terminal === 'gnome-terminal') &&
    (ctx.env.TERM ?? '').trim().startsWith('xterm') &&
    !isEnvSet(ctx.env.TMUX) &&
    !isEnvSet(ctx.env.STY) &&
    ctx.env.ZELLIJ === undefined &&
    !isEnvSet(ctx.env.XTERM_VERSION) &&
    !isEnvSet(ctx.env.ALACRITTY_WINDOW_ID) &&
    !isEnvSet(ctx.env.ALACRITTY_LOG) &&
    !isEnvSet(ctx.env.KITTY_WINDOW_ID) &&
    !isEnvSet(ctx.env.WEZTERM_PANE) &&
    !isEnvSet(ctx.env.INSIDE_EMACS) &&
    !isEnvSet(ctx.env.VIM_TERMINAL) &&
    !isEnvSet(ctx.env.NVIM)
  )
}

/**
 * Official `hasUnknownSequencePrintingBug(name)` (@220859789, threshold
 * 5300 @220859907): a VTE-based terminal running VTE < 0.53. An unparseable
 * VTE_VERSION (parseInt → NaN) fails the `<` comparison — identical to the
 * official Number.parseInt path.
 */
export function hasUnknownSequencePrintingBug(
  ctx: SequencePrintingBugContext,
): boolean {
  return (
    isVteBasedTerminal(ctx) &&
    Number.parseInt(ctx.env.VTE_VERSION ?? '', 10) <
      VTE_PRINT_BUG_FIXED_VERSION
  )
}

/**
 * Official `b6()` accessor (@224563183):
 * `pu()?.printsUnknownSequences ?? RE.hasUnknownSequencePrintingBug(a.terminal)`.
 *
 * DEVIATION NOTE: official consults `pu()` first — the attach-caps override
 * a remote-control daemon sends in its handshake (zod schema @225269828,
 * `printsUnknownSequences:M().optional()`). OCC has no attach-caps protocol,
 * so env-based detection is the only source.
 *
 * Deliberately NOT memoized: the official re-reads proc.env on every call
 * and terminal flavor/env are fixtures in tests.
 */
export function printsUnknownSequences(): boolean {
  return hasUnknownSequencePrintingBug({
    terminal: env.terminal,
    env: process.env,
  })
}

/** True if the terminal scrolls the viewport when it receives cursor-up
 *  sequences that reach above the visible area. On Windows, conhost's
 *  SetConsoleCursorPosition follows the cursor into scrollback
 *  (microsoft/terminal#14774), yanking users to the top of their buffer
 *  mid-stream. WT_SESSION catches WSL-in-Windows-Terminal where platform
 *  is linux but output still routes through conhost. */
export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

// Computed once at module load — terminal capabilities don't change mid-session.
// Exported so callers can pass a sync-skip hint gated to specific modes.
export const SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported()

export type Terminal = {
  stdout: Writable
  stderr: Writable
}

/**
 * Writes a rendered diff to the terminal as a single buffer.
 *
 * When `backpressure` is provided (CC 2.1.275 changelog #15 — stdout
 * backpressure port), the buffer passes through the monitor's admission
 * gate first: frames refused while the stream backlog exceeds the cap
 * are dropped (bytes counted in the episode's `droppedBytes`), and the
 * boolean result of the actual `stdout.write()` is observed so a `false`
 * return starts a backpressure episode. Without a gate the behavior is
 * byte-identical to the previous implementation.
 *
 * @returns true when the buffer was written to the stream, false when it
 *          was dropped by the backpressure gate or the diff was empty.
 */
export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
  backpressure?: WriteBackpressureGate | null,
): boolean {
  // No output if there are no patches
  if (diff.length === 0) {
    return false
  }

  // BSU/ESU wrapping is opt-out to keep main-screen behavior unchanged.
  // Callers pass skipSyncMarkers=true when the terminal doesn't support
  // DEC 2026 (e.g. tmux) AND the cost matters (high-frequency alt-screen).
  const useSync = !skipSyncMarkers

  // Buffer all writes into a single string to avoid multiple write calls
  let buffer = useSync ? BSU : ''

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        buffer += patch.content
        break
      case 'clear':
        if (patch.count > 0) {
          buffer += eraseLines(patch.count)
        }
        break
      case 'clearTerminal':
        buffer += getClearTerminalSequence()
        break
      case 'cursorHide':
        buffer += HIDE_CURSOR
        break
      case 'cursorShow':
        buffer += SHOW_CURSOR
        break
      case 'cursorMove':
        buffer += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        buffer += cursorTo(patch.col)
        break
      case 'carriageReturn':
        buffer += '\r'
        break
      case 'hyperlink':
        buffer += link(patch.uri)
        break
      case 'styleStr':
        buffer += patch.str
        break
    }
  }

  // Add synchronized update end and flush buffer
  if (useSync) buffer += ESU

  if (backpressure && !backpressure.admitWrite(buffer.length)) {
    // Frame refused by the drop gate — bytes already counted by the
    // monitor; the next full repaint (forceRedraw) restores the screen.
    return false
  }
  const ok = terminal.stdout.write(buffer)
  backpressure?.observeWriteResult(ok)
  return ok
}
