import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { marked } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../../src/components/design-system/color.js'
import type { CliHighlight } from '../../src/utils/cliHighlight.js'
import {
  applyMarkdown,
  configureMarked,
  formatToken,
} from '../../src/utils/markdown.js'

/**
 * CC 2.1.280 changelog #071 — language-less fenced code blocks colored like
 * inline code.
 *
 * Official v280 @202965215, formatToken case"code" prepends (0 hits in v278;
 * markers `codeBlockStyle!=="indented"` @202965231 and
 * `replace(/\S(?:.*\S)?/g` @202965275, v278=0 / v280=1):
 *
 *   let s=e.lang??"";if(!s&&e.codeBlockStyle!=="indented")
 *     return e.text.replace(/\S(?:.*\S)?/g,Et("permission",t))+T;
 *
 * Et("permission",t) is the same theme color the codespan case uses; T is
 * EOL. The regex paints each line's span from its first to its last
 * non-space char, preserving leading/trailing whitespace (including
 * newlines). The branch sits BEFORE the no-highlight early return, which
 * stays intact after it.
 *
 * test/preload.ts forces NO_COLOR (chalk.level 0), which would make painted
 * and plain text byte-identical — these tests raise chalk.level for the
 * duration of the file and restore it after, so assertions compare real
 * ANSI-wrapped runs.
 */

const THEME = 'dark' as const
const perm = (text: string): string => color('permission', THEME)(text)

let savedChalkLevel: number

beforeAll(() => {
  savedChalkLevel = chalk.level
  chalk.level = 3
  configureMarked()
})

afterAll(() => {
  chalk.level = savedChalkLevel
})

describe('CC 2.1.280 #071 — language-less fenced code blocks colored like inline code', () => {
  test('no-lang fenced block paints each line span with the permission color', () => {
    // Official regex \S(?:.*\S)? matches from the first non-space char to
    // the last one on each line as ONE run — inner spaces ride along inside
    // the painted span (`.` matches spaces but not newlines).
    const out = applyMarkdown('```\nhello world\n```', THEME)
    expect(out).toBe(perm('hello world'))
    // Sanity: the paint is real ANSI at level 3, not identity.
    expect(out).not.toBe('hello world')
    expect(stripAnsi(out)).toBe('hello world')
  })

  test('multi-line no-lang block paints each line span and preserves newlines', () => {
    const out = applyMarkdown('```\nls -la\necho hi\n```', THEME)
    expect(out).toBe(`${perm('ls -la')}\n${perm('echo hi')}`)
  })

  test('leading/trailing whitespace incl newlines is preserved around painted runs', () => {
    // marked lexes "```\n\n  spaced  out  \n\n```" to text
    // "\n  spaced  out  \n"; the official regex \S(?:.*\S)? keeps the
    // surrounding whitespace out of the match.
    const token = marked.lexer('```\n\n  spaced  out  \n\n```')[0]!
    const out = formatToken(token, THEME)
    expect(out).toBe(`\n  ${perm('spaced  out')}  \n\n`)
  })

  test('the no-lang branch runs BEFORE the highlight path (no-highlight early return stays after it)', () => {
    // With a highlight stub available, a language-less block must NOT go
    // through highlighting — the official branch returns first.
    const stub: CliHighlight = {
      supportsLanguage: () => true,
      highlight: ((text: string) => `H(${text})`) as CliHighlight['highlight'],
    }
    const token = marked.lexer('```\nplain run\n```')[0]!
    const out = formatToken(token, THEME, 0, null, null, stub)
    expect(out).toBe(`${perm('plain run')}\n`)
    expect(out).not.toContain('H(')
  })

  test('lang-tagged fenced block is unchanged (highlight path untouched)', () => {
    // highlight=null → falls to the pre-existing `if (!highlight)` early
    // return: raw text + EOL, no permission paint.
    const token = marked.lexer('```js\nlet x = 1\n```')[0]!
    const out = formatToken(token, THEME)
    expect(out).toBe('let x = 1\n')
    expect(out).not.toContain('\u001b')
  })

  test('lang-tagged fenced block still routes through the highlighter', () => {
    const stub: CliHighlight = {
      supportsLanguage: (lang: string) => lang === 'js',
      highlight: ((text: string) => `H(${text})`) as CliHighlight['highlight'],
    }
    const out = applyMarkdown('```js\nlet x = 1\n```', THEME, stub)
    expect(out).toBe('H(let x = 1)')
  })

  test('indented code block is NOT painted (codeBlockStyle==="indented")', () => {
    const token = marked.lexer('    indented code\n')[0]!
    expect(token.type === 'code' && token.codeBlockStyle).toBe('indented')
    const out = formatToken(token, THEME)
    expect(out).toBe('indented code\n')
    expect(out).not.toContain('\u001b')
  })

  test('codespan still uses the same permission color (inline parity)', () => {
    const out = applyMarkdown('run `npm install` now', THEME)
    expect(out).toContain(perm('npm install'))
  })
})
