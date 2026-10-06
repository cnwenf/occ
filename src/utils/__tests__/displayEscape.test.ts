import { describe, expect, test } from 'bun:test'
import {
  escapeAngleBrackets,
  escapeControlCharsAsEntities,
  escapeTextForAttribute,
  escapeTextForDisplay,
  isPlainShortPath,
  MAX_PLAIN_PATH_LENGTH,
} from '../displayEscape.js'

// CC 2.1.291 (G#9): file-name/path display escaper — verbatim port of the
// official module @205899620 (the export chunk is 0-hit in 289). The official
// control-char class is [\x00-\x1f\x7f-\x9f] plus U+2028 and U+2029 (ad uses it
// with the /g flag; aCn is the same class plus < and >, for vie). ad() rewrites
// each match to `&#NN;` via charCodeAt; vV() maps < >; du()=ad(vV(String(x??"")));
// bsr()=du() with the double-quote mapped to &quot;.
//
// Net semantics: C0/C1 control chars + U+2028/U+2029 -> HTML numeric entities
// `&#NN;` (a newline renders as the literal `&#10;`, not a real line break), so
// a file name containing a line break cannot forge extra rows / button text in
// a permission dialog (anti-spoofing) or corrupt a single-line tool_result.

// Line/paragraph separators built from code points so this source stays pure
// ASCII (no literal U+2028/U+2029 bytes, which are fragile in string literals).
const LS = String.fromCharCode(0x2028) // line separator -> &#8232;
const PS = String.fromCharCode(0x2029) // paragraph separator -> &#8233;

// The doc test-plan example input/output, assembled from explicit escapes.
const DOC_INPUT = `a\nb\rc\x00d${LS}e`
const DOC_OUTPUT = 'a&#10;b&#13;c&#0;d&#8232;e'

describe('displayEscape (CC 2.1.291 G#9)', () => {
  test('escapeControlCharsAsEntities maps control chars + line separators to entities (doc example)', () => {
    expect(escapeControlCharsAsEntities(DOC_INPUT)).toBe(DOC_OUTPUT)
  })

  test('escapeControlCharsAsEntities is the identity for ordinary path text', () => {
    // Critical invariant: normal paths are unchanged, so wiring this into the
    // file-tool error messages is a no-op for every existing (newline-free) case.
    expect(escapeControlCharsAsEntities('src/tools/FileReadTool.ts')).toBe(
      'src/tools/FileReadTool.ts',
    )
    expect(escapeControlCharsAsEntities('')).toBe('')
  })

  test('escapeControlCharsAsEntities escapes U+2029 and C1 (0x7f-0x9f) too', () => {
    expect(escapeControlCharsAsEntities(`a${PS}b`)).toBe('a&#8233;b')
    expect(escapeControlCharsAsEntities('a\x7fb')).toBe('a&#127;b')
    expect(escapeControlCharsAsEntities('a\x9fb')).toBe('a&#159;b')
    // A tab (0x09) is a C0 control char and IS escaped (matches the official
    // \x00-\x1f class — the escaper is not newline-specific).
    expect(escapeControlCharsAsEntities('a\tb')).toBe('a&#9;b')
  })

  test('escapeControlCharsAsEntities does NOT touch angle brackets (that is escapeAngleBrackets)', () => {
    // ad() only replaces the control-char class; <> survive ad() untouched.
    expect(escapeControlCharsAsEntities('a<b>c')).toBe('a<b>c')
  })

  test('escapeAngleBrackets replaces < and > with entities', () => {
    expect(escapeAngleBrackets('a<b>c')).toBe('a&lt;b&gt;c')
    expect(escapeAngleBrackets('plain')).toBe('plain')
  })

  test('escapeTextForDisplay = ad(vV(String(x ?? "")))', () => {
    // du(): angle brackets first, then control chars; nullish -> "".
    expect(escapeTextForDisplay('a<b>\nc')).toBe('a&lt;b&gt;&#10;c')
    expect(escapeTextForDisplay(undefined)).toBe('')
    expect(escapeTextForDisplay(null)).toBe('')
    expect(escapeTextForDisplay(0)).toBe('0')
  })

  test('escapeTextForAttribute = du(x) with double-quote -> &quot;', () => {
    expect(escapeTextForAttribute('a"b<c>\nd')).toBe('a&quot;b&lt;c&gt;&#10;d')
  })

  test('isPlainShortPath (vie): non-empty, <= 256, no control/angle chars', () => {
    // Doc test-plan: 256/257 boundary + <> exclusion.
    expect(MAX_PLAIN_PATH_LENGTH).toBe(256)
    expect(isPlainShortPath('a'.repeat(256))).toBe(true)
    expect(isPlainShortPath('a'.repeat(257))).toBe(false)
    expect(isPlainShortPath('')).toBe(false)
    expect(isPlainShortPath('a<b')).toBe(false)
    expect(isPlainShortPath('a>b')).toBe(false)
    expect(isPlainShortPath('a\nb')).toBe(false)
    expect(isPlainShortPath(`a${LS}b`)).toBe(false)
    expect(isPlainShortPath('src/tools/FileReadTool.ts')).toBe(true)
  })
})
