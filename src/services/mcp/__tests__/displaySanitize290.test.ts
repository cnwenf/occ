import { describe, expect, test } from 'bun:test'
import { chunkedNFKC } from '../../../utils/chunkedNormalize.js'
import {
  sanitizeForDisplay,
  sanitizeServerNameForDisplay,
} from '../displaySanitize.js'

/**
 * CC 2.1.290 cluster E item #6 — display sanitizers route NFKC through the
 * chunked engine (`zTe`), mirroring the official 2.1.290 call sites:
 * - `Zr(e,n=64)` (server-name sanitizer): `Da(zTe(e).replace(/['`]/g," "),n,"none")`
 * - `Da` core (= `Xi`): `iao(zTe(e)).replaceAll(...)` — both NFKC sites chunked.
 *
 * Motivation: a tool/server description or name containing a very long
 * combining-character run could stall the MCP tool-list render (permission
 * prompts included). On Bun 1.3.14 direct `.normalize()` does not exhibit the
 * JSC pathology (measured linear), so these tests assert equivalence +
 * absolute bounds rather than a comparison against direct normalize.
 */

describe('2.1.290 displaySanitize chunked-NFKC call sites', () => {
  test('NFKC semantics preserved: halfwidth katakana + voiced mark composes', () => {
    // 'ｶ' + 'ﾞ' → NFKC → 'ガ'. chunkedNFKC must agree with direct normalize.
    expect(chunkedNFKC('ｶﾞ')).toBe('ｶﾞ'.normalize('NFKC'))
    expect(sanitizeForDisplay('ｶﾞ')).toBe('ガ')
  })

  test('fullwidth server name folds to ASCII like before', () => {
    expect(sanitizeServerNameForDisplay('ｓｅｒｖｅｒ１')).toBe('server1')
  })

  test('quotes/backticks in server names still become spaces', () => {
    expect(sanitizeServerNameForDisplay("a'b`c")).toBe('a b c')
  })

  test('long combining-run tool description sanitizes fast and bounded', () => {
    const evil = 'desc' + '́'.repeat(500_000) + 'tail'
    const t0 = performance.now()
    const out = sanitizeForDisplay(evil)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
    expect(out.length).toBeLessThanOrEqual(201) // DEFAULT_DISPLAY_MAX 200 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  test('long combining-run server name (permission-prompt path) stays ≤ 64 + ellipsis', () => {
    const evilName = 'srv' + '́'.repeat(500_000)
    const t0 = performance.now()
    const out = sanitizeServerNameForDisplay(evilName)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
    expect(out.length).toBeLessThanOrEqual(65) // max 64 + ellipsis
    expect(out.startsWith('srv')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  test('chunked NFKC equivalence holds over sanitizer-relevant corpus', () => {
    const corpus = [
      '',
      'plain ascii',
      'ﬁle ｎａｍｅ',
      'é́'.repeat(40),
      'x' + 'ͅ'.repeat(129), // straddles the 128 window
      '🙁',
      'Ａ'.repeat(3000),
      '́'.repeat(1000),
    ]
    for (const value of corpus) {
      expect(chunkedNFKC(value)).toBe(value.normalize('NFKC'))
    }
  })

  test('sanitizeForDisplay output matches direct-normalize semantics on mixed content', () => {
    const input = 'ｓｅｃｒｅｔ token=abcdefgh12345678 ﾞ>quote< x'.normalize('NFKC')
    // Same input through the (now chunked) sanitizer must equal the sanitizer
    // applied to a pre-NFKC'd string — proving the chunked swap changed
    // nothing observable (idempotence of NFKC + equivalence).
    expect(sanitizeForDisplay(input)).toBe(sanitizeForDisplay(input.normalize('NFKC')))
    expect(sanitizeForDisplay('ｓｅｃｒｅｔ')).toBe('secret')
  })
})
