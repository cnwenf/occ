import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { renderToStringIsolated } from '../CustomSelect/__tests__/renderIsolated280.js'
import { Markdown, StreamingMarkdown } from '../Markdown.js'

/**
 * CC 2.1.314 changelog #47 — "Fixed blank lines at the top of a code block
 * disappearing when the code block opens a quote." (component seam)
 *
 * Official v314 evidence (byte-verified, 2.1.314 linux-x64 ELF):
 *   - Blockquote component `Eo` @273639700 region (v314):
 *       b=ELt(p,m) … let E=b; const R=E??p;
 *       U=he.italic((E?L:L.replace(/^\n+/,"")).trimEnd())
 *     v312 `yo` @268881500 region (the bug):
 *       v=he.italic(H.map(Xs).join("").replace(/^\n+/,"").trimEnd())
 *   - Detector `Ve`/`ELt` @259564600 region (v314) vs `Ye` @254948700 (v312)
 *     — see src/utils/__tests__/quoteCodeHoist314.test.ts for the verbatim
 *     snippets.
 *
 * OCC seam: the REPL renders assistant markdown through MarkdownBody's ANSI
 * batch, whose flush applied an UNCONDITIONAL `nonTableContent.trim()` — the
 * same class of bug as the official's unconditional `replace(/^\n+/,"")`.
 * The fix gates the flush (and the list_item #084 strip) on the ported
 * official detector: a batch opening with a quote whose first non-empty
 * token is a code block keeps its leading newline(s) (trimEnd only), exactly
 * the official `(E?L:L.replace(/^\n+/,"")).trimEnd()` semantics.
 *
 * Bar convention note: OCC follows the official STRING-path bar renderer
 * (Nt, byte-identical v312≡v314) where blank lines pass through unprefixed
 * — so the preserved leading blank line renders as a bare empty line above
 * the first "▎" line (the official's Ink border box paints the bar on it;
 * OCC has no component-path box — pinned by markdownBlockquote295 tests).
 */

const COLUMNS = 100

function render(node: React.ReactNode): Promise<string> {
  return renderToStringIsolated(
    <AppStateProvider initialState={getDefaultAppState()}>{node}</AppStateProvider>,
    COLUMNS,
  )
}

describe('2.1.314 #47 Markdown component — code block opening a quote', () => {
  test('leading blank line survives when the quote opens with a code block', async () => {
    const out = stripAnsi(await render(<Markdown>{'> ```\n>\n> code\n> ```'}</Markdown>))
    expect(out.startsWith('\n▎ code')).toBe(true)
  })

  test('leading blank line survives with a language-tagged fence', async () => {
    const out = stripAnsi(
      await render(<Markdown>{'> ```js\n>\n> let x = 1\n> ```'}</Markdown>),
    )
    expect(out.startsWith('\n')).toBe(true)
    expect(out).toContain('▎')
    expect(out).toContain('let x = 1')
  })

  test('control: plain quote (paragraph first) keeps NO leading blank line', async () => {
    const out = stripAnsi(await render(<Markdown>{'> text\n>\n> more'}</Markdown>))
    expect(out.startsWith('▎ text')).toBe(true)
    expect(out).toBe('▎ text\n\n▎ more')
  })

  test('control: quote opening with a heading keeps NO leading blank line', async () => {
    const out = stripAnsi(await render(<Markdown>{'> # head\n>\n> body'}</Markdown>))
    expect(out.startsWith('\n')).toBe(false)
    expect(out).toContain('head')
  })

  test('StreamingMarkdown preserves the leading blank line too', async () => {
    const out = stripAnsi(
      await render(<StreamingMarkdown>{'> ```\n>\n> code\n> ```'}</StreamingMarkdown>),
    )
    expect(out.startsWith('\n▎ code')).toBe(true)
  })

  test('quote opening with a code block AFTER prose keeps its interior spacing', async () => {
    const out = stripAnsi(
      await render(<Markdown>{'intro\n\n> ```\n>\n> code\n> ```'}</Markdown>),
    )
    expect(out).toContain('intro')
    // The batch starts with the paragraph → flush trims as before; the
    // quote's leading newline is interior and passes through unprefixed.
    expect(out).toContain('\n\n▎ code')
  })
})
