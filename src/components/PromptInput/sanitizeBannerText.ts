// Official 2.1.269 (E35): prompt-box banner text sanitizer + width clamp.
//
// The official binary sanitizes banner/title text at RENDER time (2.1.268
// rendered `cg.text` raw — x268 @205750433):
//   dx  (x269 @181158419): `function dx(e){return wn(uWn(cV(e))).replace(/ {2,}/g," ").trim()}`
//   cV  (x269 @180829930): strips lone surrogates —
//         `function cV(e){if(T&&T(e))return e;return e.replace(Fe,"")}` with
//         Fe (x269 @180829424) =
//         /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g
//   uWn (x269 @181158419): 4-pass ANSI strip with
//         b = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g
//         (re-applied until a fixed point so stripping one sequence can't
//         splice a second one together, e.g. `ESC[ ESC[31m 31m`)
//   wn  (x269 @181016275): `e.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu," ")`
//   clamp (x269 @206568999): `var rSo=24;` … `Ke(dx(P.text),Math.max(1,Math.min(rSo,ee-1)))`
//   Ke (x269 @181621891) is byte-identical to OCC's `truncateToWidth`
//   (grapheme-segmented width loop + `…`, `maxWidth<=1` guard).

import { truncateToWidth } from '../../utils/truncate.js'

/** Official `rSo` (x269 @206568999) — hard cap on banner label width. */
export const BANNER_TEXT_MAX_WIDTH = 24

/** Official `uWn` pass count (x269 @181158419: `N=4`). */
const ANSI_STRIP_PASSES = 4

// Official `b` (x269 @181158419): CSI sequences (params \x30-\x3f,
// intermediates \x20-\x2f, final \x40-\x7e) and string sequences
// (OSC ] / DCS P / SOS X / PM ^ / APC _) terminated by BEL or ST.
// eslint-disable-next-line no-control-regex
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char matcher (official 2.1.269 E35 binary-verbatim ANSI strip regex `b`)
const ANSI_SEQUENCE_RE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[\]PX^_][^\x1b\x07]*(?:\x07|\x1b\\)/g

// Official `Fe` (x269 @180829424): unpaired UTF-16 surrogates.
const LONE_SURROGATE_RE =
  // eslint-disable-next-line no-control-regex
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// Official `wn` regex (x269 @181016275): C0/C1 controls + format chars
// (ZWSP, ZWJ, BOM, bidi overrides, …) + line/paragraph separators.
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu

const isWellFormed: ((text: string) => boolean) | undefined =
  typeof String.prototype.isWellFormed === 'function'
    ? Function.prototype.call.bind(String.prototype.isWellFormed)
    : undefined

/** Official `cV` — drop lone surrogates (fast path: isWellFormed). */
function stripLoneSurrogates(text: string): string {
  if (isWellFormed && isWellFormed(text)) return text
  return text.replace(LONE_SURROGATE_RE, '')
}

/** Official `uWn` — fixed-point (≤4 pass) ANSI sequence strip. */
function stripAnsiSequences(text: string): string {
  let result = text
  for (let pass = 0; pass < ANSI_STRIP_PASSES; pass++) {
    const next = result.replace(ANSI_SEQUENCE_RE, '')
    if (next === result) break
    result = next
  }
  return result
}

/** Official `wn` — controls/format chars/line separators become one space. */
function replaceControlsWithSpace(text: string): string {
  return text.replace(CONTROL_FORMAT_RE, ' ')
}

/**
 * Official `dx` (x269 @181158419): lone surrogates → ANSI strip →
 * controls/format chars → space, collapse runs of spaces, trim.
 * Empty result means the render site falls back to the plain border.
 */
export function sanitizeBannerText(text: string): string {
  return replaceControlsWithSpace(
    stripAnsiSequences(stripLoneSurrogates(text)),
  )
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Official clamp (x269 @206568999): `Math.max(1,Math.min(rSo,ee-1))` with
 * rSo=24 and ee = the render site's available width.
 */
export function clampBannerTextWidth(maxWidth: number): number {
  return Math.max(1, Math.min(BANNER_TEXT_MAX_WIDTH, maxWidth - 1))
}

/**
 * Official composition (x269 @206568999):
 * `Ke(dx(P.text),Math.max(1,Math.min(rSo,ee-1)))` — sanitize, then
 * width-truncate (Ke ≡ truncateToWidth, appends `…` when clipped).
 */
export function sanitizeAndClampBannerText(
  text: string,
  maxWidth: number,
): string {
  return truncateToWidth(
    sanitizeBannerText(text),
    clampBannerTextWidth(maxWidth),
  )
}
