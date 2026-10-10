import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { applyMarkdown } from '../markdown.js'
import { stripRawHyperlinks } from '../stripRawHyperlinks.js'

/**
 * CC 2.1.295 P0 render-security — raw OSC-8 hyperlink strip at the markdown
 * sanitize boundary.
 *
 * Official evidence (v295 linux-x64 ELF):
 *   @220895091  `Ue=/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g`
 *               — the OSC-8 scanner (BEL + ST terminators, empty closing seq)
 *   @220891500  `Ecn` walkTokens control-char strip: removes the `\x1b`/`\x07`
 *               control bytes of raw escapes from token string fields (except
 *               `href`), so smuggled clickable cells render as inert text
 *   @190910058  `jar` — fixed-point (≤4 pass) strip convention
 *
 * Markdown-GENERATED links must keep working: the official link renderer `rw`
 * (@220894xxx, see /tmp/cc295/ev/osc8_sanitize.txt hit 204) intentionally
 * emits `\x1b]8;;URL\x07colored\x1b]8;;\x07` for `[text](url)` — emission
 * happens downstream of the source sanitize, so it is unaffected.
 */

const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'
const THEME = 'dark' as const

const EVIL_BEL = `${ESC}]8;;http://evil\x07click here${ESC}]8;;\x07`
const EVIL_ST = `${ESC}]8;;http://evil${ST}click here${ESC}]8;;${ST}`

describe('stripRawHyperlinks — util (official Ue shape, fixed-point)', () => {
  test('strips the BEL-terminated form, anchor text stays visible', () => {
    expect(stripRawHyperlinks(EVIL_BEL)).toBe('click here')
  })

  test('strips the ST-terminated form, anchor text stays visible', () => {
    expect(stripRawHyperlinks(EVIL_ST)).toBe('click here')
  })

  test('strips OSC-8 with non-empty params', () => {
    expect(stripRawHyperlinks(`${ESC}]8;id=x;http://evil${BEL}t${ESC}]8;;${BEL}`)).toBe('t')
  })

  test('fixed point defeats nested reassembly', () => {
    // Inner sequence removed first; the residue must NOT reassemble into a
    // live introducer+URL on a later pass — everything is swept.
    const nested = `${ESC}]8;;${ESC}]8;;http://evil${BEL}${BEL}text`
    const out = stripRawHyperlinks(nested)
    expect(out).toBe('text')
    expect(out).not.toContain(`${ESC}]8;`)
    expect(out).not.toContain('http://evil')
  })

  test('unterminated introducer is defanged to inert residue (official Wt bare-ESC strip)', () => {
    // Official chain: `Ue` needs a terminator, so the unterminated introducer
    // survives it; `Wt` (/\x1b(?!\[)/g) then deletes the bare ESC, leaving
    // printable-but-inert residue — exactly what official Ecn/PH produce.
    expect(stripRawHyperlinks(`${ESC}]8;;abc`)).toBe(']8;;abc')
  })

  test('plain text and SGR sequences are untouched', () => {
    expect(stripRawHyperlinks('plain text')).toBe('plain text')
    const sgr = `${ESC}[1m${ESC}[31mred bold${ESC}[0m`
    expect(stripRawHyperlinks(sgr)).toBe(sgr)
  })

  test('fast path returns the same string when no OSC-8 introducer', () => {
    const input = 'no escapes here'
    expect(stripRawHyperlinks(input)).toBe(input)
  })
})

describe('applyMarkdown — sanitize boundary (CC 2.1.295)', () => {
  let savedForce: string | undefined
  beforeAll(() => {
    savedForce = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'
  })
  afterAll(() => {
    if (savedForce === undefined) delete process.env.FORCE_HYPERLINK
    else process.env.FORCE_HYPERLINK = savedForce
  })

  test('raw OSC-8 in model text is neutralized: anchor visible, no escape bytes, no URL', () => {
    const out = applyMarkdown(EVIL_BEL, THEME)
    expect(out).toContain('click here')
    expect(out).not.toContain(`${ESC}]8;`)
    expect(out).not.toContain(BEL)
    expect(out).not.toContain('http://evil')
  })

  test('markdown-generated links STILL emit OSC-8 (sanitization is upstream of emission)', () => {
    const out = applyMarkdown('[x](https://ok)', THEME)
    expect(out).toContain(`${ESC}]8;;https://ok${BEL}`)
    expect(out).toContain('x')
  })

  test('raw OSC-8 smuggled inside a markdown link label is neutralized', () => {
    const out = applyMarkdown(`[a${EVIL_BEL}b](https://ok)`, THEME)
    // The generated link survives; the smuggled raw sequence does not.
    expect(out).toContain(`${ESC}]8;;https://ok${BEL}`)
    expect(out).not.toContain('http://evil')
    expect(out).toContain('click here')
  })
})
