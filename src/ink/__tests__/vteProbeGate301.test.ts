/**
 * CC 2.1.301 changelog #15 — "Fixed terminal query sequences appearing as
 * text on some older terminals" (VTE < 0.53, e.g. MATE Terminal on RHEL 8,
 * prints unrecognized CSI >-family queries as stray text: `>0q` on the trust
 * prompt, `>4m` at exit).
 *
 * Official v301 evidence (byte-verified via grep -aboF + dd; binary NEVER
 * executed). All of these are v301-NEW — v300 has zero occurrences:
 *
 * - Predicate `hasUnknownSequencePrintingBug(r)` @220859789:
 *     return this.isVteBasedTerminal(r)
 *       && Number.parseInt(this.proc.env.VTE_VERSION ?? "", 10) < 5300
 * - `isVteBasedTerminal(r)` @220858997 (with `g(x)` = trimmed-nonempty
 *   @220860439):
 *     g(VTE_VERSION) && (r==="vte-based"||r==="gnome-terminal")
 *     && (TERM??"").trim().startsWith("xterm") && !g(TMUX) && !g(STY)
 *     && ZELLIJ===void 0 && !g(XTERM_VERSION) && !g(ALACRITTY_WINDOW_ID)
 *     && !g(ALACRITTY_LOG) && !g(KITTY_WINDOW_ID) && !g(WEZTERM_PANE)
 *     && !g(INSIDE_EMACS) && !g(VIM_TERMINAL) && !g(NVIM)
 * - Startup probe batch gate @231942639: `R=!b6()` then
 *     [T,D,A,H]=await Promise.all([
 *       R?n.send(Q5o()):Promise.resolve(void 0), ... , n.flush()])
 *   — gated sends resolve undefined WITHOUT writing; flush() (DA1 sentinel)
 *   stays unconditional.
 * - Official v301-only debug string @231943157:
 *     "XTVERSION: not asked (VTE before 0.53 would show the query as text)"
 * - Capability source string @231673843:
 *     `env: terminal=${e}, VTE before 0.53 (shows the query as text)`
 *
 * ADAPTATION NOTES (OCC has no capability-record store, and App.tsx's
 * XTVERSION send site is outside this port's file ownership):
 * - The gate lives inside TerminalQuerier.send() via a `vteEchoedProbe` tag
 *   on the affected query builders (xtversion, kittyKeyboard, decrqm) plus
 *   an optional constructor predicate defaulting to `printsUnknownSequences()`
 *   (the occ160 main-line no-arg `b6()` accessor — re-reads env.terminal +
 *   process.env at call time) — observable behavior matches the official
 *   batch gate (resolve undefined, write nothing, debug string). This gate
 *   complements occ160 WP-H's emitter-side gating; the querier covers the
 *   probe-send side the official gates at @231942639.
 * - For non-XTVERSION probes OCC logs the official capability source string
 *   verbatim inside the skip message (the official records it as the
 *   capability's `source`; OCC has no such record — helper lives in
 *   terminal-querier.ts).
 * - Untagged (fire as today even under the gate): DA1/DA2 (VTE has answered
 *   device-attributes since forever — the official keeps `n.flush()`
 *   unconditional), cursorPosition, oscColor, osc52Read.
 *
 * DEDICATED mock.module FILE: debug.js (log capture) is a process-global
 * mock; it is re-pinned in afterAll (same pattern as osc52VteGuard296).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

// --- Seam: capture the debug log (must be registered before module import) ---
const actualDebugModule = await import('../../utils/debug.js')
const capturedLogs: string[] = []
mock.module('../../utils/debug.js', () => ({
  ...(actualDebugModule as object),
  logForDebugging: (message: string) => {
    capturedLogs.push(message)
  },
}))

const {
  isVteBasedTerminal,
  hasUnknownSequencePrintingBug,
  printsUnknownSequences,
} = await import('../terminal.js')
const {
  TerminalQuerier,
  cursorPosition,
  da1,
  da2,
  decrqm,
  kittyKeyboard,
  vteSequenceBugSkipSource,
  xtversion,
} = await import('../terminal-querier.js')
const { env } = await import('../../utils/env.js')

import type { TerminalResponse } from '../parse-keypress.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUARD_ENV_KEYS = [
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
let savedTerminal: string | null | undefined

/** Official `g(x)` truthy-fixture: a bare VTE terminal predating 0.53. */
function vteSignals(overrides: Record<string, string> = {}) {
  return {
    terminal: 'vte-based',
    env: { VTE_VERSION: '5200', TERM: 'xterm-256color', ...overrides },
  }
}

type MockStdout = NodeJS.WriteStream & { writes: string[] }

function makeMockStdout(): MockStdout {
  const emitter = new EventEmitter() as EventEmitter & {
    columns: number
    rows: number
    isTTY: boolean
    writes: string[]
    write: (chunk: string) => boolean
  }
  emitter.columns = 80
  emitter.rows = 24
  emitter.isTTY = false
  emitter.writes = []
  emitter.write = (chunk: string): boolean => {
    emitter.writes.push(String(chunk))
    return true
  }
  return emitter as unknown as MockStdout
}

beforeEach(() => {
  for (const key of GUARD_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  savedTerminal = env.terminal
  env.terminal = 'vte-based'
  capturedLogs.length = 0
})

afterEach(() => {
  for (const key of GUARD_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  env.terminal = savedTerminal
})

afterAll(() => {
  // Re-pin the real debug module (mock.module is process-global).
  mock.module('../../utils/debug.js', () => actualDebugModule)
})

// ---------------------------------------------------------------------------
// Suite A: isVteBasedTerminal (official @220858997)
// ---------------------------------------------------------------------------

describe('CC 2.1.301 #15: isVteBasedTerminal', () => {
  test('vte-based + xterm TERM + VTE_VERSION → true', () => {
    expect(isVteBasedTerminal(vteSignals())).toBe(true)
  })

  test('gnome-terminal flavor → true', () => {
    expect(isVteBasedTerminal({ ...vteSignals(), terminal: 'gnome-terminal' })).toBe(true)
  })

  test('other terminal flavors → false', () => {
    for (const terminal of ['iTerm.app', 'kitty', 'xterm', 'vscode', undefined]) {
      expect(isVteBasedTerminal({ ...vteSignals(), terminal })).toBe(false)
    }
  })

  test('TERM must start with xterm', () => {
    expect(isVteBasedTerminal(vteSignals({ TERM: 'screen-256color' }))).toBe(false)
    expect(isVteBasedTerminal(vteSignals({ TERM: 'xterm' }))).toBe(true)
  })

  test('missing TERM → false (official (TERM ?? "").trim().startsWith)', () => {
    const s = vteSignals()
    delete s.env.TERM
    expect(isVteBasedTerminal(s)).toBe(false)
  })

  test('VTE_VERSION blank → false (official g() trim check)', () => {
    expect(isVteBasedTerminal(vteSignals({ VTE_VERSION: '' }))).toBe(false)
    expect(isVteBasedTerminal(vteSignals({ VTE_VERSION: '   ' }))).toBe(false)
  })

  test('multiplexers exclude (TMUX / STY)', () => {
    expect(isVteBasedTerminal(vteSignals({ TMUX: '/tmp/tmux-1000/0,default,1' }))).toBe(false)
    expect(isVteBasedTerminal(vteSignals({ STY: '12345.pts-0.host' }))).toBe(false)
  })

  test('ZELLIJ merely defined excludes (official === void 0, not g())', () => {
    expect(isVteBasedTerminal(vteSignals({ ZELLIJ: '1' }))).toBe(false)
    expect(isVteBasedTerminal(vteSignals({ ZELLIJ: '' }))).toBe(false)
  })

  test('competing terminal markers exclude', () => {
    const markers: Record<string, string> = {
      XTERM_VERSION: 'XTerm(379)',
      ALACRITTY_WINDOW_ID: '1',
      ALACRITTY_LOG: '/tmp/alacritty.log',
      KITTY_WINDOW_ID: '1',
      WEZTERM_PANE: '0',
      INSIDE_EMACS: '29.1,term:0.96',
      VIM_TERMINAL: '1',
      NVIM: '/tmp/nvim.user/0',
    }
    for (const [key, value] of Object.entries(markers)) {
      expect(isVteBasedTerminal(vteSignals({ [key]: value }))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Suite B: hasUnknownSequencePrintingBug (official @220859789)
// ---------------------------------------------------------------------------

describe('CC 2.1.301 #15: hasUnknownSequencePrintingBug', () => {
  test('VTE_VERSION 5200 (< 5300) → true', () => {
    expect(hasUnknownSequencePrintingBug(vteSignals())).toBe(true)
  })

  test('boundary: 5299 → true, 5300 → false', () => {
    expect(hasUnknownSequencePrintingBug(vteSignals({ VTE_VERSION: '5299' }))).toBe(true)
    expect(hasUnknownSequencePrintingBug(vteSignals({ VTE_VERSION: '5300' }))).toBe(false)
  })

  test('modern VTE (7000) → false', () => {
    expect(hasUnknownSequencePrintingBug(vteSignals({ VTE_VERSION: '7000' }))).toBe(false)
  })

  test('VTE_VERSION unset → false (official parseInt("" ?? ,10) = NaN)', () => {
    const s = vteSignals()
    delete s.env.VTE_VERSION
    // VTE_VERSION absent also fails the isVteBased g() check — both paths
    // agree: probes fire as today.
    expect(hasUnknownSequencePrintingBug(s)).toBe(false)
  })

  test('non-numeric VTE_VERSION → false (NaN < 5300 is false)', () => {
    expect(hasUnknownSequencePrintingBug(vteSignals({ VTE_VERSION: 'abc' }))).toBe(false)
  })

  test('leading-whitespace VTE_VERSION parses (Number.parseInt semantics)', () => {
    expect(hasUnknownSequencePrintingBug(vteSignals({ VTE_VERSION: ' 5200' }))).toBe(true)
  })

  test('default signals: printsUnknownSequences reads env.terminal + process.env at call time', () => {
    // beforeEach set env.terminal = 'vte-based' and cleared the env keys.
    expect(printsUnknownSequences()).toBe(false)
    process.env.VTE_VERSION = '5200'
    process.env.TERM = 'xterm-256color'
    expect(printsUnknownSequences()).toBe(true)
    process.env.VTE_VERSION = '6800'
    expect(printsUnknownSequences()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suite C: capability source string (official @231673843)
// ---------------------------------------------------------------------------

describe('CC 2.1.301 #15: vteSequenceBugSkipSource', () => {
  test('mirrors the official source string byte-for-byte', () => {
    expect(vteSequenceBugSkipSource('vte-based')).toBe(
      'env: terminal=vte-based, VTE before 0.53 (shows the query as text)',
    )
  })
})

// ---------------------------------------------------------------------------
// Suite D: TerminalQuerier gate (official batch @231942639 behavior)
// ---------------------------------------------------------------------------

const XTVERSION_SKIP_LOG =
  'XTVERSION: not asked (VTE before 0.53 would show the query as text)'
const OFFICIAL_SOURCE =
  'env: terminal=vte-based, VTE before 0.53 (shows the query as text)'

describe('CC 2.1.301 #15: TerminalQuerier gated probes', () => {
  test('gate ON: send(xtversion()) resolves undefined and writes nothing', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => true)

    await expect(q.send(xtversion())).resolves.toBeUndefined()
    expect(stdout.writes).toEqual([])
    // Official v301-only debug string, byte-for-byte.
    expect(capturedLogs).toContain(XTVERSION_SKIP_LOG)
  })

  test('gate ON: send(kittyKeyboard()) resolves undefined, writes nothing, logs source', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => true)

    await expect(q.send(kittyKeyboard())).resolves.toBeUndefined()
    expect(stdout.writes).toEqual([])
    expect(capturedLogs.some(l => l.includes(OFFICIAL_SOURCE))).toBe(true)
  })

  test('gate ON: send(decrqm(2026)) resolves undefined and writes nothing', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => true)

    await expect(q.send(decrqm(2026))).resolves.toBeUndefined()
    expect(stdout.writes).toEqual([])
  })

  test('gate ON: flush() still writes the DA1 sentinel unconditionally', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => true)

    const flushDone = q.flush()
    expect(stdout.writes).toEqual(['\x1b[c'])
    q.onResponse({ type: 'da1', params: [] } as unknown as TerminalResponse)
    await flushDone
  })

  test('gate ON: untagged queries (da1/da2/cursorPosition) still fire', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => true)

    void q.send(da1())
    void q.send(da2())
    void q.send(cursorPosition())
    expect(stdout.writes).toEqual(['\x1b[c', '\x1b[>c', '\x1b[?6n'])
  })

  test('gate ON: default construction reads live env (integration path)', async () => {
    process.env.VTE_VERSION = '5200'
    process.env.TERM = 'xterm-256color'
    // env.terminal already 'vte-based' via beforeEach.
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)

    await expect(q.send(xtversion())).resolves.toBeUndefined()
    expect(stdout.writes).toEqual([])
  })

  test('gate OFF: send(xtversion()) writes CSI >0q as today', async () => {
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream, () => false)

    const pending = q.send(xtversion())
    expect(stdout.writes).toEqual(['\x1b[>0q'])
    // Complete the round-trip so the promise resolves.
    q.onResponse({ type: 'xtversion', name: 'GNOME Terminal' } as unknown as TerminalResponse)
    const r = await pending
    expect(r?.type).toBe('xtversion')
  })

  test('default construction without VTE env fires probes (regression guard)', async () => {
    // beforeEach cleared VTE_VERSION etc.; env.terminal is 'vte-based' but
    // the version gate (parseInt('' ,10) = NaN) keeps the bug false.
    const stdout = makeMockStdout()
    const q = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)

    const pending = q.send(decrqm(2026))
    expect(stdout.writes).toEqual(['\x1b[?2026$p'])
    const flushDone = q.flush()
    q.onResponse({ type: 'da1', params: [] } as unknown as TerminalResponse)
    await expect(pending).resolves.toBeUndefined()
    await flushDone
  })
})
