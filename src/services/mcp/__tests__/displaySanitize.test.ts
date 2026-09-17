/**
 * CC 2.1.274 S3a — display sanitizer family unit tests.
 *
 * Every expectation below is derived from the byte-verified port of the
 * official 2.1.274 linux-x64 binary functions (`Xi`/`Kin`/`gnr`/`oe`/`_e`/
 * `xr`/`nPr` @194523909/@194524420/@187512864/@187105334 regions) — see
 * src/services/mcp/displaySanitize.ts header for offsets. Forensics:
 * docs/upstream-version-gap-occ127.md Part II.
 */
import { describe, expect, test } from 'bun:test'

import {
  redactSecretsForDisplay,
  sanitizeDisplayUrl,
  sanitizeForDisplay,
  sanitizeServerNameForDisplay,
  stripInvisibleForDisplay,
  truncateToDisplayLength,
} from '../displaySanitize.js'

describe('sanitizeServerNameForDisplay (binary xr)', () => {
  test('plain name passes through', () => {
    expect(sanitizeServerNameForDisplay('my-server')).toBe('my-server')
  })

  test('backticks and single quotes become spaces', () => {
    // xr replaces /['`]/g with " " BEFORE Xi; Xi collapses whitespace.
    expect(sanitizeServerNameForDisplay("ev`il'name")).toBe('ev il name')
  })

  test('double quotes neutralized by Xi (description-template breakout)', () => {
    expect(sanitizeServerNameForDisplay('a"b')).toBe('a b')
  })

  test('NFKC-normalizes fullwidth lookalikes', () => {
    expect(sanitizeServerNameForDisplay('ｓｅｒｖｅｒ')).toBe(
      'server',
    )
  })

  test('caps at 64 code units with ellipsis', () => {
    const out = sanitizeServerNameForDisplay('a'.repeat(100))
    expect(out).toBe(`${'a'.repeat(64)}…`)
  })

  test('non-string input returns empty string', () => {
    expect(sanitizeServerNameForDisplay(undefined)).toBe('')
    expect(sanitizeServerNameForDisplay(null)).toBe('')
    expect(sanitizeServerNameForDisplay(42)).toBe('')
  })

  test('redaction is OFF for names (Kin mode "none")', () => {
    const name = 'token=abcdefgh12345678'
    expect(sanitizeServerNameForDisplay(name)).toBe(name)
  })
})

describe('stripInvisibleForDisplay (binary gnr)', () => {
  test('replaces lone surrogates with a space, keeps well-formed pairs', () => {
    expect(stripInvisibleForDisplay('a\uD800b')).toBe('a b')
    expect(stripInvisibleForDisplay('a\u{1F600}b')).toBe('a\u{1F600}b')
  })

  test('replaces invisible/format characters with a space', () => {
    // U+200B ZERO WIDTH SPACE is Default_Ignorable_Code_Point.
    expect(stripInvisibleForDisplay('a​b')).toBe('a b')
    // U+202E RIGHT-TO-LEFT OVERRIDE is Cf.
    expect(stripInvisibleForDisplay('a‮b')).toBe('a b')
    // U+2800 BRAILLE PATTERN BLANK is explicitly in the class.
    expect(stripInvisibleForDisplay('a⠀b')).toBe('a b')
  })

  test('caps input at 4096 code units', () => {
    expect(stripInvisibleForDisplay('y'.repeat(5000)).length).toBe(4096)
  })

  test('non-string input returns empty string', () => {
    expect(stripInvisibleForDisplay(undefined)).toBe('')
  })
})

describe('truncateToDisplayLength (binary oe)', () => {
  test('max <= 0 returns empty string', () => {
    expect(truncateToDisplayLength('abc', 0)).toBe('')
    expect(truncateToDisplayLength('abc', -1)).toBe('')
  })

  test('returns input unchanged when within max', () => {
    expect(truncateToDisplayLength('abc', 3)).toBe('abc')
    expect(truncateToDisplayLength('abc', 10)).toBe('abc')
  })

  test('drops a dangling high surrogate at the cut', () => {
    // 'a😀b' = ['a', '\uD83D', '\uDE00', 'b']; cut at 2 would end on the
    // high surrogate — oe slices it off.
    expect(truncateToDisplayLength('a\u{1F600}b', 2)).toBe('a')
  })

  test('plain ASCII cut is exact', () => {
    expect(truncateToDisplayLength('abcdef', 3)).toBe('abc')
  })
})

describe('redactSecretsForDisplay (binary Kin)', () => {
  test('mode "none" is a pass-through', () => {
    const s = 'api_key=abcdefgh12345678'
    expect(redactSecretsForDisplay(s, 'none')).toBe(s)
  })

  test('bearer/basic secrets are redacted', () => {
    expect(redactSecretsForDisplay('Bearer ghp_secretvalue123')).toBe(
      'Bearer [redacted]',
    )
    expect(redactSecretsForDisplay('basic:YWJjZGVmZ2hpamts')).toBe(
      'basic [redacted]',
    )
  })

  test('token-family label=value pairs are redacted', () => {
    expect(redactSecretsForDisplay('api_key=abcdefgh12345678')).toBe(
      'api_key [redacted]',
    )
    expect(redactSecretsForDisplay('access_token: abcdefgh12345678')).toBe(
      'access_token [redacted]',
    )
    expect(redactSecretsForDisplay('password=hunter2hunter2')).toBe(
      'password [redacted]',
    )
  })

  test('short (<8 char) values are not redacted', () => {
    expect(redactSecretsForDisplay('api_key=short')).toBe('api_key=short')
  })

  test('values outside the secret charset are not redacted', () => {
    // replacer guard: /[0-9._~+/=%-]/.test(secret) — 'abcdefgh' alone has
    // none of the required punctuation chars… it is >=8 alnum though, and
    // the charset test is on the SECRET body which includes letters; verify
    // the exact official guard: letters alone pass {8,} but the replacer
    // requires one of [0-9._~+/=%-].
    expect(redactSecretsForDisplay('api_key=abcdefghij')).toBe(
      'api_key=abcdefghij',
    )
  })
})

describe('sanitizeForDisplay (binary Xi)', () => {
  test('non-string returns empty string', () => {
    expect(sanitizeForDisplay(undefined)).toBe('')
  })

  test('collapses whitespace and trims', () => {
    expect(sanitizeForDisplay('  a \n\t b  ')).toBe('a b')
  })

  test('neutralizes angle brackets and double quotes', () => {
    expect(sanitizeForDisplay('<script>')).toBe('script')
    expect(sanitizeForDisplay('a"b')).toBe('a b')
  })

  test('overflow input truncates to max with ellipsis', () => {
    // scanMax = max(2000, 200+512) = 2000; 3000 chars overflow → redact
    // over the 2000-char window → still >200 → oe(y,200) + '…'.
    const out = sanitizeForDisplay('x'.repeat(3000))
    expect(out).toBe(`${'x'.repeat(200)}…`)
  })

  test('lone surrogates are stripped before display', () => {
    expect(sanitizeForDisplay('a\uD800b')).toBe('a b')
  })
})

describe('sanitizeDisplayUrl (binary nPr)', () => {
  test('plain URL passes through', () => {
    expect(sanitizeDisplayUrl('https://real.host.test/mcp')).toBe(
      'https://real.host.test/mcp',
    )
  })

  test('authored ${VAR} placeholders survive (display shows the template)', () => {
    expect(sanitizeDisplayUrl('https://${API_HOST}/mcp')).toBe(
      'https://${API_HOST}/mcp',
    )
  })

  test('secret-bearing query params are redacted', () => {
    expect(
      sanitizeDisplayUrl('https://host.test/mcp?api_key=abcdefgh12345678'),
    ).toBe('https://host.test/mcp?api_key [redacted]')
  })

  test('respects a custom max (auth-stub uses 256)', () => {
    const out = sanitizeDisplayUrl('https://host.test/' + 'p'.repeat(400), 256)
    expect(out.length).toBe(257) // 256 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })
})
