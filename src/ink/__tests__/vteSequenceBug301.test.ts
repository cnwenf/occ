/**
 * CC 2.1.301 (occ160 WP-H) — stray `>0q` / `>4m` on VTE < 0.53.
 *
 * Official 2.1.301 changelog: "Fixed stray characters such as `>0q` covering
 * the folder trust prompt, and `>4m` before the shell prompt at exit, in
 * terminals built on VTE older than 0.53 such as MATE Terminal on RHEL 8."
 *
 * Mechanism (byte-forensics on the official 2.1.301 binary; zero call sites
 * in 2.1.300):
 *   - `hasUnknownSequencePrintingBug(name)` @220859789 =
 *     isVteBasedTerminal(name) && parseInt(VTE_VERSION ?? "", 10) < 5300
 *     (threshold literal @220859907; VTE encodes major*10000+minor*100).
 *   - `isVteBasedTerminal(name)`: VTE_VERSION non-empty (trimmed) && name is
 *     "vte-based"/"gnome-terminal" && TERM starts with "xterm" && none of
 *     TMUX/STY/XTERM_VERSION/ALACRITTY_WINDOW_ID/ALACRITTY_LOG/
 *     KITTY_WINDOW_ID/WEZTERM_PANE/INSIDE_EMACS/VIM_TERMINAL/NVIM set &&
 *     ZELLIJ === undefined.
 *   - Accessor `b6()` @224563183 = printsUnknownSequences; gates the startup
 *     XTVERSION send (@231943057 `R=!b6()`, skip-log "XTVERSION: not asked
 *     (VTE before 0.53 would show the query as text)") and the extended-keys
 *     OFF sequences `lvt()` (CSI >4m) / `o0e()` (CSI <u) @231683280 wired
 *     through the mode registry (@231688928) and exit cleanup
 *     (`vre()=o0e()+pvt+lvt()`).
 *
 * OCC port sites: terminal.ts (detection), App.tsx (XTVERSION probe +
 * raw-mode disable), ink.tsx (enterAlternateScreen + exit path),
 * guiEditorHandoff.ts (disable/restore seqs), gracefulShutdown.ts
 * (cleanupTerminalModes — the `>4m` before the shell prompt).
 *
 * DEVIATION NOTE: official b6() first consults the attach-caps override
 * (`pu()?.printsUnknownSequences`, zod schema @225269828) from the
 * remote-control daemon handshake; OCC has no attach-caps protocol, so the
 * env-based detection is the only source (same deviation style as the
 * omitted R7r() predicate in the OCC-113 guard).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const {
  hasUnknownSequencePrintingBug,
  isVteBasedTerminal,
  printsUnknownSequences,
} = await import('../terminal.js')
const {
  guiEditorModeDisableSeq,
  guiEditorModeRestoreSeq,
} = await import('../termio/guiEditorHandoff.js')
const { env } = await import('../../utils/env.js')

// ---------------------------------------------------------------------------
// Env fixture (same pattern as osc52VteGuard296.test.ts)
// ---------------------------------------------------------------------------

const BUG_ENV_KEYS = [
  'VTE_VERSION',
  'TERM',
  'TMUX',
  'STY',
  'ZELLIJ',
  'XTERM_VERSION',
  'ALACRITTY_WINDOW_ID',
  'ALACRITTY_LOG',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'INSIDE_EMACS',
  'VIM_TERMINAL',
  'NVIM',
] as const

const savedEnv: Record<string, string | undefined> = {}
let savedTerminal: string | undefined

beforeEach(() => {
  for (const key of BUG_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedTerminal = env.terminal
})

afterEach(() => {
  for (const key of BUG_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  env.terminal = savedTerminal
})

/** Full-conjunction context: RHEL 8 MATE Terminal (VTE 0.52 → 5200). */
function bugCtx(
  overrides: Partial<Parameters<typeof hasUnknownSequencePrintingBug>[0]> & {
    envOverrides?: Record<string, string | undefined>
  } = {},
) {
  const { envOverrides, ...rest } = overrides
  return {
    terminal: 'vte-based',
    env: { VTE_VERSION: '5200', TERM: 'xterm-256color', ...envOverrides },
    ...rest,
  } as Parameters<typeof hasUnknownSequencePrintingBug>[0]
}

// ---------------------------------------------------------------------------
// Pure predicate — the official conjunction, clause by clause
// ---------------------------------------------------------------------------

describe('CC 2.1.301 WP-H: hasUnknownSequencePrintingBug (pure predicate)', () => {
  test('fires on a bare VTE 0.52 session (RHEL 8 MATE Terminal)', () => {
    // Assert
    expect(hasUnknownSequencePrintingBug(bugCtx())).toBe(true)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ terminal: 'gnome-terminal' })),
    ).toBe(true)
  })

  test('version threshold: < 5300 buggy, >= 5300 fixed', () => {
    // Assert — VTE encodes major*10000 + minor*100; 0.53 → 5300
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { VTE_VERSION: '5299' } })),
    ).toBe(true)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { VTE_VERSION: '5300' } })),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { VTE_VERSION: '6800' } })),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { VTE_VERSION: '7600' } })),
    ).toBe(false)
  })

  test('unparseable or empty VTE_VERSION never fires', () => {
    // Assert — parseInt → NaN fails `< 5300`, matching the official path;
    // empty/whitespace fails the isVteBasedTerminal trim check.
    for (const vteVersion of ['abc', '', '   ', undefined]) {
      expect(
        hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { VTE_VERSION: vteVersion } })),
      ).toBe(false)
    }
  })

  test('does not fire for non-VTE terminal flavors', () => {
    // Assert
    for (const terminal of [
      'kitty',
      'ghostty',
      'alacritty',
      'wezterm',
      'iTerm.app',
      'windows-terminal',
      'unknown',
      undefined,
    ]) {
      expect(hasUnknownSequencePrintingBug(bugCtx({ terminal }))).toBe(false)
    }
  })

  test('requires TERM starting with "xterm"', () => {
    // Assert
    expect(
      hasUnknownSequencePrintingBug(
        bugCtx({ envOverrides: { TERM: 'screen-256color' } }),
      ),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { TERM: undefined } })),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { TERM: 'xterm' } })),
    ).toBe(true)
  })

  test('each escape-hatch env var alone disables detection', () => {
    // Assert — a real tmux/screen/xterm/alacritty/kitty/wezterm/editor-pty
    // session forwards VTE_VERSION but parses sequences itself.
    const exemptions: Array<Record<string, string>> = [
      { TMUX: '/tmp/tmux-1000/default,123,0' },
      { STY: '1234.pts-0.host' },
      { XTERM_VERSION: 'XTerm(389)' },
      { ALACRITTY_WINDOW_ID: '1' },
      { ALACRITTY_LOG: '/tmp/alacritty.log' },
      { KITTY_WINDOW_ID: '1' },
      { WEZTERM_PANE: '0' },
      { INSIDE_EMACS: '29.4,term:0.96' },
      { VIM_TERMINAL: '1' },
      { NVIM: '/tmp/nvim.user/0' },
    ]
    for (const envOverrides of exemptions) {
      expect(hasUnknownSequencePrintingBug(bugCtx({ envOverrides }))).toBe(false)
    }
  })

  test('ZELLIJ uses the official undefined check — even "" counts as inside Zellij', () => {
    // Assert — official: `e.ZELLIJ===void 0` (not the trim helper)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { ZELLIJ: '' } })),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { ZELLIJ: '1' } })),
    ).toBe(false)
    expect(
      hasUnknownSequencePrintingBug(bugCtx({ envOverrides: { ZELLIJ: undefined } })),
    ).toBe(true)
  })

  test('isVteBasedTerminal ignores the version (detection split matches official)', () => {
    // Assert — the VTE-based check has no version clause; the <5300
    // comparison lives in hasUnknownSequencePrintingBug only.
    expect(isVteBasedTerminal(bugCtx({ envOverrides: { VTE_VERSION: '9999' } }))).toBe(true)
    expect(isVteBasedTerminal(bugCtx({ terminal: 'ghostty' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Zero-arg accessor (official b6()) — env-driven
// ---------------------------------------------------------------------------

describe('CC 2.1.301 WP-H: printsUnknownSequences (b6 accessor)', () => {
  test('true on a bare older-VTE session, false otherwise', () => {
    // Arrange
    env.terminal = 'vte-based'
    process.env['VTE_VERSION'] = '5200'
    process.env['TERM'] = 'xterm-256color'

    // Act / Assert
    expect(printsUnknownSequences()).toBe(true)

    // Arrange — same session but VTE 0.76 (Fedora 40 GNOME Terminal)
    process.env['VTE_VERSION'] = '7600'

    // Act / Assert
    expect(printsUnknownSequences()).toBe(false)
  })

  test('false on normal terminals — no false positives', () => {
    // Arrange / Act / Assert — iTerm2 (the GOK terminal) and friends must
    // never trip the gate: their XTVERSION/`>4m`/`<u` handling is correct.
    env.terminal = 'iTerm.app'
    process.env['TERM'] = 'xterm-256color'
    process.env['TERM_PROGRAM'] = 'iTerm.app'
    expect(printsUnknownSequences()).toBe(false)
    delete process.env['TERM_PROGRAM']

    env.terminal = 'kitty'
    process.env['KITTY_WINDOW_ID'] = '1'
    expect(printsUnknownSequences()).toBe(false)
    delete process.env['KITTY_WINDOW_ID']

    env.terminal = 'unknown'
    expect(printsUnknownSequences()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suppression behavior — the gated keyboard-protocol sequences
// ---------------------------------------------------------------------------

describe('CC 2.1.301 WP-H: extended-keys sequence suppression', () => {
  /** Put the fixture env into bare-older-VTE mode. */
  function arrangeBuggyVte(): void {
    env.terminal = 'vte-based'
    process.env['VTE_VERSION'] = '5200'
    process.env['TERM'] = 'xterm-256color'
  }

  /** Put the fixture env into modern-VTE mode (gate must stay open). */
  function arrangeModernVte(): void {
    env.terminal = 'vte-based'
    process.env['VTE_VERSION'] = '7600'
    process.env['TERM'] = 'xterm-256color'
  }

  test('guiEditorModeDisableSeq omits CSI <u and CSI >4m on buggy VTE', () => {
    // Arrange
    arrangeBuggyVte()

    // Act
    const seq = guiEditorModeDisableSeq(true)

    // Assert — keyboard resets suppressed; mouse/focus disables survive
    expect(seq).not.toContain('\x1b[<u')
    expect(seq).not.toContain('\x1b[>4m')
    expect(seq).toContain('\x1b[?1003l') // DISABLE_MOUSE_TRACKING
    expect(seq).toContain('\x1b[?1004l') // DFE
  })

  test('guiEditorModeRestoreSeq omits the keyboard block on buggy VTE', () => {
    // Arrange
    arrangeBuggyVte()

    // Act
    const seq = guiEditorModeRestoreSeq(true)

    // Assert — no `<u`/`>1u`/`>4;2m`; mouse/focus restores survive
    expect(seq).not.toContain('\x1b[<u')
    expect(seq).not.toContain('\x1b[>1u')
    expect(seq).not.toContain('\x1b[>4;2m')
    expect(seq).toContain('\x1b[?1003h') // ENABLE_MOUSE_TRACKING
    expect(seq).toContain('\x1b[?1004h') // EFE
  })

  test('modern VTE keeps every sequence (no false positives)', () => {
    // Arrange
    arrangeModernVte()

    // Act
    const disable = guiEditorModeDisableSeq(false)
    const restore = guiEditorModeRestoreSeq(false)

    // Assert — full keyboard blocks emitted, same as before the port
    expect(disable).toContain('\x1b[<u')
    expect(disable).toContain('\x1b[>4m')
    expect(restore).toContain('\x1b[<u')
    expect(restore).toContain('\x1b[>1u')
    expect(restore).toContain('\x1b[>4;2m')
  })

  test('normal input text is never affected — gate is emitter-side only', async () => {
    // Arrange — even on buggy VTE the guard only suppresses OUR outbound
    // sequences; it must not filter inbound stdin (no speculative input
    // filters per WP-H discipline).
    arrangeBuggyVte()

    // Act — parse-keypress has no GOK/kitty-graphics handling and the port
    // added none; legitimate user text like ">0q" typed at the prompt is
    // still just text.
    const { INITIAL_STATE, parseMultipleKeypresses } = await import(
      '../parse-keypress.js'
    )
    const [parsed] = parseMultipleKeypresses(INITIAL_STATE, '>0q>4m GOK')

    // Assert
    const text = parsed
      .map(p => ('sequence' in p ? p.sequence : ''))
      .join('')
    expect(text).toContain('>0q')
    expect(text).toContain('>4m')
    expect(text).toContain('GOK')
  })
})
