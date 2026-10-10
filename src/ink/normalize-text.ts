/**
 * CC 2.1.289 changelog #19 — the shared text-normalization pipeline.
 *
 * > 19 - Fixed text with a tab, a stray escape and a C1 control, or a short
 * > text with a tab and CRLF line endings, drawing over the rows below it
 *
 * One normalizer, used by BOTH the yoga measure path and the render/paint
 * path, so the two can never disagree about how wide a piece of text is.
 *
 * Byte-recovered from the official 2.1.289 linux-x64 ELF (offsets located with
 * `grep -aboF`, bytes read with `dd`; the binary was never executed). Official
 * marker → this module:
 *
 *   @201062051  YSt=8            -> TAB_INTERVAL
 *               uR=/(\t|\n)/     -> TAB_OR_NEWLINE
 *               hR=/[\x1b\x9b]/g -> ESC_OR_C1_CSI        (-> CAN)
 *               pR=/[\x90\x98\x9d-\x9f]/g -> C1_TO_REPLACEMENT (-> U+FFFD)
 *               _R               -> HAS_CONTROL_CHARS
 *               mR               -> STRING_INTRODUCER (output-tokenizer.ts)
 *               gR=/^\x1b[P_].*\x07$|\x9c/s -> BEL_OR_ST_TERMINATED_STRING
 *               La -> replaceC1        Va -> cleanToken
 *               u9r -> hasControlChars p9r -> piecesAreDirty
 *               $rr -> expandTabsInPieces   $se -> normalizeSingleString
 *   @205420347  bft=[[1564,1564],[8234,8238],[8294,8297]] -> BIDI_RANGES
 *               P6n (class source) + R8e (/[<bidi>]/gu)   -> BIDI_GLOBAL
 *   @213553684  h0 (/[<bidi>]/u) -> HAS_BIDI     Ya -> replaceBidi
 *               XX -> normalizeText  Oc -> normalizePieces
 *               Hc -> normalizeDirtyPieces   ja -> isWrapTextMode
 *   @213590147  mE  (measure) — consumes normalizePieces
 *   @213698657  dC  (styled pieces) -> normalizeStyledPieces
 *   @213699402  Gs  (render) — consumes normalizeStyledPieces/normalizeText
 *
 * NOTE: `bft` predates 2.1.289 (v288 has it as `pCt`, feeding `Tc`/`$q`); what
 * is new in 289 is the piece-aware pipeline (`Ua`/`Va`/`$rr`/`p9r`/`dC`/`Oc`),
 * verified absent from the v288 ELF (`mR`/`gR` have no match there).
 *
 * CC 2.1.295 changelog #76 (re-verified against the md5-checked 2.1.294 and
 * 2.1.295 linux-x64 ELFs, bytes read with python `mmap` + `m.find`; neither
 * binary was ever executed):
 *
 * > Fixed text with tabs or bidirectional control characters losing its end at
 * > the edge of the screen or drawing over nearby rows
 *
 * Official marker → this module, 2.1.294 (BEFORE) → 2.1.295 (AFTER):
 *
 *   @206283879 -> @208573587   TCe=8 -> bxe=8            TAB_INTERVAL (unchanged)
 *                              Jce   -> jue              normalizeSingleString (unchanged)
 *   @206283910 -> @208573618   dwr   -> YTo              expandTabsInPieces  **CHANGED**
 *                              Ayo   -> XTo              piecesAreDirty      (unchanged)
 *                              pt    -> mt               cleanToken          (unchanged)
 *                              mr    -> hr               TAB_OR_NEWLINE      (unchanged)
 *   @218667344 -> @221164481   h0    -> p0               HAS_BIDI            (unchanged)
 *                              mxo   -> F0r              TAB_OR_BIDI  **promoted into the gate**
 *   @218667446 -> @221164583   L7    -> eIe              normalizeText       (call form only)
 *   @218667459 -> @221164597   _c    -> wc               normalizePieces     **CHANGED**
 *   @218667618 -> @221164627   Dc    -> _c               normalizeDirtyPieces **CHANGED**
 *   @218668154 -> @221165265   ja    -> op               isWrapTextMode      (unchanged)
 *   @218703994 -> @221201067   dE    -> mE               measure path — drops the `ja(y)` arg
 *   @218812084 -> @221309901   uC    -> hC               normalizeStyledPieces (unchanged;
 *                                                        only its inner Dc->_c call changed)
 *   @218814334 -> @221312120   Is    -> ks               paint path — drops the second
 *                                                        normalization probe (see
 *                                                        render-node-to-output.ts)
 *
 * NOT PORTED (2.1.295 only, deliberately):
 *   - `gt`'s new clean-input fast path `if(!QWn(e))return[{type:"text",value:e}]`
 *     (v295 @208574...). Provably output-neutral: it can only fire when the
 *     piece has no control byte, in which case `tokenizeForOutput` already
 *     yields exactly one `text` token holding the whole piece and `cleanToken`
 *     is a per-character map, so splitting vs. not splitting produces the same
 *     concatenation and the same `stringWidth`. It is a pure allocation
 *     optimization, i.e. render-performance territory, and porting it would
 *     need either a circular import (normalize-text <-> output-tokenizer) or a
 *     duplicated control-byte regex.
 *   - the `L`/`F` terminal state machine's `forOutput` option removal
 *     (v294 `A_e` @205527826 -> v295 `hSe` @207297236). Diffed branch by
 *     branch: for the output instantiation (every option false) each branch's
 *     live/dead status is identical, so `output-tokenizer.ts` needs no edit.
 *
 * Two claims in docs/gap-research-289/cluster-f-mods-ui-runtime.md §#19 are
 * corrected by the binary and asserted in __tests__/textNormalization289.test.ts:
 *   1. `a\x9bb` yields CAN (U+0018), not U+FFFD: 0x9b is in `hR`, not `pR`.
 *   2. `a\x1bb` inside ONE piece is left alone (ESC + 0x30-0x7e is a valid
 *      `sequence` token); the stray-escape rewrite bites at piece boundaries.
 *
 * Source is pure ASCII: every control byte below is written as a regex escape.
 */
import {
  type OutputToken,
  tokenizeForOutput,
} from './output-tokenizer.js'
import type { StyledSegment } from './squash-text-nodes.js'
import { stringWidth } from './stringWidth.js'

/** Official `YSt` — POSIX/terminal default tab stop interval. */
export const TAB_INTERVAL = 8

/** Official `uR`. The capture group keeps the delimiters in the split output. */
const TAB_OR_NEWLINE = /(\t|\n)/
/** Official `hR` — ESC and the 8-bit CSI both collapse to CAN. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `hR` (v289 @201062051) — the ESC/C1 class IS the rewrite target
const ESC_OR_C1_CSI = /[\x1b\x9b]/g
/** Official `pR` — the C1 controls that become a replacement glyph. */
const C1_TO_REPLACEMENT = /[\x90\x98\x9d-\x9f]/g
/** Official `_R` — the cheap "is this piece dirty at all?" probe. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `_R` (v289 @201062051) — the control-byte class IS the dirty probe
const HAS_CONTROL_CHARS = /[\x1b\x90\x98\x9b\x9d-\x9f]/
/** Official `gR` — a DCS/APC that BEL-terminated, or any C1 ST (0x9c). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `gR` (v289 @201062051) — ESC/BEL/ST are the terminators being detected
const BEL_OR_ST_TERMINATED_STRING = /^\x1b[P_].*\x07$|\x9c/s
/** Official: the ESC k window-label branch only CAN-ifies 0x9b. */
const C1_CSI_ONLY = /\x9b/g
/** Official `mR` lives in output-tokenizer.ts; `Va` needs the ESC k prefix. */
const WINDOW_LABEL_PREFIX = '\x1bk'

const CAN = '\x18'
const REPLACEMENT_CHAR = '\uFFFD'

/**
 * Official `bft` @205420347 — the bidi overrides the painter neutralizes.
 * Upstream freezes the table and hands it to the NATIVE painter (`Es(bft)`);
 * OCC's cell writer is the painter, so `replaceBidi` is applied there.
 */
const BIDI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x061c, 0x061c],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]

/** Official `P6n` — the `\u{..}` class source built from `bft`. */
const BIDI_CLASS_SOURCE = BIDI_RANGES.map(([lo, hi]) =>
  hi > lo
    ? `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`
    : `\\u{${lo.toString(16)}}`,
).join('')

/** Official `h0`. */
const HAS_BIDI = new RegExp(`[${BIDI_CLASS_SOURCE}]`, 'u')
/** Official `R8e`. */
const BIDI_GLOBAL = new RegExp(`[${BIDI_CLASS_SOURCE}]`, 'gu')
/**
 * Official `mxo` (2.1.294 @218667344) / `F0r` (2.1.295 @221164481) —
 * `/[\t<bidi>]/u`. In 2.1.294 this regex existed but was NOT the dirty gate;
 * 2.1.295 promotes it into `_c` (normalizeDirtyPieces) so a piece carrying a tab
 * or a bidirectional control is ALWAYS normalized, in every text-wrap mode.
 */
const TAB_OR_BIDI = new RegExp(`[\\t${BIDI_CLASS_SOURCE}]`, 'u')

/** Official `La` — the C1 controls that get a visible replacement glyph. */
export function replaceC1(value: string): string {
  return value.replace(C1_TO_REPLACEMENT, REPLACEMENT_CHAR)
}

/** Official `Ya` — bidi overrides become U+FFFD (width 1, same as the override). */
export function replaceBidi(value: string): string {
  return HAS_BIDI.test(value)
    ? value.replace(BIDI_GLOBAL, REPLACEMENT_CHAR)
    : value
}

/**
 * Official `Va` — clean one token, or return undefined to mean "this token is a
 * well-formed control sequence, pass it through verbatim".
 *
 * Text tokens always get cleaned. A `sequence` token is cleaned only when it
 * cannot be a legitimate sequence: it carries a newline, it BEL/ST-terminated
 * as a DCS or APC (`gR`, whose payload is data rather than styling), or it is
 * an ESC k window label (where only 0x9b is rewritten, keeping the introducer).
 */
export function cleanToken(token: OutputToken): string | undefined {
  if (
    token.type === 'text' ||
    token.value.includes('\n') ||
    BEL_OR_ST_TERMINATED_STRING.test(token.value)
  ) {
    return replaceC1(token.value.replace(ESC_OR_C1_CSI, CAN))
  }
  if (token.value.startsWith(WINDOW_LABEL_PREFIX)) {
    return replaceC1(token.value.replace(C1_CSI_ONLY, CAN))
  }
  return undefined
}

/** Official `u9r`. */
export function hasControlChars(value: string): boolean {
  return HAS_CONTROL_CHARS.test(value)
}

/**
 * Official `p9r` — true when at least one piece carries a control byte that
 * normalization would actually rewrite. This is the gate that keeps the
 * pipeline free for the overwhelmingly common clean-text case.
 */
export function piecesAreDirty(pieces: readonly string[]): boolean {
  return pieces.some(
    (piece, index) =>
      hasControlChars(piece) &&
      tokenizeForOutput(piece, index === pieces.length - 1).some(
        token => (cleanToken(token) ?? token.value) !== token.value,
      ),
  )
}

/**
 * Official `$rr` (2.1.289) / `dwr` (2.1.294 @206283910) / `YTo`
 * (2.1.295 @208573618) — expand tabs to literal spaces at `interval`-column
 * stops.
 *
 * CC 2.1.295 changelog #76:
 *
 * > Fixed text with tabs or bidirectional control characters losing its end at
 * > the edge of the screen or drawing over nearby rows
 *
 * and #120:
 *
 * > Changed tab stops to count from where a text starts instead of from the
 * > screen's left edge: an answer indented by 2 has its first stop 8 cells in,
 * > where it was 6
 *
 * The 2.1.294 version measured eagerly — `column += stringWidth(part)` for every
 * text part as it was emitted. `stringWidth` is NOT additive across grapheme
 * clusters that straddle a piece or token boundary: a ZWJ emoji split between
 * two styled pieces measures 2 + 2 = 4 cell-wise but 2 as one cluster, so the
 * eager column drifted ahead of what the terminal actually shows and the next
 * tab stop landed in the wrong place. 2.1.295 defers the measurement: text is
 * accumulated in `pending` and measured ONCE, as a single string, at the tab
 * that consumes it.
 *
 * Official `YTo`, verbatim:
 *
 *   function YTo(e,n=bxe){let r=0,i="";return e.map((o,s)=>{
 *     if(!QWn(o)&&!o.includes("\t")){let d=o.lastIndexOf("\n")+1;
 *       if(d>0)r=0,i="";return i+=d>0?o.slice(d):o,o}
 *     let u="";for(let d of gt(o,s===e.length-1)){let p=mt(d);
 *       if(p===void 0){u+=d.value,i+=d.value;continue}
 *       for(let h of p.split(hr))
 *         if(h==="\t"){r+=ae(i);let R=n-r%n;u+=" ".repeat(R),r+=R,i=""}
 *         else if(h==="\n")u+=h,r=0,i="";
 *         else u+=h,i+=h}
 *     return u})}
 *
 * `r` = column, `i` = pending, `o` = piece, `u` = out, `gt` = tokenizeForOutput,
 * `mt` = cleanToken, `hr` = TAB_OR_NEWLINE, `ae` = stringWidth,
 * `QWn` = hasControlChars.
 *
 * A clean piece (no control byte, no tab) takes the fast path: it is returned
 * verbatim and never tokenized, but it still updates the shared registers — the
 * column resets at its last newline and everything after that newline joins
 * `pending`, so a tab in a LATER piece still measures the full run.
 *
 * Tokens `cleanToken` declines (well-formed control sequences) are appended
 * verbatim to both the output and `pending`; `stringWidth` ignores ANSI, so they
 * contribute zero cells but keep the run contiguous.
 */
export function expandTabsInPieces(
  pieces: readonly string[],
  interval: number = TAB_INTERVAL,
): string[] {
  let column = 0
  let pending = ''
  return pieces.map((piece, index) => {
    if (!hasControlChars(piece) && !piece.includes('\t')) {
      const tailStart = piece.lastIndexOf('\n') + 1
      if (tailStart > 0) {
        column = 0
        pending = ''
      }
      pending += tailStart > 0 ? piece.slice(tailStart) : piece
      return piece
    }
    let out = ''
    const tokens = tokenizeForOutput(piece, index === pieces.length - 1)
    for (const token of tokens) {
      const cleaned = cleanToken(token)
      if (cleaned === undefined) {
        out += token.value
        pending += token.value
        continue
      }
      for (const part of cleaned.split(TAB_OR_NEWLINE)) {
        if (part === '\t') {
          column += stringWidth(pending)
          const spaces = interval - (column % interval)
          out += ' '.repeat(spaces)
          column += spaces
          pending = ''
        } else if (part === '\n') {
          out += part
          column = 0
          pending = ''
        } else {
          out += part
          pending += part
        }
      }
    }
    return out
  })
}

/**
 * Official `Hc` (2.1.289) / `Dc` (2.1.294 @218667618) / `_c`
 * (2.1.295 @221164627) — the dirty-piece path: bidi-neutralize each piece, then
 * run the shared tab/control expansion. Undefined means "nothing to clean",
 * which lets callers keep their original strings (no allocation).
 *
 * 2.1.295 widened the gate. v294 `Dc(n){return Ayo(n)?dwr(n.map(Ya)):void 0}`
 * fired only on `piecesAreDirty` (a control byte that normalization would
 * rewrite); a piece holding just a tab or a bidi override fell through to the
 * caller, which in wrap mode joined the pieces with NO bidi neutralization at
 * all. v295 is
 * `_c(n){return n.some((u)=>F0r.test(u))||XTo(n)?YTo(n.map(Nc)):void 0}` —
 * tab-or-bidi is dirty too, so `replaceBidi` always runs and the painter and the
 * measure path can no longer disagree.
 */
export function normalizeDirtyPieces(
  pieces: readonly string[],
): string[] | undefined {
  const isDirty =
    pieces.some(piece => TAB_OR_BIDI.test(piece)) || piecesAreDirty(pieces)
  if (!isDirty) return undefined
  return expandTabsInPieces(pieces.map(piece => replaceBidi(piece)))
}

/**
 * Official `Oc` (2.1.289) / `_c(n,u)` (2.1.294 @218667459) / `wc`
 * (2.1.295 @221164597) — the single entry point both measure (`dE`/`mE`) and
 * render (`Is`/`ks`) use.
 *
 * 2.1.295 dropped the `isWrapMode` parameter entirely. v294 was
 * `_c(n,u){let f=Dc(n);if(f!==void 0)return f.join("");
 *   let m=u?n.join(""):Ya(n.join(""));
 *   return m.includes("\t")?dwr([m]).join(""):m}`
 * — i.e. clean pieces were bidi-neutralized only OUTSIDE wrap mode (in wrap mode
 * the native painter owned bidi), and a joined string carrying a tab got a
 * second expansion pass. v295 is `wc(n){return(_c(n)??n).join("")}`: both
 * special cases moved into the widened `normalizeDirtyPieces` gate, so clean
 * pieces are joined verbatim and every tab/bidi piece is normalized per piece
 * regardless of wrap mode.
 */
export function normalizePieces(pieces: readonly string[]): string {
  return (normalizeDirtyPieces(pieces) ?? pieces).join('')
}

/** Official `XX` (2.1.289) / `L7` (2.1.294 @218667446) / `eIe` (2.1.295 @221164583). */
export function normalizeText(value: string): string {
  return normalizePieces([value])
}

/**
 * Official `$se` (2.1.289) / `Jce` (2.1.294 @206283879) / `jue`
 * (2.1.295 @208573587) — normalize one standalone string. Note it never applies
 * `replaceBidi` (upstream's `$rr`/`YTo` has no `Ya`/`Nc` pre-map), so bidi
 * neutralization for this entry point stays the painter's job.
 */
export function normalizeSingleString(
  value: string,
  interval: number = TAB_INTERVAL,
): string {
  if (!value.includes('\t') && !piecesAreDirty([value])) return value
  return expandTabsInPieces([value], interval).join('')
}

/**
 * Official `ja` (2.1.294 @218668154) / `op` (2.1.295 @221165265) — unchanged
 * across the two versions. 2.1.295 no longer feeds it to the measure path
 * (`mE`) or the paint path's normalization probe; the remaining consumer is
 * `wrapWithSoftWrap` (`xv`/`Mv`).
 */
export function isWrapTextMode(mode: string | undefined): boolean {
  // 'wrap-stream' is in the official list; OCC's TextWrap union has no such
  // mode (src/ink/styles.ts) but the test is kept byte-faithful.
  return mode === 'wrap' || mode === 'wrap-trim' || mode === 'wrap-stream'
}

export interface NormalizedStyledPieces {
  /** The segments to style with — the input array when nothing needed cleaning. */
  readonly segments: StyledSegment[]
  /** The joined, normalized plain text (official `dC`'s return value). */
  readonly text: string
}

/**
 * Official `dC` (2.1.289) / `uC` (2.1.294 @218812084) / `hC`
 * (2.1.295 @221309901) — normalize a styled piece list. Structurally identical
 * across 2.1.294 and 2.1.295 (only its inner `Dc`->`_c` call changed, i.e. it
 * inherits the widened dirty gate automatically). Upstream mutates
 * `segments[i].text` in place; OCC returns fresh segment objects and leaves the
 * caller's array untouched (ECC immutability rule). Either way the invariant
 * that matters is the same: `text === segments.map(s => s.text).join('')`, so
 * `buildCharToSegmentMap` stays aligned with the wrapped output.
 */
export function normalizeStyledPieces(
  segments: StyledSegment[],
): NormalizedStyledPieces {
  const texts = segments.map(segment => segment.text)
  const normalized = normalizeDirtyPieces(texts)
  if (normalized === undefined) {
    return { segments, text: texts.join('') }
  }
  return {
    segments: segments.map((segment, index) => ({
      ...segment,
      text: normalized[index] ?? '',
    })),
    text: normalized.join(''),
  }
}
