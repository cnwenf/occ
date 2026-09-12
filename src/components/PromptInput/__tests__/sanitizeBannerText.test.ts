import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../../../ink/stringWidth.js'
import {
  BANNER_TEXT_MAX_WIDTH,
  clampBannerTextWidth,
  sanitizeAndClampBannerText,
  sanitizeBannerText,
} from '../sanitizeBannerText.js'

/**
 * Official 2.1.269 (E35): prompt-box banner text sanitize + width clamp.
 *
 * Binary evidence:
 *   dx (x269 @181158419): `wn(uWn(cV(e))).replace(/ {2,}/g," ").trim()`
 *   clamp (x269 @206568999): `Ke(dx(P.text),Math.max(1,Math.min(rSo,ee-1)))`, rSo=24
 *   2.1.268 rendered the banner text raw (x268 @205750433 — no dx, no clamp).
 */

describe('sanitizeBannerText (Official 2.1.269 E35 — dx)', () => {
  test('strips ANSI CSI sequences', () => {
    expect(sanitizeBannerText('\x1b[31mred\x1b[0m')).toBe('red')
    expect(sanitizeBannerText('\x1b[1m\x1b[38;5;12mbold-blue\x1b[0m')).toBe(
      'bold-blue',
    )
  })

  test('strips OSC string sequences (BEL and ST terminated)', () => {
    expect(sanitizeBannerText('\x1b]0;evil-title\x07text')).toBe('text')
    expect(sanitizeBannerText('\x1b]8;;http://x\x1b\\link')).toBe('link')
  })

  test('multi-pass strip catches sequences spliced together by an inner strip', () => {
    // uWn runs the ANSI regex up to 4 passes until a fixed point: removing
    // the inner `ESC[31m` splices `ESC[` + `31m` into a new valid sequence,
    // which only a second pass removes.
    expect(sanitizeBannerText('\x1b[\x1b[31m31mfoo\x1b[0m')).toBe('foo')
  })

  test('collapses newlines and control chars into single spaces', () => {
    expect(sanitizeBannerText('a\nb')).toBe('a b')
    expect(sanitizeBannerText('a\n\n\nb')).toBe('a b')
    expect(sanitizeBannerText('a\r\tb')).toBe('a b')
    expect(sanitizeBannerText('a\x07b')).toBe('a b')
  })

  test('removes invisible format characters (Cf)', () => {
    // ZWSP, ZWJ, BOM, bidi override — all Cf, replaced by a space then
    // collapsed/trimmed away at the edges.
    expect(sanitizeBannerText('\u200Bagent\u200B')).toBe('agent')
    expect(sanitizeBannerText('\u202Eevil\u202C')).toBe('evil')
    expect(sanitizeBannerText('\uFEFF@name')).toBe('@name')
  })

  test('strips lone surrogates (cV)', () => {
    expect(sanitizeBannerText('\uD800abc')).toBe('abc')
    expect(sanitizeBannerText('a\uDC00b')).toBe('ab')
    // A well-formed pair is preserved.
    expect(sanitizeBannerText('ok😀')).toBe('ok😀')
  })

  test('collapses runs of spaces and trims', () => {
    expect(sanitizeBannerText('  a    b  ')).toBe('a b')
  })

  test('empty / only-invisible input sanitizes to empty string (render-site fallback)', () => {
    expect(sanitizeBannerText('')).toBe('')
    expect(sanitizeBannerText('\u200B\u200B')).toBe('')
    expect(sanitizeBannerText('\x1b[31m\x1b[0m')).toBe('')
  })

  test('preserves the real banner strings from useSwarmBanner', () => {
    expect(sanitizeBannerText('@teammate-1')).toBe('@teammate-1')
    expect(sanitizeBannerText('View teammates: `tmux -L occ a`')).toBe(
      'View teammates: `tmux -L occ a`',
    )
  })
})

describe('clampBannerTextWidth (Official 2.1.269 E35 — Math.max(1,Math.min(rSo,ee-1)))', () => {
  test('caps at 24 for wide terminals', () => {
    expect(clampBannerTextWidth(100)).toBe(BANNER_TEXT_MAX_WIDTH)
    expect(clampBannerTextWidth(25)).toBe(24)
  })

  test('follows maxWidth-1 below the cap', () => {
    expect(clampBannerTextWidth(10)).toBe(9)
    expect(clampBannerTextWidth(2)).toBe(1)
  })

  test('never goes below 1 (tiny/degenerate maxWidth)', () => {
    expect(clampBannerTextWidth(1)).toBe(1)
    expect(clampBannerTextWidth(0)).toBe(1)
    expect(clampBannerTextWidth(-5)).toBe(1)
  })
})

describe('sanitizeAndClampBannerText (Official 2.1.269 E35 — Ke(dx(…), clamp))', () => {
  test('long text is truncated to width ≤24 on wide terminals', () => {
    const long = 'x'.repeat(80)
    const result = sanitizeAndClampBannerText(long, 100)
    expect(stringWidth(result)).toBeLessThanOrEqual(BANNER_TEXT_MAX_WIDTH)
    expect(result.endsWith('…')).toBe(true)
  })

  test('long text is truncated to ≥1 column on tiny terminals', () => {
    const result = sanitizeAndClampBannerText('x'.repeat(80), 0)
    expect(stringWidth(result)).toBeGreaterThanOrEqual(1)
    expect(stringWidth(result)).toBeLessThanOrEqual(BANNER_TEXT_MAX_WIDTH)
  })

  test('short clean text passes through unchanged', () => {
    expect(sanitizeAndClampBannerText('@agent', 100)).toBe('@agent')
  })

  test('ANSI padding cannot inflate the rendered banner width', () => {
    // 2.1.268 rendered this raw: the escape codes broke stringWidth-based
    // border padding and could inject newlines into the prompt box.
    const evil = '\x1b[31m' + 'y'.repeat(60) + '\x1b[0m\n\u202E!'
    const result = sanitizeAndClampBannerText(evil, 100)
    expect(result.includes('\x1b')).toBe(false)
    expect(result.includes('\n')).toBe(false)
    expect(stringWidth(result)).toBeLessThanOrEqual(BANNER_TEXT_MAX_WIDTH)
  })
})
