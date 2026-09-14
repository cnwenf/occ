import { describe, expect, test } from 'bun:test'
import { marked, type Token, type Tokens } from 'marked'
import { formatTaskList } from '../../src/components/Markdown.js'
import {
  applyMarkdown,
  configureMarked,
  formatToken,
} from '../../src/utils/markdown.js'

/**
 * Pinning tests for the Gap-125b markdown-serializer parity fix
 * (src/utils/markdown.ts formatToken) + the OCC-125 review-round P2-2
 * task-list checkbox policy.
 *
 * Official 2.1.270 serializer (Fk @197018715, switch end @197023577):
 *   case"escape":return e.text;case"html":return e.text;case"def":return""}return e.raw
 *
 * Mutation contract (per review): EVERY assertion group below must FAIL if the
 * pre-fix behavior is restored:
 *   - `case 'html': return ''`            → the html-token tests fail
 *   - switch default `return ''`          → the raw-fallback test fails
 *   - checkbox child not filtered /
 *     no task marker in the text case     → the task-list tests fail
 *
 * These exist because the original Gap-125b change shipped with ZERO automated
 * coverage — reverting html→''/default→'' kept all suites green (reviewer
 * mutation-proven). This file is the regression gate.
 */

const THEME = 'dark' as const

describe('formatToken — html token parity (official Fk @197023577: case"html":return e.text)', () => {
  test('applyMarkdown preserves inline html verbatim ("<style>" survives)', () => {
    // The exact live-discovered gap: OCC rendered "Usage: /output-style"
    // where the official renders "Usage: /output-style <style>".
    const out = applyMarkdown('Usage: /output-style <style>', THEME)
    expect(out).toContain('<style>')
    expect(out).toContain('Usage: /output-style <style>')
  })

  test('formatToken returns token.text for an html token (not raw, not empty)', () => {
    // html tokens carry both `raw` (source slice) and `text`; the official
    // returns `.text`. A mutation to `return ''` fails this; a mutation to
    // `return token.raw` is distinguished here via a token whose raw differs.
    const token: Token = {
      type: 'html',
      raw: '<div class="x">\n',
      text: '<div class="x">',
    } as unknown as Token
    expect(formatToken(token, THEME)).toBe('<div class="x">')
  })

  test('block-level html token renders its text verbatim', () => {
    const out = applyMarkdown('before\n\n<div>raw block</div>\n\nafter', THEME)
    expect(out).toContain('<div>raw block</div>')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })
})

describe('formatToken — unhandled-token raw fallback (official Fk: }return e.raw)', () => {
  test('unknown token type falls back to token.raw', () => {
    // The official serializer's switch default is `return e.raw` — unhandled
    // token types render their raw markdown source instead of being dropped.
    // A synthetic type is used because marked v17 has no real unhandled type;
    // the fallback must still hold for anything the tokenizer emits later.
    const token: Token = {
      type: 'some-future-token-type',
      raw: 'RAW-FALLBACK-SOURCE',
      text: 'should-not-be-used',
    } as unknown as Token
    expect(formatToken(token, THEME)).toBe('RAW-FALLBACK-SOURCE')
  })

  test('raw fallback does NOT use token.text', () => {
    const token: Token = {
      type: 'another-unknown-type',
      raw: 'the-raw',
      text: 'the-text',
    } as unknown as Token
    expect(formatToken(token, THEME)).not.toBe('the-text')
    expect(formatToken(token, THEME)).toBe('the-raw')
  })

  test('def tokens still render empty (official: case"def":return"")', () => {
    // Pinned alongside the default so a blanket `default: return raw`
    // mutation of the def arm is caught: def must stay ''.
    const token: Token = {
      type: 'def',
      raw: '[ref]: https://example.com',
      text: 'https://example.com',
    } as unknown as Token
    expect(formatToken(token, THEME)).toBe('')
  })
})

describe('formatToken — GFM task-list checkbox policy (review P2-2, official single-sink)', () => {
  // Official text case (binary @197018715):
  //   `${l.task&&f?`[${l.checked?"x":" "}] `:""}${p}${E}` — the marker is
  // rendered from the list_item's task/checked flags. The official's older
  // marked never emitted a `checkbox` child token; marked v17 does, so OCC
  // filters it in the list_item case and renders it as '' defensively.
  // Pre-fix behavior leaked the checkbox raw BEFORE the bullet:
  //   "[ ] - task one" — every assertion below kills that mutation.

  test('applyMarkdown renders the exact official task-list output', () => {
    const out = applyMarkdown('- [ ] task one\n- [x] task two', THEME)
    expect(out).toBe('- [ ] task one\n- [x] task two')
  })

  test('checkbox raw never leaks before the bullet', () => {
    const out = applyMarkdown('- [ ] task one\n- [x] task two', THEME)
    expect(out).not.toContain('[ ] -')
    expect(out).not.toContain('[x] -')
    // Every line starts with the bullet, not the marker.
    for (const line of out.split('\n')) {
      expect(line.startsWith('- ')).toBe(true)
    }
  })

  test('formatToken renders a bare checkbox token as empty string', () => {
    const token: Token = {
      type: 'checkbox',
      raw: '[ ] ',
      checked: false,
    } as unknown as Token
    expect(formatToken(token, THEME)).toBe('')
  })

  test('mixed task/plain list items render markers only on task items', () => {
    const out = applyMarkdown('- [ ] open task\n- [x] done task\n- plain item', THEME)
    expect(out.split('\n')).toEqual([
      '- [ ] open task',
      '- [x] done task',
      '- plain item',
    ])
  })

  test('nested task items keep the 2-space indent (checkbox filter mutation)', () => {
    // At depth > 0 each list_item child picks up a '  '.repeat(listDepth)
    // prefix — an unfiltered checkbox child would add a spurious blank-indented
    // slot even though it renders '' (4 spaces instead of 2). This kills the
    // "remove the .filter(checkbox) but keep the '' arm" mutation, which is
    // invisible at depth 0.
    const out = applyMarkdown('- outer\n  - [ ] inner task', THEME)
    expect(out).toBe('- outer\n  - [ ] inner task')
  })

  test('cross-sink parity: formatToken path === formatTaskList path', () => {
    // Markdown.tsx routes task lists through formatTaskList (pinned by
    // version-2.1.149-ui.e2e); applyMarkdown routes them through formatToken.
    // Both sinks must produce identical output — the reviewer's dual-sink
    // inconsistency finding.
    configureMarked()
    const tokens = marked.lexer('- [ ] task one\n- [x] task two')
    const list = tokens.find(t => t.type === 'list') as Tokens.List
    const viaTaskList = formatTaskList(list, THEME, null)
    const viaFormatToken = applyMarkdown('- [ ] task one\n- [x] task two', THEME)
    // formatTaskList keeps a trailing newline per item; applyMarkdown trims.
    expect(viaTaskList.replace(/\n$/, '')).toBe(viaFormatToken)
  })
})
