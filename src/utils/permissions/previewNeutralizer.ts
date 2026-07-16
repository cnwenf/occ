/**
 * Neutralizes dangerous Unicode characters in permission preview text relayed
 * to chat channels (CCR, claude.ai, SDK consumers).
 *
 * CC 2.1.211 changelog: "Fixed permission previews relayed to chat channels
 * not neutralizing bidirectional-override, zero-width, and look-alike quote
 * characters, so tool inputs cannot visually alter the approval message."
 *
 * Without neutralization, a malicious tool input containing e.g. RLO (U+202E)
 * can reverse the display of the approval prompt, tricking the user into
 * approving a different action than what actually executes.
 */

// ---------------------------------------------------------------------------
// Character sets (derived from CC 2.1.211 binary recon)
// ---------------------------------------------------------------------------

/**
 * Bidirectional override controls. These can reverse or redirect the visual
 * rendering order of text, enabling approval-message spoofing.
 *
 * Binary evidence: `[؜‪-‮⁦-⁩]` in the 2.1.211 binary,
 * replaced with U+FFFD (replacement character) by the bidi-reorder function.
 *
 * - U+061C  Arabic Letter Mark
 * - U+202A  LRE (Left-to-Right Embedding)
 * - U+202B  RLE (Right-to-Left Embedding)
 * - U+202C  PDF (Pop Directional Formatting)
 * - U+202D  LRO (Left-to-Right Override)
 * - U+202E  RLO (Right-to-Left Override)
 * - U+2066  LRI (Left-to-Right Isolate)
 * - U+2067  RLI (Right-to-Left Isolate)
 * - U+2068  FSI (First Strong Isolate)
 * - U+2069  PDI (Pop Directional Isolate)
 */
const BIDI_CONTROLS_RE = /[؜‪-‮⁦-⁩]/g

/**
 * Zero-width and invisible formatting characters. These are invisible in
 * most renderers but can affect string comparison, display, and copy/paste
 * behavior.
 *
 * - U+200B  Zero Width Space
 * - U+200C  Zero Width Non-Joiner
 * - U+200D  Zero Width Joiner
 * - U+200E  Left-to-Right Mark
 * - U+200F  Right-to-Left Mark
 * - U+2060  Word Joiner (zero-width no-break space)
 * - U+FEFF  Zero Width No-Break Space / BOM
 * - U+00AD  Soft Hyphen
 * - U+2061  Function Application
 * - U+2062  Invisible Times
 * - U+2063  Invisible Separator
 * - U+2064  Invisible Plus
 */
const ZERO_WIDTH_RE = /[​-‏⁠-⁤­﻿]/g

/**
 * Look-alike double-quote characters. These visually resemble ASCII double
 * quotes (U+0022) but are distinct code points, enabling visual spoofing.
 *
 * Binary evidence (s211, expanded from s210): character class
 * `[“”„‟＂″‶ʺ˝ˮ״〃
 * 〝-〟❝❞]` in the 2.1.211 binary.
 */
const LOOKALIKE_DOUBLE_QUOTES_RE =
  /[“”„‟＂″‶ʺ˝ˮ״〃〝-〟❝❞]/g

/**
 * Look-alike single-quote characters. These visually resemble ASCII single
 * quotes / apostrophes (U+0027) but are distinct code points.
 *
 * Binary evidence (s211): `[‘’‚‛]`
 */
const LOOKALIKE_SINGLE_QUOTES_RE = /[‘’‚‛]/g

/**
 * Replacement character (U+FFFD) used for bidi controls — matches the
 * upstream binary behavior of replacing invisible bidi controls with U+FFFD.
 */
const REPLACEMENT_CHAR = '�'

/**
 * Neutralizes dangerous Unicode characters in a preview string so tool
 * inputs cannot visually alter the approval message relayed to chat channels.
 *
 * Transformation:
 * 1. Bidi override controls → U+FFFD (replacement char) — visible but harmless
 * 2. Zero-width/invisible chars → removed entirely (empty string)
 * 3. Look-alike double quotes → ASCII `"` (U+0022)
 * 4. Look-alike single quotes → ASCII `'` (U+0027)
 *
 * @param text - The raw preview text from tool input (may contain spoofing chars)
 * @returns Neutralized text safe for relay to chat channels
 */
export function neutralizePreviewText(text: string): string {
  if (!text || typeof text !== 'string') {
    return text
  }

  return text
    .replace(BIDI_CONTROLS_RE, REPLACEMENT_CHAR)
    .replace(ZERO_WIDTH_RE, '')
    .replace(LOOKALIKE_DOUBLE_QUOTES_RE, '"')
    .replace(LOOKALIKE_SINGLE_QUOTES_RE, "'")
}

/**
 * Maximum recursion depth for neutralizing nested input objects. Prevents
 * stack overflow from pathological or malicious deeply-nested payloads.
 * Tool inputs are normally 2-3 levels deep; 10 is generous but bounded.
 */
const MAX_NEUTRALIZE_DEPTH = 10

/**
 * Recursively neutralizes all string values in a record (typically the raw
 * tool `input` object relayed alongside the action_description).
 *
 * Only string values are transformed; non-string values (numbers, booleans,
 * null) are passed through unchanged. Nested objects and arrays are traversed
 * up to MAX_NEUTRALIZE_DEPTH levels to prevent DoS via deeply nested input.
 *
 * @param input - The raw tool input object (may contain spoofing chars in string values)
 * @returns A new object with all string values neutralized (immutable — original is not mutated)
 */
export function neutralizePreviewInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    result[key] = neutralizeValue(value, 0)
  }
  return result
}

function neutralizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_NEUTRALIZE_DEPTH) {
    return value
  }
  if (typeof value === 'string') {
    return neutralizePreviewText(value)
  }
  if (Array.isArray(value)) {
    return value.map(v => neutralizeValue(v, depth + 1))
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = neutralizeValue(v, depth + 1)
    }
    return result
  }
  return value
}
