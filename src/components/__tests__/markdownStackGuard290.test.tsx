import { describe, expect, spyOn, test } from 'bun:test'
import { marked } from 'marked'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { MARKDOWN_STACK_FALLBACK_MESSAGE } from '../../utils/markdown.js'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { Markdown, StreamingMarkdown } from '../Markdown.js'

/**
 * CC 2.1.290 cluster E item #1 — component-level RangeError catch.
 *
 * Official behavior: a RangeError escaping the markdown render path surfaces
 * the byte-exact fallback message
 * "markdown rendering exceeded the stack — input is too deeply nested"
 * (em-dash U+2014, verified in the 2.1.290 binary string table @133892/133983)
 * as plain text instead of crashing the REPL.
 *
 * OCC seam: MarkdownBody wraps cachedLexer + formatToken loop in a
 * RangeError-only catch → fallback element; StreamingMarkdown wraps its own
 * incremental lex and delegates the whole stripped input to <Markdown> on
 * RangeError (which then emits the fallback from MarkdownBody's catch).
 *
 * RED baseline: bq-20000 (`'>' + '> '.repeat(20000) + 'deep'`) throws
 * RangeError: Maximum call stack size exceeded through the unguarded
 * component path on Bun 1.3.14 + marked 17.0.5 (measured ~3.4s).
 */

const COLUMNS = 100
const BQ_20000 = '>' + '> '.repeat(20000) + 'deep'

function render(node: React.ReactNode): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>,
    COLUMNS,
  )
}

function spyLexerRangeError() {
  return spyOn(marked, 'lexer').mockImplementation(() => {
    throw new RangeError('Maximum call stack size exceeded')
  })
}

describe('2.1.290 Markdown stack-guard component behavior', () => {
  test('deeply nested blockquote (unguarded RED: RangeError) renders without crashing', async () => {
    const out = stripAnsi(await render(<Markdown>{BQ_20000}</Markdown>))
    expect(out).toContain('deep')
    expect(out).not.toContain(MARKDOWN_STACK_FALLBACK_MESSAGE)
  }, 30_000)

  test('RangeError from the lexer renders the official fallback message (Markdown)', async () => {
    const spy = spyLexerRangeError()
    try {
      const out = stripAnsi(await render(<Markdown>{'# hello *world*'}</Markdown>))
      expect(out).toContain(MARKDOWN_STACK_FALLBACK_MESSAGE)
    } finally {
      spy.mockRestore()
    }
  })

  test('RangeError from the lexer renders the official fallback message (StreamingMarkdown)', async () => {
    const spy = spyLexerRangeError()
    try {
      const out = stripAnsi(
        await render(<StreamingMarkdown>{'# hello *streaming*'}</StreamingMarkdown>),
      )
      expect(out).toContain(MARKDOWN_STACK_FALLBACK_MESSAGE)
    } finally {
      spy.mockRestore()
    }
  })

  // NOTE: no component-level non-RangeError propagation test here BY DESIGN.
  // If MarkdownBody rethrows a TypeError, ink's error boundary renders
  // ErrorOverview and the RenderOnceAndExit wrapper never runs its exit
  // effect — waitUntilExit never resolves and the harness hangs (documented
  // in renderIsolated280.tsx). The rethrow contract is pinned at the unit
  // level instead: "applyMarkdown rethrows non-RangeError lexer failures" in
  // src/utils/__tests__/markdownLexLevel290.test.ts. The component catch is
  // RangeError-only by inspection (`if (!(error instanceof RangeError)) throw
  // error` in MarkdownBody / StreamingMarkdown).

  test('normal content renders unchanged (guard + catch invisible below the cap)', async () => {
    const out = stripAnsi(await render(<Markdown>{'**bold** and `code`'}</Markdown>))
    expect(out).toContain('bold')
    expect(out).toContain('code')
    expect(out).not.toContain(MARKDOWN_STACK_FALLBACK_MESSAGE)
  })

  test('StreamingMarkdown still renders normal streaming content', async () => {
    const out = stripAnsi(await render(<StreamingMarkdown>{'para one\n\npara two\n'}</StreamingMarkdown>))
    expect(out).toContain('para one')
    expect(out).toContain('para two')
  })
})
