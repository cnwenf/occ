/**
 * CC 2.1.289 changelog #19 — shared text-normalization pipeline (unit half).
 *
 * > 19 - Fixed text with a tab, a stray escape and a C1 control, or a short
 * > text with a tab and CRLF line endings, drawing over the rows below it
 *
 * Every expectation below is derived from the byte-recovered official v289
 * bundle (linux-x64 ELF; offsets verified with `grep -aboF` + `dd`, the binary
 * was never executed). Marker → offset map:
 *
 *   @201062051  YSt=8, uR=/(\t|\n)/, hR=/[\x1b\x9b]/g, pR=/[\x90\x98\x9d-\x9f]/g,
 *               _R (quick dirty test), mR=/^\x1b[P\]X^_k]/, gR=/^\x1b[P_].*\x07$|\x9c/s,
 *               $se, $rr, u9r, p9r, Ua, Va, La
 *   @200687588  Mme({forOutput:!0}) — the tokenizer `Ua` feeds on
 *   @205420347  bft=[[1564,1564],[8234,8238],[8294,8297]] (bidi table),
 *               R8e=new RegExp("[<bidi>]","gu")
 *   @213553684  Ya, XX, Oc, Hc, ja, cm
 *   @213590147  mE  (measure — consumes Oc)
 *   @213698657  dC  (styled-piece variant of Hc/Oc)
 *   @213699402  Gs  (render — consumes dC/XX)
 *
 * See docs/gap-research-289/cluster-f-mods-ui-runtime.md §#19 for the recovery
 * narrative. NOTE: two claims in that doc's A/B table are corrected here by the
 * binary itself (both are covered by explicit tests below):
 *   - `a\x9bb` → the C1 CSI 0x9b is in hR (→ CAN), NOT in pR (→ U+FFFD).
 *     Only 0x90/0x98/0x9d-0x9f become U+FFFD.
 *   - `a\x1bb` → ESC + printable (0x30-0x7e) tokenizes as a *sequence*, so `Va`
 *     returns undefined and the string passes through UNCHANGED. CAN-ification
 *     happens for text tokens: bare/unterminated ESC at a non-final piece,
 *     ESC + control/intermediate/DEL/high-byte, mR string introducers, and
 *     sequences containing a newline or matching gR.
 *
 * Source is kept pure ASCII on purpose: control characters are built with
 * String.fromCharCode so no literal C0/C1 byte ever lands in this file.
 */
import { describe, expect, test } from 'bun:test'
import {
  TAB_INTERVAL,
  cleanToken,
  expandTabsInPieces,
  hasControlChars,
  isWrapTextMode,
  normalizeDirtyPieces,
  normalizePieces,
  normalizeSingleString,
  normalizeStyledPieces,
  normalizeText,
  piecesAreDirty,
  replaceBidi,
  replaceC1,
} from '../normalize-text.js'
import { tokenizeForOutput } from '../output-tokenizer.js'

const ch = (code: number): string => String.fromCharCode(code)

/** C0 */
const BEL = ch(0x07)
const CAN = ch(0x18)
const ESC = ch(0x1b)
const DEL = ch(0x7f)

/** C1 controls — pR = [\x90\x98\x9d-\x9f] (DCS, SOS, OSC/PM/APC 8-bit forms) */
const C1_DCS = ch(0x90)
const C1_SOS = ch(0x98)
const C1_OSC = ch(0x9d)
const C1_PMI = ch(0x9e)
const C1_APC = ch(0x9f)
/** C1 CSI 0x9b belongs to hR (→ CAN), not pR. */
const C1_CSI = ch(0x9b)
/** 0x9c (C1 string terminator) is in NEITHER class — byte-faithful survival. */
const C1_ST = ch(0x9c)

const FFFD = ch(0xfffd)

/** bft @205420347 — [[1564,1564],[8234,8238],[8294,8297]] */
const BIDI_CODE_POINTS = [
  0x061c, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
  0x2069,
]

const RED_OPEN = `${ESC}[31m`
const RED_CLOSE = `${ESC}[39m`

/**
 * 2.1.295 #76 — grapheme-cluster fixtures. Spelled as code points so this file
 * stays pure ASCII. `stringWidth` is NOT additive across these clusters when a
 * piece boundary splits them: width(MAN + ZWJ) = 2 and width(WOMAN) = 2, but
 * width(MAN + ZWJ + WOMAN) = 2 — exactly the divergence 2.1.295 fixed by
 * deferring the measure into a single `pending` buffer measured once at the tab.
 */
const ZWJ = String.fromCodePoint(0x200d)
const VS16 = String.fromCodePoint(0xfe0f)
const MAN = String.fromCodePoint(0x1f468)
const WOMAN = String.fromCodePoint(0x1f469)
const WHITE_FLAG = String.fromCodePoint(0x1f3f3)
const RAINBOW = String.fromCodePoint(0x1f308)

describe('2.1.289 #19: TAB_INTERVAL (official YSt)', () => {
  test('the tab stop interval is 8 columns', () => {
    // Arrange / Act / Assert
    expect(TAB_INTERVAL).toBe(8)
  })
})

describe('2.1.289 #19: tokenizeForOutput (official Ua + Mme forOutput)', () => {
  test('keeps C0 controls inside the text run (forOutput ground state)', () => {
    // Arrange
    const piece = 'a\tb\nc'

    // Act
    const tokens = tokenizeForOutput(piece, true)

    // Assert — the input tokenizer would have split on control chars; the
    // forOutput variant gates that branch on `!o`, so tabs/newlines stay text.
    expect(tokens).toEqual([{ type: 'text', value: piece }])
  })

  test('emits ESC + printable as a sequence token', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`a${ESC}b`, true)

    // Assert — 0x30-0x7e is a final byte (official E()), so this is a valid
    // two-character escape, NOT stray text.
    expect(tokens).toEqual([
      { type: 'text', value: 'a' },
      { type: 'sequence', value: `${ESC}b` },
    ])
  })

  test('emits ESC + tab/newline/space as a text token including it', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`a${ESC}\tb`, true)

    // Assert — official: `o && u in {32,13,10,9}` → text slice(seqStart, i+1)
    expect(tokens).toEqual([
      { type: 'text', value: 'a' },
      { type: 'text', value: `${ESC}\t` },
      { type: 'text', value: 'b' },
    ])
  })

  test('emits ESC + intermediate byte as text without consuming it', () => {
    // Arrange / Act — charset designator ESC ( B
    const tokens = tokenizeForOutput(`${ESC}(B`, true)

    // Assert — official: `o && S(u)` → text slice(seqStart, i), i NOT advanced,
    // so the intermediate and the designator fall back into the text run.
    expect(tokens).toEqual([
      { type: 'text', value: ESC },
      { type: 'text', value: '(B' },
    ])
  })

  test('emits ESC + DEL as a text token', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`${ESC}${DEL}`, true)

    // Assert
    expect(tokens).toEqual([{ type: 'text', value: `${ESC}${DEL}` }])
  })

  test('folds ESC into the text run when followed by a high byte', () => {
    // Arrange / Act — é = U+00E9, a single code unit >= 0x80
    const tokens = tokenizeForOutput(`${ESC}${ch(0x00e9)}`, true)

    // Assert — official: else-branch → ground with textStart = seqStart
    expect(tokens).toEqual([{ type: 'text', value: `${ESC}${ch(0x00e9)}` }])
  })

  test('emits a doubled ESC as a lone-ESC sequence then a new escape', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`${ESC}${ESC}[0m`, true)

    // Assert
    expect(tokens).toEqual([
      { type: 'sequence', value: ESC },
      { type: 'sequence', value: `${ESC}[0m` },
    ])
  })

  test('classifies an unterminated buffer as text on non-final pieces', () => {
    // Arrange — a styled piece ending mid-CSI; another piece follows
    const piece = `a${ESC}[3`

    // Act
    const tokens = tokenizeForOutput(piece, false)

    // Assert — official Ua: type = isLast && !mR.test(buffer) ? sequence : text
    expect(tokens).toEqual([
      { type: 'text', value: 'a' },
      { type: 'text', value: `${ESC}[3` },
    ])
  })

  test('classifies an unterminated buffer as a sequence on the final piece', () => {
    // Arrange
    const piece = `a${ESC}[3`

    // Act
    const tokens = tokenizeForOutput(piece, true)

    // Assert
    expect(tokens).toEqual([
      { type: 'text', value: 'a' },
      { type: 'sequence', value: `${ESC}[3` },
    ])
  })

  test('keeps an unterminated string introducer as text even when final (mR)', () => {
    // Arrange — mR = /^\x1b[P\]X^_k]/ : DCS, OSC, SOS, PM, APC, ESC k
    const piece = `a${ESC}]0;title`

    // Act
    const tokens = tokenizeForOutput(piece, true)

    // Assert — a truncated title/OSC payload must never reach the terminal
    expect(tokens).toEqual([
      { type: 'text', value: 'a' },
      { type: 'text', value: `${ESC}]0;title` },
    ])
  })

  test('tokenizes a BEL-terminated OSC as one sequence (hyperlinks survive)', () => {
    // Arrange
    const osc8 = `${ESC}]8;;https://example.com${BEL}`

    // Act
    const tokens = tokenizeForOutput(osc8, true)

    // Assert
    expect(tokens).toEqual([{ type: 'sequence', value: osc8 }])
  })

  test('tokenizes an ST-terminated OSC as one sequence', () => {
    // Arrange
    const osc = `${ESC}]0;title${ESC}\\`

    // Act
    const tokens = tokenizeForOutput(osc, true)

    // Assert
    expect(tokens).toEqual([{ type: 'sequence', value: osc }])
  })

  test('PM/SOS are not BEL-terminated, so a BEL payload stays buffered', () => {
    // Arrange — official: BEL terminates every string state except pm/sos
    const piece = `${ESC}^x${BEL}`

    // Act
    const tokens = tokenizeForOutput(piece, true)

    // Assert — unterminated at end of input → buffer; mR matches ESC ^ → text
    expect(tokens).toEqual([{ type: 'text', value: piece }])
  })

  test('CAN aborts a string sequence', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`${ESC}]0;t${CAN}rest`, true)

    // Assert
    expect(tokens).toEqual([
      { type: 'sequence', value: `${ESC}]0;t${CAN}` },
      { type: 'text', value: 'rest' },
    ])
  })

  test('keeps a well-formed SGR run as a single sequence token', () => {
    // Arrange / Act
    const tokens = tokenizeForOutput(`${RED_OPEN}red${RED_CLOSE}`, true)

    // Assert
    expect(tokens).toEqual([
      { type: 'sequence', value: RED_OPEN },
      { type: 'text', value: 'red' },
      { type: 'sequence', value: RED_CLOSE },
    ])
  })
})

describe('2.1.289 #19: cleanToken (official Va)', () => {
  test('CAN-ifies ESC and C1 CSI inside a text token', () => {
    // Arrange
    const token = { type: 'text' as const, value: `a${ESC}b${C1_CSI}c` }

    // Act / Assert — hR = /[\x1b\x9b]/g → CAN
    expect(cleanToken(token)).toBe(`a${CAN}b${CAN}c`)
  })

  test('replaces the remaining C1 controls with U+FFFD', () => {
    // Arrange
    const value = `a${C1_DCS}b${C1_SOS}c${C1_OSC}d${C1_PMI}e${C1_APC}f`

    // Act / Assert — pR = /[\x90\x98\x9d-\x9f]/g
    expect(cleanToken({ type: 'text', value })).toBe(
      `a${FFFD}b${FFFD}c${FFFD}d${FFFD}e${FFFD}f`,
    )
  })

  test('leaves C1 ST (0x9c) alone — it is in neither hR nor pR', () => {
    // Arrange
    const value = `a${C1_ST}b`

    // Act / Assert
    expect(cleanToken({ type: 'text', value })).toBe(value)
  })

  test('returns undefined for a well-formed terminated sequence', () => {
    // Arrange — OSC 8 hyperlink, BEL-terminated
    const token = {
      type: 'sequence' as const,
      value: `${ESC}]8;;https://example.com${BEL}`,
    }

    // Act / Assert — undefined means "pass the token through untouched"
    expect(cleanToken(token)).toBeUndefined()
  })

  test('cleans a sequence token that contains a newline', () => {
    // Arrange — official Va: `e.value.includes("\n")` short-circuits to cleaning
    const token = { type: 'sequence' as const, value: `${ESC}]0;a\nb${BEL}` }

    // Act / Assert
    expect(cleanToken(token)).toBe(`${CAN}]0;a\nb${BEL}`)
  })

  test('cleans a BEL-terminated DCS (gR first alternative)', () => {
    // Arrange — gR = /^\x1b[P_].*\x07$|\x9c/s
    const token = { type: 'sequence' as const, value: `${ESC}Pfoo${BEL}` }

    // Act / Assert
    expect(cleanToken(token)).toBe(`${CAN}Pfoo${BEL}`)
  })

  test('cleans a sequence carrying a C1 string terminator (gR second alt)', () => {
    // Arrange
    const token = { type: 'sequence' as const, value: `${ESC}Pfoo${C1_ST}` }

    // Act / Assert
    expect(cleanToken(token)).toBe(`${CAN}Pfoo${C1_ST}`)
  })

  test('cleans an unterminated SGR fragment on a non-final piece', () => {
    // Arrange — Ua typed it as text because more pieces follow
    const token = { type: 'text' as const, value: `${ESC}[3` }

    // Act / Assert
    expect(cleanToken(token)).toBe(`${CAN}[3`)
  })

  test('CAN-ifies C1 CSI inside an ESC k label sequence', () => {
    // Arrange — official Va: `e.value.startsWith("\x1Bk")`
    const token = { type: 'sequence' as const, value: `${ESC}k${C1_CSI}x` }

    // Act / Assert — only \x9b is replaced here (not \x1b)
    expect(cleanToken(token)).toBe(`${ESC}k${CAN}x`)
  })

  test('returns an ESC k label sequence unchanged when it carries no C1', () => {
    // Arrange
    const value = `${ESC}klabel`

    // Act / Assert
    expect(cleanToken({ type: 'sequence', value })).toBe(value)
  })
})

describe('2.1.289 #19: replaceC1 (official La)', () => {
  test('maps 0x90/0x98/0x9d-0x9f to U+FFFD and leaves 0x9b alone', () => {
    // Arrange / Act / Assert
    expect(replaceC1(`a${C1_DCS}${C1_SOS}${C1_OSC}`)).toBe(
      `a${FFFD}${FFFD}${FFFD}`,
    )
    expect(replaceC1(`a${C1_CSI}b`)).toBe(`a${C1_CSI}b`)
  })
})

describe('2.1.289 #19: hasControlChars (official u9r / _R)', () => {
  test('flags ESC and every C1 control in _R', () => {
    // Arrange / Act / Assert
    for (const value of [ESC, C1_DCS, C1_SOS, C1_CSI, C1_OSC, C1_PMI, C1_APC]) {
      expect(hasControlChars(`a${value}b`)).toBe(true)
    }
  })

  test('does not flag tabs, newlines or carriage returns', () => {
    // Arrange / Act / Assert — _R has no \t: tab handling is width-only
    expect(hasControlChars('a\tb\nc\rd')).toBe(false)
    expect(hasControlChars('plain text')).toBe(false)
    expect(hasControlChars('')).toBe(false)
  })
})

describe('2.1.289 #19: piecesAreDirty (official p9r)', () => {
  test('is false for a well-formed styled run', () => {
    // Arrange / Act / Assert — Va returns undefined for every token
    expect(piecesAreDirty([`${RED_OPEN}red${RED_CLOSE}`])).toBe(false)
  })

  test('is false for plain text with tabs (tab is not a control char)', () => {
    // Arrange / Act / Assert
    expect(piecesAreDirty(['a\tb'])).toBe(false)
  })

  test('is true for a bare ESC at the end of a non-final piece', () => {
    // Arrange — the stray-escape case from the changelog: the ESC would
    // otherwise swallow the FIRST CHARACTER OF THE NEXT PIECE at paint time.
    const pieces = [`a${ESC}`, 'b']

    // Act / Assert
    expect(piecesAreDirty(pieces)).toBe(true)
  })

  test('is false when that same bare ESC ends the FINAL piece', () => {
    // Arrange — Ua types a final unterminated buffer as a sequence → Va
    // returns undefined → nothing to clean.
    const pieces = ['a', `b${ESC}`]

    // Act / Assert
    expect(piecesAreDirty(pieces)).toBe(false)
  })

  test('is true for a C1 control inside a text run', () => {
    // Arrange / Act / Assert
    expect(piecesAreDirty([`a${C1_OSC}b`])).toBe(true)
    expect(piecesAreDirty([`a${C1_CSI}b`])).toBe(true)
  })

  test('is true for an unterminated string introducer on the final piece', () => {
    // Arrange — mR forces the buffer to stay text-typed even when final
    const pieces = [`a${ESC}]0;title`]

    // Act / Assert
    expect(piecesAreDirty(pieces)).toBe(true)
  })

  test('is false for an OSC-8 hyperlink pair around styled text', () => {
    // Arrange
    const link = `${ESC}]8;;https://example.com${BEL}`
    const unlink = `${ESC}]8;;${BEL}`

    // Act / Assert
    expect(piecesAreDirty([link, 'label', unlink])).toBe(false)
  })
})

describe('2.1.295 #76: expandTabsInPieces (official $rr -> dwr -> YTo)', () => {
  test('expands a tab to the next 8-column stop', () => {
    // Arrange / Act / Assert
    expect(expandTabsInPieces(['a\tb'])).toEqual(['a       b'])
  })

  test('tracks the column across styled pieces', () => {
    // Arrange — piece 1 starts at column 2
    const pieces = ['ab', '\tc']

    // Act / Assert — 8 - 2 = 6 spaces
    expect(expandTabsInPieces(pieces)).toEqual(['ab', '      c'])
  })

  test('resets the column at a newline', () => {
    // Arrange / Act / Assert — '\n' resets the column to 0, 'h' advances it to
    // 1, so the tab pads 8 - 1 = 7 spaces.
    expect(expandTabsInPieces(['abcdefg\nh\ti'])).toEqual([
      'abcdefg\nh       i',
    ])
  })

  test('advances the column by display width, not char count', () => {
    // Arrange — 你 is a wide (2-cell) grapheme
    const pieces = ['你\tb']

    // Act / Assert — 8 - 2 = 6 spaces
    expect(expandTabsInPieces(pieces)).toEqual(['你      b'])
  })

  test('does not advance the column for pass-through escape sequences', () => {
    // Arrange — Va returns undefined for a well-formed SGR, so $rr appends the
    // raw value WITHOUT touching the column counter.
    const pieces = [RED_OPEN, '\tx']

    // Act / Assert
    expect(expandTabsInPieces(pieces)).toEqual([RED_OPEN, '        x'])
  })

  test('cleans a stray ESC before doing the tab math', () => {
    // Arrange — the CAN that replaces the stray ESC is width 0
    const pieces = [`a${ESC}`, '\tb']

    // Act / Assert — column 1 after 'a' → 7 spaces
    expect(expandTabsInPieces(pieces)).toEqual([`a${CAN}`, '       b'])
  })

  test('honours a custom tab interval', () => {
    // Arrange / Act / Assert
    expect(expandTabsInPieces(['a\tb'], 4)).toEqual(['a   b'])
  })

  test('leaves a tab-free piece byte-identical', () => {
    // Arrange
    const pieces = [`plain ${RED_OPEN}text${RED_CLOSE}`]

    // Act / Assert
    expect(expandTabsInPieces(pieces)).toEqual(pieces)
  })

  // ---------------------------------------------------------------------------
  // 2.1.295 #76 — "text with tabs ... losing its end at the edge of the screen
  // or drawing over nearby rows". Official `dwr` @206283910 (v294) advanced the
  // column counter EAGERLY (`r += ae(f)` for every text part as it was emitted).
  // Official `YTo` @208573587 (v295) instead buffers the text in `pending` and
  // calls `ae(i)` — `stringWidth` — ONCE, at the tab:
  //
  //   if(h==="\t"){r+=ae(i);let R=n-r%n;u+=" ".repeat(R);r+=R;i=""}
  //
  // `stringWidth` is not additive across grapheme clusters, so a cluster split
  // over a piece boundary now measures as ONE grapheme instead of two. Every
  // test below is a real v294-vs-v295 divergence or a fixture pinning the new
  // `pending` bookkeeping that the clean-piece fast path must maintain.
  // ---------------------------------------------------------------------------

  test('measures the whole pending run at the tab, not each piece eagerly (split ZWJ cluster)', () => {
    // Arrange — MAN + ZWJ is an incomplete ZWJ sequence and WOMAN is a separate
    // grapheme: width(MAN+ZWJ) = 2, width(WOMAN) = 2, width(MAN+ZWJ+WOMAN) = 2.
    const pieces = [`${MAN}${ZWJ}`, `${WOMAN}\tx`]

    // Act
    const result = expandTabsInPieces(pieces)

    // Assert — v295 measures the joined run once: 8 - 2 = 6 spaces.
    // v294 added 2 + 2 eagerly and produced only 8 - 4 = 4 spaces.
    expect(result).toEqual([`${MAN}${ZWJ}`, `${WOMAN}      x`])
  })

  test('measures the whole pending run at the tab for a variation-selector cluster split too', () => {
    // Arrange — WHITE_FLAG + VS16 + ZWJ / RAINBOW is the second measured
    // non-additive split (2 + 2 eager vs 2 joined).
    const pieces = [`${WHITE_FLAG}${VS16}${ZWJ}`, `${RAINBOW}\tx`]

    // Act
    const result = expandTabsInPieces(pieces)

    // Assert — 8 - 2 = 6 spaces (v294: 4).
    expect(result).toEqual([
      `${WHITE_FLAG}${VS16}${ZWJ}`,
      `${RAINBOW}      x`,
    ])
  })

  test('the clean-piece fast path still feeds the pending run', () => {
    // Arrange — 'ab' and 'cd' both take the v295 fast path
    // (`!QWn(o) && !o.includes("\t")` → return the piece verbatim), but each
    // still appends to `pending` so the later tab sees the full 4-cell run.
    const pieces = ['ab', 'cd', '\te']

    // Act / Assert — 8 - 4 = 4 spaces; the clean pieces are byte-identical.
    expect(expandTabsInPieces(pieces)).toEqual(['ab', 'cd', '    e'])
  })

  test('a tab in an earlier piece empties the pending run', () => {
    // Arrange — `YTo` sets `i=""` after padding, so 'bcde' (fast path) restarts
    // the run at column 8 rather than continuing from column 1.
    const pieces = ['a\t', 'bcde', '\tf']

    // Act / Assert — first tab: 8 - 1 = 7 spaces (column 8); second tab:
    // 8 + 4 = 12 → 8 - 12 % 8 = 4 spaces.
    expect(expandTabsInPieces(pieces)).toEqual(['a       ', 'bcde', '    f'])
  })

  test('the fast path re-seeds pending from the last newline of a clean piece', () => {
    // Arrange — `d = o.lastIndexOf("\n") + 1` → the fast path drops everything
    // before the final newline, resets `r`/`i`, and seeds `pending` with 'gh'.
    const pieces = ['abcdef\ngh', '\tx']

    // Act / Assert — the clean piece is returned byte-identical; the tab pads
    // 8 - 2 = 6 spaces off the run that started after the newline.
    expect(expandTabsInPieces(pieces)).toEqual(['abcdef\ngh', '      x'])
  })

  test('a pass-through escape sequence joins the pending run without advancing the column', () => {
    // Arrange — `mt` returns undefined for a well-formed SGR, so `YTo` appends
    // the raw value to BOTH `u` and `i`. `stringWidth` ignores ANSI, so the run
    // still measures as 2 cells.
    const pieces = [RED_OPEN, 'ab', '\tx']

    // Act / Assert — 8 - 2 = 6 spaces.
    expect(expandTabsInPieces(pieces)).toEqual([RED_OPEN, 'ab', '      x'])
  })

  test('a clean piece ending in a newline leaves the pending run empty', () => {
    // Arrange — tailStart === piece.length, so `pending` is seeded with ''.
    const pieces = ['xyz\n', 'ab\tc']

    // Act / Assert — the tab pads 8 - 2 = 6 spaces.
    expect(expandTabsInPieces(pieces)).toEqual(['xyz\n', 'ab      c'])
  })
})

describe('2.1.289 #19: replaceBidi (official Ya / R8e / bft)', () => {
  test('replaces every code point in the official bidi table with U+FFFD', () => {
    for (const codePoint of BIDI_CODE_POINTS) {
      // Arrange / Act / Assert
      expect(replaceBidi(`a${ch(codePoint)}b`)).toBe(`a${FFFD}b`)
    }
  })

  test('returns the identical string when no bidi override is present', () => {
    // Arrange
    const value = 'no bidi here 中文 עברית'

    // Act / Assert — h0.test() gate keeps this allocation-free
    expect(replaceBidi(value)).toBe(value)
  })

  test('leaves neighbouring formatting code points alone', () => {
    // Arrange — U+206A..U+206F are NOT in bft [[8294,8297]]
    const value = `a${ch(0x206a)}b`

    // Act / Assert
    expect(replaceBidi(value)).toBe(value)
  })
})

describe('2.1.295 #76: normalizeDirtyPieces (official Hc -> Dc -> _c)', () => {
  test('returns undefined for clean pieces (the fast path)', () => {
    // Arrange / Act / Assert — v295 `_c` gate is
    // `n.some(u => F0r.test(u)) || XTo(n)`; neither a tab/bidi nor a rewritable
    // control byte is present, so the pieces are returned untouched.
    expect(normalizeDirtyPieces([`plain ${RED_OPEN}text`, RED_CLOSE])).toBeUndefined()
  })

  test('treats a piece holding only a TAB as dirty (2.1.295 widened gate)', () => {
    // Arrange — 2.1.294 `Dc` gated on `Ayo(n)` (piecesAreDirty) alone, so a
    // tab-only piece was NOT dirty and the tab survived to the painter.
    // 2.1.295 `_c` adds `n.some(u => /[\\t<bidi>]/u.test(u))` (v295 @221164627).
    const pieces = ['a\tb', RED_OPEN]

    // Act
    const normalized = normalizeDirtyPieces(pieces)

    // Assert
    expect(normalized).toEqual(['a       b', RED_OPEN])
  })

  test('treats a piece holding only a BIDI override as dirty (2.1.295 widened gate)', () => {
    // Arrange — changelog #76 names "bidirectional control characters" alongside
    // tabs. In wrap mode 2.1.294 left these for the native painter entirely.
    const pieces = [`a${ch(0x202e)}b`]

    // Act
    const normalized = normalizeDirtyPieces(pieces)

    // Assert
    expect(normalized).toEqual([`a${FFFD}b`])
  })

  test('returns bidi-replaced, control-cleaned, tab-expanded pieces when dirty', () => {
    // Arrange — dirty via the C1 control; bidi is replaced by the Ya/Nc pre-map
    const pieces = [`a${C1_OSC}${ch(0x202e)}`, '\tb']

    // Act
    const normalized = normalizeDirtyPieces(pieces)

    // Assert — 'a' + FFFD + FFFD = 3 cells → tab pads 5 spaces to column 8
    expect(normalized).toEqual([`a${FFFD}${FFFD}`, '     b'])
  })
})

describe('2.1.295 #76: normalizePieces / normalizeText (official Oc -> _c -> wc / XX -> L7 -> eIe)', () => {
  test('expands tabs AND replaces bidi in every mode (the isWrapMode arg is gone)', () => {
    // Arrange — 2.1.294 `_c(n,u)` kept the bidi override when `u` (isWrapMode)
    // was true: `let m = u ? n.join("") : Ya(n.join(""))`. 2.1.295
    // `wc(n){return(_c(n)??n).join("")}` has no wrap-mode branch at all
    // (v295 @221164597) — bidi neutralization moved into the widened dirty gate,
    // so it now happens per piece in EVERY mode.
    const pieces = [`a\tb${ch(0x202e)}`]

    // Act / Assert
    expect(normalizePieces(pieces)).toBe(`a       b${FFFD}`)
  })

  test('clean text without tabs or bidi is returned byte-identical', () => {
    // Arrange
    const pieces = [`plain ${RED_OPEN}text${RED_CLOSE}`]

    // Act / Assert — `wc` falls back to `n` and joins, so the string is verbatim
    expect(normalizePieces(pieces)).toBe(pieces[0])
  })

  test('clean pieces are joined verbatim across pieces', () => {
    // Arrange / Act / Assert
    expect(normalizePieces(['ab', 'cd'])).toBe('abcd')
  })

  test('dirty pieces take the per-piece path', () => {
    // Arrange — the gate runs before any join, so dirty text is normalized
    // identically for wrap and truncate modes.
    const pieces = [`a${C1_OSC}`, '\tb']

    // Act / Assert — 'a' + FFFD = 2 cells → 6 spaces to column 8
    expect(normalizePieces(pieces)).toBe(`a${FFFD}      b`)
  })

  test('normalizeText is the single-string entry (XX = Oc([n], false) -> eIe = wc([n]))', () => {
    // Arrange / Act / Assert
    expect(normalizeText('a\tb')).toBe('a       b')
    expect(normalizeText(`a${ch(0x202e)}b`)).toBe(`a${FFFD}b`)
    expect(normalizeText(`a${C1_OSC}b`)).toBe(`a${FFFD}b`)
  })
})

describe('2.1.289 #19: normalizeSingleString (official $se)', () => {
  test('returns the input untouched when it has neither tab nor control', () => {
    // Arrange
    const value = `plain ${RED_OPEN}text${RED_CLOSE}`

    // Act / Assert — identity, no allocation
    expect(normalizeSingleString(value)).toBe(value)
  })

  test('expands tabs and cleans controls, but never touches bidi', () => {
    // Arrange — $se = includes("\t") || p9r([e]) ? $rr([e], s) : e ; $rr has no
    // Ya pre-map, so a bidi override survives this entry point.
    const value = `a\tb${ch(0x202e)}${C1_OSC}`

    // Act
    const normalized = normalizeSingleString(value)

    // Assert — the C1 makes it dirty → $rr cleans it; bidi stays
    expect(normalized).toBe(`a       b${ch(0x202e)}${FFFD}`)
  })

  test('honours a custom tab interval', () => {
    // Arrange / Act / Assert
    expect(normalizeSingleString('a\tb', 4)).toBe('a   b')
  })
})

describe('2.1.295 #76: normalizeStyledPieces (official dC -> uC -> hC)', () => {
  test('returns the same array and raw join for clean pieces', () => {
    // Arrange — hC only ever rewrites pieces when _c says they are dirty. A tab
    // makes them dirty as of 2.1.295, so the clean case needs neither tab, bidi
    // nor a rewritable control byte.
    const segments = [
      { text: `a${RED_OPEN}b`, styles: {} },
      { text: 'c', styles: {} },
    ]

    // Act
    const result = normalizeStyledPieces(segments)

    // Assert
    expect(result.segments).toBe(segments)
    expect(result.text).toBe(`a${RED_OPEN}bc`)
  })

  test('expands a tab inside a styled piece (2.1.295 widened gate reaches hC)', () => {
    // Arrange — 2.1.294 `uC` returned the raw join here (a tab is not a control
    // byte, so `Dc` said "clean") and left tab expansion to the cell writer.
    // 2.1.295 `hC` calls the widened `_c`, so the segment texts come back
    // already expanded — which is exactly what let the paint path drop its own
    // second normalization probe.
    const segments = [
      { text: 'a\tb', styles: {} },
      { text: 'c', styles: {} },
    ]

    // Act
    const result = normalizeStyledPieces(segments)

    // Assert
    expect(result.segments).not.toBe(segments)
    expect(result.segments.map(s => s.text)).toEqual(['a       b', 'c'])
    expect(result.text).toBe('a       bc')
    // the caller's array is never mutated (ECC immutability rule)
    expect(segments.map(s => s.text)).toEqual(['a\tb', 'c'])
  })

  test('normalizes every piece with a shared column when dirty', () => {
    // Arrange — piece 0 ends with a stray ESC and piece 1 starts with a tab
    const styles = { color: 'red' as const }
    const segments = [
      { text: `a${ESC}`, styles, hyperlink: 'https://example.com' },
      { text: '\tb', styles: {} },
    ]

    // Act
    const result = normalizeStyledPieces(segments)

    // Assert — CAN is width 0 → the tab still pads to column 8
    expect(result.segments.map(s => s.text)).toEqual([`a${CAN}`, '       b'])
    expect(result.text).toBe(`a${CAN}       b`)
    // styles/hyperlink travel with the piece
    expect(result.segments[0]!.styles).toBe(styles)
    expect(result.segments[0]!.hyperlink).toBe('https://example.com')
  })

  test('never mutates the caller-owned segments', () => {
    // Arrange — official dC writes `y.text = f[m]` in place; OCC keeps the
    // pipeline immutable (ECC coding-style) and returns fresh objects.
    const segments = [
      { text: `a${ESC}`, styles: {} },
      { text: `\tb${C1_OSC}`, styles: {} },
    ]
    const originalTexts = segments.map(s => s.text)

    // Act
    const result = normalizeStyledPieces(segments)

    // Assert
    expect(result.segments).not.toBe(segments)
    expect(segments.map(s => s.text)).toEqual(originalTexts)
    expect(result.text).toBe(`a${CAN}       b${FFFD}`)
  })
})

describe('2.1.295 #76: isWrapTextMode (official ja -> op)', () => {
  test('is true for the wrap modes', () => {
    // Arrange / Act / Assert
    expect(isWrapTextMode('wrap')).toBe(true)
    expect(isWrapTextMode('wrap-trim')).toBe(true)
  })

  test('is false for every truncate/clip mode', () => {
    // Arrange / Act / Assert — official ja also lists 'wrap-stream', which OCC
    // does not implement (src/ink/styles.ts TextWrap has no such mode).
    for (const mode of [
      'end',
      'middle',
      'truncate',
      'truncate-end',
      'truncate-middle',
      'truncate-start',
    ] as const) {
      expect(isWrapTextMode(mode)).toBe(false)
    }
  })

  test('the pipeline no longer keys off it — bidi is replaced in every mode', () => {
    // Arrange — 2.1.289/2.1.294 threaded `ja(y)` into `_c(n, u)` so clean pieces
    // were bidi-neutralized ONLY when the consumer was in a wrap mode; a
    // truncate/clip consumer (`L7` → `_c(..., !1)`) got the bidi byte through
    // untouched. 2.1.295 drops the parameter entirely (`wc(n)` @221164548) and
    // moves bidi replacement into `_c`, per piece, unconditionally. The helper
    // itself survives (as `op` @221165265) for other callers.
    const bidi = `a${ch(0x202e)}b`

    // Act
    const result = normalizeText(bidi)

    // Assert — v294 left the U+202E byte through on the truncate path.
    expect(result).toBe(`a${FFFD}b`)
  })
})
