import { describe, expect, test } from 'bun:test'

import type { PastedContent } from '../config.js'
import {
  SEARCH_PASTE_CONTENT_MAX,
  expandPillsForSearch,
  findSearchCursorPosition,
  historyEntryMatchesQuery,
  truncateForSearch,
} from '../historySearchMatch.js'

/**
 * CC 2.1.314 item 70: Ctrl+R now matches text inside collapsed
 * `[Pasted text]` pills.
 *
 * Official 2.1.314 (byte-verified from the binary):
 *   - inline-search match predicate (v314):
 *     `rn=Ho.toLowerCase().includes(yn)||uKo(Ho,Co).toLowerCase().includes(yn)`
 *     where `yn=We.toLowerCase()` (lowercased query), Ho=display, Co=pastedContents.
 *     v312 matched only `Bo.toLowerCase().lastIndexOf(un)` on the display text.
 *   - `uKo(e,n)` (v314): truncates each *text* paste content to 32768 chars
 *     (`Ix=32768`) via `ne(h.content,Ix)`, then expands pills via `Rfe(e,r)`
 *     (= expandPastedTextRefs).
 *   - `ne(t,n)` (v314): `if(n<=0)return"";if(t.length<=n)return t;let
 *     e=t.slice(0,n),r=e.charCodeAt(n-1);return hQt(r>=55296&&r<=56319?e.slice(0,-1):e)`
 *     — drop a trailing lone high surrogate; hQt sanitizes via a utf16le Buffer
 *     round-trip (binary offset 243462231).
 *   - cursor placement `te(M1e(kI(Ho),Co,yn))` (v314), `M1e(h,x,D)`:
 *     `let L=h.toLowerCase().lastIndexOf(D);if(L!==-1)return L;let te=iu(h).findLast(ke=>{
 *     let Ce=x[ke.id];return Ce?.type==="text"&&!Ce.unavailable&&Ce.content.toLowerCase()
 *     .includes(D)});return te?te.index:h.length`
 *     — value match wins; else the index of the last pill whose text content
 *     contains the query; else end of value. (iu = parseReferences.)
 */

function textPaste(id: number, content: string): PastedContent {
  return { id, type: 'text', content }
}

describe('2.1.314 item 70 historyEntryMatchesQuery (official rn predicate)', () => {
  test('matches plain display text, case-insensitively (official .toLowerCase().includes)', () => {
    expect(historyEntryMatchesQuery('Fix the login bug', {}, 'login')).toBe(true)
    // Official lowercases both sides: `We.toLowerCase()` for the query, and
    // `.toLowerCase().includes(yn)` for the display — so an uppercase query
    // still matches. Callers pass the raw stored query; casing is handled here.
    expect(historyEntryMatchesQuery('Fix the login bug', {}, 'LOGIN')).toBe(true)
    expect(historyEntryMatchesQuery('Fix the login bug', {}, 'lOgIn')).toBe(true)
  })

  test('no match anywhere → false', () => {
    expect(historyEntryMatchesQuery('Fix the login bug', {}, 'payment')).toBe(false)
  })

  test('matches text inside a collapsed [Pasted text] pill (the item 70 fix)', () => {
    const display = 'debug this [Pasted text #1 +3 lines] please'
    const pastedContents = {
      1: textPaste(1, 'line one\nTypeError: x is not a function\nline three'),
    }
    expect(historyEntryMatchesQuery(display, pastedContents, 'TypeError')).toBe(true)
    expect(historyEntryMatchesQuery(display, pastedContents, 'not a function')).toBe(true)
    // v312 behavior would have been false for both (display-only match).
    expect(display.includes('TypeError')).toBe(false)
  })

  test('does not match image pill content (uKo only rewrites type==="text")', () => {
    const display = 'look at [Image #2]'
    const pastedContents = {
      2: { id: 2, type: 'image', content: 'secret-diagram-bytes', mediaType: 'image/png' } as PastedContent,
    }
    // expandPastedTextRefs leaves image refs alone, so the content is never searched.
    expect(historyEntryMatchesQuery(display, pastedContents, 'secret-diagram')).toBe(false)
  })

  test('pill content beyond the 32768-char truncation cap is not matched (official Ix=32768)', () => {
    const filler = 'a'.repeat(SEARCH_PASTE_CONTENT_MAX)
    const pastedContents = { 1: textPaste(1, `${filler}NEEDLE_AT_END`) }
    const display = 'x [Pasted text #1] y'
    expect(historyEntryMatchesQuery(display, pastedContents, 'needle_at_end')).toBe(false)
    // Content within the cap still matches (32748 filler + 13 needle ≤ 32768).
    const within = { 1: textPaste(1, `${filler.slice(0, SEARCH_PASTE_CONTENT_MAX - 20)}NEEDLE_INSIDE`) }
    expect(historyEntryMatchesQuery(display, within, 'needle_inside')).toBe(true)
  })

  test('empty query matches (includes("") === true, same as official)', () => {
    expect(historyEntryMatchesQuery('anything', {}, '')).toBe(true)
  })
})

describe('2.1.314 item 70 truncateForSearch (official ne with hQt sanitize)', () => {
  test('content shorter than max is returned unchanged', () => {
    expect(truncateForSearch('short text', 32768)).toBe('short text')
    expect(truncateForSearch('', 32768)).toBe('')
  })

  test('max <= 0 returns empty string', () => {
    expect(truncateForSearch('anything', 0)).toBe('')
    expect(truncateForSearch('anything', -1)).toBe('')
  })

  test('content longer than max is sliced to max', () => {
    expect(truncateForSearch('abcdef', 3)).toBe('abc')
  })

  test('a trailing lone high surrogate at the cut point is dropped (official charCodeAt 55296..56319)', () => {
    // '😀' is a surrogate pair; slicing at length 3 leaves a lone high surrogate at index 2.
    const input = `ab😀cd`
    const out = truncateForSearch(input, 3)
    expect(out).toBe('ab')
    expect(out.length).toBe(2)
  })

  test('a complete surrogate pair at the cut point is kept', () => {
    const out = truncateForSearch('ab😀cd', 4)
    expect(out).toBe('ab😀')
  })
})

describe('2.1.314 item 70 expandPillsForSearch (official uKo)', () => {
  test('expands [Pasted text #N] with (truncated) content', () => {
    const display = 'fix [Pasted text #1] now'
    const expanded = expandPillsForSearch(display, { 1: textPaste(1, 'the bug') })
    expect(expanded).toBe('fix the bug now')
  })

  test('truncates each text paste to the search cap before expanding', () => {
    const display = '[Pasted text #1]'
    const expanded = expandPillsForSearch(display, {
      1: textPaste(1, 'b'.repeat(SEARCH_PASTE_CONTENT_MAX + 100)),
    })
    expect(expanded.length).toBe(SEARCH_PASTE_CONTENT_MAX)
  })

  test('does not mutate the original pastedContents record', () => {
    const original = textPaste(1, 'c'.repeat(SEARCH_PASTE_CONTENT_MAX + 5))
    expandPillsForSearch('[Pasted text #1]', { 1: original })
    expect(original.content.length).toBe(SEARCH_PASTE_CONTENT_MAX + 5)
  })
})

describe('2.1.314 item 70 findSearchCursorPosition (official M1e)', () => {
  test('direct match in value wins: last lowercase index of the query', () => {
    expect(findSearchCursorPosition('hello world world', {}, 'world')).toBe(12)
    expect(findSearchCursorPosition('Hello World', {}, 'world')).toBe(6)
  })

  test('match only inside pill content → index of the last matching pill', () => {
    const value = 'see [Pasted text #1] and [Pasted text #2] end'
    const pastedContents = {
      1: textPaste(1, 'first needle here'),
      2: textPaste(2, 'second needle here'),
    }
    // 'needle' is not in the value itself; findLast → pill #2 at index 25.
    expect(value.indexOf('[Pasted text #2]')).toBe(25)
    expect(findSearchCursorPosition(value, pastedContents, 'needle')).toBe(25)
  })

  test('image pill content never counts (official Ce?.type==="text" guard)', () => {
    const value = 'img [Image #1] tail'
    const pastedContents = {
      1: { id: 1, type: 'image', content: 'needle bytes' } as PastedContent,
    }
    expect(findSearchCursorPosition(value, pastedContents, 'needle')).toBe(value.length)
  })

  test('no match anywhere → value.length (official fallback)', () => {
    expect(findSearchCursorPosition('plain text', {}, 'zzz')).toBe(10)
  })
})
