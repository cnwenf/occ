/**
 * Official display-text sanitizer family (`Kt` @195748391 in CC 2.1.285;
 * `wn` @190910153 in CC 2.1.276).
 *
 * Extracted verbatim from desktopDeepLink.ts (its original OCC port site) so
 * the v285 git-URL validator (`R8`) can reuse the exact same pipeline the
 * official uses inside its `Invalid git URL: ${Kt(vp(e),200)} …` messages.
 *
 * Official pipeline:
 *   Kt(e,n=160) = f7(iM(p(e,n)).normalize("NFC")
 *                    .replace(/[\u0060\uff40\u02cb\u1fef\u2035]/g,"'")
 *                    .replace(i,""), n)
 *   iM(e)       = An(jar(f6(e))).replace(/ {2,}/g," ").trim()   (qP)
 *   p(e,n)      = `y` — pre-slice to n*8 with ANSI-boundary repair
 *   f7(e,n)     = `eEt` — head-truncate + ellipsis
 */

import { truncateToDisplayLength } from '../services/mcp/displaySanitize.js'

/** Official `y` (@190911701) pre-slices to `n*8` before ANSI-boundary repair. */
const DETAIL_PRE_SLICE_FACTOR = 8

/** Official `N=4` (@190910058 `jar`) — ANSI-strip fixed-point pass count. */
const ANSI_STRIP_PASSES = 4

// Official `b` (@190909897 region): CSI sequences (params \x30-\x3f,
// intermediates \x20-\x2f, final \x40-\x7e) and string sequences
// (OSC ] / DCS P / SOS X / PM ^ / APC _) terminated by BEL or ST.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim ANSI strip regex `b` (v276 @190909897)
const ANSI_SEQUENCE_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g

// Official `je` (@190576033 region, used by `f6`): unpaired UTF-16 surrogates.
const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// Official `An` (@190766242): C0/C1 controls + format chars + line/paragraph
// separators collapse to a single space. (No biome-ignore needed: `\p{Cc}` and
// the U+2028/U+2029 escapes below are written as \u sequences, not literal
// line/paragraph-separator chars, so this comment stays a single line.)
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu

// Official `p` (@190911701 region): combining marks not preceded by a
// non-space non-punctuation base — stray marks left by sanitization.
const STRAY_COMBINING_MARK_RE = /(?<![^\s\p{P}])\p{M}+/gu

// Official `wn` (@190910153): backtick lookalikes fold to ASCII apostrophe.
const BACKTICK_VARIANT_RE = /[\u0060\uff40\u02cb\u1fef\u2035]/g

// Official `y` (@190911701): trailing partial escape detector + the two
// complete-sequence probes used to decide whether the cut landed mid-escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim partial-escape detector (v276 `y` @190911701)
const PARTIAL_ESCAPE_TAIL_RE = /\x1b(?:[\]PX^_][^\x1b\x07]*\x1b?|\[[\x30-\x3f]*[\x20-\x2f]*)$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim CSI probe (v276 `y` @190911701)
const COMPLETE_CSI_RE = /^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: official binary-verbatim string-escape probe (v276 `y` @190911701)
const COMPLETE_STRING_ESCAPE_RE = /^\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/

const isWellFormed: ((text: string) => boolean) | undefined =
  typeof String.prototype.isWellFormed === 'function'
    ? Function.prototype.call.bind(String.prototype.isWellFormed)
    : undefined

/** Official `f6` (@190577265) — drop lone surrogates (isWellFormed fast path). */
function stripLoneSurrogates(text: string): string {
  if (isWellFormed && isWellFormed(text)) return text
  return text.replace(LONE_SURROGATE_RE, '')
}

/** Official `jar` (@190910058) — fixed-point (≤4 pass) ANSI sequence strip. */
function stripAnsiSequences(text: string): string {
  let result = text
  for (let pass = 0; pass < ANSI_STRIP_PASSES; pass++) {
    const next = result.replace(ANSI_SEQUENCE_RE, '')
    if (next === result) break
    result = next
  }
  return result
}

/**
 * Official `qP` (@190909897): `An(jar(f6(e))).replace(/ {2,}/g," ").trim()` —
 * lone surrogates → ANSI strip → controls/format → space, collapse space
 * runs, trim.
 */
function sanitizeForDisplay(text: string): string {
  return stripAnsiSequences(stripLoneSurrogates(text))
    .replace(CONTROL_FORMAT_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Official `y` (@190911701): head-slice to `n*8`, then repair a cut that
 * landed inside an ANSI escape — when the sliced tail looks like a partial
 * escape but the full remainder forms a complete sequence, drop it.
 */
function sliceWithAnsiBoundaryRepair(text: string, max: number): string {
  const head = truncateToDisplayLength(text, max * DETAIL_PRE_SLICE_FACTOR)
  if (head.length === text.length) return head
  const partial = PARTIAL_ESCAPE_TAIL_RE.exec(head)
  if (partial === null) return head
  const remainder = text.slice(partial.index)
  const isCompleteEscape =
    remainder[1] === '['
      ? COMPLETE_CSI_RE.test(remainder)
      : COMPLETE_STRING_ESCAPE_RE.test(remainder)
  return isCompleteEscape ? head.slice(0, partial.index) : head
}

/** Official `eEt` (@190910353) — head-truncate to `max` + ellipsis. */
function truncateWithEllipsis(text: string, max: number): string {
  return text.length > max
    ? `${truncateToDisplayLength(text, max)}…`
    : text
}

/**
 * Official `wn`/`Kt` (@190910153 / @195748391):
 * `eEt(qP(y(e,n)).normalize("NFC").replace(/[\u0060\uff40\u02cb\u1fef\u2035]/g,"'").replace(p,""),n)`
 */
export function sanitizeDetailText(text: string, max = 160): string {
  return truncateWithEllipsis(
    sanitizeForDisplay(sliceWithAnsiBoundaryRepair(text, max))
      .normalize('NFC')
      .replace(BACKTICK_VARIANT_RE, "'")
      .replace(STRAY_COMBINING_MARK_RE, ''),
    max,
  )
}
