import { describe, expect, test } from 'bun:test'
import { ndjsonSafeStringify } from '../ndjsonSafeStringify.js'

/**
 * CC 2.1.311 item 68 — json/stream-json wire-character escaping.
 *
 * Official v311 escaper `AIe`/`SJ` @238836256 (byte-verified with od -c — the
 * binary carries the class as ASCII escapes):
 *   function AIe(e){return e.replace(/[\u007F-\u009F\u2028\u2029\p{Cf}]/gu,SJ)}
 *   function SJ(e){return e.split("").map((n)=>"\\u"+n.charCodeAt(0)
 *     .toString(16).padStart(4,"0")).join("")}
 * Official emitter module @273874300 routes both writers through it behind
 * GrowthBook `tengu_sober_inkwell` `{safe:!0}`:
 *   function lne(r){if(o())return AIe(_(r));return xfo(r)}              // stream-json
 *   function Pfo(r,n){if(o())return AIe(_(r,null,n));return _(r,null,n)} // json print
 * v310's escaper `Gpe` @272244103 handled ONLY U+2028/U+2029 — that is the
 * behavior OCC had before this port.
 *
 * Every probe char is built with String.fromCharCode/fromCodePoint and the
 * assertion regex uses escape sequences, so this file stays ASCII-clean.
 */

const DEL = String.fromCharCode(0x7f) // DELETE
const C1_CSI = String.fromCharCode(0x9b) // C1 CONTROL SEQUENCE INTRODUCER
const ZWSP = String.fromCharCode(0x200b) // ZERO WIDTH SPACE — category Cf
const WORD_JOINER = String.fromCharCode(0x2060) // WORD JOINER — category Cf
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
const ASTRAL_CF = String.fromCodePoint(0xe0041) // LANGUAGE TAG — Cf, surrogate pair

/** Any char the official v311 class says must never appear raw on the wire. */
const RAW_WIRE_CHAR = /[\u007F-\u009F\u2028\u2029\p{Cf}]/u

describe('CC 2.1.311 item 68 — ndjsonSafeStringify escapes DEL, C1 and Cf as \\uXXXX', () => {
  test('escapes U+007F DELETE as lowercase \\u007f', () => {
    // Arrange
    const value = { type: 'result', text: `a${DEL}b` }

    // Act
    const out = ndjsonSafeStringify(value)

    // Assert
    expect(out).toContain('\\u007f')
    expect(out).not.toContain(DEL)
  })

  test('escapes C1 control U+009B as \\u009b', () => {
    const out = ndjsonSafeStringify({ text: `x${C1_CSI}y` })

    expect(out).toContain('\\u009b')
    expect(out).not.toContain(C1_CSI)
  })

  test('escapes Cf format chars (U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER)', () => {
    const out = ndjsonSafeStringify({ text: `a${ZWSP}b${WORD_JOINER}c` })

    expect(out).toContain('\\u200b')
    expect(out).toContain('\\u2060')
    expect(out).not.toContain(ZWSP)
    expect(out).not.toContain(WORD_JOINER)
  })

  test('still escapes U+2028 / U+2029 (no regression from the v310 behavior)', () => {
    const out = ndjsonSafeStringify({ text: `a${LINE_SEP}b${PARA_SEP}c` })

    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    expect(out).not.toContain(LINE_SEP)
    expect(out).not.toContain(PARA_SEP)
  })

  test('escapes an astral Cf char per UTF-16 code unit (official SJ semantics)', () => {
    const out = ndjsonSafeStringify({ text: `a${ASTRAL_CF}b` })

    // U+E0041 is DB40 + DC41 in UTF-16; official SJ maps each charCodeAt unit.
    expect(out).toContain('\\udb40\\udc41')
    expect(out).not.toContain(ASTRAL_CF)
  })

  test('leaves no raw DEL/C1/Cf/line-separator char anywhere in the output', () => {
    const value = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `${DEL}${C1_CSI}${ZWSP}${LINE_SEP}${PARA_SEP}${ASTRAL_CF}`,
          },
        ],
      },
    }

    const out = ndjsonSafeStringify(value)

    expect(RAW_WIRE_CHAR.test(out)).toBe(false)
  })

  test('round-trips: JSON.parse of the escaped output deep-equals the input value', () => {
    const value = {
      type: 'result',
      subtype: 'success',
      result: `path "C:${DEL}" ${C1_CSI}${ZWSP}${LINE_SEP}${PARA_SEP}${ASTRAL_CF}`,
      nested: { list: [`a${DEL}b`, 'plain', ZWSP] },
    }

    const out = ndjsonSafeStringify(value)

    expect(JSON.parse(out)).toEqual(value)
  })

  test('leaves printable text, structural keys and JSON.stringify escapes untouched', () => {
    const value = { type: 'result', text: 'ascii "quoted" \\ back\nnewline\ttab' }

    const out = ndjsonSafeStringify(value)

    expect(out).toBe(
      '{"type":"result","text":"ascii \\"quoted\\" \\\\ back\\nnewline\\ttab"}',
    )
  })

  test('is deterministic and does not mutate its input', () => {
    const text = `a${DEL}b${ZWSP}c`
    const value = Object.freeze({ text: Object.freeze(text) })

    const first = ndjsonSafeStringify(value)
    const second = ndjsonSafeStringify(value)

    expect(second).toBe(first)
    expect(value.text).toBe(text)
  })
})
