/**
 * CC 2.1.312 Gap-137b: sensitive-header-name display redactor — byte-verified
 * port from the official 2.1.312 linux-x64 ELF (293,592,432 B).
 *
 * The official `mcp add` sse/http confirm output prints
 *   `Headers: ${JSON.stringify(uxn(headers), null, 2)}`
 * where `uxn` replaces the VALUE of every header whose NAME matches the
 * sensitive-name pattern `pt` with `"[REDACTED]"`. This is display-only: the
 * config file (`.claude.json`) still stores the plaintext value (verified
 * against the official — it writes the raw header map to the config).
 *
 * Official symbols ported here (byte offsets located via `grep -aboF` + `dd`
 * on the ELF; module windows @238880000/@238960000, `uxn` @239000754):
 *   - `uxn` — the name-only header redactor:
 *       function uxn(e){let n=Object.create(null);for(let[r,i]of
 *         Object.entries(e))n[r]=pt.test(r)?"[REDACTED]":i;return n}
 *   - `pt` — the sensitive-name RegExp (UNANCHORED substring match, "i"):
 *       var pt=new RegExp(O6e(String.raw`api[_-]?key|secret|token|password|
 *         passwd|credential|bearer|authorization|auth[_-]?header|
 *         memory[_-]?request[_-]?mac|cookie|session[_-]?(?:id|key)|
 *         connection[_-]?string|(?:private|ssh|encryption|signing|access|
 *         deploy|master|license)[_-]?key|client[_-]?secret`),"i")
 *   - `O6e` — invisible-char pattern hardener:
 *       function O6e(e){return e.replace(/([a-z)])(?=[a-z(\[])/gi,`$1${Nlt}`)
 *         .replace(/\[_-\]\?/g,`(?:[_-]${Nlt})?`)}
 *   - `Nlt` = `[${lBe}${tto}\\ufeff]*` — zero-or-more invisible run class
 *   - `lBe` / `tto` — the invisible/default-ignorable/surrogate + Arabic-
 *     prefix control char ranges (String.raw regex source, verbatim below)
 *
 * Behavioral notes (consequences of the byte semantics — each is unit-tested):
 *   - Unanchored + case-insensitive: "My-Secret-Header", "X-Session-Key-2"
 *     and "proxy-authorization" ARE redacted.
 *   - `x-honeycomb-team` is NOT redacted — it belongs to the separate
 *     credential-header WARNING regex (`Iae`, the "Header ... looks like a
 *     credential" module), not to this display redactor.
 *   - `O6e` inserts the invisible-run class between adjacent pattern letters
 *     and inside every `[_-]?`, so zero-width evasion ("to<ZWSP>ken",
 *     "api<ZWSP>key", "au<SHY>thorization") still matches.
 *   - `uxn` builds a NEW null-prototype object — the input is never mutated
 *     (the plaintext map is what gets written to the config).
 *
 * Source hygiene: the `lBe`/`tto` ranges below are written as explicit
 * `\\uXXXX` escape text (String.raw keeps the backslashes literal, so the
 * regex engine sees exactly the official source) — never as raw invisible
 * codepoints, which would be unreviewable and copy-unsafe.
 */

/** Binary `lBe` (String.raw regex source — verbatim escape text). */
const INVISIBLE_BASE_RANGES =
  String.raw`\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\uffa0\ufff0-\ufffb\uDC00-\uDFFF\uDB40-\uDB43`

/** Binary `tto` (String.raw regex source — verbatim escape text). */
const INVISIBLE_PREPENDED_RANGES = String.raw`\u0600-\u0605\u06dd\u070f\u0890\u0891\u08e2`

/** Binary `Nlt` = `[${lBe}${tto}\\ufeff]*`. */
const INVISIBLE_RUN_CLASS = `[${INVISIBLE_BASE_RANGES}${INVISIBLE_PREPENDED_RANGES}\\ufeff]*`

/**
 * Binary `O6e`: hardens a regex source against invisible-character evasion —
 * inserts the invisible-run class between adjacent visible pattern chars and
 * rewrites every literal `[_-]?` into `(?:[_-]<invisible-run>)?`.
 */
function hardenAgainstInvisibleChars(patternSource: string): string {
  return patternSource
    .replace(/([a-z)])(?=[a-z([])/gi, `$1${INVISIBLE_RUN_CLASS}`)
    .replace(/\[_-\]\?/g, `(?:[_-]${INVISIBLE_RUN_CLASS})?`)
}

/** Binary `pt`'s String.raw alternation source (verbatim — no anchors). */
const SENSITIVE_NAME_SOURCE = String.raw`api[_-]?key|secret|token|password|passwd|credential|bearer|authorization|auth[_-]?header|memory[_-]?request[_-]?mac|cookie|session[_-]?(?:id|key)|connection[_-]?string|(?:private|ssh|encryption|signing|access|deploy|master|license)[_-]?key|client[_-]?secret`

/** Binary `pt`: the hardened, unanchored, case-insensitive name matcher. */
export const SENSITIVE_HEADER_NAME_PATTERN = new RegExp(
  hardenAgainstInvisibleChars(SENSITIVE_NAME_SOURCE),
  'i',
)

/** The official `uxn` replacement literal. */
export const HEADER_VALUE_REDACTED = '[REDACTED]'

/**
 * Binary `uxn`: returns a NEW null-prototype record where every header whose
 * NAME matches `pt` has its value replaced with `"[REDACTED]"`; all other
 * entries pass through unchanged. Never mutates the input. Display-only —
 * the config write path must keep using the plaintext record.
 */
export function redactHeadersForDisplay(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const display: Record<string, string> = Object.create(null)
  for (const [name, value] of Object.entries(headers)) {
    display[name] = SENSITIVE_HEADER_NAME_PATTERN.test(name)
      ? HEADER_VALUE_REDACTED
      : value
  }
  return display
}
