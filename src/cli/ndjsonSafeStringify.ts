import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify emits a number of characters raw that are valid per
// ECMA-404 but dangerous on a one-message-per-line wire:
//   - U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR: a receiver using
//     JavaScript line-terminator semantics (ECMA-262) splits the stream
//     mid-string and the fragment is silently dropped.
//   - U+007F DELETE, the U+0080-U+009F C1 control range, and the Unicode
//     Cf (Format) category (e.g. U+200B ZERO WIDTH SPACE, U+2060 WORD
//     JOINER, astral language-tag block U+E0001-U+E007F): invisible /
//     zero-width glyphs that can smuggle content past a human reviewer or
//     a naive filter and corrupt terminal/JSON consumers.
//
// The backslash-u-XXXX form is equivalent JSON (parses to the same string)
// but the raw glyph can never appear on the wire. ES2019's "Subsume JSON"
// proposal and Node's util.inspect do this for line terminators; the wider
// DEL/C1/Cf set is the official 2.1.311 hardening.
//
// CC 2.1.311 item 68 — faithful port of the official escaper AIe/SJ
// (binary @238836256, behind GrowthBook tengu_sober_inkell with safe:true;
// both json/stream-json writers route through it at emitter module
// @273874300 via lne/Pfo). v310's Gpe (@272244103) handled ONLY U+2028 and
// U+2029; v311 widens the class to DEL + C1 + Cf. U+2028/U+2029 are listed
// explicitly because they are Zl/Zp, not Cf.
//
// Official AIe replaces every char in the class [DEL, C1 range, U+2028,
// U+2029, Cf] with the SJ escape. Official SJ splits the match into UTF-16
// code units and rewrites each as a lowercase 4-hex backslash-u-XXXX JSON
// escape. The verbatim official regex and SJ source are pinned in the test
// file (ndjsonSafeStringify311.test.ts) docstring; they are not duplicated
// in source here because a raw U+2028/U+2029 in a regex literal or line
// comment is a JavaScript line terminator and breaks the parser, and a raw
// U+2028/U+2029 in a new RegExp pattern string is rejected (line
// terminators are forbidden in patterns).
//
// OCC builds the SAME class with new RegExp + String.fromCharCode. DEL
// (U+007F) and the C1 endpoint (U+009F) are not line terminators, so they
// are placed as raw chars via fromCharCode; U+2028, U+2029, and the Cf
// property escape are placed as backslash escape TEXT (the backslash itself
// via fromCharCode) so the pattern string never contains a raw line
// terminator. The matched set is identical to the official. Because SJ
// splits on UTF-16 code units, an astral Cf match (a surrogate pair
// consumed as one match under the u flag) escapes as two backslash-u-XXXX
// units, matching the official semantics.

const BACKSLASH = String.fromCharCode(0x5c)

/**
 * Official AIe class (@238836256): DEL (U+007F), the C1 control range
 * (U+0080-U+009F), both JS line separators (U+2028/U+2029), and the
 * Unicode Format category. The 'gu' flags = global + unicode (unicode
 * mode is required for the Cf property escape and astral matching).
 */
const WIRE_UNSAFE_CHARS = new RegExp(
  '[' +
    String.fromCharCode(0x7f) +
    '-' +
    String.fromCharCode(0x9f) +
    BACKSLASH + 'u2028' +
    BACKSLASH + 'u2029' +
    BACKSLASH + 'p{Cf}' +
    ']',
  'gu',
)

/**
 * Official SJ (@238836256): rewrite each matched UTF-16 code unit as a
 * lowercase 4-hex backslash-u-XXXX JSON escape.
 */
function escapeWireUnsafeChar(match: string): string {
  return match
    .split('')
    .map(ch => BACKSLASH + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('')
}

function escapeWireUnsafe(json: string): string {
  return json.replace(WIRE_UNSAFE_CHARS, escapeWireUnsafeChar)
}

/**
 * JSON.stringify for one-message-per-line transports (json / stream-json
 * output). Escapes U+2028/U+2029 plus DEL, the C1 control range, and the
 * Unicode Cf category (CC 2.1.311 item 68) so the serialized output can
 * neither be broken by a line-splitting receiver nor carry an invisible
 * glyph. Output is still valid JSON and parses to the same value.
 */
export function ndjsonSafeStringify(value: unknown): string {
  return escapeWireUnsafe(jsonStringify(value))
}
