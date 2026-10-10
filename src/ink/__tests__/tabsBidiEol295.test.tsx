import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { renderToStringIsolated } from '../../components/CustomSelect/__tests__/renderIsolated280.js'

/**
 * CC 2.1.295 changelog #076 — "Fixed text with tabs or bidirectional control
 * characters losing its end at the edge of the screen or drawing over nearby
 * rows."
 *
 * Binary forensics (v295 ELF `/tmp/cc295/v295/package/claude`, never executed):
 * official measures AND paints through the NATIVE, screen-aware segmenter
 * `Bun.ant.CellSegmenter({ ambiguousIsNarrow:!0, substitute:e, screen:n })`
 * (real-binary option-table hits @14626467/@14626593: substitute / screen /
 * widthMask / narrow / spacerTail / spacerHead). That `screen` param is
 * byte-identical in v294 and v295 (5 hits each), so it is NOT the 295 delta and
 * it is unportable — a Bun/Anthropic native internal OCC does not have.
 *
 * OCC's paint path is JS. `Gs` (render-node-to-output.ts) measures/wraps with
 * `widestLine`, where a raw TAB counts as width 0, while the cell writer
 * (`writeLineToScreen`, output.ts) expands a surviving TAB to 8-column stops.
 * That mismatch under-measured a tab line, skipped the wrap, and clipped its
 * tail at the screen edge — empirically `"aaaa\tbbbb"` @cols=10 painted
 * `"aaaa    bb"` (the `"bb"` tail lost) and `"abcd\tef"` @cols=6 painted
 * `"abcd"` (`"ef"` lost). The fix lives in `dC` (`normalizeStyledPieces`,
 * normalize-text.ts): it now pre-expands tabs for CLEAN pieces, matching
 * `Oc`/`normalizePieces` (the yoga measure path), so measure == wrap == paint.
 *
 * The BIDI half is a verified NO-OP for OCC: a bidi override measures width 1
 * (`isZeroWidth` lists no entry for U+061C / U+202A–E / U+2066–9, so it falls
 * through to `eastAsianWidth` = 1) and the painter draws U+FFFD (also width 1),
 * so measure == paint already and no tail is lost or row overwritten. These
 * tests pin BOTH halves — the tab FIX and the bidi NO-OP — against regression.
 */

// Written as \u escapes, never raw bytes: embedding a live bidi control in
// source is exactly the Trojan-source hazard this test guards against.
const RLO = '\u202e' // right-to-left override (in the official bidi table `bft`)
const LRI = '\u2066' // left-to-right isolate (in `bft`)
const FFFD = '\ufffd' // the painter's bidi-neutralization glyph

describe('CC 2.1.295 #076 — tabs at the screen edge keep their tail (dC pre-expands)', () => {
  test('a tab near the right edge in wrap mode wraps instead of clipping the tail', async () => {
    // Arrange — cols=10. "aaaa\tbbbb" expands (text-relative) to "aaaa    bbbb"
    // = 12 wide, so it MUST wrap. Pre-fix, widestLine saw the tab as width 0
    // (8 ≤ 10) → no wrap → the writer expanded the tab and clipped "bb".
    const frame = await renderToStringIsolated(
      <Box width={10}>
        <Text>{'aaaa\tbbbb'}</Text>
      </Box>,
      10,
    )

    // Act / Assert — the full "bbbb" tail survives on the wrapped row, and no
    // raw tab byte ever reaches the frame.
    expect(frame).toBe('aaaa\nbbbb')
    expect(frame.replace(/\n/g, '')).toContain('bbbb')
    expect(frame).not.toContain('\t')
  })

  test('a tab at end-of-line wraps its tail to the next row instead of losing it', async () => {
    // Arrange — cols=6. "abcd\tef" expands to "abcd    ef" = 10 wide → wraps.
    const frame = await renderToStringIsolated(
      <Box width={6}>
        <Text>{'abcd\tef'}</Text>
      </Box>,
      6,
    )

    // Act / Assert — pre-fix this painted "abcd" and dropped "ef" entirely.
    expect(frame.replace(/\n/g, '')).toContain('ef')
    expect(frame).not.toContain('\t')
  })

  test('a tab line does not draw over the row below it', async () => {
    // Arrange — a height-1 box holds the tab text; SENTINEL owns the next row.
    const frame = await renderToStringIsolated(
      <Box flexDirection="column">
        <Box height={1}>
          <Text>{'x\ty'}</Text>
        </Box>
        <Text>SENTINEL</Text>
      </Box>,
      20,
    )

    // Act / Assert — row 0 is the expanded tab line ('x' + 7 spaces + 'y', the
    // 8-column stop counted from the text start per #119); row 1 is SENTINEL,
    // intact and not overwritten by the tab expansion.
    const rows = frame.split('\n')
    expect(rows[0]).toBe('x       y')
    expect(rows[0]).not.toContain('\t')
    expect(rows[1]).toContain('SENTINEL')
  })
})

describe('CC 2.1.295 #076 — bidi controls at the edge are a NO-OP (measure == paint, width 1)', () => {
  test('an RTL override mid-line is neutralized without losing the tail', async () => {
    // Arrange — cols=10. The RLO measures width 1 and paints as U+FFFD width 1,
    // so the line width is identical either side and nothing is clipped.
    const frame = await renderToStringIsolated(
      <Box width={10}>
        <Text>{`aaaa${RLO}bbbb`}</Text>
      </Box>,
      10,
    )

    // Act / Assert — tail intact, override became the replacement glyph, and no
    // raw bidi control survives into the frame.
    expect(frame.replace(/\n/g, '')).toContain('bbbb')
    expect(frame).toContain(FFFD)
    expect(frame).not.toContain(RLO)
  })

  test('a bidi isolate at end-of-line does not draw over the next row', async () => {
    // Arrange — height-1 box; a trailing LRI must not push into SENTINEL's row.
    const frame = await renderToStringIsolated(
      <Box flexDirection="column">
        <Box height={1}>
          <Text>{`abcdefg${LRI}`}</Text>
        </Box>
        <Text>SENTINEL</Text>
      </Box>,
      20,
    )

    // Act / Assert
    const rows = frame.split('\n')
    expect(rows[0]).toContain('abcdefg')
    expect(rows[0]).toContain(FFFD)
    expect(rows[0]).not.toContain(LRI)
    expect(rows[1]).toContain('SENTINEL')
  })
})
