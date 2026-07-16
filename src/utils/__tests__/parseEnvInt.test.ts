import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { parseEnvInt, parseEnvIntWithDefault } from '../envValidation.js'
import { validateBoundedIntEnvVar } from '../envValidation.js'

/**
 * CC 2.1.211 generalizes the 2.1.208 #11 scientific-notation fix to ALL
 * integer env vars and adds digit-separator support.
 *
 * Mirrors CC 2.1.211 binary `zl`:
 *   C9f(e):
 *     if len≤32 && T9f(sci-regex).test(e) → Number(e) if integer else NaN
 *     if len≤32 && _Ka(sep-regex).test(e) → parseInt(e.replace(bKa,''),10)
 *     else undefined
 *   zl(e): t=String(e).trim(); C9f(t) ?? parseInt(t,10)
 *
 * Accepted forms: 1e6→1000000, 64_000→64000, 1_000_000→1000000, 1000→1000
 */

describe('parseEnvInt — scientific notation', () => {
  test('1e6 parses to 1000000', () => {
    expect(parseEnvInt('1e6')).toBe(1_000_000)
  })

  test('1e3 parses to 1000', () => {
    expect(parseEnvInt('1e3')).toBe(1000)
  })

  test('2e3 parses to 2000', () => {
    expect(parseEnvInt('2e3')).toBe(2000)
  })

  test('1.5e1 (==15) is accepted because result is integer', () => {
    expect(parseEnvInt('1.5e1')).toBe(15)
  })

  test('1.5e0 (==1.5) is rejected (not integer) → undefined', () => {
    expect(parseEnvInt('1.5e0')).toBeUndefined()
  })

  test('negative -1e3 is parsed as -1000 (caller validates sign)', () => {
    expect(parseEnvInt('-1e3')).toBe(-1000)
  })
})

describe('parseEnvInt — digit separators', () => {
  test('64_000 parses to 64000', () => {
    expect(parseEnvInt('64_000')).toBe(64000)
  })

  test('1_000_000 parses to 1000000', () => {
    expect(parseEnvInt('1_000_000')).toBe(1_000_000)
  })

  test('1,000 parses to 1000 (comma separator)', () => {
    expect(parseEnvInt('1,000')).toBe(1000)
  })

  test('1_000_000 with leading + is accepted', () => {
    expect(parseEnvInt('+1_000_000')).toBe(1_000_000)
  })

  test('99_999 parses to 99999', () => {
    expect(parseEnvInt('99_999')).toBe(99999)
  })

  test('inconsistent separators 1_0,000 fall to parseInt → 1', () => {
    // _Ka regex requires the SAME separator via backreference \1, so this
    // doesn't match. The parseInt fallback then stops at '_' → 1.
    // This mirrors the binary's zl behavior (C9f returns undefined → parseInt).
    expect(parseEnvInt('1_0,000')).toBe(1)
  })

  test('64_000.5 (fractional with separator) falls to parseInt → 64', () => {
    // Digit-separator regex requires all-digit groups; '.5' breaks the match.
    // parseInt fallback stops at '_' → 64. Mirrors binary zl.
    expect(parseEnvInt('64_000.5')).toBe(64)
  })
})

describe('parseEnvInt — plain integers', () => {
  test('plain 1000 parses to 1000', () => {
    expect(parseEnvInt('1000')).toBe(1000)
  })

  test('plain 0 parses to 0', () => {
    expect(parseEnvInt('0')).toBe(0)
  })

  test('plain 42 parses to 42', () => {
    expect(parseEnvInt('42')).toBe(42)
  })

  test('negative -5 parses to -5', () => {
    expect(parseEnvInt('-5')).toBe(-5)
  })
})

describe('parseEnvInt — invalid / edge cases', () => {
  test('non-numeric "abc" → undefined', () => {
    expect(parseEnvInt('abc')).toBeUndefined()
  })

  test('undefined → undefined', () => {
    expect(parseEnvInt(undefined)).toBeUndefined()
  })

  test('empty string → undefined', () => {
    expect(parseEnvInt('')).toBeUndefined()
  })

  test('whitespace-only "  " → undefined', () => {
    expect(parseEnvInt('  ')).toBeUndefined()
  })

  test('trimmed " 1000 " parses to 1000', () => {
    expect(parseEnvInt(' 1000 ')).toBe(1000)
  })
})

describe('parseEnvIntWithDefault', () => {
  test('1e6 with default 100 → 1000000', () => {
    expect(parseEnvIntWithDefault('1e6', 100)).toBe(1_000_000)
  })

  test('64_000 with default 100 → 64000', () => {
    expect(parseEnvIntWithDefault('64_000', 100)).toBe(64000)
  })

  test('undefined with default 75 → 75', () => {
    expect(parseEnvIntWithDefault(undefined, 75)).toBe(75)
  })

  test('"abc" with default 10 → 10', () => {
    expect(parseEnvIntWithDefault('abc', 10)).toBe(10)
  })

  test('0 with default 10 → 0 (0 preserved, NOT dropped to default)', () => {
    // CC 2.1.211 hardening: parseEnvIntWithDefault uses ?? (not ||) so a
    // legitimate 0 is preserved. The old `||` pattern dropped 0 to the
    // default because 0 is falsy.
    expect(parseEnvIntWithDefault('0', 10)).toBe(0)
  })
})

describe('validateBoundedIntEnvVar — digit separator support (CC 2.1.211)', () => {
  test('64_000 within bounds → valid 64000', () => {
    const result = validateBoundedIntEnvVar('X', '64_000', 100, 100_000)
    expect(result.effective).toBe(64000)
    expect(result.status).toBe('valid')
  })

  test('1_000_000 capped to upper limit', () => {
    const result = validateBoundedIntEnvVar('X', '1_000_000', 100, 500_000)
    expect(result.effective).toBe(500_000)
    expect(result.status).toBe('capped')
  })

  test('1,000 within bounds → valid 1000', () => {
    const result = validateBoundedIntEnvVar('X', '1,000', 100, 10_000)
    expect(result.effective).toBe(1000)
    expect(result.status).toBe('valid')
  })
})

/**
 * Regression tests — demonstrate the OLD failure modes that the shared
 * parser now fixes. These document WHY parseInt/Number were insufficient.
 */
describe('regression: old failure modes', () => {
  test('parseInt("1e6", 10) === 1 (the bug)', () => {
    // parseInt stops at 'e', returns 1 — the original 2.1.208 #11 bug
    expect(parseInt('1e6', 10)).toBe(1)
  })

  test('Number("64_000") is NaN (the bug)', () => {
    // Number() does not understand digit separators
    expect(Number('64_000')).toBeNaN()
  })

  test('parseInt("64_000", 10) === 64 (the bug)', () => {
    // parseInt stops at '_', returns 64
    expect(parseInt('64_000', 10)).toBe(64)
  })

  test('parseEnvInt fixes all three failure modes', () => {
    expect(parseEnvInt('1e6')).toBe(1_000_000)
    expect(parseEnvInt('64_000')).toBe(64000)
    expect(parseEnvInt('1_000_000')).toBe(1_000_000)
  })
})

/**
 * Integration test — exercises a REAL code path that reads an integer env
 * var through parseEnvInt. No mocking of the parser; only the env var is
 * set/unset. Stage 3 rule: test MUST call the real parser/code path.
 *
 * Uses getDefaultMaxRetries() from services/api/withRetry.ts, which reads
 * CLAUDE_CODE_MAX_RETRIES via parseEnvInt. With watchdog=false, values
 * above MAX_RETRIES_CLAMP (15) are clamped to 15.
 */
describe('integration: real code path through parseEnvInt', () => {
  const ENV_VAR = 'CLAUDE_CODE_MAX_RETRIES'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[ENV_VAR]
  })

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[ENV_VAR]
    } else {
      process.env[ENV_VAR] = saved
    }
  })

  test('1e1 (scientific) → 10 via getDefaultMaxRetries(false)', async () => {
    process.env[ENV_VAR] = '1e1'
    const { getDefaultMaxRetries } = await import(
      '../../services/api/withRetry.js'
    )
    // 1e1 = 10, within clamp (15) → returned directly
    expect(getDefaultMaxRetries(false)).toBe(10)
  })

  test('1_000 (digit-sep) → 1000 → clamped to 15 (not 1!)', async () => {
    // parseInt('1_000', 10) would return 1 (stops at '_').
    // parseEnvInt correctly returns 1000, which is then clamped to 15.
    process.env[ENV_VAR] = '1_000'
    const { getDefaultMaxRetries } = await import(
      '../../services/api/withRetry.js'
    )
    expect(getDefaultMaxRetries(false)).toBe(15)
  })

  test('64_000 (digit-sep) → 64000 → clamped to 15 (not 64!)', async () => {
    // parseInt('64_000', 10) would return 64 (stops at '_').
    // parseEnvInt correctly returns 64000, which is then clamped to 15.
    process.env[ENV_VAR] = '64_000'
    const { getDefaultMaxRetries } = await import(
      '../../services/api/withRetry.js'
    )
    expect(getDefaultMaxRetries(false)).toBe(15)
  })
})
