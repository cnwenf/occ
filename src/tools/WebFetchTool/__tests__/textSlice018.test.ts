import { describe, expect, test } from 'bun:test'

/**
 * Item #018a (2.1.292/293 forensics §2.3): surrogate-safe text slicers —
 * verbatim ports of the official helpers @203275474:
 *
 *   function ne(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(0,n),r=e.charCodeAt(n-1);
 *     return f(r>=55296&&r<=56319?e.slice(0,-1):e)}
 *   function Xl(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(-n),r=e.charCodeAt(0);
 *     return f(r>=56320&&r<=57343?e.slice(1):e)}
 *   function f(t){if(typeof Buffer<"u")return Buffer.from(t,"utf16le").toString("utf16le");return x(t)}
 *
 * `ne` (head) drops a trailing lone HIGH surrogate (D800–DBFF) at the cut
 * point; `Xl` (tail) drops a leading lone LOW surrogate (DC00–DFFF); `f`
 * normalizes via a utf16le Buffer round-trip. OCC names: sliceHead / sliceTail.
 */
import { sliceHead, sliceTail } from '../textSlice.js'

// '😀' === '😀' (high + low surrogate pair)
const EMOJI = '😀'
const HIGH = '\uD83D'
const LOW = '\uDE00'

describe('sliceHead (official ne) — head truncation', () => {
  test('returns empty string when n <= 0', () => {
    expect(sliceHead('abcdef', 0)).toBe('')
    expect(sliceHead('abcdef', -5)).toBe('')
  })

  test('returns the whole string when n >= length', () => {
    expect(sliceHead('abc', 3)).toBe('abc')
    expect(sliceHead('abc', 5)).toBe('abc')
    expect(sliceHead('', 10)).toBe('')
  })

  test('plain ASCII head slice', () => {
    expect(sliceHead('abcdef', 3)).toBe('abc')
  })

  test('drops a trailing lone high surrogate at the cut point', () => {
    // slice(0, 2) of 'a😀b' === 'a\uD83D' — lone high surrogate must go
    expect(sliceHead(`a${EMOJI}b`, 2)).toBe('a')
    // slice(0, 1) of '😀abc' === '\uD83D' — the whole slice is one lone high
    expect(sliceHead(`${EMOJI}abc`, 1)).toBe('')
  })

  test('keeps a complete surrogate pair when the cut lands after it', () => {
    // slice(0, 3) of 'a😀b' === 'a😀' — complete pair stays
    expect(sliceHead(`a${EMOJI}b`, 3)).toBe(`a${EMOJI}`)
  })

  test('does not cut a paired low surrogate (mid-pair charCodeAt is low, not high)', () => {
    // 'ab' with no surrogates — boundary char 'b' is untouched
    expect(sliceHead('ab', 1)).toBe('a')
  })
})

describe('sliceTail (official Xl) — tail slicing (offset reader)', () => {
  test('returns empty string when n <= 0', () => {
    expect(sliceTail('abcdef', 0)).toBe('')
    expect(sliceTail('abcdef', -1)).toBe('')
  })

  test('returns the whole string when n >= length', () => {
    expect(sliceTail('abc', 3)).toBe('abc')
    expect(sliceTail('abc', 9)).toBe('abc')
  })

  test('plain ASCII tail slice', () => {
    expect(sliceTail('abcdef', 3)).toBe('def')
  })

  test('drops a leading lone low surrogate at the cut point', () => {
    // slice(-2) of 'a😀b' === '\uDE00b' — lone low surrogate must go
    expect(sliceTail(`a${EMOJI}b`, 2)).toBe('b')
    // slice(-1) of '😀b' === 'b' — no surrogate involved
    expect(sliceTail(`${EMOJI}b`, 1)).toBe('b')
    // slice(-2) of 'a\uDE00' where the low is genuinely lone
    expect(sliceTail(`a${LOW}`, 2)).toBe(`a${LOW}`)
  })

  test('keeps a complete surrogate pair when the cut lands before it', () => {
    // slice(-3) of 'a😀b' === '😀b' — complete pair stays
    expect(sliceTail(`a${EMOJI}b`, 3)).toBe(`${EMOJI}b`)
  })

  test('offset semantics: sliceTail(t, t.length - offset) === text from offset on', () => {
    const text = 'abcdefghij'
    expect(sliceTail(text, text.length - 4)).toBe('efghij')
    expect(sliceTail(text, text.length - 0)).toBe(text)
    // offset past end → empty (drives the past_end branch)
    expect(sliceTail(text, text.length - 20)).toBe('')
  })

  test('lone HIGH surrogate at the tail start is kept (official only drops low)', () => {
    expect(sliceTail(`${HIGH}abc`, 4)).toBe(`${HIGH}abc`)
  })
})

describe('utf16le normalization (official f)', () => {
  test('round-trips paired astral characters unchanged', () => {
    // '😀😀x' sliced to 3 code units cuts mid-second-pair →
    // lone high surrogate dropped → '😀'
    expect(sliceHead(`${EMOJI}${EMOJI}x`, 3)).toBe(EMOJI)
    // full pair boundary preserved
    expect(sliceHead(`${EMOJI}${EMOJI}x`, 4)).toBe(`${EMOJI}${EMOJI}`)
  })
})
