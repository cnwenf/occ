/**
 * Tests for the CC 2.1.296 hint-tag line-scanner rewrite + hook-output
 * sanitizer (official `Mct`/`Oct`/`v1n`/`Ctr`/`lL`, evidence:
 * /tmp/cc296/ev-hints296.txt).
 *
 * The 295-era multiline regex treated a `<claude-code-hint .../>` sequence as
 * a tag even when embedded mid-line in log text (and even when spanning
 * newlines via `[^>]*?`). 296 semantics: a tag counts only when it occupies
 * its WHOLE line — boundaries are \n, \r and the U+2028/U+2029 separators —
 * and lines longer than 1024 chars are never hints (but are still stripped
 * from model-visible output by the extraction walker).
 *
 * `stripHintTagLines` (official `lL`) is the hook-side sanitizer: whole-line
 * tags are dropped line-wise from hook stdout/stderr/output. Unlike the
 * extraction path it does NOT collapse the blank lines left behind.
 */
import { describe, expect, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  _test,
  extractClaudeCodeHints,
  stripHintTagLines,
} from '../claudeCodeHints.js'

const TAG = '<claude-code-hint v=1 type=plugin value=foo@bar/>'

describe('extractClaudeCodeHints — 2.1.296 line-based extraction (official Mct)', () => {
  test('fast path: output without the tag-open sequence is returned unchanged', () => {
    const output = 'plain log output\nnothing to see\n'
    const result = extractClaudeCodeHints(output, 'npx tool')
    expect(result.hints).toEqual([])
    expect(result.stripped).toBe(output) // same reference — no allocation
  })

  test('extracts and strips a whole-line tag', () => {
    const result = extractClaudeCodeHints(
      `before\n${TAG}\nafter`,
      'npx some-tool run --flag',
    )
    expect(result.hints).toEqual([
      {
        v: 1,
        type: 'plugin',
        value: 'foo@bar',
        sourceCommand: 'npx',
      },
    ])
    expect(result.stripped).toBe('before\n\nafter')
  })

  test('absorbs surrounding spaces/tabs on the tag line', () => {
    const result = extractClaudeCodeHints(`x\n\t  ${TAG} \t\ny`, 'tool')
    expect(result.hints.length).toBe(1)
    expect(result.stripped).toBe('x\n\ny')
  })

  test('REGRESSION (296 fix): a tag embedded mid-line is NOT extracted and output is untouched', () => {
    const output = `log said ${TAG} inline`
    const result = extractClaudeCodeHints(output, 'tool')
    expect(result.hints).toEqual([])
    expect(result.stripped).toBe(output)
  })

  test('REGRESSION (296 fix): a tag spanning newlines is NOT extracted (old [^>]*? regex matched it)', () => {
    const output = '<claude-code-hint v=1\n type=plugin value=foo@bar/>'
    const result = extractClaudeCodeHints(output, 'tool')
    expect(result.hints).toEqual([])
    expect(result.stripped).toBe(output)
  })

  test('\\r counts as a line boundary', () => {
    const result = extractClaudeCodeHints(`a\r${TAG}\rb`, 'tool')
    expect(result.hints.length).toBe(1)
    expect(result.hints[0]!.value).toBe('foo@bar')
    expect(result.stripped).not.toContain('<claude-code-hint')
  })

  test('U+2028/U+2029 count as line boundaries (official Act)', () => {
    const result = extractClaudeCodeHints(`a ${TAG} b`, 'tool')
    expect(result.hints.length).toBe(1)
    expect(result.hints[0]!.value).toBe('foo@bar')
    expect(result.stripped).toBe('a  b')
  })

  test('over-long tag line (>1024 chars) is dropped as a hint but STILL stripped from output', () => {
    const longTag = `<claude-code-hint v=1 type=plugin value=foo@bar pad="${'x'.repeat(
      1100,
    )}"/>`
    expect(longTag.length).toBeGreaterThan(1024)
    const result = extractClaudeCodeHints(`keep\n${longTag}\nkeep2`, 'tool')
    expect(result.hints).toEqual([])
    expect(result.stripped).not.toContain('<claude-code-hint')
    expect(result.stripped).toContain('keep')
    expect(result.stripped).toContain('keep2')
  })

  test('a 1024-char tag line is still accepted (cap is exclusive)', () => {
    // Build a tag whose whole-line raw match is exactly 1024 chars.
    const padLen = 1024 - TAG.length
    const tag = `<claude-code-hint v=1 type=plugin value=foo@bar pad="${'x'.repeat(
      padLen - 7,
    )}"/>`
    expect(tag.length).toBe(1024)
    const result = extractClaudeCodeHints(tag, 'tool')
    expect(result.hints.length).toBe(1)
  })

  test('plugin value must be a name@marketplace slug (official S1n, new in 296)', () => {
    const bad = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=plugin value=not-a-slug/>',
      'tool',
    )
    expect(bad.hints).toEqual([])
    expect(bad.stripped).not.toContain('<claude-code-hint') // stripped anyway

    const badChars = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=plugin value=foo!@bar/>',
      'tool',
    )
    expect(badChars.hints).toEqual([])

    const good = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=plugin value=my.plugin_1@my.market_place-2/>',
      'tool',
    )
    expect(good.hints.length).toBe(1)
    expect(good.hints[0]!.value).toBe('my.plugin_1@my.market_place-2')
  })

  test('slug halves are capped at 64 chars (official S1n)', () => {
    const half64 = 'a'.repeat(64)
    const half65 = 'a'.repeat(65)
    expect(
      extractClaudeCodeHints(
        `<claude-code-hint v=1 type=plugin value=${half64}@${half64}/>`,
        'tool',
      ).hints.length,
    ).toBe(1)
    expect(
      extractClaudeCodeHints(
        `<claude-code-hint v=1 type=plugin value=${half65}@${half64}/>`,
        'tool',
      ).hints.length,
    ).toBe(0)
  })

  test('unsupported v / type / empty value are dropped but still stripped', () => {
    const v2 = extractClaudeCodeHints(
      '<claude-code-hint v=2 type=plugin value=foo@bar/>',
      'tool',
    )
    expect(v2.hints).toEqual([])
    expect(v2.stripped).toBe('')

    const agent = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=agent value=foo@bar/>',
      'tool',
    )
    expect(agent.hints).toEqual([])

    const empty = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=plugin value=""/>',
      'tool',
    )
    expect(empty.hints).toEqual([])
  })

  test('quoted attribute values are parsed (official b1n)', () => {
    const result = extractClaudeCodeHints(
      '<claude-code-hint v=1 type=plugin value="foo@bar"/>',
      'tool',
    )
    expect(result.hints.length).toBe(1)
    expect(result.hints[0]!.value).toBe('foo@bar')
  })

  test('stripping collapses runs of 3+ newlines to 2 (official replace)', () => {
    const result = extractClaudeCodeHints(`a\n\n${TAG}\n\nb`, 'tool')
    expect(result.hints.length).toBe(1)
    expect(result.stripped).toBe('a\n\nb')
  })

  test('multiple tags on separate lines are all extracted in order', () => {
    const result = extractClaudeCodeHints(
      `${TAG}\ntext\n<claude-code-hint v=1 type=plugin value=second@mp/>`,
      'mytool arg',
    )
    expect(result.hints.map(h => h.value)).toEqual(['foo@bar', 'second@mp'])
    expect(result.hints.every(h => h.sourceCommand === 'mytool')).toBe(true)
    expect(result.stripped).not.toContain('<claude-code-hint')
    expect(result.stripped).toContain('text')
  })
})

describe('stripHintTagLines — hook-output sanitizer (official lL)', () => {
  test('fast path: text without the tag-open sequence is returned as-is (same reference)', () => {
    const text = 'hook output\nwith lines\n'
    expect(stripHintTagLines(text)).toBe(text)
  })

  test('drops whole-line tags line-wise (no blank left behind, no collapse)', () => {
    expect(stripHintTagLines(`keep\n${TAG}\nkeep2`)).toBe('keep\nkeep2')
  })

  test('keeps mid-line lookalikes verbatim', () => {
    const text = `log said ${TAG} inline\nother`
    expect(stripHintTagLines(text)).toBe(text)
  })

  test('handles CRLF output: the trailing \\r is removed by trim() before the whole-line test', () => {
    expect(stripHintTagLines(`keep\r\n${TAG}\r\nkeep2`)).toBe('keep\r\nkeep2')
  })

  test('drops space/tab-padded tag lines', () => {
    expect(stripHintTagLines(`a\n \t ${TAG}\t \nb`)).toBe('a\nb')
  })

  test('keeps over-long (>1024-char) lookalike lines (official Ctr length cap)', () => {
    const longLine = `<claude-code-hint v=1 type=plugin value=foo@bar pad="${'x'.repeat(
      1100,
    )}"/>`
    const text = `a\n${longLine}\nb`
    expect(stripHintTagLines(text)).toBe(text)
  })

  test('splits on \\n only — a \\r-only separated lookalike line stays (faithful to official lL)', () => {
    const text = `${TAG}\rnext`
    expect(stripHintTagLines(text)).toBe(text)
  })

  test('does NOT collapse blank lines (collapse belongs to the extraction path only)', () => {
    // 5 lines → the tag line is removed → 4 lines → 3 newlines, no collapse.
    expect(stripHintTagLines(`a\n\n${TAG}\n\nb`)).toBe('a\n\n\nb')
  })

  test('P3#1 (OCC-113 review): U+2028/U+2029 count as line boundaries — protocol-legal tag lines cannot ride the hook channel', () => {
    // The extraction path recognizes U+2028/U+2029 as boundaries (official
    // `Act`); the sanitizer must drop the same lines or hook output would be
    // strictly more permissive than tool output. The LS/PS consts hold
    // literal separator characters (invisible in source) — same convention
    // as the extraction test above.
    const LS = ' '
    const PS = ' '
    expect(stripHintTagLines(`keep${LS}${TAG}${LS}keep2`)).toBe(
      `keep${LS}keep2`,
    )
    expect(stripHintTagLines(`keep${PS}${TAG}${PS}keep2`)).toBe(
      `keep${PS}keep2`,
    )
    // A U+2028-delimited tag segment inside one \n line.
    expect(stripHintTagLines(`a\nb${LS}${TAG}${LS}c\nd`)).toBe(`a\nb${LS}c\nd`)
    // Leading tag with a Unicode separator: the separator drops with the line
    // (same semantics as the leading-\n case).
    expect(stripHintTagLines(`${TAG}${LS}next`)).toBe('next')
    // Mid-line lookalikes around a Unicode boundary stay verbatim.
    const lookalike = `log said ${TAG} inline${LS}x`
    expect(stripHintTagLines(lookalike)).toBe(lookalike)
    // Over-long cap still applies on Unicode-separated segments.
    const longTag = `<claude-code-hint v=1 type=plugin value=foo@bar pad="${'x'.repeat(
      1100,
    )}"/>`
    const longText = `a${LS}${longTag}${LS}b`
    expect(stripHintTagLines(longText)).toBe(longText)
  })
})

describe('internal helpers (official Ctr / v1n)', () => {
  test('isHintTagLine: whole-line only, length-capped, tag-open required', () => {
    expect(_test.isHintTagLine(TAG)).toBe(true)
    expect(_test.isHintTagLine(`  ${TAG}\t`)).toBe(true) // regex tolerates padding
    expect(_test.isHintTagLine(`x ${TAG}`)).toBe(false)
    expect(_test.isHintTagLine(`${TAG} x`)).toBe(false)
    expect(_test.isHintTagLine('no tag here')).toBe(false)
    expect(
      _test.isHintTagLine(
        `<claude-code-hint v=1 type=plugin value=foo@bar pad="${'x'.repeat(
          1100,
        )}"/>`,
      ),
    ).toBe(false)
  })

  test('findTagMatchesInLine: match range absorbs surrounding spaces/tabs', () => {
    const matches = _test.findTagMatchesInLine(`\t ${TAG} \t`)
    expect(matches.length).toBe(1)
    expect(matches[0]!.start).toBe(0)
    expect(matches[0]!.end).toBe(`\t ${TAG} \t`.length)
    expect(matches[0]!.body).toBe('v=1 type=plugin value=foo@bar')
  })

  test('findTagMatchesInLine: no match when the tag does not occupy the line', () => {
    expect(_test.findTagMatchesInLine(`prefix ${TAG}`)).toEqual([])
    expect(_test.findTagMatchesInLine(`${TAG} suffix`)).toEqual([])
    expect(_test.findTagMatchesInLine('<claude-code-hintfoo v=1/>')).toEqual([])
  })
})
