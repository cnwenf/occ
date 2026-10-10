/**
 * CC 2.1.296 #017 — suppress the stray `52;c;…` escape on older VTE
 * terminals.
 *
 * Official 2.1.296 guard (forensics-batch5 `yE`): with no multiplexer, a
 * successful native clipboard copy, platform linux/wsl, an R7r() predicate,
 * a vte-based/gnome-terminal flavor, TERM starting with "xterm", and none of
 * XTERM_VERSION / ALACRITTY_WINDOW_ID / ALACRITTY_LOG / KITTY_WINDOW_ID /
 * WEZTERM_PANE set, the official emits NOTHING (return "") instead of the
 * raw OSC 52 — older VTE leaks the sequence onto the screen as `52;c;…`.
 * The debug log gained the `emit=` field: none(vte)/raw+dcs/dcs/raw.
 *
 * DEVIATION NOTE: the official conjunction includes an opaque predicate
 * `R7r()` whose definition was not captured in any evidence file — it is
 * OMITTED from the OCC port (guard is at most as wide as official, and only
 * fires after the native copy already succeeded, so no clipboard loss).
 *
 * DEDICATED mock.module FILE: execFileNoThrow (native clipboard probes /
 * tmux load-buffer) + debug.js (log capture) are process-global mocks;
 * both are re-pinned in afterAll.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// --- Seam 1: controllable subprocess results --------------------------------
const actualExecModule = await import('../../utils/execFileNoThrow.js')
let execResults: Record<string, number> = {}
const execCalls: Array<{ cmd: string; args: string[] }> = []

mock.module('../../utils/execFileNoThrow.js', () => ({
  ...(actualExecModule as object),
  execFileNoThrow: async (cmd: string, args: string[]) => {
    execCalls.push({ cmd, args })
    return { code: execResults[cmd] ?? 1, stdout: '', stderr: '' }
  },
}))

// --- Seam 2: capture the clipboard debug log --------------------------------
const actualDebugModule = await import('../../utils/debug.js')
const capturedLogs: string[] = []
mock.module('../../utils/debug.js', () => ({
  ...(actualDebugModule as object),
  logForDebugging: (message: string) => {
    capturedLogs.push(message)
  },
}))

const {
  _resetLinuxCopyCache,
  getMultiplexer,
  setClipboard,
  shouldSuppressOsc52OnOlderVte,
} = await import('../termio/osc.js')
const { env } = await import('../../utils/env.js')

// ---------------------------------------------------------------------------
// Env fixture
// ---------------------------------------------------------------------------

const GUARD_ENV_KEYS = [
  'TERM',
  'TMUX',
  'STY',
  'SSH_CONNECTION',
  'XTERM_VERSION',
  'ALACRITTY_WINDOW_ID',
  'ALACRITTY_LOG',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'LC_TERMINAL',
] as const

const savedEnv: Record<string, string | undefined> = {}
let savedTerminal: string | undefined

beforeEach(() => {
  for (const key of GUARD_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedTerminal = env.terminal
  execResults = {}
  execCalls.length = 0
  capturedLogs.length = 0
  _resetLinuxCopyCache()
})

afterEach(() => {
  for (const key of GUARD_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  env.terminal = savedTerminal
  _resetLinuxCopyCache()
})

afterAll(() => {
  mock.module('../../utils/execFileNoThrow.js', () => actualExecModule as object)
  mock.module('../../utils/debug.js', () => actualDebugModule as object)
})

/** Full-conjunction context: every guard condition satisfied. */
function guardCtx(
  overrides: Partial<Parameters<typeof shouldSuppressOsc52OnOlderVte>[0]> = {},
) {
  return {
    mux: null,
    nativeAvailable: true,
    platform: 'linux',
    flavor: 'vte-based',
    env: { TERM: 'xterm-256color' },
    ...overrides,
  } as Parameters<typeof shouldSuppressOsc52OnOlderVte>[0]
}

// ---------------------------------------------------------------------------
// Pure predicate — the official conjunction, clause by clause
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #017: shouldSuppressOsc52OnOlderVte (pure predicate)', () => {
  test('fires only when the FULL conjunction holds', () => {
    // Assert
    expect(shouldSuppressOsc52OnOlderVte(guardCtx())).toBe(true)
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ platform: 'wsl' })),
    ).toBe(true)
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ flavor: 'gnome-terminal' })),
    ).toBe(true)
  })

  test('does not fire inside tmux or screen (DCS paths untouched)', () => {
    // Assert
    expect(shouldSuppressOsc52OnOlderVte(guardCtx({ mux: 'tmux' }))).toBe(false)
    expect(shouldSuppressOsc52OnOlderVte(guardCtx({ mux: 'screen' }))).toBe(false)
  })

  test('does not fire when the native copy was unavailable', () => {
    // Assert — nothing else put the text on the clipboard, so OSC 52 must go
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ nativeAvailable: false })),
    ).toBe(false)
  })

  test('does not fire off linux/wsl', () => {
    // Assert
    expect(shouldSuppressOsc52OnOlderVte(guardCtx({ platform: 'macos' }))).toBe(false)
    expect(shouldSuppressOsc52OnOlderVte(guardCtx({ platform: 'windows' }))).toBe(false)
    expect(shouldSuppressOsc52OnOlderVte(guardCtx({ platform: 'unknown' }))).toBe(false)
  })

  test('does not fire for non-VTE flavors', () => {
    // Assert
    for (const flavor of ['kitty', 'ghostty', 'alacritty', 'wezterm', 'unknown', undefined]) {
      expect(shouldSuppressOsc52OnOlderVte(guardCtx({ flavor }))).toBe(false)
    }
  })

  test('requires TERM starting with "xterm"', () => {
    // Assert
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ env: { TERM: 'screen-256color' } })),
    ).toBe(false)
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ env: {} })),
    ).toBe(false)
    expect(
      shouldSuppressOsc52OnOlderVte(guardCtx({ env: { TERM: 'xterm' } })),
    ).toBe(true)
  })

  test('each modern-terminal env var alone disables the guard', () => {
    // Assert — real xterm/alacritty/kitty/wezterm advertise themselves
    const exemptions: Array<Record<string, string>> = [
      { TERM: 'xterm-256color', XTERM_VERSION: 'XTerm(389)' },
      { TERM: 'xterm-256color', ALACRITTY_WINDOW_ID: '1' },
      { TERM: 'xterm-256color', ALACRITTY_LOG: '/tmp/alacritty.log' },
      { TERM: 'xterm-256color', KITTY_WINDOW_ID: '1' },
      { TERM: 'xterm-256color', WEZTERM_PANE: '0' },
    ]
    for (const envOverride of exemptions) {
      expect(shouldSuppressOsc52OnOlderVte(guardCtx({ env: envOverride }))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// getMultiplexer
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #017: getMultiplexer', () => {
  test('detects tmux, screen, and bare terminals', () => {
    // Arrange / Act / Assert
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    expect(getMultiplexer()).toBe('tmux')
    delete process.env['TMUX']

    process.env['STY'] = '1234.pts-0.host'
    expect(getMultiplexer()).toBe('screen')
    delete process.env['STY']

    expect(getMultiplexer()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// setClipboard integration (linux host; native probe via mocked exec)
// ---------------------------------------------------------------------------

describe('CC 2.1.296 #017: setClipboard guard integration', () => {
  test('returns "" on a bare older-VTE session after the native copy succeeded', async () => {
    // Arrange
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'
    execResults['wl-copy'] = 0 // native probe succeeds → nativeAvailable

    // Act
    const out = await setClipboard('hello')

    // Assert — no OSC 52 emitted at all; native copy still happened
    expect(out).toBe('')
    expect(execCalls.some(c => c.cmd === 'wl-copy')).toBe(true)
    const log = capturedLogs.find(m => m.startsWith('clipboard: setClipboard'))
    expect(log).toContain('mux=none')
    expect(log).toContain('ssh=false')
    expect(log).toContain('native=true')
    expect(log).toContain('emit=none(vte)')
    expect(log).toContain('bytes=5')
  })

  test('emits raw OSC 52 when XTERM_VERSION marks a real xterm', async () => {
    // Arrange
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'
    process.env['XTERM_VERSION'] = 'XTerm(389)'
    execResults['wl-copy'] = 0

    // Act
    const out = await setClipboard('hello')

    // Assert — ESC ] 52 ; c ; <b64> BEL
    expect(out).toBe(`\x1b]52;c;${Buffer.from('hello').toString('base64')}\x07`)
    expect(capturedLogs.find(m => m.startsWith('clipboard: setClipboard'))).toContain('emit=raw')
  })

  test.each([
    ['ALACRITTY_WINDOW_ID', '1'],
    ['ALACRITTY_LOG', '/tmp/alacritty.log'],
    ['KITTY_WINDOW_ID', '1'],
    ['WEZTERM_PANE', '0'],
  ])('emits raw OSC 52 when %s is set', async (key, value) => {
    // Arrange
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'
    process.env[key] = value
    execResults['wl-copy'] = 0

    // Act
    const out = await setClipboard('hello')

    // Assert
    expect(out).toContain(']52;c;')
  })

  test('emits raw OSC 52 when the native probe finds no clipboard tool', async () => {
    // Arrange — vte + xterm TERM, but wl-copy/xclip/xsel all fail
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'

    // Act
    const out = await setClipboard('hello')

    // Assert — guard needs nativeAvailable; OSC 52 is the only path left
    expect(out).toContain(']52;c;')
    expect(capturedLogs.find(m => m.startsWith('clipboard: setClipboard'))).toContain('native=false')
  })

  test('emits raw OSC 52 over SSH (native copy skipped entirely)', async () => {
    // Arrange
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'
    process.env['SSH_CONNECTION'] = '10.0.0.1 1234 10.0.0.2 22'
    execResults['wl-copy'] = 0

    // Act
    const out = await setClipboard('hello')

    // Assert — ssh=true → native=false → guard cannot fire
    expect(out).toContain(']52;c;')
    expect(execCalls.some(c => c.cmd === 'wl-copy')).toBe(false)
    const log = capturedLogs.find(m => m.startsWith('clipboard: setClipboard'))
    expect(log).toContain('ssh=true')
    expect(log).toContain('native=false')
  })

  test('emits raw OSC 52 for non-VTE flavors', async () => {
    // Arrange
    env.terminal = 'ghostty'
    process.env['TERM'] = 'xterm-256color'
    execResults['wl-copy'] = 0

    // Act
    const out = await setClipboard('hello')

    // Assert
    expect(out).toContain(']52;c;')
  })

  test('tmux path is untouched by the guard (DCS passthrough still emitted)', async () => {
    // Arrange — inside tmux on a vte-based terminal with xterm TERM
    env.terminal = 'vte-based'
    process.env['TERM'] = 'xterm-256color'
    process.env['TMUX'] = '/tmp/tmux-1000/default,123,0'
    execResults['wl-copy'] = 0
    execResults['tmux'] = 0 // load-buffer succeeds

    // Act
    const out = await setClipboard('hello')

    // Assert — DCS tmux passthrough wrapping the inner OSC 52
    expect(out).toBe(
      `\x1bPtmux;\x1b\x1b]52;c;${Buffer.from('hello').toString('base64')}\x07\x1b\\`,
    )
    expect(capturedLogs.find(m => m.startsWith('clipboard: setClipboard'))).toContain('mux=tmux')
  })

  test('caches the linux tool: second call skips the probe but keeps native=true', async () => {
    // Arrange
    env.terminal = 'ghostty' // guard off — observe emission, not suppression
    execResults['wl-copy'] = 0

    // Act
    await setClipboard('first')
    const callsAfterFirst = execCalls.filter(c => c.cmd === 'wl-copy').length
    await setClipboard('second')
    const callsAfterSecond = execCalls.filter(c => c.cmd === 'wl-copy').length

    // Assert — probe ran once; cached path still fires the copy
    expect(callsAfterFirst).toBe(1)
    expect(callsAfterSecond).toBe(2)
    const log = capturedLogs.find(m => m.includes('bytes=6'))
    expect(log).toContain('native=true')
  })
})
