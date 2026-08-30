import { describe, expect, test } from 'bun:test'
import { EFFORT_HIGH, EFFORT_LOW, EFFORT_MAX, EFFORT_MEDIUM, EFFORT_XHIGH } from '../figures.js'

/**
 * Gap-110a (2.1.251, OCC-110): the effort glyph mapping shifted upstream.
 * Verified byte-exact against the official 2.1.251 binary: minified figure
 * `air` = U+25C9 and `lir` = U+25C8; the effort mapper `je()` maps
 * low→○, medium→◐, high→●, xhigh→◉ (fisheye), max→◈ (diamond-in-circle).
 * Live-verified: the official REPL status chip renders `◉ xhigh · /effort`.
 * The earlier ◍ xhigh claim traced a stale minified name (oOs) from an
 * older release — the current release's mapper is je().
 */
describe('2.1.251 effort glyph table (Gap-110a)', () => {
  test('low/medium/high glyphs unchanged', () => {
    expect(EFFORT_LOW).toBe('○') // ○
    expect(EFFORT_MEDIUM).toBe('◐') // ◐
    expect(EFFORT_HIGH).toBe('●') // ●
  })

  test('xhigh is the fisheye U+25C9 (◉), per mapper je()', () => {
    expect(EFFORT_XHIGH).toBe('◉')
    expect(EFFORT_XHIGH.codePointAt(0)).toBe(0x25c9)
  })

  test('max is the diamond-in-circle U+25C8 (◈), per mapper je()', () => {
    expect(EFFORT_MAX).toBe('◈')
    expect(EFFORT_MAX.codePointAt(0)).toBe(0x25c8)
  })

  test('all five glyphs are distinct', () => {
    const glyphs = [EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH, EFFORT_MAX]
    expect(new Set(glyphs).size).toBe(5)
  })
})
