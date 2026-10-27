import { describe, expect, test } from 'bun:test'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../markdown.js'

// CC 2.1.311 item 33 — official marked `wrappedBackslash` inline extension
// (binary `Xt` @254743052, with `Kt`/`Qt`/`qt` verbatim). v310 has no such
// extension; an orphan `\` before a closing bracket/quote was consumed by
// marked's built-in escape tokenizer (so `\)` → `)`, `\"` → `"`) and the
// backslash vanished. The extension re-tokenizes `\` + closer into an escape
// token whose text is `\` + closer, so the backslash survives — but ONLY when
// the preceding text token ends with the matching opener (the wrapping case).
// The `case 'escape'` renderer already returns `token.text`, so once the
// tokenizer emits the escape token it renders correctly with no renderer change.

describe('CC 2.1.311 item 33 — wrappedBackslash preserves an orphan backslash before a closer', () => {
  test('(\\) keeps the backslash (was dropped to ())', () => {
    const out = stripAnsi(applyMarkdown('(\\)', 'dark'))
    // Pre-fix: `\)` → escape `)` → renders `()`. Post-fix: `\)` escape token.
    expect(out).toContain('\\)')
  })

  test('"\\\\" keeps the backslash (quote pair)', () => {
    // Input value: " \ " (quote, backslash, quote)
    const out = stripAnsi(applyMarkdown('"\\"', 'dark'))
    expect(out).toContain('\\"')
  })

  test('[\\] keeps the backslash (bracket pair)', () => {
    const out = stripAnsi(applyMarkdown('[\\]', 'dark'))
    expect(out).toContain('\\]')
  })

  test('{\\} keeps the backslash (brace pair)', () => {
    const out = stripAnsi(applyMarkdown('{\\}', 'dark'))
    expect(out).toContain('\\}')
  })

  test('a real escape (\\*) is NOT re-wrapped — falls through to marked escape', () => {
    // `\*` mid-text is a legitimate escape; wrappedBackslash's Qt guard
    // (`/^\\.[\p{L}\p{N}\\*_`~]/u`) returns early so it renders as `*`, not `\*`.
    const out = stripAnsi(applyMarkdown('a\\*b', 'dark'))
    expect(out).toContain('*')
    expect(out).not.toContain('\\*')
  })

  test('\\) inside a link is left alone (inLink guard)', () => {
    // The official `this.lexer.state.inLink` guard returns early inside links.
    // We only assert this does not throw / does not double-process.
    expect(() => applyMarkdown('[label](http://x/\\))', 'dark')).not.toThrow()
  })
})
