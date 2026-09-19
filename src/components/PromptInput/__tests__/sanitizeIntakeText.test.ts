import { describe, expect, test } from 'bun:test'
import { sanitizeIntakeText } from '../sanitizeIntakeText.js'

// CC 2.1.278 (D3): ANSI/control-sequence strip on the non-keyboard intake
// paths (history recall + external-editor read-back). sanitizeIntakeText is
// the exact existing onTextPaste composition — stripAnsi -> decodePastedNewlines
// -> tab expansion — reused so colored/corrupt entries can't reach the editor
// layout/cursor math raw.
//
// DISCIPLINE: all ESC/control bytes are explicit \u001b/\u0007/\r/\t escapes —
// this file contains no raw control characters.

const ESC = '\u001b'
const BEL = '\u0007'

describe('sanitizeIntakeText', () => {
  test('strips ANSI color sequences from a history-recall entry', () => {
    const recalled = `${ESC}[31mred${ESC}[0m`
    const clean = sanitizeIntakeText(recalled)
    expect(clean).toBe('red')
    expect(clean.includes(ESC)).toBe(false)
  })

  test('strips OSC-8 hyperlink sequences', () => {
    const recalled = `${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`
    expect(sanitizeIntakeText(recalled)).toBe('link')
  })

  test('strips a full colorized multi-style entry without leaving escapes', () => {
    const recalled = `${ESC}[1;33mWarning:${ESC}[0m check ${ESC}[4mthis${ESC}[0m ${ESC}[32mok${ESC}[0m`
    const clean = sanitizeIntakeText(recalled)
    expect(clean).toBe('Warning: check this ok')
    expect(clean.includes(ESC)).toBe(false)
  })

  test('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeIntakeText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  test('expands tabs to 4 spaces', () => {
    expect(sanitizeIntakeText('a\tb')).toBe('a    b')
  })

  test('composition: colors + tabs + CR in one external-editor load', () => {
    const editorContent = `${ESC}[1;33mWarning:${ESC}[0m\tcheck\r\n${ESC}[32mok${ESC}[0m`
    expect(sanitizeIntakeText(editorContent)).toBe('Warning:    check\nok')
  })

  test('leaves clean text unchanged (idempotent)', () => {
    const clean = 'hello world\nline2 with  spaces'
    expect(sanitizeIntakeText(clean)).toBe(clean)
    expect(sanitizeIntakeText(sanitizeIntakeText(clean))).toBe(clean)
  })

  test('handles the empty string', () => {
    expect(sanitizeIntakeText('')).toBe('')
  })

  test('preserves real newlines and printable unicode', () => {
    const text = 'line1\nline2 — ünicode ✓'
    expect(sanitizeIntakeText(text)).toBe(text)
  })
})
