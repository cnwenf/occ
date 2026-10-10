import { describe, expect, test } from 'bun:test'
import {
  type CopyEntry,
  QUOTE_FILENAME,
  extractCopyEntries,
  fileExtension,
} from '../copy.js'

// Helpers -------------------------------------------------------------------------

const quoteTexts = (entries: CopyEntry[]): string[] =>
  entries.filter((e) => e.kind === 'quote').map((e) => e.text)

// extractCopyEntries — quote merging contract -------------------------------------

describe('extractCopyEntries quote handling', () => {
  test('single blockquote produces one quote entry', () => {
    const entries = extractCopyEntries('> one')
    expect(entries).toEqual([{ kind: 'quote', text: 'one' }])
  })

  test('consecutive blockquotes merge into one entry joined by \\n', () => {
    const entries = extractCopyEntries('> one\n> two')
    // A single blockquote token whose text spans both lines: marked strips
    // the '>' markers, so the entry text carries no markers.
    expect(quoteTexts(entries)).toEqual(['one\ntwo'])
  })

  test('two adjacent blockquote blocks separated only by a blank line merge', () => {
    // marked lexes "> a\n\n> b" as two blockquote tokens with only a 'space'
    // token between them — 'space' is skipped and must NOT reset the merge.
    const entries = extractCopyEntries('> a\n\n> b')
    expect(quoteTexts(entries)).toEqual(['a\nb'])
  })

  test('non-quote token between blockquotes resets the merge (documented contract)', () => {
    // Regression: previously merged into a single 'one\nafter' entry,
    // silently dropping the intervening paragraph and violating the
    // "any other token resets the merge state" contract.
    const entries = extractCopyEntries('> one\n\nplain paragraph\n\n> after')
    expect(quoteTexts(entries)).toEqual(['one', 'after'])
  })

  test('non-quote reset also applies when the intervening block is a code fence', () => {
    const entries = extractCopyEntries('> one\n\n```js\nconst x = 1\n```\n\n> after')
    expect(entries).toEqual([
      { kind: 'quote', text: 'one' },
      { kind: 'code', text: 'const x = 1', lang: 'js' },
      { kind: 'quote', text: 'after' },
    ])
  })

  test('multi-line blockquote keeps internal lines and strips ">" markers', () => {
    const entries = extractCopyEntries('> line one\n> line two\n> line three')
    expect(quoteTexts(entries)).toEqual(['line one\nline two\nline three'])
    for (const text of quoteTexts(entries)) {
      expect(text).not.toContain('>')
    }
  })

  test('trailing whitespace/newlines are trimmed (official normalization)', () => {
    const entries = extractCopyEntries('> one  \n\n\n')
    expect(quoteTexts(entries)).toEqual(['one'])
  })

  test('empty blockquote is skipped', () => {
    const entries = extractCopyEntries('>')
    expect(entries).toEqual([])
  })

  test('plain non-quote markdown text produces no entries', () => {
    // Existing contract: only code fences and blockquotes become entries.
    const entries = extractCopyEntries('just a paragraph\n\n# heading\n\n- list')
    expect(entries).toEqual([])
  })

  test('leading paragraph then quote yields only the quote entry', () => {
    const entries = extractCopyEntries('intro text\n\n> quoted')
    expect(entries).toEqual([{ kind: 'quote', text: 'quoted' }])
  })
})

// QUOTE_FILENAME wiring ------------------------------------------------------------

describe('QUOTE_FILENAME', () => {
  test('matches the official copy.md constant', () => {
    // Official CC 2.1.295 binary: ge="copy.md" — quoted passages copy to this
    // filename (picker getSelectionContent: kind === 'quote' → QUOTE_FILENAME).
    expect(QUOTE_FILENAME).toBe('copy.md')
  })

  test('code entries still derive their filename from the language extension', () => {
    // The picker maps code entries to `copy${fileExtension(lang)}` — quote
    // entries are the only kind routed to QUOTE_FILENAME.
    expect(fileExtension('ts')).toBe('.ts')
    expect(fileExtension(undefined)).toBe('.txt')
    expect(fileExtension('plaintext')).toBe('.txt')
    expect(fileExtension('../../etc/passwd')).toBe('.etcpasswd')
  })
})
