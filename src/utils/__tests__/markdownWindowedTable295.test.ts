/**
 * OCC-154 fix-round C-item t-06 — windowed-lex give-up constant +
 * >1000-row table fixture (CC 2.1.295 changelog #056).
 *
 * Why this file exists: the 验收员 t-06 mutation recipes showed two blind
 * spots the existing markdownWindowed295 suite (13 tests) cannot see —
 *
 *   1. `GIVEUP_WINDOW_LINES = 16000` has no constant pin: mutating it to
 *      999 keeps all 13 existing tests green. The give-up growth window
 *      (official `at(e,t)`: `makeWindow([], rest, GIVEUP_WINDOW_LINES)`)
 *      decides how far the lexer re-scans when a window fails to lex
 *      cleanly; shrinking it 16× changes recovery geometry silently.
 *   2. The table branches (`windowTable` / `tableRowsEnd` / `sliceRows` /
 *      `singleTableToken` / `declineTable`) have ZERO fixtures: flipping
 *      the `tableContinues` boundary or capping the row-slice loop keeps
 *      all 13 green, and a skip-odd row mutation makes a >1000-row table
 *      lex NON-TERMINATING — exactly the freeze class #056 fixed.
 *
 * This suite pins both:
 *   - the official give-up constant (16000 = 16 × WINDOW_LINES), and
 *   - a 1100-row 2-column GFM table (1102 lines > WINDOW_LINES → forced
 *     through the windowed path) lexed to ONE merged table token with
 *     every row present — including the slice boundary rows 999/1000 —
 *     in bounded time, with windowed marks and exact source conservation.
 *
 * Mutation-verify recipes (each must turn THIS suite RED while the
 * existing 13 stay GREEN):
 *   - markdownWindowed.ts `GIVEUP_WINDOW_LINES = 16000` → `999`:
 *     the constant pin goes RED.
 *   - windowTable row loop `taken.length < rows.length` →
 *     `taken.length < 1` (row-loop cap): the merged table keeps only the
 *     first 1000-row slice → `rows.length` 1000 ≠ 1100 → RED.
 *   - (freeze class) any sliceRows/lineSpanEnd skip-odd mutation makes
 *     the 1100-row walk non-terminating → bounded-time assert / test
 *     timeout → RED.
 */
import { describe, expect, test } from 'bun:test'
import { Marked, type Tokens } from 'marked'
import {
  GIVEUP_WINDOW_LINES,
  WINDOW_LINES,
  isWholeTextSafe,
  lexWithWindowing,
  takenRawEquals,
  type WindowedToken,
} from '../markdownWindowed.ts'

describe('295 #056 — give-up window constant (t-06 pin)', () => {
  test('GIVEUP_WINDOW_LINES matches the official binary (16000 = 16 × window)', () => {
    // Arrange / Act / Assert — mutation RED point: 16000 → 999.
    expect(GIVEUP_WINDOW_LINES).toBe(16_000)
    expect(GIVEUP_WINDOW_LINES).toBe(WINDOW_LINES * 16)
  })
})

describe('295 #056 — >1000-row table through windowTable (t-06 fixture)', () => {
  const DATA_ROWS = 1100

  /** Header + delimiter + DATA_ROWS 2-column rows + trailing newline. */
  function bigTable(): string {
    const lines = ['| left | right |', '| --- | --- |']
    for (let i = 0; i < DATA_ROWS; i++) {
      lines.push(`| l${i} | r${i} |`)
    }
    return `${lines.join('\n')}\n`
  }

  function rowTexts(table: Tokens.Table, index: number): string[] {
    return (table.rows[index] ?? []).map(cell => cell.text)
  }

  test('1100-row 2-column table lexes as ONE windowed table with every row, in bounded time', () => {
    // Arrange — 1102 lines > WINDOW_LINES → not whole-text-safe → the
    // windowed path must handle it via fallbackWindow → windowTable
    // (two 1000-row slices merged into a single table token).
    const text = bigTable()
    expect(text.split('\n').length - 1).toBeGreaterThan(WINDOW_LINES)
    expect(isWholeTextSafe(text)).toBe(false)
    const marked = new Marked()

    // Act
    const t0 = Date.now()
    const tokens = lexWithWindowing(marked, text)
    const ms = Date.now() - t0

    // Assert — bounded time: skip-odd / non-terminating row mutations hit
    // the test timeout instead (the #056 freeze class).
    expect(ms).toBeLessThan(2_000)

    // Exactly one table token; no row lost at the 1000-row slice boundary.
    const tables = tokens.filter(t => t.type === 'table') as Tokens.Table[]
    expect(tables.length).toBe(1)
    const table = tables[0] as Tokens.Table
    expect(table.header.map(cell => cell.text)).toEqual(['left', 'right'])
    // Mutation RED point: row-loop cap → 1000 (first slice only) ≠ 1100.
    expect(table.rows.length).toBe(DATA_ROWS)
    expect(rowTexts(table, 0)).toEqual(['l0', 'r0'])
    expect(rowTexts(table, 999)).toEqual(['l999', 'r999']) // slice-1 tail
    expect(rowTexts(table, 1000)).toEqual(['l1000', 'r1000']) // slice-2 head
    expect(rowTexts(table, DATA_ROWS - 1)).toEqual(['l1099', 'r1099'])

    // Every token carries the windowed mark, and the token raws re-join to
    // the normalized source exactly (no dropped/duplicated bytes).
    expect(tokens.length).toBeGreaterThan(0)
    expect(
      tokens.every(t => (t as WindowedToken).windowed === true),
    ).toBe(true)
    expect(takenRawEquals(tokens, text.replace(/\r\n?/g, '\n'))).toBe(true)
  })
})
