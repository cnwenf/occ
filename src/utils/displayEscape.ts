/**
 * CC 2.1.291 (G#9): display escaper for file names / paths shown in tool-error
 * messages and permission prompts.
 *
 * Verbatim port of the official 291 module @205899620 (the export chunk is
 * 0-hit in 289 — this is a new 291 addition):
 *
 *   var n=/[\x00-\x1f\x7f-\x9f  ]/g, Owt=256,
 *       aCn=/[\x00-\x1f\x7f-\x9f  <>]/;
 *   function vie(e){return e.length>0&&e.length<=256&&!aCn.test(e)}
 *   function ad(e){return e.replace(n,(t)=>`&#${t.charCodeAt(0)};`)}
 *   function vV(e){return e.replaceAll("<","&lt;").replaceAll(">","&gt;")}
 *   function du(e){return ad(vV(String(e??"")))}
 *   function bsr(e){return du(e).replaceAll('"',"&quot;")}
 *   export{Owt,aCn,vie,...,ad,vV,du,bsr}
 *
 * Security rationale (291 changelog): a file name containing a line break could
 * forge extra rows or button text in a permission dialog (spoofing) and corrupt
 * a single-line tool_result. Escaping C0/C1 control chars + the JS line
 * separators U+2028/U+2029 to HTML numeric entities (`&#NN;`) neutralizes this
 * — a newline renders as the literal text `&#10;` instead of a real line break.
 *
 * The two regexes below replicate the official character class byte-for-byte.
 * U+2028/U+2029 are appended via String.fromCharCode so THIS source file stays
 * pure ASCII (a literal line separator inside a regex literal is a syntax
 * error); the resulting RegExp is functionally identical to the official
 * /[\x00-\x1f\x7f-\x9f  ]/ class.
 */

/** Official `Owt` — the max length a "plain" path may have. */
export const MAX_PLAIN_PATH_LENGTH = 256

// Official control-char class: C0 (\x00-\x1f), DEL + C1 (\x7f-\x9f), and the
// JS line separators U+2028 / U+2029.
const CONTROL_CLASS_SOURCE =
  '\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029)

/** Official `n` (global) — used by ad()/escapeControlCharsAsEntities. */
const CONTROL_ENTITY_RE = new RegExp(`[${CONTROL_CLASS_SOURCE}]`, 'g')

/** Official `aCn` (no /g → stateless .test()) — the class plus < and >. */
const PLAIN_PATH_TEST_RE = new RegExp(`[${CONTROL_CLASS_SOURCE}<>]`)

/**
 * Official `vie`: true when the string is a non-empty, <= 256-char path with no
 * control characters and no angle brackets — i.e. safe to show verbatim.
 */
export function isPlainShortPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PLAIN_PATH_LENGTH &&
    !PLAIN_PATH_TEST_RE.test(value)
  )
}

/**
 * Official `ad`: replace every control char / line separator with its HTML
 * numeric entity `&#NN;` (decimal charCodeAt). Identity for ordinary text.
 */
export function escapeControlCharsAsEntities(value: string): string {
  return value.replace(
    CONTROL_ENTITY_RE,
    (match) => `&#${match.charCodeAt(0)};`,
  )
}

/** Official `vV`: escape `<` and `>` as `&lt;` / `&gt;`. */
export function escapeAngleBrackets(value: string): string {
  return value.replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** Official `du`: `ad(vV(String(value ?? "")))`. */
export function escapeTextForDisplay(value: unknown): string {
  return escapeControlCharsAsEntities(
    escapeAngleBrackets(String(value ?? '')),
  )
}

/** Official `bsr`: `du(value)` with `"` → `&quot;` (attribute context). */
export function escapeTextForAttribute(value: unknown): string {
  return escapeTextForDisplay(value).replaceAll('"', '&quot;')
}
