import { describe, expect, test } from 'bun:test'
import {
  getCliHighlightPromise,
  isPathologicalHtmlForHighlight,
} from '../cliHighlight.js'

/**
 * CC 2.1.289 changelog #2 (OCC-side mitigation): the html/xml highlight
 * grammar backtracks exponentially on repeated unclosed `<script>` tags
 * (measured: 10 tags ≈ 100ms, 15 ≈ 600ms, 20 > 6s), freezing the terminal
 * render path. The guard skips highlighting for html-family blocks with
 * more than MAX_SCRIPT_TAGS_TO_HIGHLIGHT (8) `<script` open tags.
 * See docs/upstream-version-gap-occ146-2026-10.md.
 */

describe('2.1.289 #2 — pathological html highlight guard', () => {
  test('detects >8 script open tags in html/xml-family languages', () => {
    const code = '<script>'.repeat(9)
    expect(isPathologicalHtmlForHighlight(code, 'html')).toBe(true)
    expect(isPathologicalHtmlForHighlight(code, 'xml')).toBe(true)
    expect(isPathologicalHtmlForHighlight(code, 'XHTML')).toBe(true)
  })

  test('at or below the threshold is not pathological', () => {
    const code = '<script>'.repeat(8)
    expect(isPathologicalHtmlForHighlight(code, 'html')).toBe(false)
  })

  test('non-html languages are never guarded', () => {
    const code = '<script>'.repeat(50)
    expect(isPathologicalHtmlForHighlight(code, 'javascript')).toBe(false)
    expect(isPathologicalHtmlForHighlight(code, 'plaintext')).toBe(false)
  })

  test('undefined language is never guarded', () => {
    expect(
      isPathologicalHtmlForHighlight('<script>'.repeat(50), undefined),
    ).toBe(false)
  })

  test('wrapped highlight passes pathological html through as plain text, fast', async () => {
    const hl = await getCliHighlightPromise()
    expect(hl).not.toBeNull()
    const code = '<script>'.repeat(50)
    const start = performance.now()
    const out = hl!.highlight(code, { language: 'html' })
    expect(performance.now() - start).toBeLessThan(1000)
    expect(out).toBe(code)
  })

  test('benign html still gets ANSI highlighting', async () => {
    const hl = await getCliHighlightPromise()
    const out = hl!.highlight('<div class="x">hi</div>', { language: 'html' })
    expect(out).toContain('div')
  })

  test('closed script tags under the threshold still highlight', async () => {
    const hl = await getCliHighlightPromise()
    const code = '<script>var a = 1;</script>'.repeat(3)
    const out = hl!.highlight(code, { language: 'html' })
    expect(out).toContain('var a = 1;')
  })
})
