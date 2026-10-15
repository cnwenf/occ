import { logForDebugging } from './debug.js'

/**
 * Shared name-safety limits/helpers — ported verbatim from the official
 * Claude Code binary (2.1.292 cluster-c-h-carryover §C6 + CC 2.1.299 #154).
 *
 * Official shared constant (@207344922): `iY=256`.
 * Official frontmatter ignorer M4t (@207586013):
 *
 *   function M4t(e,n){if(e==null)return;let r=String(e);if(r.length<=iY)return r;
 *     t(`Frontmatter "name" of ${n} is over ${iY} characters - ignoring it`,{level:"warn"});return}
 *
 * M4t is the "ignore + warn" lane used by the skill loader, plugin agent
 * loader, and plugin command loader: an over-long frontmatter `name` is
 * DROPPED (returns undefined) so the caller falls back to its own default
 * (filename stem / caller-supplied name), and a warning is logged. This is
 * distinct from the agent loader's hard-reject lane (BFo/EXn), which lives in
 * loadAgentsDir.ts and returns the `names must be at most 256 characters`
 * error rather than silently ignoring.
 *
 * CC 2.1.299 #154 (security) adds the full "shown name" rule set below —
 * byte-exact from v299 @214784400 (predicate chain), @224020500
 * (bRt/k6/zao/qao/sj), @224020700 (wI warn), @214772100 (KU/Vc escapers),
 * @214767500 (ne/P$t truncator).
 */

/** Official `iY` — the maximum accepted length for a frontmatter `name`. */
export const NAME_MAX_LENGTH = 256

/**
 * M4t equivalent. Validates a frontmatter `name` value against the 256-char
 * limit.
 *
 * - `null`/`undefined` → `undefined` (no warning; caller falls back).
 * - value whose `String()` form is `<= 256` chars → that string.
 * - value whose `String()` form is `> 256` chars → `undefined` + a `warn`
 *   log with the official message shape, so the caller falls back.
 *
 * @param value  raw frontmatter `name` value (unknown type; coerced via String)
 * @param label  human-readable owner of the name, e.g. `skill <name>` or
 *               `plugin agent <path>` — interpolated verbatim into the warning
 */
export function validateFrontmatterName(
  value: unknown,
  label: string,
): string | undefined {
  if (value == null) {
    return undefined
  }
  const name = String(value)
  if (name.length <= NAME_MAX_LENGTH) {
    return name
  }
  logForDebugging(
    `Frontmatter "name" of ${label} is over ${NAME_MAX_LENGTH} characters - ignoring it`,
    { level: 'warn' },
  )
  return undefined
}

// ---------------------------------------------------------------------------
// CC 2.1.299 #154 — shown-name rule predicates (v299 @214784400).
//
// Official source (minified names kept in comments):
//   var br=/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, FG=256,
//       N4n=/[\x00-\x1f\x7f-\x9f\u2028\u2029<>]/;
//   function kr(e){return e.length<=256&&!N4n.test(e)}
//   function UG(e){return e.length>0&&kr(e)}
//   var Mt="\\p{Default_Ignorable_Code_Point}\\u2800",
//       b_=`\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\u2028\\u2029${Mt}`;
//   var Ar=new RegExp(`[${b_}]`,"u"),
//       Rr=/(?! )\p{Zs}|[\uFFFC\u{1D159}\u{13441}\u{13442}\u{16FE4}]|^ | $/u,
//       ke="[\\p{M}\\u1160-\\u11FF\\uD7B0-\\uD7FF]",
//       _r=new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${ke}|${ke}{9}|\\p{Soft_Dotted}\\p{M}*\\u0307|[\\u0131\\u0237]\\p{M}|(?<=[\\p{sc=Latin}\\p{sc=Common}]${ke}*)(?!\\p{sc=Inherited})${ke}`,"u");
//   function vr(e){return UG(e)&&!Ar.test(e)&&!Rr.test(e)}
//   function XHo(e){return vr(e)&&!e.includes("  ")&&!_r.test(e)}
//   var zao=/(?:^|:) | (?::|$)|^:|:$/;
//   function qao(e){return XHo(e)&&!zao.test(e)}
//   function sj(e){return qao(e)||UG(e)&&!bRt()}   // skill "is offered"
//   function k6(e){return XHo(e)||UG(e)&&!bRt()}   // command "is shown"
//   function bRt(){return _x()||k("tengu_slate_wicket",!0)!==!1}
//
// `bRt` is the Statsig gate `tengu_slate_wicket` — its default value is TRUE,
// so `!bRt()` is false by default and the official DEFAULT behavior is the
// strict lane: sj ≡ qao, k6 ≡ XHo. OCC has no remote gates, so only the
// strict lane is ported (the official default).
// ---------------------------------------------------------------------------

/** Official `N4n` — chars a name may never hold (controls, LS/PS, <>). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: byte-faithful port of official `N4n` (v299 @214784400) — the control-character ranges ARE the refusal target
const NAME_FORBIDDEN_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029<>]/

/** Official `kr` — length-capped and free of forbidden characters. */
function hasAllowedLengthAndChars(name: string): boolean {
  return name.length <= NAME_MAX_LENGTH && !NAME_FORBIDDEN_RE.test(name)
}

/** Official `UG` — non-empty and `kr`. */
function isNonEmptyAllowedName(name: string): boolean {
  return name.length > 0 && hasAllowedLengthAndChars(name)
}

/** Official `Mt` — Default_Ignorable class plus BRAILLE PATTERN BLANK. */
const IGNORABLE_CLASS_SRC = '\\p{Default_Ignorable_Code_Point}\\u2800'

/** Official `b_` — the hidden-character class source. */
const HIDDEN_CLASS_SRC = `\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\u2028\\u2029${IGNORABLE_CLASS_SRC}`

/** Official `Ar` — any single hidden character. */
const HIDDEN_CHAR_RE = new RegExp(`[${HIDDEN_CLASS_SRC}]`, 'u')

/** Official `Rr` — blank-like characters (non-space Zs, object replacement char, exotic blanks, edge spaces). */
const BLANK_LIKE_RE =
  /(?! )\p{Zs}|[\uFFFC\u{1D159}\u{13441}\u{13442}\u{16FE4}]|^ | $/u

/** Official `ke` — combining-mark class source. */
const COMBINING_CLASS_SRC = '[\\p{M}\\u1160-\\u11FF\\uD7B0-\\uD7FF]'

/** Official `_r` — combining-mark spoofing patterns. */
const COMBINING_SPOOF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])${COMBINING_CLASS_SRC}|${COMBINING_CLASS_SRC}{9}|\\p{Soft_Dotted}\\p{M}*\\u0307|[\\u0131\\u0237]\\p{M}|(?<=[\\p{sc=Latin}\\p{sc=Common}]${COMBINING_CLASS_SRC}*)(?!\\p{sc=Inherited})${COMBINING_CLASS_SRC}`,
  'u',
)

/** Official `vr` — non-empty, no hidden chars, no blank-like chars. */
function isVisibleSafeName(name: string): boolean {
  return (
    isNonEmptyAllowedName(name) &&
    !HIDDEN_CHAR_RE.test(name) &&
    !BLANK_LIKE_RE.test(name)
  )
}

/** Official `XHo` — `vr` plus no double space and no combining-mark spoofing. */
function isStrictlyShownName(name: string): boolean {
  return (
    isVisibleSafeName(name) &&
    !name.includes('  ') &&
    !COMBINING_SPOOF_RE.test(name)
  )
}

/** Official `zao` — colon-at-edge / colon-adjacent-space patterns. */
const COLON_EDGE_RE = /(?:^|:) | (?::|$)|^:|:$/

/** Official `qao` — `XHo` plus the colon-edge rule. */
function isOfferableStrictName(name: string): boolean {
  return isStrictlyShownName(name) && !COLON_EDGE_RE.test(name)
}

/**
 * Official `sj` (strict lane) — the skill-registration predicate. A name that
 * fails is NOT OFFERED: the loader warns via `warnNameNotShown(name, 'is not
 * offered')` and skips registration entirely.
 */
export function isSkillNameOffered(name: string): boolean {
  return isOfferableStrictName(name)
}

/**
 * Official `k6` (strict lane) — the command display-name predicate. A display
 * name that fails is NOT SHOWN: the command keeps loading but its
 * `userFacingName` alias is shed (falls back to the internal name), with a
 * `warnNameNotShown(name, 'is not shown for <internalName>')` warning.
 */
export function isCommandNameShown(name: string): boolean {
  return isStrictlyShownName(name)
}

// ---------------------------------------------------------------------------
// CC 2.1.299 #154 — warn lane (official wI @224020700) + escapers (@214772100).
//
//   var LJr="a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters",
//       hir=100, Kao=/[^\P{Z} ]/gu;
//   function wI(e,n){let r=wr().namesNotShown,
//     h=`${Vc(ne(e,200)).replace(Kao,(y)=>`\\u{${y.codePointAt(0)?.toString(16).toUpperCase()}}`)} ${n}`;
//     if(r.has(h)||r.size>=hir)return;
//     if(r.add(h),t(`[names] ${h}: ${LJr}${r.size===hir?". No more are told":""}`,{level:"warn"}),
//        Ji().claim("shown_name_rule_refused"))f("skill_shown_name_rule","name_refused")}
//
// The official telemetry pair (Ji().claim + f analytics) is omitted — OCC's
// analytics surface is stubbed; the observable warn behavior is byte-identical.
// The official `namesNotShown` set lives in the global markdown state and is
// cleared on invalidate; OCC keeps a module-level set with a test reset.
// ---------------------------------------------------------------------------

/** Official `LJr` — the refusal reason appended to every [names] warning. */
export const NAME_REFUSAL_REASON =
  'a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters'

/** Official `hir` — max distinct refusals that are warned about. */
export const MAX_DISTINCT_NAME_WARNINGS = 100

/** Official `Kao` — separator (Zs) characters that are not the plain space. */
const INVISIBLE_SEPARATOR_RE = /[^\P{Z} ]/gu

/** Official `wr().namesNotShown` — dedup set of already-warned refusals. */
const namesNotShown = new Set<string>()

/** @internal — test seam: clear the dedup set. */
export function _resetNamesNotShownForTesting(): void {
  namesNotShown.clear()
}

/** Official `P$t` (Buffer lane — Bun always has Buffer). */
function normalizeUtf16(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le')
}

/**
 * Official `ne` (@214767500) — surrogate-safe truncation to `max` UTF-16
 * code units: if the cut lands right after a high surrogate, drop it.
 */
function truncateUtf16Safe(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const sliced = text.slice(0, max)
  const lastUnit = sliced.charCodeAt(max - 1)
  return normalizeUtf16(
    lastUnit >= 0xd800 && lastUnit <= 0xdbff ? sliced.slice(0, -1) : sliced,
  )
}

/** Official KU control/hidden-class regex (`n` in the minified source). */
const CONTROL_GRAPH_RE =
  /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu

/** Official Extended_Pictographic / Regional_Indicator / keycap segment test (`i`). */
const PICTOGRAPHIC_SEGMENT_RE =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|^[#*0-9]\uFE0F?\u20E3$/u

/** Official tag-sequence (flag) segment test (`o`). */
const TAG_SEQUENCE_RE =
  /^\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}$/u

/**
 * Official `KU` (@214772100) — grapheme-aware escaper for display: keeps
 * `\n`/`\t`, keeps emoji variation selectors / ZWJ / keycaps / tag characters
 * inside pictographic segments, and renders other control/hidden characters
 * as their visible pictures (U+241B for ESC, U+2421 for DEL, U+2400+cp for
 * C0) or `\u{HEX}`.
 */
function escapeControlGraphemes(text: string): string {
  if (!CONTROL_GRAPH_RE.test(text)) return text
  let out = ''
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  for (const { segment } of segmenter.segment(text)) {
    const isPictographic = PICTOGRAPHIC_SEGMENT_RE.test(segment)
    const isTagSequence = TAG_SEQUENCE_RE.test(segment)
    CONTROL_GRAPH_RE.lastIndex = 0
    out += segment.replace(
      CONTROL_GRAPH_RE,
      (match: string, offset: number): string => {
        if (match === '\n' || match === '\t') return match
        const codePoint = match.codePointAt(0) ?? 0
        if (
          isPictographic &&
          (match === '\uFE0F' ||
            match === '\uFE0E' ||
            match === '\u20E3' ||
            (match === '\u200D' && offset + match.length < segment.length) ||
            (isTagSequence && codePoint >= 917536 && codePoint <= 917631))
        ) {
          return match
        }
        if (codePoint === 27) return '\u241B'
        if (codePoint < 32) return String.fromCodePoint(9216 + codePoint)
        if (codePoint === 127) return '\u2421'
        return `\\u{${codePoint.toString(16).toUpperCase()}}`
      },
    )
  }
  return out
}

/** Official `Vc` — `KU` plus newline/tab visible pictures (U+2424 / U+2409). */
function escapeNameForDisplay(text: string): string {
  return escapeControlGraphemes(text)
    .replace(/\n/g, '\u2424')
    .replace(/\t/g, '\u2409')
}

/**
 * Official `wI` (@224020700) — warn that a name was refused, deduplicated and
 * capped at 100 distinct messages (the 100th appends ". No more are told";
 * later refusals are silent).
 *
 * @param name   the refused name (escaped + truncated to 200 in the message)
 * @param suffix official suffix, e.g. `is not offered` or
 *               ``is not shown for <internalName>``
 */
export function warnNameNotShown(name: string, suffix: string): void {
  const escaped = `${escapeNameForDisplay(truncateUtf16Safe(name, 200)).replace(
    INVISIBLE_SEPARATOR_RE,
    y => `\\u{${y.codePointAt(0)?.toString(16).toUpperCase()}}`,
  )} ${suffix}`
  if (
    namesNotShown.has(escaped) ||
    namesNotShown.size >= MAX_DISTINCT_NAME_WARNINGS
  ) {
    return
  }
  namesNotShown.add(escaped)
  logForDebugging(
    `[names] ${escaped}: ${NAME_REFUSAL_REASON}${
      namesNotShown.size === MAX_DISTINCT_NAME_WARNINGS
        ? '. No more are told'
        : ''
    }`,
    { level: 'warn' },
  )
}
