import { describe, expect, test } from 'bun:test'
import { expandTabsInPieces, normalizeText, TAB_INTERVAL } from '../normalize-text.js'

/**
 * CC 2.1.295 verification (NO-OP port — pinning test only).
 *
 * The 2.1.294→295 changelog reports tabs advancing the cursor to the wrong
 * column. Official evidence: v295 `YTo` @208573899 initializes its column
 * counter `r=0` PER CALL — i.e. tab stops are computed from the START OF THE
 * TEXT being rendered, not from the terminal screen edge / cursor position.
 *
 * OCC's `expandTabsInPieces` was verified compliant: `let column = 0` at the
 * top of each call, `interval - (column % interval)` spaces per TAB, '\n'
 * resets column to 0, and non-string (cleanToken undefined) pieces pass
 * through verbatim without advancing the column. No code change needed — this
 * file pins the verified behavior against regression.
 */

describe('CC 2.1.295 — tab stops count from text start (official YTo @208573899)', () => {
  test('leading tab expands to a full interval (column starts at 0, not screen edge)', () => {
    expect(expandTabsInPieces(['\tx'], TAB_INTERVAL)).toEqual([
      `${' '.repeat(8)}x`,
    ])
  })

  test('tab after text advances to the next tab stop from text start', () => {
    // 'ab' occupies columns 0-1; tab pads to column 8 → 6 spaces.
    expect(expandTabsInPieces(['ab\tc'], TAB_INTERVAL)).toEqual([
      `ab${' '.repeat(6)}c`,
    ])
  })

  test('changelog scenario: "answer\\tx" pads 2 spaces (8 - 6), not screen-relative', () => {
    expect(expandTabsInPieces(['answer\tx'], TAB_INTERVAL)).toEqual([
      `answer${' '.repeat(2)}x`,
    ])
  })

  test('column count accumulates across pieces within one call', () => {
    expect(expandTabsInPieces(['ab', '\tc'], TAB_INTERVAL)).toEqual([
      'ab',
      `${' '.repeat(6)}c`,
    ])
  })

  test('newline resets the column counter', () => {
    // 'cd' after '\n' starts at column 0 → wait, 'cd' is 2 columns, tab pads 6.
    expect(expandTabsInPieces(['ab\ncd\te'], TAB_INTERVAL)).toEqual([
      `ab\ncd${' '.repeat(6)}e`,
    ])
  })

  test('tab directly after newline expands to a full interval', () => {
    expect(expandTabsInPieces(['ab\n\tx'], TAB_INTERVAL)).toEqual([
      `ab\n${' '.repeat(8)}x`,
    ])
  })

  test('normalizeText applies the same text-start tab stops', () => {
    expect(normalizeText('\tx')).toEqual(`${' '.repeat(8)}x`)
    expect(normalizeText('ab\tc')).toEqual(`ab${' '.repeat(6)}c`)
  })
})
