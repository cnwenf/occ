/**
 * CC 2.1.295 render-boundary raw-hyperlink stripper (P0 render-security).
 *
 * Official v295 neutralizes RAW OSC-8 escape sequences smuggled in model /
 * teammate text before they can reach the terminal as clickable cells with a
 * hidden address. The official sanitize chain (v295 `PH` windowed-token
 * fallback @220891500 region) applies, in order:
 *
 * - `Ue` (@220895091): `/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g`
 *   — removes COMPLETE OSC-8 sequences: both the BEL (`\x07`) and ST
 *   (`\x1b\\`) terminators, including the closing empty sequence
 *   `\x1b]8;;\x07`;
 * - `Dt` (`/\x9d/g`) — removes C1 OSC introducers;
 * - `Wt` (`/\x1b(?!\[)/g`) — removes bare ESC bytes (any ESC not starting an
 *   SGR `CSI [` run), which defangs unterminated/orphaned introducer residue
 *   into inert visible text (e.g. `\x1b]8;;abc` → `]8;;abc`);
 * - markdown pipeline `Ecn` (@220891500): walkTokens strips the same non-SGR
 *   control bytes from every token string field except `href`.
 *
 * This util implements that boundary as a targeted strip: complete OSC-8
 * sequences are removed fixed-point (≤4 passes, mirroring the official
 * ANSI-strip `jar` / OCC `stripAnsiSequences` in textSanitize.ts) so a nested
 * payload like `\x1b]8;;\x1b]8;;URL\x07\x07` cannot reassemble — the inner
 * complete sequence is removed first and the outer residue completes on the
 * next pass. Any leftover bare ESC (unterminated introducer) is then deleted
 * per official `Wt`, leaving only inert printable residue.
 *
 * Sanitization MUST run on the raw source BEFORE markdown lexing so
 * markdown-generated links keep working: the official link renderer (`rw`)
 * intentionally EMITS OSC-8 (`\x1b]8;;URL\x07colored\x1b]8;;\x07`) for
 * `[text](url)` — that emission happens downstream of this strip and is
 * unaffected.
 */

/** Official `N=4` (@190910058 `jar`) — fixed-point pass count. */
const STRIP_PASSES = 4

// Official `Ue` shape (v295 @220895091), terminator REQUIRED; the params/URL
// classes are merged (`[^\x07\x1b]*` spans both) which matches the same
// language — OSC-8 payload bytes exclude the BEL and ESC terminators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official-derived OSC-8 strip regex (v295 `Ue` @220895091)
const OSC8_SEQUENCE_RE = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g

// Official `Wt` (v295, `PH` chain): bare ESC not starting a CSI/SGR run.
// biome-ignore lint/suspicious/noControlCharactersInRegex: official-derived bare-ESC strip regex (v295 `Wt`)
const BARE_ESC_RE = /\x1b(?!\[)/g

/** Fast-path probe — the official OSC-8 introducer. */
const OSC8_INTRO = '\x1b]8;'

/**
 * Strip raw OSC-8 hyperlink escape sequences from untrusted display text,
 * leaving the anchor text visible as plain text. Fixed-point (≤4 passes)
 * `Ue` strip, then official `Wt` bare-ESC sweep for unterminated residue.
 */
export function stripRawHyperlinks(text: string): string {
  if (!text.includes(OSC8_INTRO)) return text
  let result = text
  for (let pass = 0; pass < STRIP_PASSES; pass++) {
    const next = result.replace(OSC8_SEQUENCE_RE, '')
    if (next === result) break
    result = next
  }
  // Defang unterminated/orphaned introducers: delete the bare ESC byte per
  // official `Wt` — printable residue stays visible but inert.
  return result.replace(BARE_ESC_RE, '')
}
