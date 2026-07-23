import { test, expect, describe } from 'bun:test'
import { decodePastedNewlines } from '../pasteNewlineDecoder.js'

// CC 2.1.218 #6: multi-line paste collapsed into one line with `j` in place
// of newlines. Root cause (empirically verified against OCC's parser):
// kitty-keyboard-protocol terminals encode a pasted newline as the CSIu
// sequence for the 'j' key (codepoint 106) — `\x1b[106u` — because Ctrl+J
// (byte 0x0a) is the newline producer. Outside paste, parseKeypress decodes
// `\x1b[106u` to key.name='j' and InputEvent.input='j'. Inside bracketed
// paste the raw `\x1b[106u` is appended to the paste buffer; stripAnsi then
// strips the CSIu, collapsing the multi-line paste into one line (the 'j'
// appears when the paste is delivered as decoded per-key input). The decoder
// converts these newline-representing CSIu sequences back to real '\n' BEFORE
// stripAnsi runs, preserving the original line structure.

describe('decodePastedNewlines', () => {
  test('preserves real newlines', () => {
    expect(decodePastedNewlines('line1\nline2\nline3')).toBe('line1\nline2\nline3')
  })

  test('converts \\r and \\r\\n to \\n (existing behavior, single source)', () => {
    expect(decodePastedNewlines('line1\rline2')).toBe('line1\nline2')
    expect(decodePastedNewlines('line1\r\nline2')).toBe('line1\nline2')
  })

  test('does not corrupt a normal paste that legitimately contains the letter j', () => {
    // A literal 'j' that is NOT a kitty CSIu sequence must be preserved as-is.
    // The decoder only converts CSIu escape sequences, never bare letters,
    // so normal words like "javascript" survive untouched.
    expect(decodePastedNewlines('javascript')).toBe('javascript')
    expect(decodePastedNewlines('java\nscript')).toBe('java\nscript')
  })

  test('decodes kitty CSIu newline sequences (the j-in-place-of-newlines regression)', () => {
    // `\x1b[106u` is the kitty CSIu for codepoint 106 ('j'); when sent for a
    // pasted newline it collapses the line. Decode back to a real newline.
    expect(decodePastedNewlines('line1\x1b[106uline2\x1b[106uline3')).toBe(
      'line1\nline2\nline3',
    )
  })

  test('decodes the kitty keycode-74 variant of the j newline sequence', () => {
    // kitty also sends `\x1b[74u` (keycode 74) which decodes to 'j'.
    expect(decodePastedNewlines('a\x1b[74ub')).toBe('a\nb')
  })

  test('decodes CSIu Enter (codepoint 13) and LF (codepoint 10) as newlines', () => {
    // Some kitty configs send Enter/LF CSIu for pasted newlines.
    expect(decodePastedNewlines('a\x1b[13ub')).toBe('a\nb')
    expect(decodePastedNewlines('a\x1b[10ub')).toBe('a\nb')
  })

  test('handles mixed real-newline and CSIu-encoded content', () => {
    expect(decodePastedNewlines('a\nb\x1b[106uc')).toBe('a\nb\nc')
  })

  test('is a no-op on empty input', () => {
    expect(decodePastedNewlines('')).toBe('')
  })

  test('does not touch unrelated CSIu sequences for printable letters', () => {
    // `\x1b[97u` is codepoint 97 ('a'); it is NOT a newline, so it should be
    // left for stripAnsi to handle (not converted to '\n').
    expect(decodePastedNewlines('x\x1b[97uy')).toBe('x\x1b[97uy')
  })
})
