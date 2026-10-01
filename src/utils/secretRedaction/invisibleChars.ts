/**
 * Invisible-character machinery for zero-width-tolerant secret patterns.
 *
 * Port of the official Claude Code 2.1.286 redactor rewrite (changelog
 * bullet #19: "Fixed redacted logs and transcripts showing a secret whose
 * key name has an invisible character inside, such as a zero-width space").
 *
 * Upstream source (chunk-pn8bw28z.js, v2.1.286 linux-x64 binary,
 * md5 7a1a1bf1223b8dc705fec6124dd82df1). All constants are String.raw
 * regex-source TEXT (literal backslash-u escape sequences, never decoded
 * characters in this file):
 *
 *   ape = INVISIBLE_CHARS          (see below, byte-exact)
 *   s   = PREPENDED_CONCAT_MARKS   (see below, byte-exact)
 *   jje = `[${ape}${s}\\ufeff]*`
 *   function $Se(e) {
 *     return e
 *       .replace(/([a-z)])(?=[a-z(\[])/gi, `$1${jje}`)
 *       .replace(/\[_-\]\?/g, `(?:[_-]${jje})?`)
 *   }
 *
 * v2.1.285 has no such class (verified by byte forensics) - this is the
 * mechanism of bullet #19.
 */

/**
 * Zero-width / invisible code point ranges that may be smuggled inside a
 * secret's key name. Byte-exact match of the official `ape` constant
 * (v2.1.286): soft hyphen, combining grapheme joiner, Arabic number signs,
 * Hangul fillers, Khmer vowel inherent, Mongolian FVS, ZWSP..RLM, bidi
 * embedding/override, word joiner + invisible operators, braille blank,
 * Hangul filler 3164, variation selectors, halfwidth Hangul filler,
 * specials, lone surrogates, tag characters.
 */
export const INVISIBLE_CHARS = String.raw`\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\uffa0\ufff0-\ufffb\uDC00-\uDFFF\uDB40-\uDB43`

/**
 * Arabic-block prepended concatenation marks. Byte-exact match of the
 * official `s` constant (v2.1.286).
 */
export const PREPENDED_CONCAT_MARKS = String.raw`\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2`

/**
 * Regex fragment matching any run of invisible characters (including BOM).
 * Byte-exact match of the official `jje` constant (v2.1.286).
 */
export const INVISIBLE_RUN = `[${INVISIBLE_CHARS}${PREPENDED_CONCAT_MARKS}\\ufeff]*`

/** Matches a single invisible character (upstream `h4o`). */
export const INVISIBLE_CHAR_RE = new RegExp(
  `[${INVISIBLE_CHARS}${PREPENDED_CONCAT_MARKS}\\ufeff]`,
)

/**
 * Rewrite a regex source of ASCII key-name keywords so it tolerates invisible
 * characters smuggled between letters, and so `[_-]?` connector groups also
 * tolerate them. Byte-exact port of the official `$Se` builder (v2.1.286):
 * every boundary between two letters (or `)` -> letter/bracket) gains an
 * optional invisible run, and every literal `[_-]?` becomes `(?:[_-]<inv>)?`.
 */
export function invisibleTolerantSource(source: string): string {
  return source
    .replace(/([a-z)])(?=[a-z([])/gi, `$1${INVISIBLE_RUN}`)
    .replace(/\[_-\]\?/g, `(?:[_-]${INVISIBLE_RUN})?`)
}
