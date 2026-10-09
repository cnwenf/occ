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
 * Official `$rr` — expand tabs to literal spaces at `interval`-column stops,
 * tracking the display column ACROSS pieces (styled runs share one register)
 * and resetting it at every newline. Tokens `cleanToken` declines are appended
 * verbatim and do not advance the column, so SGR/OSC-8 runs survive intact.
 */
export function expandTabsInPieces(
  pieces: readonly string[],
  interval: number = TAB_INTERVAL,
): string[] {
  let column = 0
  return pieces.map((piece, index) => {
    let out = ''
    const tokens = tokenizeForOutput(piece, index === pieces.length - 1)
    for (const token of tokens) {
      const cleaned = cleanToken(token)
      if (cleaned === undefined) {
        out += token.value
        continue
      }
      for (const part of cleaned.split(TAB_OR_NEWLINE)) {
        if (part === '\t') {
          const spaces = interval - (column % interval)
          out += ' '.repeat(spaces)
          column += spaces
        } else if (part === '\n') {
          out += part
          column = 0
        } else {
          out += part
          column += stringWidth(part)
        }
      }
    }
    return out
  })
}

/**
 * Official `Hc` — the dirty-piece path: bidi-neutralize each piece, then run
 * the shared tab/control expansion. Undefined means "nothing to clean", which
 * lets callers keep their original strings (no allocation).
 */
export function normalizeDirtyPieces(
  pieces: readonly string[],
): string[] | undefined {
  if (!piecesAreDirty(pieces)) return undefined
  return expandTabsInPieces(pieces.map(piece => replaceBidi(piece)))
}

/**
 * Official `Oc` — the single entry point both measure (`mE`) and render (`Gs`)
 * use. Dirty pieces are normalized per piece; clean pieces are joined first and
 * only bidi-neutralized when NOT in a wrap mode (in wrap mode the painter owns
 * bidi, matching upstream's native painter built with `bft`). Tabs are always
 * expanded, so a tab can never reach the cell writer as a control byte.
 */
export function normalizePieces(
  pieces: readonly string[],
  isWrapMode: boolean,
): string {
  const dirty = normalizeDirtyPieces(pieces)
  if (dirty !== undefined) return dirty.join('')
  const joined = isWrapMode ? pieces.join('') : replaceBidi(pieces.join(''))
  return joined.includes('\t') ? expandTabsInPieces([joined]).join('') : joined
}

/** Official `XX` — the single-string, non-wrap entry point. */
export function normalizeText(value: string): string {
  return normalizePieces([value], false)
}

/**
 * Official `$se` — normalize one standalone string. Note it never applies
 * `replaceBidi` (upstream's `$rr` has no `Ya` pre-map), so bidi neutralization
 * for this entry point stays the painter's job.
 */
export function normalizeSingleString(
  value: string,
  interval: number = TAB_INTERVAL,
): string {
  if (!value.includes('\t') && !piecesAreDirty([value])) return value
  return expandTabsInPieces([value], interval).join('')
}

/** Official `ja`. */
export function isWrapTextMode(mode: string | undefined): boolean {
  // 'wrap-stream' is in the official list; OCC's TextWrap union has no such
  // mode (src/ink/styles.ts) but the test is kept byte-faithful.
  return mode === 'wrap' || mode === 'wrap-trim' || mode === 'wrap-stream'
}

export interface NormalizedStyledPieces {
  /**
   * The segments to style with — the input array by reference only when nothing
   * needed cleaning AND no tab needed expanding; otherwise fresh objects.
   */
  readonly segments: StyledSegment[]
  /** The joined, normalized plain text (official `dC`'s return value). */
  readonly text: string
}

/**
 * Official `dC` — normalize a styled piece list. Upstream mutates
 * `segments[i].text` in place; OCC returns fresh segment objects and leaves the
 * caller's array untouched (ECC immutability rule). Either way the invariant
 * that matters is the same: `text === segments.map(s => s.text).join('')`, so
 * `buildCharToSegmentMap` stays aligned with the wrapped output.
 *
 * CC 2.1.295 changelog #076 — "text with tabs or bidirectional control
 * characters losing its end at the edge of the screen or drawing over nearby
 * rows". Official measures AND paints through its native, screen-aware
 * `Bun.ant.CellSegmenter({ …, screen })` (byte-identical in v294 and v295), so
 * it can hand a raw tab to the writer and still wrap at the right column. OCC
 * has no such native segmenter: its paint path (`Gs`) measures/wraps the text
 * returned here with the JS `widestLine`, where a TAB counts as width 0, while
 * the cell writer (`writeLineToScreen`) expands a surviving TAB to 8-column
 * stops. That mismatch under-measures the line, skips the wrap, and clips the
 * tail at the screen edge. So `dC` pre-expands tabs for CLEAN pieces here —
 * exactly as `normalizePieces`/`Oc` (the yoga measure path) already does — to
 * keep measure == wrap == paint. Bidi overrides are still left to the painter in
 * wrap mode: they measure width 1 and the writer draws U+FFFD (also width 1), so
 * they never desync — #076's bidi half is a verified NO-OP for OCC.
 */
export function normalizeStyledPieces(
  segments: StyledSegment[],
): NormalizedStyledPieces {
  const texts = segments.map(segment => segment.text)
  const normalized = normalizeDirtyPieces(texts)
  if (normalized !== undefined) {
    return {
      segments: segments.map((segment, index) => ({
        ...segment,
        text: normalized[index] ?? '',
      })),
      text: normalized.join(''),
    }
  }
  // Clean pieces: no control byte to rewrite, but a TAB must still become
  // literal spaces so the JS width probe measures what the writer will draw
  // (see the #076 note above). Mirrors `Oc`'s clean-piece branch, which always
  // expands tabs. Tab-free clean text is returned by reference (no allocation),
  // and bidi is left for the painter (width 1 either side — never desyncs).
  const joined = texts.join('')
  if (!joined.includes('\t')) {
    return { segments, text: joined }
  }
  const expanded = expandTabsInPieces(texts)
  return {
    segments: segments.map((segment, index) => ({
      ...segment,
      text: expanded[index] ?? '',
    })),
    text: expanded.join(''),
  }
}
