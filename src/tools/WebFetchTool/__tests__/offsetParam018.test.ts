import { describe, expect, test } from 'bun:test'

/**
 * Item #018a (2.1.292/293 forensics §2.13/§2.15/§1.2): the `offset` input
 * param plumbing — numeric-string coercion (official `XMe` @211419386), the
 * verbatim schema describe text (official `T2t` @213374410), the past_end
 * message, the secondary-model contentLead, the `M2t` continuation message
 * (@213373984) and the coverage note (§1.2 branch 4).
 *
 * Official verbatim sources:
 *
 *   function XMe(e){if(typeof e==="string"){let n=e.trim();
 *     if(/^[-+]?\d+(\.\d+)?$/.test(n)){let r=Number(n);if(Number.isFinite(r))return r}}return e}
 *
 *   offset:pO(E().int().nonnegative().optional()).describe("Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.")
 *
 *   function M2t(e){return` — to read on, call ${dr} again with the same url and offset: ${e}`}
 *
 *   zn=`Nothing left to read from offset ${H}: this page's text is ${Ut.length} characters long.`
 *
 *   contentLead:H>0?`The content below is one part of a longer page: it starts ${H} characters into the page's ${Ut.length}.\n`:""
 *
 *   zn+=`\n\n[${dr} note: this page's text is ${Ut.length} characters long and the answer above covers only characters ${Ln} to ${Eo}; the final ${Ut.length-Eo} were not read${M2t(Eo)}.]`
 */
import {
  coerceNumericString,
  continuationMessage,
  makeContentLead,
  makeCoverageNote,
  makePastEndMessage,
  OFFSET_DESCRIBE,
} from '../offsetParam.js'

describe('coerceNumericString (official XMe)', () => {
  test('coerces plain numeric strings', () => {
    expect(coerceNumericString('500')).toBe(500)
    expect(coerceNumericString('0')).toBe(0)
  })

  test('trims surrounding whitespace before matching', () => {
    expect(coerceNumericString('  42  ')).toBe(42)
    expect(coerceNumericString('\t7\n')).toBe(7)
  })

  test('accepts an explicit sign', () => {
    expect(coerceNumericString('+7')).toBe(7)
    expect(coerceNumericString('-3')).toBe(-3)
  })

  test('accepts decimal literals (inner .int() still rejects them)', () => {
    expect(coerceNumericString('1.5')).toBe(1.5)
  })

  test('passes through non-numeric strings untouched', () => {
    expect(coerceNumericString('abc')).toBe('abc')
    expect(coerceNumericString('')).toBe('')
    expect(coerceNumericString('1e5')).toBe('1e5')
    expect(coerceNumericString('0x10')).toBe('0x10')
  })

  test('passes through non-string values untouched', () => {
    expect(coerceNumericString(5)).toBe(5)
    expect(coerceNumericString(null)).toBe(null)
    expect(coerceNumericString(undefined)).toBe(undefined)
    expect(coerceNumericString({})).toEqual({})
  })
})

describe('OFFSET_DESCRIBE (official T2t describe text, verbatim)', () => {
  test('matches the official string byte-for-byte', () => {
    expect(OFFSET_DESCRIBE).toBe(
      'Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.',
    )
  })
})

describe('makePastEndMessage (official past_end branch)', () => {
  test('matches the official string byte-for-byte', () => {
    expect(makePastEndMessage(10, 3)).toBe(
      "Nothing left to read from offset 10: this page's text is 3 characters long.",
    )
  })
})

describe('continuationMessage (official M2t)', () => {
  test('matches the official template byte-for-byte', () => {
    expect(continuationMessage(100000)).toBe(
      ' — to read on, call WebFetch again with the same url and offset: 100000',
    )
  })
})

describe('makeContentLead (official secondary_model contentLead)', () => {
  test('matches the official template byte-for-byte, incl. trailing newline', () => {
    expect(makeContentLead(500, 200000)).toBe(
      "The content below is one part of a longer page: it starts 500 characters into the page's 200000.\n",
    )
  })
})

describe('makeCoverageNote (official coverage note, §1.2 branch 4)', () => {
  test('matches the official template byte-for-byte', () => {
    expect(makeCoverageNote(150000, 0, 100000)).toBe(
      "\n\n[WebFetch note: this page's text is 150000 characters long and the answer above covers only characters 0 to 100000; the final 50000 were not read — to read on, call WebFetch again with the same url and offset: 100000.]",
    )
  })

  test('computes the unread remainder from answerEnd', () => {
    expect(makeCoverageNote(1200, 200, 700)).toBe(
      "\n\n[WebFetch note: this page's text is 1200 characters long and the answer above covers only characters 200 to 700; the final 500 were not read — to read on, call WebFetch again with the same url and offset: 700.]",
    )
  })
})
