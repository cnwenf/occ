/**
 * CC 2.1.289 changelog #19 — the `forOutput` tokenizer behind the shared
 * text-normalization pipeline.
 *
 * > 19 - Fixed text with a tab, a stray escape and a C1 control, or a short
 * > text with a tab and CRLF line endings, drawing over the rows below it
 *
 * Byte-recovered from the official 2.1.289 linux-x64 ELF (offsets located with
 * `grep -aboF`, bytes read with `dd`; the binary was never executed):
 *
 *   @200685200  `vee` (C0 table), `G9` (ESC_TYPE), the `E`/`y`/`S`/`O` byte
 *               predicates, `K=/^\[M[\x60-\x7f][\x20-\\uffff]?$/`, `T="Gi="`
 *   @200687588  `Mme(options)` + the `w(input, state, buffer, flush, x10Mouse,
 *               forOutput, escPrefixedKeyIsAlt, stringsEndAtLineFeed)` state
 *               machine @200688035
 *   @201062051  `Ua(piece, isLast)` — feed once, then classify the leftover
 *               buffer with `mR=/^\x1b[P\]X^_k]/`
 *
 * Official `Ua`, verbatim:
 *
 *   function Ua(e,s){let r=Mme({forOutput:!0}),n=r.feed(e),i=r.buffer();
 *     if(i!=="")n.push({type:s&&!mR.test(i)?"sequence":"text",value:i});return n}
 *
 * PARAMETER MAPPING (easy to get backwards, and it decides which branches are
 * live): `Mme` calls `w(d,t,r,!1,n,s,o?.()??!1,l)` where `n=x10Mouse`,
 * `s=forOutput`, `o=escPrefixedKeyIsAlt`, `l=stringsEndAtLineFeed`. So inside
 * `w`, the 5th parameter is x10Mouse and the 6th is forOutput. For the
 * normalization pipeline (`Mme({forOutput:!0})`) that means:
 * x10Mouse=false, forOutput=TRUE, escPrefixedKeyIsAlt=false,
 * stringsEndAtLineFeed=false, flush=false.
 *
 * Consequence worth spelling out: the ground-state branch
 * `!o && u<32 && (len<64 || u===BS)` — which splits every C0 into its own text
 * token and collapses CRLF into a bare CR — is DEAD here (`!o` is false). It
 * belongs to the stdin key reader. C0 controls (tab, LF, CR) therefore stay
 * inside the text run, which is what makes `$rr`'s column tracking work.
 *
 * NOT PORTED, each because the option that gates it is false in this
 * instantiation (all are input-reader or x10-mouse concerns, output-neutral):
 *   - ground C0 split + CRLF→CR collapse (`!forOutput`)
 *   - ground DEL `K.test(...)` x10-mouse-body guard (only shifts token
 *     boundaries; both branches keep the DEL, so `$rr` output is identical)
 *   - `escapeIntermediate` state (`forOutput && S(u)` returns to ground first)
 *   - csi x10 `CSI M` mouse-report branch (`x10Mouse`)
 *   - apc kitty-graphics gate `T="Gi="` (`x10Mouse`)
 *   - doubled-ESC `escPrefixedKeyIsAlt` lookahead, `stringsEndAtLineFeed`
 *     OSC-abort-at-LF
 *
 * Source is pure ASCII: no literal control byte appears in this file.
 */
import { C0, ESC_TYPE, isEscFinal } from './termio/ansi.js'
import {
  isCSIIntermediate,
  isCSIFinal,
  isCSIParam,
} from './termio/csi.js'

export type OutputTokenType = 'text' | 'sequence'

export interface OutputToken {
  readonly type: OutputTokenType
  readonly value: string
}

/** ESC O — SS3 introducer (official: `u===79`). */
const SS3_INTRODUCER = 0x4f
/** ESC k — window-label introducer (official: `u===107`, folded into SOS). */
const WINDOW_LABEL_INTRODUCER = 0x6b
/** Bytes the official escape state treats as "text including this byte". */
const ESCAPE_TEXT_BYTES: readonly number[] = [0x20, 0x0d, 0x0a, 0x09]

/**
 * States reachable in forOutput mode. `escapeIntermediate` is deliberately
 * absent — see the NOT PORTED note in the file header.
 */
type ScanState =
  | 'ground'
  | 'escape'
  | 'csi'
  | 'ss3'
  | 'osc'
  | 'dcs'
  | 'apc'
  | 'pm'
  | 'sos'

/** Mutable scan position: official `i` (index), `g` (textStart), `f` (seqStart). */
interface ScanCursor {
  index: number
  textStart: number
  seqStart: number
  state: ScanState
}

/** Official `mR` @201062051 — DCS/OSC/SOS/PM/APC plus ESC k window labels. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `mR` (v289 @201062051) — ESC + string introducer IS the gate
const STRING_INTRODUCER = /^\x1b[P\]X^_k]/

function newCursor(): ScanCursor {
  return { index: 0, textStart: 0, seqStart: 0, state: 'ground' }
}

/** Official `b()`: close the open text run at the current index. */
function flushText(
  data: string,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  if (cursor.index > cursor.textStart) {
    const value = data.slice(cursor.textStart, cursor.index)
    if (value !== '') tokens.push({ type: 'text', value })
  }
  cursor.textStart = cursor.index
}

/** Official `p(u)`: emit a finished sequence and return to ground. */
function emitSequence(
  value: string,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  if (value !== '') tokens.push({ type: 'sequence', value })
  cursor.state = 'ground'
  cursor.textStart = cursor.index
}

/** Official: `i++, push text slice(seqStart, i)`, back to ground. */
function emitEscapeText(
  data: string,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  cursor.index++
  tokens.push({ type: 'text', value: data.slice(cursor.seqStart, cursor.index) })
  cursor.state = 'ground'
  cursor.textStart = cursor.index
}

/** Abandon a half-parsed escape: its bytes rejoin the open text run. */
function abandonSequence(cursor: ScanCursor): void {
  cursor.state = 'ground'
  cursor.textStart = cursor.seqStart
}

function scanGround(
  data: string,
  code: number,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  if (code === C0.ESC) {
    flushText(data, cursor, tokens)
    cursor.seqStart = cursor.index
    cursor.state = 'escape'
    cursor.index++
    return
  }
  if (code === C0.DEL) {
    // Official: DEL becomes its own text token (`b()` then push then `g=i`).
    flushText(data, cursor, tokens)
    cursor.index++
    tokens.push({ type: 'text', value: String.fromCharCode(C0.DEL) })
    cursor.textStart = cursor.index
    return
  }
  // Everything else — including tab, LF and CR — stays in the text run.
  cursor.index++
}

function scanEscape(
  data: string,
  code: number,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  const introducers: ReadonlyArray<readonly [number, ScanState]> = [
    [ESC_TYPE.CSI, 'csi'],
    [ESC_TYPE.OSC, 'osc'],
    [ESC_TYPE.DCS, 'dcs'],
    [ESC_TYPE.APC, 'apc'],
    [ESC_TYPE.PM, 'pm'],
    [ESC_TYPE.SOS, 'sos'],
    [WINDOW_LABEL_INTRODUCER, 'sos'],
    [SS3_INTRODUCER, 'ss3'],
  ]
  for (const [byte, state] of introducers) {
    if (code === byte) {
      cursor.state = state
      cursor.index++
      return
    }
  }
  if (ESCAPE_TEXT_BYTES.includes(code)) {
    // Official: `forOutput && u in {32,13,10,9}` → text INCLUDING the byte.
    emitEscapeText(data, cursor, tokens)
    return
  }
  if (isCSIIntermediate(code)) {
    // Official: `forOutput && S(u)` → text EXCLUDING the intermediate; the byte
    // is re-scanned in ground state, so a charset designator such as ESC ( B
    // surfaces as text and `Va` CAN-ifies the leading ESC.
    tokens.push({ type: 'text', value: data.slice(cursor.seqStart, cursor.index) })
    cursor.state = 'ground'
    cursor.textStart = cursor.index
    return
  }
  if (code === C0.DEL) {
    emitEscapeText(data, cursor, tokens)
    return
  }
  if (isEscFinal(code)) {
    cursor.index++
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    return
  }
  if (code === C0.ESC) {
    // Doubled ESC: the first one is a complete (if useless) sequence.
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    cursor.seqStart = cursor.index
    cursor.state = 'escape'
    cursor.index++
    return
  }
  if (code < 0x20) {
    emitEscapeText(data, cursor, tokens)
    return
  }
  // ESC followed by a high byte is not an escape at all.
  abandonSequence(cursor)
}

function scanCsi(
  data: string,
  code: number,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  if (isCSIFinal(code)) {
    cursor.index++
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    return
  }
  if (isCSIParam(code) || isCSIIntermediate(code)) {
    cursor.index++
    return
  }
  abandonSequence(cursor)
}

function scanSs3(
  data: string,
  code: number,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  // Official: `u>=64 && u<=126` — wider than `E()` on purpose.
  if (code >= 0x40 && code <= 0x7e) {
    cursor.index++
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    return
  }
  abandonSequence(cursor)
}

/** Shared body for osc/dcs/apc/pm/sos — the official's single case group. */
function scanString(
  data: string,
  code: number,
  cursor: ScanCursor,
  tokens: OutputToken[],
): void {
  const isBelTerminable = cursor.state !== 'pm' && cursor.state !== 'sos'
  if (code === C0.BEL && isBelTerminable) {
    cursor.index++
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    return
  }
  if (code === C0.ESC && cursor.index + 1 < data.length) {
    if (data.charCodeAt(cursor.index + 1) === ESC_TYPE.ST) {
      cursor.index += 2
      emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
      return
    }
    // A fresh escape inside an unterminated string closes the string here.
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    cursor.seqStart = cursor.index
    cursor.state = 'escape'
    cursor.index++
    return
  }
  if (code === C0.CAN || code === C0.SUB) {
    cursor.index++
    emitSequence(data.slice(cursor.seqStart, cursor.index), cursor, tokens)
    return
  }
  cursor.index++
}

/**
 * Official `Ua(piece, isLast)` @201062051: tokenize one styled piece with
 * `Mme({forOutput:!0})`, then classify whatever is left in the buffer.
 *
 * `isLastPiece` decides the fate of a truncated sequence: on a non-final piece
 * the tail is TEXT (the next piece continues the run, so treating it as a
 * control sequence would let it swallow the following piece's first
 * characters); on the final piece it stays a SEQUENCE — unless it is a string
 * introducer (`mR`), which is forced to text so a half-written OSC title can
 * never reach the terminal.
 */
export function tokenizeForOutput(
  piece: string,
  isLastPiece: boolean,
): OutputToken[] {
  const tokens: OutputToken[] = []
  const cursor = newCursor()

  while (cursor.index < piece.length) {
    const code = piece.charCodeAt(cursor.index)
    switch (cursor.state) {
      case 'ground':
        scanGround(piece, code, cursor, tokens)
        break
      case 'escape':
        scanEscape(piece, code, cursor, tokens)
        break
      case 'csi':
        scanCsi(piece, code, cursor, tokens)
        break
      case 'ss3':
        scanSs3(piece, code, cursor, tokens)
        break
      default:
        scanString(piece, code, cursor, tokens)
        break
    }
  }

  if (cursor.state === 'ground') {
    flushText(piece, cursor, tokens)
    return tokens
  }

  const buffer = piece.slice(cursor.seqStart)
  if (buffer === '') return tokens
  const type: OutputTokenType =
    isLastPiece && !STRING_INTRODUCER.test(buffer) ? 'sequence' : 'text'
  return [...tokens, { type, value: buffer }]
}
