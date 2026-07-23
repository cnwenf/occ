// CC 2.1.218 #6: multi-line paste collapsed into one line with `j` in place
// of newlines.
//
// Root cause (verified empirically against OCC's parser):
// kitty-keyboard-protocol terminals encode a pasted newline (Ctrl+J, byte
// 0x0a) as the CSIu sequence for the 'j' key (Unicode codepoint 106) —
// `\x1b[106u` (or the keycode-74 variant `\x1b[74u`). Outside bracketed
// paste, `parseKeypress` decodes `\x1b[106u` to `key.name = 'j'` and
// `InputEvent.input = 'j'`, so a non-bracketed multi-line paste collapses to
// one line with literal `j` characters where newlines should be. Inside
// bracketed paste the raw `\x1b[106u` is appended to the paste buffer and
// `stripAnsi` then strips the CSIu, also collapsing the line.
//
// The conservative, safe fix lives at the paste-decode layer (called from
// `onTextPaste` before the `\r` -> `\n` normalization): convert ONLY the
// specific kitty CSIu sequences that represent newlines back to real '\n'.
// We never convert a bare letter 'j' — that cannot be distinguished from a
// typed 'j' and would corrupt normal pastes like "javascript".
//
// Official binary evidence (s21218.txt, fast grep): the official parser tracks
// bracketed-paste state with `key.name = "paste-start"` and `key.name =
// "paste-end"`, confirming paste-aware newline handling at the parser layer.
//
// Mapped codepoints:
//   106  -> 'j' (Unicode codepoint of 'j'; the Ctrl+J newline producer)
//   74   -> 'j' (kitty keycode variant)
//   13   -> 'return' / Enter
//   10   -> LF (newline)

const NEWLINE_CSIU_CODEPOINTS = new Set([106, 74, 13, 10])

// Match `ESC [ <codepoint> ; <modifier> u` or `ESC [ <codepoint> u`.
// Capture group 1 = codepoint (digits). Optional `;modifier` is allowed.
// ESC (0x1b) is built via String.fromCodePoint so the source contains no
// literal control character (biome noControlCharactersInRegex/String).
const CSIU_RE = new RegExp(
  String.fromCodePoint(0x1b) + '\\[(\\d+)(?:;\\d+)?u',
  'g',
)

/**
 * Convert paste-encoded newline representations back to real '\n'.
 *
 * Conservative decoder: only the kitty CSIu sequences for newline-producing
 * codepoints are converted. Real '\n' is preserved, '\r' and '\r\n' are
 * normalized to '\n', and bare letters (including a literal 'j') are never
 * touched.
 */
export function decodePastedNewlines(text: string): string {
  if (!text) return text

  let converted = false
  let out = text.replace(CSIU_RE, (full, codepointStr) => {
    const codepoint = Number(codepointStr)
    if (Number.isInteger(codepoint) && NEWLINE_CSIU_CODEPOINTS.has(codepoint)) {
      converted = true
      return '\n'
    }
    return full
  })

  if (!converted && out === text) {
    // Fast path: nothing matched — still normalize CR below.
  }

  // Normalize CR / CRLF to LF. Idempotent with the existing onTextPaste
  // `.replace(/\r/g, '\n')`, but centralizing here keeps a single source of
  // truth for newline normalization of pasted content.
  out = out.replace(/\r\n?/g, '\n')
  return out
}
