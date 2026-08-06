import { afterEach, describe, expect, test } from 'bun:test'
import { getEffectiveContextWindowSize } from '../../services/compact/autoCompact.js'
import {
  AUTO_COMPACT_WINDOW_MAX,
  AUTO_COMPACT_WINDOW_MIN,
  getSessionAutoCompactWindow,
  parseAutoCompactWindowInput,
  resolveAutoCompactWindowOverride,
  setSessionAutoCompactWindow,
} from '../autoCompactWindow.js'
import { SettingsSchema } from '../settings/types.js'

/**
 * OCC-58: official Claude Code 2.1.221 silently added the --autocompact
 * flag + autoCompactWindow settings key. Parser and merge semantics are
 * byte-verified from the 2.1.223 linux-x64 ELF (`Jon` / `Fju`).
 */

const ENV_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
const TEST_MODEL = 'claude-sonnet-4-6'

afterEach(() => {
  setSessionAutoCompactWindow(undefined)
  delete process.env[ENV_KEY]
})

describe('2.1.221 parseAutoCompactWindowInput (official `Jon` port)', () => {
  test('accepts "auto" (case-insensitive, trimmed)', () => {
    expect(parseAutoCompactWindowInput('auto')).toBe('auto')
    expect(parseAutoCompactWindowInput('  AUTO ')).toBe('auto')
  })

  test('"k" suffix multiplies by 1000', () => {
    expect(parseAutoCompactWindowInput('500k')).toBe(500_000)
    expect(parseAutoCompactWindowInput('100K')).toBe(100_000)
    expect(parseAutoCompactWindowInput('0.5k')).toBe(undefined) // 500 < min
  })

  test('"m" suffix multiplies by 1e6', () => {
    expect(parseAutoCompactWindowInput('1m')).toBe(1_000_000)
    expect(parseAutoCompactWindowInput('0.5m')).toBe(500_000)
    expect(parseAutoCompactWindowInput('1.5m')).toBe(undefined) // > max
  })

  test('bare value in [100, 1000] is shorthand for thousands', () => {
    expect(parseAutoCompactWindowInput('200')).toBe(200_000)
    expect(parseAutoCompactWindowInput('100')).toBe(100_000)
    expect(parseAutoCompactWindowInput('1000')).toBe(1_000_000)
  })

  test('bare value outside [100, 1000] is a raw token count', () => {
    expect(parseAutoCompactWindowInput('200000')).toBe(200_000)
    expect(parseAutoCompactWindowInput('999999')).toBe(999_999)
    // Official `xp` falls back to parseInt — a bare fraction keeps its
    // leading integer ("200.5" -> 200 -> shorthand 200000).
    expect(parseAutoCompactWindowInput('200.5')).toBe(200_000)
    expect(parseAutoCompactWindowInput('200000.9')).toBe(200_000)
  })

  test('exponent notation is accepted only when it parses to an integer', () => {
    expect(parseAutoCompactWindowInput('1e5')).toBe(100_000)
    expect(parseAutoCompactWindowInput('1.5e2')).toBe(150_000) // 150 -> shorthand
    expect(parseAutoCompactWindowInput('1.234e2')).toBe(undefined) // 123.4
  })

  test('comma-grouped thousands are stripped', () => {
    expect(parseAutoCompactWindowInput('1,000,000')).toBe(1_000_000)
    expect(parseAutoCompactWindowInput('500,000')).toBe(500_000)
  })

  test('rejects values outside [100k, 1M]', () => {
    expect(parseAutoCompactWindowInput('99')).toBe(undefined) // raw 99
    expect(parseAutoCompactWindowInput('99999')).toBe(undefined)
    expect(parseAutoCompactWindowInput('1000001')).toBe(undefined)
  })

  test('rejects garbage input', () => {
    expect(parseAutoCompactWindowInput('')).toBe(undefined)
    expect(parseAutoCompactWindowInput('abc')).toBe(undefined)
    expect(parseAutoCompactWindowInput('k')).toBe(undefined)
    expect(parseAutoCompactWindowInput('auto2')).toBe(undefined)
  })

  test('rounds fractional token counts', () => {
    expect(parseAutoCompactWindowInput('200.4k')).toBe(200_400)
    expect(parseAutoCompactWindowInput('200.456k')).toBe(200_456)
  })
})

describe('2.1.221 autoCompactWindow settings schema key', () => {
  test('accepts integers within [100k, 1M]', () => {
    expect(
      SettingsSchema().safeParse({ autoCompactWindow: 100_000 }).success,
    ).toBe(true)
    expect(
      SettingsSchema().safeParse({ autoCompactWindow: 1_000_000 }).success,
    ).toBe(true)
    expect(
      SettingsSchema().safeParse({ autoCompactWindow: 500_000 }).success,
    ).toBe(true)
  })

  test('out-of-range values are caught to undefined (official .catch(void 0))', () => {
    // zod .catch() fires on ANY parse failure — min/max included — so an
    // out-of-range window degrades to "unset", never a validation error.
    const low = SettingsSchema().safeParse({ autoCompactWindow: 99_999 })
    expect(low.success).toBe(true)
    if (low.success) {
      expect(low.data.autoCompactWindow).toBeUndefined()
    }
    const high = SettingsSchema().safeParse({ autoCompactWindow: 1_000_001 })
    expect(high.success).toBe(true)
    if (high.success) {
      expect(high.data.autoCompactWindow).toBeUndefined()
    }
  })

  test('rejects non-integers... by catching them to undefined', () => {
    const result = SettingsSchema().safeParse({ autoCompactWindow: 500_000.5 })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.autoCompactWindow).toBeUndefined()
    }
  })

  test('catches invalid types to undefined (official .catch(void 0))', () => {
    const result = SettingsSchema().safeParse({ autoCompactWindow: 'big' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.autoCompactWindow).toBeUndefined()
    }
  })

  test('range constants match the schema bounds', () => {
    expect(AUTO_COMPACT_WINDOW_MIN).toBe(100_000)
    expect(AUTO_COMPACT_WINDOW_MAX).toBe(1_000_000)
  })
})

describe('2.1.221 resolveAutoCompactWindowOverride (official `Fju` port)', () => {
  test('explicit "auto" clears any settings override for the session', () => {
    expect(resolveAutoCompactWindowOverride('auto')).toBeUndefined()
  })

  test('numeric flag value passes through', () => {
    expect(resolveAutoCompactWindowOverride(500_000)).toBe(500_000)
  })
})

describe('2.1.221 auto-compact threshold consumption', () => {
  test('session window shrinks the effective context window', () => {
    const base = getEffectiveContextWindowSize(TEST_MODEL)

    setSessionAutoCompactWindow(100_000)
    const withWindow = getEffectiveContextWindowSize(TEST_MODEL)
    expect(withWindow).toBeLessThan(base)

    // The session window behaves exactly like the pre-existing env override
    // (min with the model window) — official caps to the model limit.
    setSessionAutoCompactWindow(undefined)
    process.env[ENV_KEY] = '100000'
    const withEnv = getEffectiveContextWindowSize(TEST_MODEL)
    expect(withWindow).toBe(withEnv)
  })

  test('env var takes precedence over the session window', () => {
    process.env[ENV_KEY] = '150000'
    const envOnly = getEffectiveContextWindowSize(TEST_MODEL)

    setSessionAutoCompactWindow(100_000)
    const both = getEffectiveContextWindowSize(TEST_MODEL)
    expect(both).toBe(envOnly)
  })

  test('clearing the session window restores the base window', () => {
    const base = getEffectiveContextWindowSize(TEST_MODEL)
    setSessionAutoCompactWindow(100_000)
    setSessionAutoCompactWindow(undefined)
    expect(getEffectiveContextWindowSize(TEST_MODEL)).toBe(base)
    expect(getSessionAutoCompactWindow()).toBeUndefined()
  })

  test('a window above the model window does not grow the context', () => {
    const base = getEffectiveContextWindowSize(TEST_MODEL)
    setSessionAutoCompactWindow(AUTO_COMPACT_WINDOW_MAX)
    expect(getEffectiveContextWindowSize(TEST_MODEL)).toBeLessThanOrEqual(base)
  })
})
