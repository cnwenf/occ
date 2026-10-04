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

describe('2.1.289 #19: expandTabsInPieces (official $rr)', () => {
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

describe('2.1.289 #19: normalizeDirtyPieces (official Hc)', () => {
  test('returns undefined for clean pieces (the fast path)', () => {
    // Arrange / Act / Assert
    expect(normalizeDirtyPieces(['a\tb', RED_OPEN])).toBeUndefined()
  })

  test('returns bidi-replaced, control-cleaned, tab-expanded pieces when dirty', () => {
    // Arrange — dirty via the C1 control; bidi is replaced by the Ya pre-map
    const pieces = [`a${C1_OSC}${ch(0x202e)}`, '\tb']

    // Act
    const normalized = normalizeDirtyPieces(pieces)

    // Assert — 'a' + FFFD + FFFD = 3 cells → tab pads 5 spaces to column 8
    expect(normalized).toEqual([`a${FFFD}${FFFD}`, '     b'])
  })
})

describe('2.1.289 #19: normalizePieces / normalizeText (official Oc / XX)', () => {
  test('clean + wrap mode: expands tabs, keeps bidi (painter owns it)', () => {
    // Arrange — official Oc: `let m = u ? n.join("") : Ya(n.join(""))`; the
    // bidi table is handed to the screen painter (native, constructed with
    // bft) for wrap-mode text. OCC's painter equivalent applies replaceBidi
    // in output.ts writeLineToScreen.
    const pieces = [`a\tb${ch(0x202e)}`]

    // Act / Assert
    expect(normalizePieces(pieces, true)).toBe(`a       b${ch(0x202e)}`)
  })

  test('clean + non-wrap mode: replaces bidi AND expands tabs', () => {
    // Arrange / Act / Assert
    expect(normalizePieces([`a\tb${ch(0x202e)}`], false)).toBe(`a       b${FFFD}`)
  })

  test('clean text without tabs or bidi is returned byte-identical', () => {
    // Arrange
    const pieces = [`plain ${RED_OPEN}text${RED_CLOSE}`]

    // Act / Assert
    expect(normalizePieces(pieces, true)).toBe(pieces[0])
    expect(normalizePieces(pieces, false)).toBe(pieces[0])
  })

  test('dirty pieces take the per-piece path in BOTH wrap modes', () => {
    // Arrange — Hc runs before the wrap gate, so dirty text is normalized
    // identically for wrap and truncate modes.
    const pieces = [`a${C1_OSC}`, '\tb']

    // Act / Assert — 'a' + FFFD = 2 cells → 6 spaces to column 8
    expect(normalizePieces(pieces, true)).toBe(`a${FFFD}      b`)
    expect(normalizePieces(pieces, false)).toBe(`a${FFFD}      b`)
  })

  test('normalizeText is the single-string non-wrap entry (XX = Oc([n], false))', () => {
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

describe('2.1.289 #19: normalizeStyledPieces (official dC)', () => {
  test('returns the same array and raw join for clean pieces', () => {
    // Arrange — dC only ever rewrites pieces when Hc says they are dirty;
    // tab expansion for clean wrap-mode text is the painter's job.
    const segments = [
      { text: 'a\tb', styles: {} },
      { text: 'c', styles: {} },
    ]

    // Act
    const result = normalizeStyledPieces(segments)

    // Assert
    expect(result.segments).toBe(segments)
    expect(result.text).toBe('a\tbc')
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

describe('2.1.289 #19: isWrapTextMode (official ja)', () => {
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
})
