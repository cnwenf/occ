import { describe, expect, test } from 'bun:test'
import {
  findThinkingTriggerPositions,
  hasUltrathinkKeyword,
} from '../thinking.js'

/**
 * claude-code 2.1.311 triage-T4-sweep item 66 — the rainbow thinking-trigger
 * position scanner gained official `da()`'s quote/path filtering.
 *
 * Official v311 (byte-verified):
 *   `function Nce(e){return da(e,"ultrathink")}`   (@246987759)
 *   `function da(e,n){if(!new RegExp(n,"i").test(e))return[];
 *      if(e.startsWith("/"))return[]; ...}`        (@246986898)
 *   `function Wci(e){return/\bultrathink\b/i.test(e)}` (@242287678)
 *
 * `da` skips occurrences inside paired delimiters (backtick, double quote,
 * tag-like angle, brace, bracket, paren, non-apostrophe single quote), in
 * path/identifier context (`/`, `\`, `-` adjacent, or `.`+word after), before
 * a `?`, and rejects slash-command input outright. `Wci` — the boolean
 * keyword check behind `hasUltrathinkKeyword` — stays naive in v311 too.
 *
 * OCC shares its existing byte-faithful `da` port
 * (utils/ultraplan/keyword.js) rather than duplicating it.
 */

describe('2.1.311 #66: findThinkingTriggerPositions matches real directives', () => {
  test('finds a bare occurrence at the start', () => {
    expect(findThinkingTriggerPositions('ultrathink this')).toEqual([
      { word: 'ultrathink', start: 0, end: 10 },
    ])
  })

  test('finds an occurrence mid-sentence', () => {
    expect(findThinkingTriggerPositions('please ultrathink the refactor')).toEqual([
      { word: 'ultrathink', start: 7, end: 17 },
    ])
  })

  test('finds a sentence-final occurrence before a period', () => {
    expect(findThinkingTriggerPositions('go ultrathink.')).toEqual([
      { word: 'ultrathink', start: 3, end: 13 },
    ])
  })

  test('preserves the matched surface casing (official keeps match[0])', () => {
    expect(findThinkingTriggerPositions('UltraThink now')[0]?.word).toBe(
      'UltraThink',
    )
  })

  test('returns every occurrence in document order', () => {
    expect(findThinkingTriggerPositions('ultrathink a and ultrathink b')).toEqual([
      { word: 'ultrathink', start: 0, end: 10 },
      { word: 'ultrathink', start: 17, end: 27 },
    ])
  })

  test('is stateless across repeated calls on the same input', () => {
    const text = 'ultrathink this'
    expect(findThinkingTriggerPositions(text)).toEqual(
      findThinkingTriggerPositions(text),
    )
  })

  test('returns an empty array when the keyword is absent', () => {
    expect(findThinkingTriggerPositions('think hard about this')).toEqual([])
  })
})

describe('2.1.311 #66: findThinkingTriggerPositions skips non-directive contexts', () => {
  test('skips an occurrence inside backticks', () => {
    expect(findThinkingTriggerPositions('what does `ultrathink` mean')).toEqual([])
  })

  test('skips an occurrence inside double quotes', () => {
    expect(findThinkingTriggerPositions('you said "ultrathink" earlier')).toEqual([])
  })

  test('skips an occurrence inside square brackets (pasted-text placeholder)', () => {
    expect(findThinkingTriggerPositions('[ultrathink] pasted')).toEqual([])
  })

  test('skips an occurrence inside a tag-like angle range', () => {
    expect(findThinkingTriggerPositions('<ultrathink> body')).toEqual([])
  })

  test('skips an occurrence inside a single-quoted range', () => {
    expect(findThinkingTriggerPositions("the 'ultrathink' keyword")).toEqual([])
  })

  test("still matches when the single quotes are apostrophes", () => {
    // official `da`: `'` opens a range only when not preceded by a word char
    // and closes only when not followed by one, so contractions stay inert.
    expect(findThinkingTriggerPositions("let's ultrathink it's fine")).toEqual([
      { word: 'ultrathink', start: 6, end: 16 },
    ])
  })

  test('skips a file path occurrence', () => {
    expect(findThinkingTriggerPositions('see src/utils/ultrathink/foo.ts')).toEqual(
      [],
    )
  })

  test('skips a file extension occurrence', () => {
    expect(findThinkingTriggerPositions('open ultrathink.tsx')).toEqual([])
  })

  test('skips a CLI flag occurrence', () => {
    expect(findThinkingTriggerPositions('run with --ultrathink-mode')).toEqual([])
  })

  test('skips an occurrence followed by a question mark', () => {
    expect(findThinkingTriggerPositions('what is ultrathink?')).toEqual([])
  })

  test('skips everything in slash-command input', () => {
    expect(findThinkingTriggerPositions('/rename ultrathink foo')).toEqual([])
  })
})

describe('2.1.311 #66: hasUltrathinkKeyword stays naive (official Wci)', () => {
  test('is true for a quoted occurrence that positions filter out', () => {
    expect(hasUltrathinkKeyword('what does `ultrathink` mean')).toBe(true)
    expect(findThinkingTriggerPositions('what does `ultrathink` mean')).toEqual([])
  })

  test('is true for a path occurrence that positions filter out', () => {
    expect(hasUltrathinkKeyword('see src/utils/ultrathink/foo.ts')).toBe(true)
    expect(findThinkingTriggerPositions('see src/utils/ultrathink/foo.ts')).toEqual(
      [],
    )
  })

  test('is true for slash-command input that positions filter out', () => {
    expect(hasUltrathinkKeyword('/rename ultrathink foo')).toBe(true)
    expect(findThinkingTriggerPositions('/rename ultrathink foo')).toEqual([])
  })

  test('is false when the keyword is absent', () => {
    expect(hasUltrathinkKeyword('think harder')).toBe(false)
  })
})
