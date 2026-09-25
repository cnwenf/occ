import { describe, expect, test } from 'bun:test'
import { marked, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import {
  applyMarkdown,
  formatToken,
  normalizeNumericListItem,
} from '../../src/utils/markdown.js'

/**
 * Pinning tests for the CC 2.1.281 #084/#085 markdown list-rendering ports
 * (src/utils/markdown.ts).
 *
 * Official v281 evidence (byte-verified against the linux-x64 ELF):
 *   #085 `Jmn` @205766829 — list_item normalizer collapsing nested ordered
 *     lists whose items are bare number markers with no content
 *     (`- 316.`) into a single text token; immutability guard returns the
 *     ORIGINAL object when nothing changed. Call site `h=e.tokens?Jmn(e):e`
 *     @205762134. Absent from v280 (@202967599 list_item has no normalizer).
 *   #085 side-fix `ce` (v280 @202972475 ≡ v281 @205767145 region):
 *     `case 2: n>=1 ? letter : plain`, `case 3: n>=1 && r<=3999 ? roman :
 *     plain` with {first,last} from `a6n`/`lzn`.
 *   #084 v281 list_item @205762134 region strips leading newlines from the
 *     joined inner content BEFORE the bullet/plain branch
 *     (`R=join().replace(/^\n+/,""); return L||b ? prefix+marker+EOL+R : R`);
 *     v280 stripped only inside the bullet branch.
 *
 * Mutation contract: EVERY assertion group below must FAIL if the pre-281
 * behavior is restored:
 *   - without the Jmn port, `- 316.` renders as "" (number lost entirely)
 *   - without the `ce` guards, `0. b` at letter depth renders ". b" and
 *     `4000.` at roman depth renders "mmmm."
 *   - without the #084 strip, items whose text starts on the next line
 *     render a leading blank line
 */

const THEME = 'dark' as const

function firstListItem(src: string): Tokens.ListItem {
  const list = marked.lexer(src)[0] as Tokens.List
  return list.items[0]!
}

describe('#085 normalizeNumericListItem — Jmn port (v281 @205766829)', () => {
  test('bare-number bullet "- 316." renders as "316.", not a letter/roman/drop', () => {
    // Pre-fix OCC rendered "" (the misparsed nested ordered list had a
    // content-less item, so no text child existed to carry the number).
    expect(applyMarkdown('- 316.\n', THEME)).toBe('- 316.')
  })

  test('every item of a bare-number bullet list keeps its number', () => {
    expect(applyMarkdown('- 316.\n- 12.\n', THEME)).toBe('- 316.\n- 12.')
  })

  test('paren-style bare-number marker "- 316)" is preserved too', () => {
    // Official regex /^ *(\d{1,9}[.)])/ covers both "." and ")".
    expect(applyMarkdown('- 316)\n', THEME)).toBe('- 316)')
  })

  test('collapses the misparsed nested ordered list into a single text token', () => {
    const item = firstListItem('- 316.\n')
    const normalized = normalizeNumericListItem(item)
    expect(normalized).not.toBe(item)
    expect(normalized.tokens).toHaveLength(1)
    const text = normalized.tokens[0] as Tokens.Text
    expect(text.type).toBe('text')
    expect(text.raw).toBe('316.')
    expect(text.text).toBe('316.')
    // The original object is never mutated (immutable pattern).
    expect((item.tokens[0] as Tokens.Generic).type).toBe('list')
  })

  test('joins multiple bare-number markers with newlines (official r.join("\\n"))', () => {
    // "- 1.\n  2." misparses as one nested ordered list with two bare items;
    // Jmn collapses it to a single text token "1.\n2.".
    expect(applyMarkdown('- 1.\n  2.\n', THEME)).toBe('- 1.\n2.')
  })

  test('immutability guard: returns the ORIGINAL object when nothing changed', () => {
    const plain = firstListItem('- plain item\n')
    expect(normalizeNumericListItem(plain)).toBe(plain)

    const ordered = firstListItem('1. one\n2. two\n')
    expect(normalizeNumericListItem(ordered)).toBe(ordered)
  })

  test('does NOT collapse a nested ordered list whose items have content', () => {
    // Official guard: `if (l.tokens.length > 0 || s === undefined) return n`.
    const item = firstListItem('- 316. and 12. mixed\n')
    expect(normalizeNumericListItem(item)).toBe(item)
  })
})

describe('#085 getListNumber domain guards (official `ce` v280≡v281)', () => {
  test('normal top-level ordered lists still render as numbers', () => {
    expect(applyMarkdown('1. one\n2. two\n', THEME)).toBe('1. one\n2. two')
  })

  test('in-domain depth-2 nested ordered lists still render as letters', () => {
    expect(applyMarkdown('1. a\n   1. b\n', THEME)).toBe('1. a\n  a. b')
  })

  test('in-domain depth-3 nested ordered lists still render as romans', () => {
    expect(applyMarkdown('1. a\n   1. b\n      1. c\n', THEME)).toBe(
      '1. a\n  a. b\n      i. c',
    )
  })

  test('letter guard: first < 1 falls back to plain numbers', () => {
    // Official `ce` case 2: `n>=1 ? oe(t) : t.toString()`. Pre-fix OCC
    // rendered numberToLetter(0) === "" → ". b".
    expect(applyMarkdown('1. a\n   0. b\n', THEME)).toBe('1. a\n  0. b')
  })

  test('roman guard: last > 3999 falls back to plain numbers', () => {
    // Official `ce` case 3: `n>=1 && r<=3999 ? ae(t) : t.toString()`.
    // Pre-fix OCC rendered numberToRoman(4000) === "mmmm".
    expect(applyMarkdown('1. a\n   1. b\n      4000. c\n', THEME)).toBe(
      '1. a\n  a. b\n      4000. c',
    )
  })

  test('roman guard boundary: last === 3999 still converts', () => {
    expect(applyMarkdown('1. a\n   1. b\n      3999. c\n', THEME)).toContain(
      'mmmcmxcix. c',
    )
  })
})

describe('#084 leading-newline strip before the return-path decision', () => {
  test('bullet path: item text starting on the next line has no leading blank line', () => {
    expect(applyMarkdown('1.\n   text on next line\n', THEME)).toBe(
      '1. text on next line',
    )
  })

  test('bullet path mid-document: no extra blank line above the item', () => {
    const out = applyMarkdown(
      'para\n\n-\n  foo on next line\n\nafter\n',
      THEME,
    )
    expect(out).toBe('para\n\n- foo on next line\n\nafter')
    expect(out).not.toContain('\n\n\n')
  })

  test('plain path: item whose first child is a block has no leading blank line', () => {
    // v281 applies the strip BEFORE the bullet/plain branch decision, so the
    // non-bullet return path also loses the blank line. OCC adaptation: one
    // return path, strip on the joined inner content.
    const item = firstListItem('-\n  > quoted text\n')
    const rendered = stripAnsi(formatToken(item, THEME))
    expect(rendered.startsWith('\n')).toBe(false)
    expect(rendered).toContain('quoted text')
  })

  test('nested item (depth > 0): indented blank child line is stripped too', () => {
    // At depth ≥ 1 the leading `space` child renders as "  \n" (OCC prefixes
    // every child with the depth indent) — the adapted strip removes it.
    const out = applyMarkdown('- outer\n  1.\n     inner next line\n', THEME)
    expect(out).toBe('- outer\n  a. inner next line')
    expect(out).not.toContain('\n  \n')
  })

  test('direct formatToken on the list_item token starts with the bullet', () => {
    const item = firstListItem('-\n  foo on next line\n')
    expect(formatToken(item, THEME)).toBe('- foo on next line\n')
  })

  test('regular list items are unaffected', () => {
    expect(applyMarkdown('- one\n- two\n', THEME)).toBe('- one\n- two')
  })
})
