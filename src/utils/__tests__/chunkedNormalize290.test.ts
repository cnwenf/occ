import { describe, expect, test } from 'bun:test'
import {
  chunkedNFKC,
  chunkedNFKD,
  CHUNK_WINDOW_SIZE,
  COMBINING_RUN_MIN,
  RE_ENCODE_CHUNK_SIZE,
} from '../chunkedNormalize.js'

/**
 * CC 2.1.290 cluster E items #5/#6 — chunked NFKC/NFKD engine.
 *
 * Official binary evidence (v2.1.290 linux-x64, chunk-z6am4wsr.js module
 * @202016511, byte-extracted): windowed normalize `m(e,n)` with window
 * `E=128`, combining-run detector `L=/[\p{M}ﾞﾟ]{32,}/gu`, manual
 * canonical combining-order `F` (per-codepoint cached NFKD `S`, combining
 * class discovery `I` with binary insertion into samples array `p`, stable
 * counting sort into Int32Array, 4096-chunk re-encode `b`), window boundaries
 * placed at starter code points (`A`/`T`/`y`) with trailing non-starter carry
 * between windows. Public API: `zTe(e)=m(e,"NFKC")`, `lps(e)=m(e,"NFKD")`.
 *
 * Motivation (official changelog): pathological `.normalize()` cost on very
 * long combining-character runs in JSC. NOTE (measured, Bun 1.3.14): the
 * pathology DOES reproduce for MIXED-CLASS runs — direct `.normalize('NFKD')`
 * is quadratic there (420ms @ 21K chars, ~43s @ 210K) while the chunked
 * engine is linear (1.5ms / 32ms). Single-class runs (e.g. 200K × U+0301)
 * stay linear in direct normalize (~5ms), so those tests assert absolute
 * bounds + exact equivalence instead of a comparison.
 */

/** Deterministic PRNG (mulberry32) so the fuzz corpus is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Codepoint pool: starters, non-starters, jamo, halfwidth marks, astral. */
const POOL: number[] = []
for (let cp = 0x61; cp <= 0x7a; cp++) POOL.push(cp) // a-z starters
POOL.push(0x20, 0x41, 0xc0, 0xe9, 0x1100, 0xac00) // space, A, À, é, ᄀ, 가
for (let cp = 0x1161; cp <= 0x1175; cp++) POOL.push(cp) // Hangul vowel jamo (non-starters)
for (let cp = 0x11a8; cp <= 0x11c2; cp++) POOL.push(cp) // Hangul final jamo
for (let cp = 0x0300; cp <= 0x036f; cp++) POOL.push(cp) // combining diacritics (mixed classes)
POOL.push(0x0334, 0x0345, 0x0338, 0x0344, 0x1e9b, 0x1dc0)
POOL.push(0xff9e, 0xff9f) // halfwidth katakana voiced marks (in official L class)
POOL.push(0xff66, 0xff71, 0xff84) // halfwidth katakana ﾌ ｱ ﾞ-base letters
POOL.push(0x1f642, 0x1d400, 0x2000b) // astral: emoji, math A, CJK ext-B
POOL.push(0x304c, 0x30f5, 0xfb01, 0x2460) // が, ヵ, fi ligature, ①

function randomString(rand: () => number, maxLen: number): string {
  const len = Math.floor(rand() * maxLen)
  let out = ''
  for (let i = 0; i < len; i++) {
    const cp = POOL[Math.floor(rand() * POOL.length)]!
    out += String.fromCodePoint(cp)
  }
  return out
}

function assertEquivalent(value: string): void {
  expect(chunkedNFKC(value)).toBe(value.normalize('NFKC'))
  expect(chunkedNFKD(value)).toBe(value.normalize('NFKD'))
}

describe('2.1.290 chunked-normalize constants (official zTe/lps module)', () => {
  test('window 128 / run threshold 32 / re-encode chunk 4096 (never invented)', () => {
    expect(CHUNK_WINDOW_SIZE).toBe(128) // official E=128
    expect(COMBINING_RUN_MIN).toBe(32) // official L={32,}
    expect(RE_ENCODE_CHUNK_SIZE).toBe(4096) // official C=4096
  })
})

describe('2.1.290 chunked-normalize equivalence (targeted cases)', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['ascii', 'hello world'],
    ['short (< 32) passthrough', 'áé'],
    ['precomposed NFC', 'éÀ가が'],
    ['decomposed NFD', 'éÀ가'],
    ['hangul jamo assembly', '각'], // 각
    ['halfwidth katakana + voiced marks', 'ｶﾞﾄﾟ'], // パ? (ﾊ+ﾞ, ﾄ+ﾟ)
    ['combining run exactly 32', 'a' + '́'.repeat(32)],
    ['combining run 31 (below threshold)', 'a' + '́'.repeat(31)],
    [
      'multi-class run ≥ 32 (canonical ordering path F)',
      'a' +
        Array.from({ length: 40 }, (_, i) =>
          String.fromCodePoint([0x0301, 0x0334, 0x0345, 0x0338][i % 4]!),
        ).join(''),
    ],
    [
      'out-of-order marks needing reorder',
      'á̴ͅ' + 'b̴́ͅ'.repeat(12),
    ],
    ['run straddling the 128 window', 'a'.repeat(120) + '́'.repeat(50) + 'b́c'],
    ['marks at string end (carry path y)', 'x'.repeat(200) + '́ͅ'],
    ['all non-starters (no window boundary)', '́'.repeat(300)],
    ['astral + combining mix', '🙂́' + 'é'.repeat(80) + '𝔀̴'],
    ['ligature + fullwidth', 'ﬁ ａｂｃ'],
    ['U+0344 / U+1E9B specials', 'ä́ ẛ ̈́'.repeat(10)],
    ['ideographic + Zs separators', '　 abc '],
    ['long starter-only string (> window)', 'x'.repeat(1000)],
    [
      'interleaved starters/marks over many windows',
      'ab́cdͅ'.repeat(100),
    ],
  ]
  for (const [name, value] of cases) {
    test(name, () => assertEquivalent(value))
  }

  test('NFC/NFD pre-normalized inputs round-trip equivalently', () => {
    const base = randomString(mulberry32(7), 400)
    for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'] as const) {
      assertEquivalent(base.normalize(form))
    }
  })
})

describe('2.1.290 chunked-normalize equivalence (seeded fuzz)', () => {
  test('500 random strings over the full codepoint pool', () => {
    const rand = mulberry32(0x5eed290)
    for (let i = 0; i < 500; i++) {
      const value = randomString(rand, 600)
      const form = i % 3 === 0 ? 'NFC' : i % 3 === 1 ? 'NFD' : null
      assertEquivalent(form ? value.normalize(form) : value)
    }
  })

  test('200 random strings biased to long combining runs', () => {
    const rand = mulberry32(0xc0ffee)
    for (let i = 0; i < 200; i++) {
      const starter = String.fromCodePoint(POOL[Math.floor(rand() * 26)]!)
      const runLen = 20 + Math.floor(rand() * 80)
      let run = ''
      for (let j = 0; j < runLen; j++) {
        run += String.fromCodePoint(0x0300 + Math.floor(rand() * 0x70))
      }
      const value = i % 2 === 0 ? starter + run : 'pre' + starter + run + 'post' + starter + run
      assertEquivalent(value)
    }
  })
})

describe('2.1.290 chunked-normalize timing (doc 测试计划, adapted — see header)', () => {
  test('1MB string with 200K combining accents normalizes in < 500ms', () => {
    // 5-char pattern 'abcd◌́' × 200_000 = 1_000_000 chars with 200K accents.
    const big = 'abcd́'.repeat(200_000)
    expect(big.length).toBe(1_000_000)
    const t0 = performance.now()
    const out = chunkedNFKC(big)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
    expect(out).toBe(big.normalize('NFKC'))
  })

  test('200K contiguous combining run normalizes in < 500ms', () => {
    const run = 'a' + '́'.repeat(200_000)
    const t0 = performance.now()
    const out = chunkedNFKC(run)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
    expect(out).toBe(run.normalize('NFKC'))
  })

  test('doc comparison: chunked beats direct normalize by >3x on a mixed-class run', () => {
    // The doc's "assert direct .normalize is dramatically slower" test —
    // reproducible on Bun for mixed-class runs (quadratic direct, linear
    // chunked). 21K chars keeps the direct side ~420ms.
    const run = 'a' + '\u0345\u0334\u0301'.repeat(7_000)
    let t0 = performance.now()
    const chunked = chunkedNFKD(run)
    const chunkedMs = performance.now() - t0
    t0 = performance.now()
    const direct = run.normalize('NFKD')
    const directMs = performance.now() - t0
    expect(chunked).toBe(direct)
    expect(directMs).toBeGreaterThan(chunkedMs * 3)
  })

  test('210K mixed-class run: chunked stays linear (<500ms) where direct normalize is quadratic', () => {
    // Direct .normalize('NFKD') on mixed-class runs is quadratic on this
    // platform (measured: 420ms @ 21K chars, ~43s @ 210K) — exactly the
    // official pathology the chunked engine exists for. Equivalence is
    // verified at 21K (affordable); the 210K run asserts the linear bound.
    const mixed = (n: number): string => 'a' + '\u0345\u0334\u0301'.repeat(n)
    const small = mixed(7_000) // 21,001 chars
    expect(chunkedNFKD(small)).toBe(small.normalize('NFKD'))
    const big = mixed(70_000) // 210,001 chars
    const t0 = performance.now()
    const out = chunkedNFKD(big)
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
    expect(out.length).toBeGreaterThan(0)
  })
})
