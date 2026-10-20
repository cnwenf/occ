/**
 * CC 2.1.304 changelog #41 — `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200k` silently
 * became a 200-token (→100k-clamped) window; official 304 adds k/M suffix
 * parsing, clamp-to-bounds, and user-facing warnings.
 *
 * Official symbols (byte-verified from the 2.1.304 linux-x64 ELF; offsets in
 * docs/gap-research-304/research-R3-session-api.md §#41):
 *   j_e @246816065 = parseAutoCompactWindowSize
 *   yVe (bareThousands:false) = parseAutoCompactWindowEnv
 *   T4t @246816476 = resolveAutoCompactWindowEnvTokens
 *   E4t @246817300 = buildAutoCompactWindowEnvMessage (verbatim strings)
 *   XFe = buildAutoCompactWindowEnvWarning (msg-or-null)
 *   ySs @246816655 = warnAutoCompactWindowEnv (telemetry `compact_window_env`)
 *   gP=1e5 / vN=1e6 / v4t=32
 *
 * Mock plumbing mirrors autoCompactWindowWarnGate300.test.ts (settings seam)
 * and dangerousRmAutoDenyWindow281.test.ts (analytics capture with a
 * passthrough flag so the process-global mock stays behavior-neutral for
 * later files in the shared test process).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Mock plumbing
// ---------------------------------------------------------------------------

const actualAnalytics = await import('../../services/analytics/index.js')
const actualSettingsModule = await import('../settings/settings.js')
const actualConstantsModule = await import('../settings/constants.js')

let loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
let env304MocksActive = true
const actualLogEvent = actualAnalytics.logEvent as (
  name: string,
  metadata: Record<string, unknown>,
) => void

mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (env304MocksActive) {
      loggedEvents.push({ name, metadata })
    } else {
      actualLogEvent(name, metadata)
    }
  },
}))

let settingsBySource: Record<string, Record<string, unknown> | null> = {}
let enabledSources: string[] = ['userSettings']

const actualGetSettingsForSource = actualSettingsModule.getSettingsForSource
const actualGetEnabledSettingSources =
  actualConstantsModule.getEnabledSettingSources

mock.module('../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (
    source: Parameters<typeof actualGetSettingsForSource>[0],
  ) =>
    env304MocksActive
      ? (settingsBySource[source] ?? null)
      : actualGetSettingsForSource(source),
}))

mock.module('../settings/constants.js', () => ({
  ...actualConstantsModule,
  getEnabledSettingSources: () =>
    env304MocksActive
      ? [...enabledSources]
      : actualGetEnabledSettingSources(),
}))

afterAll(() => {
  env304MocksActive = false
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
  mock.module('../settings/settings.js', () => ({
    ...actualSettingsModule,
    getSettingsForSource: actualGetSettingsForSource,
  }))
  mock.module('../settings/constants.js', () => ({
    ...actualConstantsModule,
    getEnabledSettingSources: actualGetEnabledSettingSources,
  }))
})

// Modules under test — imported AFTER mocks.
const {
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  buildAutoCompactWindowEnvWarning,
  parseAutoCompactWindowEnv,
  parseAutoCompactWindowInput,
  parseAutoCompactWindowSize,
  resolveAutoCompactWindow,
  resolveAutoCompactWindowEnvTokens,
  warnAutoCompactWindowEnv,
} = await import('../autoCompactWindow.js')
const { call: autocompactCall } = await import(
  '../../commands/autocompact/autocompact-noninteractive.js'
)
import type { ToolUseContext } from '../../Tool.js'

// ---------------------------------------------------------------------------
// Env hygiene + fixtures
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const SONNET = 'claude-sonnet-4-6'
const CTX = 200_000

const GUARDED_ENV_KEYS = [
  ENV_KEY,
  'CLAUDE_CODE_ENTRYPOINT',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'USER_TYPE',
] as const

let tmpConfig = ''
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
let savedEnv: Record<string, string | undefined> = {}

function makeContext(model: string): ToolUseContext {
  return { options: { mainLoopModel: model } } as unknown as ToolUseContext
}

beforeEach(() => {
  tmpConfig = mkdtempSync(join(tmpdir(), 'occ-acw-env-304-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfig
  savedEnv = {}
  for (const key of GUARDED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  loggedEvents = []
  settingsBySource = {}
  enabledSources = ['userSettings']
})

afterEach(() => {
  for (const key of GUARDED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  rmSync(tmpConfig, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// j_e / yVe — core parser with bareThousands:false for the env variant
// ---------------------------------------------------------------------------

describe('2.1.304 #41 parseAutoCompactWindowSize (official `j_e` port)', () => {
  test('"k" suffix multiplies by 1000 (case-insensitive)', () => {
    // Arrange / Act
    const lower = parseAutoCompactWindowSize('200k', { bareThousands: false })
    const upper = parseAutoCompactWindowSize('200K', { bareThousands: false })

    // Assert
    expect(lower).toEqual({ kind: 'in_range', tokens: 200_000, suffixed: true })
    expect(upper).toEqual({ kind: 'in_range', tokens: 200_000, suffixed: true })
  })

  test('"m" suffix multiplies by 1e6; 5M is above_maximum', () => {
    expect(parseAutoCompactWindowSize('1m', { bareThousands: false })).toEqual({
      kind: 'in_range',
      tokens: 1_000_000,
      suffixed: true,
    })
    expect(parseAutoCompactWindowSize('5M', { bareThousands: false })).toEqual({
      kind: 'above_maximum',
    })
  })

  test('bare env value gets NO thousands shorthand (bareThousands:false)', () => {
    // "200" as an ENV value reads as 200 tokens → below_minimum; the
    // /autocompact flag parser (bareThousands:true) reads it as 200000.
    expect(parseAutoCompactWindowEnv('200')).toEqual({
      kind: 'below_minimum',
      tokens: 200,
    })
    expect(parseAutoCompactWindowSize('200', { bareThousands: true })).toEqual({
      kind: 'in_range',
      tokens: 200_000,
      suffixed: false,
    })
    expect(parseAutoCompactWindowInput('200')).toBe(200_000)
  })

  test('below_minimum clamps reported tokens to min(99999, round)', () => {
    expect(parseAutoCompactWindowEnv('50')).toEqual({
      kind: 'below_minimum',
      tokens: 50,
    })
    expect(parseAutoCompactWindowEnv('99999.6')).toEqual({
      kind: 'below_minimum',
      tokens: 99_999,
    })
  })

  test('unusable: garbage, empty, and sub-1 values', () => {
    expect(parseAutoCompactWindowEnv('abc')).toEqual({ kind: 'unusable' })
    expect(parseAutoCompactWindowEnv('')).toEqual({ kind: 'unusable' })
    expect(parseAutoCompactWindowEnv('0.5')).toEqual({ kind: 'unusable' })
    expect(parseAutoCompactWindowEnv('0')).toEqual({ kind: 'unusable' })
  })

  test('boundary values are in_range', () => {
    expect(parseAutoCompactWindowEnv('100000')).toEqual({
      kind: 'in_range',
      tokens: AUTO_COMPACT_WINDOW_MIN,
      suffixed: false,
    })
    expect(parseAutoCompactWindowEnv('1000000')).toEqual({
      kind: 'in_range',
      tokens: AUTO_COMPACT_WINDOW_MAX,
      suffixed: false,
    })
    expect(parseAutoCompactWindowEnv('1000001')).toEqual({
      kind: 'above_maximum',
    })
  })
})

// ---------------------------------------------------------------------------
// T4t — env resolver (clamp / ignore)
// ---------------------------------------------------------------------------

describe('2.1.304 #41 resolveAutoCompactWindowEnvTokens (official `T4t` port)', () => {
  test('in_range passes tokens through', () => {
    expect(resolveAutoCompactWindowEnvTokens('200k')).toBe(200_000)
    expect(resolveAutoCompactWindowEnvTokens('200000')).toBe(200_000)
  })

  test('below_minimum clamps UP to the 100k minimum', () => {
    expect(resolveAutoCompactWindowEnvTokens('50')).toBe(
      AUTO_COMPACT_WINDOW_MIN,
    )
    expect(resolveAutoCompactWindowEnvTokens('200')).toBe(
      AUTO_COMPACT_WINDOW_MIN,
    )
  })

  test('above_maximum clamps DOWN to the 1M maximum', () => {
    expect(resolveAutoCompactWindowEnvTokens('5M')).toBe(
      AUTO_COMPACT_WINDOW_MAX,
    )
  })

  test('unusable and unset are ignored (undefined)', () => {
    expect(resolveAutoCompactWindowEnvTokens('abc')).toBeUndefined()
    expect(resolveAutoCompactWindowEnvTokens('')).toBeUndefined()
    expect(resolveAutoCompactWindowEnvTokens(undefined)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Yb env branch inside resolveAutoCompactWindow — the actual #41 bug fix
// ---------------------------------------------------------------------------

describe('2.1.304 #41 resolveAutoCompactWindow env branch (official `Yb`)', () => {
  test('"200k" resolves to a 200000-token env window (was parseInt→200)', () => {
    // Arrange
    process.env[ENV_KEY] = '200k'

    // Act
    const resolved = resolveAutoCompactWindow(SONNET, 1_000_000, undefined)

    // Assert — the pre-304 parseInt branch produced window=min(ctx,200)=200.
    expect(resolved).toEqual({
      window: 200_000,
      configured: 200_000,
      source: 'env',
    })
  })

  test('below-minimum env clamps to 100k with source "env"', () => {
    process.env[ENV_KEY] = '50'
    expect(resolveAutoCompactWindow(SONNET, CTX, undefined)).toEqual({
      window: AUTO_COMPACT_WINDOW_MIN,
      configured: AUTO_COMPACT_WINDOW_MIN,
      source: 'env',
    })
  })

  test('above-maximum env clamps to 1M, still capped by the context window', () => {
    process.env[ENV_KEY] = '5M'
    expect(resolveAutoCompactWindow(SONNET, CTX, undefined)).toEqual({
      window: CTX,
      configured: AUTO_COMPACT_WINDOW_MAX,
      source: 'env',
    })
  })

  test('unusable env is ignored — resolver falls through to auto', () => {
    process.env[ENV_KEY] = 'abc'
    expect(resolveAutoCompactWindow(SONNET, CTX, undefined)).toEqual({
      window: CTX,
      configured: CTX,
      source: 'auto',
    })
  })
})

// ---------------------------------------------------------------------------
// E4t / XFe — verbatim warning messages
// ---------------------------------------------------------------------------

const ADVICE =
  'Set it to a size from 100k to 1M, such as 200k or 200000, or unset it.'

describe('2.1.304 #41 buildAutoCompactWindowEnvWarning (official `XFe`/`E4t`)', () => {
  test('in-range and unset values produce no warning', () => {
    expect(buildAutoCompactWindowEnvWarning('200k')).toBeNull()
    expect(buildAutoCompactWindowEnvWarning('200000')).toBeNull()
    expect(buildAutoCompactWindowEnvWarning(undefined)).toBeNull()
  })

  test('below_minimum message is byte-verbatim', () => {
    expect(buildAutoCompactWindowEnvWarning('50')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="50" reads as 50 tokens, so Claude Code treats it as the 100k minimum. ${ADVICE}`,
    )
  })

  test('below_minimum pluralizes a single token (official `I(tokens,"token")`)', () => {
    expect(buildAutoCompactWindowEnvWarning('1')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="1" reads as 1 token, so Claude Code treats it as the 100k minimum. ${ADVICE}`,
    )
  })

  test('below_minimum formats tokens with en-US thousands separators', () => {
    expect(buildAutoCompactWindowEnvWarning('99999')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="99999" reads as 99,999 tokens, so Claude Code treats it as the 100k minimum. ${ADVICE}`,
    )
  })

  test('above_maximum message is byte-verbatim', () => {
    expect(buildAutoCompactWindowEnvWarning('5M')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="5M" is too large, so Claude Code treats it as the 1M maximum. ${ADVICE}`,
    )
  })

  test('unusable message is byte-verbatim', () => {
    expect(buildAutoCompactWindowEnvWarning('abc')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="abc" isn't a usable size, so Claude Code ignores it. ${ADVICE}`,
    )
  })

  test('disallowed characters collapse to "?" (official [^\\w.,+ $%{}=;-]+ filter)', () => {
    // Runs of disallowed characters each collapse to a single "?".
    // '50<k' parses as 50 * 1000 (parseFloat stops at '<') → below_minimum.
    expect(buildAutoCompactWindowEnvWarning('50<k')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="50?k" reads as 50,000 tokens, so Claude Code treats it as the 100k minimum. ${ADVICE}`,
    )
    // Allowed punctuation survives: word chars, . , + space $ % { } = ; -
    expect(buildAutoCompactWindowEnvWarning('a.b,c+d e$f%g{h}i=j;k-l')).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="a.b,c+d e$f%g{h}i=j;k-l" isn't a usable size, so Claude Code ignores it. ${ADVICE}`,
    )
  })

  test('values longer than 32 chars are truncated with an ellipsis', () => {
    // Arrange — 40 chars: 32 kept + "…"; the tail (chars 33-40) is dropped.
    const raw = `${'9'.repeat(32)}${'k'.repeat(8)}`

    // Act
    const warning = buildAutoCompactWindowEnvWarning(raw)

    // Assert — '9'*32 + 'k'*8 parses as a huge number → above_maximum.
    expect(warning).toBe(
      `CLAUDE_CODE_AUTO_COMPACT_WINDOW="${'9'.repeat(32)}…" is too large, so Claude Code treats it as the 1M maximum. ${ADVICE}`,
    )
  })
})

// ---------------------------------------------------------------------------
// ySs — startup emitter: telemetry + interactive/headless surfacing
// ---------------------------------------------------------------------------

describe('2.1.304 #41 warnAutoCompactWindowEnv (official `ySs` port)', () => {
  test('unset env is a no-op (no telemetry, no surfacing)', () => {
    // Arrange
    const headless: string[] = []

    // Act
    warnAutoCompactWindowEnv(undefined, {
      interactive: false,
      headless: m => headless.push(m),
    })

    // Assert
    expect(loggedEvents).toEqual([])
    expect(headless).toEqual([])
  })

  test('in-range env is silent', () => {
    const headless: string[] = []
    warnAutoCompactWindowEnv('200k', {
      interactive: false,
      headless: m => headless.push(m),
    })
    expect(loggedEvents).toEqual([])
    expect(headless).toEqual([])
  })

  test('below_minimum logs compact_window_env + flag-accepts and surfaces headless', () => {
    // Arrange
    const headless: string[] = []

    // Act — "200" warns for the env but /autocompact 200 IS valid shorthand.
    warnAutoCompactWindowEnv('200', {
      interactive: false,
      headless: m => headless.push(m),
    })

    // Assert
    expect(loggedEvents).toEqual([
      {
        name: 'compact_window_env',
        metadata: { kind: 'below_minimum', below_minimum_flag_accepts: true },
      },
    ])
    expect(headless).toEqual([buildAutoCompactWindowEnvWarning('200')])
  })

  test('below_minimum records flag_accepts:false when the flag also rejects', () => {
    warnAutoCompactWindowEnv('50', { interactive: false })
    expect(loggedEvents).toEqual([
      {
        name: 'compact_window_env',
        metadata: { kind: 'below_minimum', below_minimum_flag_accepts: false },
      },
    ])
  })

  test('above_maximum logs kind only (no flag field)', () => {
    const headless: string[] = []
    warnAutoCompactWindowEnv('5M', {
      interactive: false,
      headless: m => headless.push(m),
    })
    expect(loggedEvents).toEqual([
      { name: 'compact_window_env', metadata: { kind: 'above_maximum' } },
    ])
    expect(headless).toEqual([buildAutoCompactWindowEnvWarning('5M')])
  })

  test('unusable logs kind only and surfaces headless', () => {
    const headless: string[] = []
    warnAutoCompactWindowEnv('abc', {
      interactive: false,
      headless: m => headless.push(m),
    })
    expect(loggedEvents).toEqual([
      { name: 'compact_window_env', metadata: { kind: 'unusable' } },
    ])
    expect(headless).toEqual([buildAutoCompactWindowEnvWarning('abc')])
  })

  test('interactive surfaces "[autocompact] <msg>" on stderr, skips headless', () => {
    // Arrange
    const written: string[] = []
    const realWrite = process.stderr.write
    const headless: string[] = []
    process.stderr.write = ((chunk: string) => {
      written.push(chunk)
      return true
    }) as typeof process.stderr.write

    try {
      // Act
      warnAutoCompactWindowEnv('50', {
        interactive: true,
        headless: m => headless.push(m),
      })
    } finally {
      process.stderr.write = realWrite
    }

    // Assert
    expect(written).toEqual([
      `[autocompact] ${buildAutoCompactWindowEnvWarning('50')}\n`,
    ])
    expect(headless).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// /autocompact non-interactive display — XFe line (official `u.push(p)`)
// ---------------------------------------------------------------------------

describe('2.1.304 #41 /autocompact describe shows the env warning line', () => {
  test('below-minimum env appends the verbatim warning after the prose', async () => {
    // Arrange
    process.env[ENV_KEY] = '50'

    // Act
    const { value } = await autocompactCall('', makeContext(SONNET))

    // Assert
    const lines = value.split('\n')
    expect(lines[lines.length - 1]).toBe(buildAutoCompactWindowEnvWarning('50'))
    expect(value).toContain('from CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  })

  test('in-range env adds no warning line', async () => {
    process.env[ENV_KEY] = '200k'
    const { value } = await autocompactCall('', makeContext(SONNET))
    expect(value).not.toContain('Set it to a size from 100k to 1M')
    expect(value).toContain('200k tokens (from CLAUDE_CODE_AUTO_COMPACT_WINDOW)')
  })

  test('unset env adds no warning line', async () => {
    const { value } = await autocompactCall('', makeContext(SONNET))
    expect(value).not.toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW="')
  })
})
