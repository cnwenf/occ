/**
 * CC 2.1.295 changelog #056 — "Fixed the terminal freezing, with ctrl+c
 * ignored, when a response ran to tens of thousands of lines."
 *
 * Official mechanism (recovered from the 2.1.295 linux-x64 binary markdown
 * module, beautified verbatim in /tmp/cc-153/md_v295_pretty.js lines 64-276):
 * the whole-text `marked.lexer()` call is replaced by a 1000-line sliding
 * window (`iXe=(e,t)=>sXe(t)?e.lexer(t):y4n(J.during(()=>nt(e,t)))`). Tokens
 * from the windowed path are marked `windowed:!0` (links also
 * `defanged:!0`), the setext-lheading tokenizer runs under a hold counter
 * with a bounded `{1,100}` newline regex, adjacent space tokens merge, and a
 * declining-table continuation state (`{header,fromRow}`) keeps giant tables
 * linear.
 *
 * These tests pin: (a) NORMAL (whole-text-safe) input takes marked's own
 * lexer unchanged — no marks, no divergence; (b) oversized input takes the
 * windowed path, completes in bounded time, and conserves the source text
 * exactly (token raws re-join to the normalized input); (c) the lheading
 * hold swaps the unbounded regex for the bounded one; (d) markWindowed
 * defangs links; (e) applyMarkdown end-to-end renders huge inputs in
 * bounded time and strips OSC8/C1/bare-ESC control bytes from WINDOWED
 * tokens only (the official PH wrapper).
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { Marked } from 'marked'
import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../markdown.ts'
import {
  CHARS_PER_LINE,
  MAX_LINE_CHARS,
  NEWLINE_LIMIT,
  WINDOW_LINES,
  isWholeTextSafe,
  lexWithWindowing,
  lheadingHold,
  lheadingMatchesOverride,
  markWindowed,
  takenRawEquals,
  windowedLex,
  type WindowedToken,
} from '../markdownWindowed.ts'

/** Official window geometry — verbatim binary constants (md_v295_pretty.js
 * `1e3` window lines, `100` chars/line estimate, lheading `{1,100}`). */
describe('295 #056 — windowed markdown lexer constants', () => {
  test('window geometry matches the official binary', () => {
    // Arrange / Act / Assert
    expect(WINDOW_LINES).toBe(1000)
    expect(CHARS_PER_LINE).toBe(100)
    expect(NEWLINE_LIMIT).toBe(100)
    expect(MAX_LINE_CHARS).toBe(WINDOW_LINES * CHARS_PER_LINE)
  })
})

describe('295 #056 — whole-text-safe pass-through', () => {
  test('small normal text is whole-text-safe and lexes via marked unchanged (no windowed marks)', () => {
    // Arrange
    const marked = new Marked()
    const text = '# Title\n\nSome **bold** text.\n\n- a\n- b\n\n> quote\n'

    // Act
    const safe = isWholeTextSafe(text)
    const tokens = lexWithWindowing(marked, text)

    // Assert — identical to marked's own lexer, and NOT marked windowed
    expect(safe).toBe(true)
    expect(tokens).toEqual(marked.lexer(text))
    expect(tokens.every(t => !('windowed' in t))).toBe(true)
  })

  test('text longer than the window is not whole-text-safe', () => {
    // Arrange — alternating content/blank lines make many small paragraphs
    const lines: string[] = []
    for (let i = 0; i < WINDOW_LINES + 400; i++) {
      lines.push(`para ${i}`, '')
    }
    const text = lines.join('\n')

    // Act / Assert
    expect(isWholeTextSafe(text)).toBe(false)
  })

  test('a single line over MAX_LINE_CHARS is not whole-text-safe', () => {
    // Arrange
    const text = `code intro\n\n${'x'.repeat(MAX_LINE_CHARS + 1)}\n`

    // Act / Assert
    expect(isWholeTextSafe(text)).toBe(false)
  })
})

describe('295 #056 — windowed lexing', () => {
  test('lexes a multi-window document in bounded time, marks tokens, and conserves source text', () => {
    // Arrange — ~1400 lines → at least two 1000-line windows
    const lines: string[] = []
    for (let i = 0; i < 700; i++) {
      lines.push(`line ${i} with some words`, '')
    }
    const text = lines.join('\n')
    const marked = new Marked()

    // Act
    const t0 = Date.now()
    const tokens = lexWithWindowing(marked, text)
    const ms = Date.now() - t0

    // Assert — bounded time, windowed marks present, raws re-join to source
    expect(ms).toBeLessThan(2000)
    expect(tokens.length).toBeGreaterThan(0)
    expect((tokens[0] as WindowedToken).windowed).toBe(true)
    expect(takenRawEquals(tokens, text.replace(/\r\n?/g, '\n'))).toBe(true)
  })

  test('an oversized single line degrades to a paragraph token in bounded time (no freeze)', () => {
    // Arrange — one 200k-char line: pre-fix marked inline-lexed this as one
    // paragraph via unbounded regex scans; the windowed path gives up into a
    // plain paragraph quickly.
    const huge = 'w'.repeat(MAX_LINE_CHARS * 2)
    const marked = new Marked()

    // Act
    const t0 = Date.now()
    const tokens = windowedLex(marked, huge)
    const ms = Date.now() - t0

    // Assert
    expect(ms).toBeLessThan(2000)
    expect(tokens.map(t => t.raw).join('')).toBe(huge)
  })

  test('tens of thousands of lines lex in bounded time (the changelog freeze scenario)', () => {
    // Arrange — 30k lines, the "tens of thousands of lines" shape. Pre-fix
    // this ran marked's whole-text block+inline lexer over the full string
    // (quadratic paragraph/inline scans) and froze the render loop.
    const lines: string[] = []
    for (let i = 0; i < 30_000; i++) {
      lines.push(i % 3 === 2 ? '' : `output line ${i}`)
    }
    const text = lines.join('\n')
    const marked = new Marked()

    // Act
    const t0 = Date.now()
    const tokens = lexWithWindowing(marked, text)
    const ms = Date.now() - t0

    // Assert — linear-ish windowed walk, exact source conservation
    expect(ms).toBeLessThan(4000)
    expect(tokens.length).toBeGreaterThan(100)
    expect(takenRawEquals(tokens, text)).toBe(true)
  })
})

describe('295 #056 — lheading hold counter', () => {
  test('outside the hold the original unbounded lheading predicate matches deep setext sources', () => {
    // Arrange — 200 content lines then a setext underline: marked's original
    // unbounded `(?:[^\n]+\n)+?` regex matches (and catastrophically
    // backtracks on non-matching giant inputs — the freeze).
    const deep = 'a\n'.repeat(200) + '===\n'

    // Act / Assert
    expect(lheadingHold.isHeld()).toBe(false)
    expect(lheadingMatchesOverride(deep)).toBe(true)
  })

  test('inside the hold the bounded {1,100} regex rejects setext sources deeper than NEWLINE_LIMIT', () => {
    // Arrange
    const deep = 'a\n'.repeat(200) + '===\n'
    const shallow = 'title\n===\n'

    // Act
    const results = lheadingHold.during(() => ({
      deep: lheadingMatchesOverride(deep),
      shallow: lheadingMatchesOverride(shallow),
      held: lheadingHold.isHeld(),
    }))

    // Assert — bounded regex refuses the deep form (marked falls through to
    // a paragraph), still accepts normal headings, and the hold is released.
    expect(results.held).toBe(true)
    expect(results.deep).toBe(false)
    expect(results.shallow).toBe(true)
    expect(lheadingHold.isHeld()).toBe(false)
  })
})

describe('295 #056 — markWindowed', () => {
  test('marks every token windowed and links additionally defanged', () => {
    // Arrange
    const marked = new Marked()
    const tokens = marked.lexer('text [a](https://x.y) more\n')

    // Act
    markWindowed(tokens)

    // Assert
    const paragraph = tokens[0] as WindowedToken & { tokens: WindowedToken[] }
    expect(paragraph.windowed).toBe(true)
    expect(paragraph.defanged).toBeUndefined()
    const link = paragraph.tokens.find(t => t.type === 'link') as WindowedToken
    expect(link.windowed).toBe(true)
    expect((link as WindowedToken & { defanged?: boolean }).defanged).toBe(true)
  })
})

describe('295 #056 — applyMarkdown end-to-end', () => {
  test('renders a huge document in bounded time with visible content preserved', () => {
    // Arrange — 12k lines with headings/lists/paragraphs mixed
    const lines: string[] = []
    for (let i = 0; i < 4000; i++) {
      lines.push(`## section ${i}`, '', `body text ${i}`, '- item', '')
    }
    const text = lines.join('\n')

    // Act
    const t0 = Date.now()
    const out = applyMarkdown(text, 'dark')
    const ms = Date.now() - t0

    // Assert
    expect(ms).toBeLessThan(8000)
    const plain = stripAnsi(out)
    expect(plain).toContain('section 3999')
    expect(plain).toContain('body text 0')
  })

  test('normal small documents render exactly as before (unchanged output)', () => {
    // Arrange — force chalk color on so the emphasis assertion is deterministic
    // (the test env reports chalk.level 0 → no ANSI, which would make the
    // "emphasis present" check environment-dependent rather than behavior-dependent).
    const savedLevel = chalk.level
    chalk.level = 1
    try {
      // Act
      const bold = applyMarkdown('**bold**', 'dark')
      const heading = applyMarkdown('# Head\n\npara', 'dark')

      // Assert — visible text intact, emphasis applied, no windowed stripping
      expect(stripAnsi(bold)).toBe('bold')
      expect(bold).toContain('\x1b[') // chalk emphasis present
      expect(stripAnsi(heading)).toContain('Head')
      expect(stripAnsi(heading)).toContain('para')
    } finally {
      chalk.level = savedLevel
    }
  })

  test('OSC8 hyperlinks are stripped from BOTH windowed and safe renders (Ecn pre-render + PH post-render)', () => {
    // Arrange — the same OSC8-bearing line in a small (whole-text-safe) doc
    // and in a >window-lines doc (windowed path).
    const osc8 =
      'before \x1b]8;;https://evil.example\x07click\x1b]8;;\x07 after'
    const small = applyMarkdown(osc8, 'dark')
    const bigLines: string[] = []
    for (let i = 0; i < WINDOW_LINES + 100; i++) {
      bigLines.push(`filler line ${i}`, '')
    }
    bigLines.push(osc8, '')

    // Act
    const big = applyMarkdown(bigLines.join('\n'), 'dark')

    // Assert — official TNt = `Ecn(iXe(Em,r)).map(PH)` @220898004: Ecn
    // sanitizes the token tree BEFORE rendering on both lex paths, so no OSC8
    // introducer survives anywhere. The safe path keeps the inert residue
    // (ESC/BEL deleted, visible text preserved) instead of a clickable link.
    expect(big).not.toContain('\x1b]8;')
    expect(small).not.toContain('\x1b]8;')
    expect(stripAnsi(small)).toContain(']8;;https://evil.example')
    expect(stripAnsi(small)).toContain('click')
  })
})
