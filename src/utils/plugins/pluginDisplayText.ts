/**
 * Plugin user-facing text helpers — the official 2.1.285 display-sanitize
 * family as used by plugin messages (decompiled v285 @195748391 region):
 *
 *   official            here
 *   --------            ----
 *   `Kt(e,n=160)`       sanitizePluginDisplayText (via textSanitize, ≡ `Kt`)
 *   `Va(e,n=300)`       = Kt(e ?? "", n) — folded into sanitizePluginDisplayText callers
 *   `vt(e,n=300)`       sanitizePluginMessageText
 *   `If(e)` (no-limit)  wrapInCurlyQuotes
 *
 * `vt` verbatim:
 *   function vt(e,n=300){return Kt(e??"",n).replace(u,"")
 *     .replace(/[ʻʼ]/g,"’").replace(/"/g,"”")
 *     .replace(/'/g,"’").replace(i,"")}
 *
 * Known omissions (documented, not invented): the `u` and `i` regex aliases
 * were not recovered from the binary; `Kt` (textSanitize.sanitizeDetailText)
 * already applies the control/format-char strip and NFC normalization that
 * `i` covers, so only the three quote substitutions are applied on top.
 * `If`'s head/tail-truncation arm (`L7`) is unused by plugin messages and is
 * not ported; its sanitize chain (`iG`/`Zg`/`cr`) collapses into the same
 * sanitizeDetailText pipeline.
 */

import { sanitizeDetailText } from '../textSanitize.js'

/** Official `Kt(e,n=160)` / `Va(e,n=300)`: sanitize + NFC + truncate. */
export function sanitizePluginDisplayText(
  text: string | null | undefined,
  max = 160,
): string {
  return sanitizeDetailText(text ?? '', max)
}

/** Official `vt(e,n=300)`: `Kt` plus the curly-quote substitutions. */
export function sanitizePluginMessageText(
  text: string | null | undefined,
  max = 300,
): string {
  return sanitizeDetailText(text ?? '', max)
    .replace(/[ʻʼ]/g, '’')
    .replace(/"/g, '”')
    .replace(/'/g, '’')
}

/**
 * Official `If(e)` (no-truncation arm): collapse whitespace, sanitize, fold
 * quotes to ASCII, trim, then wrap in curly quotes. Empty input → "".
 */
export function wrapInCurlyQuotes(text: string): string {
  const folded = sanitizeDetailText(text.replace(/\s+/g, ' '), 200)
    .replace(/["ʻʼ]/g, "'")
    .trim()
  if (!folded) return ''
  return `“${folded}”`
}
