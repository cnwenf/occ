/**
 * CC 2.1.295 changelog #067 — "Fixed replies whose quotes nest deeper every
 * few lines freezing the terminal for seconds and using gigabytes of memory."
 *
 * Official mechanism (recovered from the 2.1.295 linux-x64 binary markdown
 * module, beautified verbatim in /tmp/cc-153/md_v295_pretty.js lines
 * 315-340): row-group renderer. Depth < 6 renders the classic per-line
 * dim-bar + italic (`Nt`); depth >= 6 draws ALL ancestor bars in ONE capped
 * prefix (max 16, `Ot`) and marks the group `isDone` so ancestors pass it
 * through untouched — eliminating the pre-v295 O(depth × lines) per-level
 * split/re-prefix/re-join blowup.
 *
 * These tests pin: (a) classic-depth rendering is byte-stable (bar + italic,
 * blank lines pass through — official `Nt` behavior, which also resolves
 * OCC's old blank→bar divergence); (b) deep nesting caps the drawn bars at
 * MAX_QUOTE_BARS and completes in bounded time; (c) end-to-end applyMarkdown
 * on the changelog scenario ("quotes nest deeper every few lines") renders
 * in bounded time with every line's bar count capped and content preserved.
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { Marked } from 'marked'
import stripAnsi from 'strip-ansi'
import { BLOCKQUOTE_BAR } from '../../constants/figures.js'
import { applyMarkdown } from '../markdown.ts'
import {
  CLASSIC_QUOTE_DEPTH_LIMIT,
  MAX_QUOTE_BARS,
  renderBlockquoteWindowed,
  renderClassicQuoteRows,
} from '../markdownBlockquote.ts'

/** Official constants — verbatim from the binary (`_t` = 6, `At` = 16). */
describe('295 #067 — constants', () => {
  test('depth limit and bar cap match the official binary', () => {
    // Arrange / Act / Assert
    expect(CLASSIC_QUOTE_DEPTH_LIMIT).toBe(6)
    expect(MAX_QUOTE_BARS).toBe(16)
  })
})

describe('295 #067 — classic (depth < 6) rendering', () => {
  test('visible lines get a dim bar + italic; blank lines pass through unchanged', () => {
    // Arrange
    const bar = chalk.dim(BLOCKQUOTE_BAR)
    const rows = 'hello\n\nworld'

    // Act
    const group = renderClassicQuoteRows(rows)

    // Assert — official Nt: blank lines are NOT bar-prefixed
    expect(group.isDone).toBe(false)
    expect(group.rows).toBe(
      [`${bar} ${chalk.italic('hello')}`, '', `${bar} ${chalk.italic('world')}`].join('\n'),
    )
  })

  test('a single-level blockquote renders through the official entry with depth 1', () => {
    // Arrange
    const marked = new Marked()
    const [quote] = marked.lexer('> hello\n')
    const depths: number[] = []
    const draw = (token: { type: string }, depth: number): string => {
      depths.push(depth)
      return token.type === 'space' ? '\n' : 'hello\n'
    }

    // Act
    const out = renderBlockquoteWindowed(quote.tokens ?? [], 0, draw)

    // Assert
    expect(depths).toEqual([1])
    expect(out).toBe(`${chalk.dim(BLOCKQUOTE_BAR)} ${chalk.italic('hello')}\n`)
  })
})

describe('295 #067 — deep nesting cap', () => {
  test('30-deep nested quotes draw at most MAX_QUOTE_BARS bars and keep the leaf text', () => {
    // Arrange — build a 30-level blockquote chain by hand (marked cannot be
    // relied on to keep every level for hand-fed tokens)
    type FakeToken = { type: string; tokens?: FakeToken[]; text?: string }
    let node: FakeToken = { type: 'paragraph', text: 'deep' }
    for (let i = 0; i < 30; i++) {
      node = { type: 'blockquote', tokens: [node] }
    }
    const draw = (): string => 'deep\n'

    // Act
    const t0 = Date.now()
    const out = renderBlockquoteWindowed(
      node.tokens ?? [],
      0,
      draw as never,
    )
    const ms = Date.now() - t0

    // Assert — one-shot capped prefix: never more than 16 bars, leaf kept
    expect(ms).toBeLessThan(1000)
    const firstLine = stripAnsi(out.split('\n')[0] ?? '')
    const bars = firstLine.split(BLOCKQUOTE_BAR).length - 1
    expect(bars).toBeGreaterThan(0)
    expect(bars).toBeLessThanOrEqual(MAX_QUOTE_BARS)
    expect(stripAnsi(out)).toContain('deep')
  })

  test('deep groups marked isDone pass through ancestor levels without extra bars', () => {
    // Arrange — 40-deep chain over a 50-line leaf: pre-fix this re-split and
    // re-joined the whole body at EVERY level (40 × 50 line rewrites); the
    // capped group is drawn once and ancestors pass it through.
    type FakeToken = { type: string; tokens?: FakeToken[]; text?: string }
    const body = Array.from({ length: 50 }, (_, i) => `body ${i}`).join('\n') + '\n'
    let node: FakeToken = { type: 'paragraph', text: body }
    for (let i = 0; i < 40; i++) {
      node = { type: 'blockquote', tokens: [node] }
    }
    const draw = (): string => body

    // Act
    const t0 = Date.now()
    const out = renderBlockquoteWindowed(node.tokens ?? [], 0, draw as never)
    const ms = Date.now() - t0

    // Assert
    expect(ms).toBeLessThan(1000)
    for (const line of stripAnsi(out).split('\n')) {
      expect(line.split(BLOCKQUOTE_BAR).length - 1).toBeLessThanOrEqual(MAX_QUOTE_BARS)
    }
    expect(stripAnsi(out)).toContain('body 49')
  })
})

describe('295 #067 — applyMarkdown end-to-end (changelog scenario)', () => {
  test('quotes nesting deeper every few lines render in bounded time with capped bars', () => {
    // Arrange — the exact changelog shape: every 2 lines the quote gains one
    // more `>` level, reaching depth ~100 over 200 lines. Pre-fix OCC froze
    // for seconds here (O(depth × lines) re-joins + gigabytes of
    // intermediate strings).
    const lines: string[] = []
    for (let i = 0; i < 200; i++) {
      const depth = 1 + Math.floor(i / 2)
      lines.push(`${'>'.repeat(depth)} q${i}`)
    }
    const text = lines.join('\n')

    // Act
    const t0 = Date.now()
    const out = applyMarkdown(text, 'dark')
    const ms = Date.now() - t0

    // Assert — bounded time; every rendered line respects the 16-bar cap;
    // the deepest content survives.
    expect(ms).toBeLessThan(3000)
    const plain = stripAnsi(out)
    expect(plain).toContain('q199')
    for (const line of plain.split('\n')) {
      expect(line.split(BLOCKQUOTE_BAR).length - 1).toBeLessThanOrEqual(MAX_QUOTE_BARS)
    }
  })

  test('normal single-level quotes render unchanged (bar + content)', () => {
    // Arrange / Act
    const out = applyMarkdown('> hello world', 'dark')
    const plain = stripAnsi(out)

    // Assert
    expect(plain).toContain(`${BLOCKQUOTE_BAR} hello world`)
  })

  test('blank quote lines pass through without a bar (official Nt alignment)', () => {
    // Arrange / Act
    const out = applyMarkdown('> a\n>\n> b', 'dark')

    // Assert — the middle line renders empty; OCC's pre-v295 renderer drew a
    // lone bar on blank lines (documented divergence, resolved by this port).
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(stripAnsi(lines[1] ?? 'x')).toBe('')
    expect(stripAnsi(out)).toContain('a')
    expect(stripAnsi(out)).toContain('b')
  })
})
