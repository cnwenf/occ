import { describe, expect, test } from 'bun:test'

import {
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_BYTES,
  MAX_ENTRYPOINT_LINES,
  truncateEntrypointContent,
  truncatePreviewAtWordBoundary,
} from '../memdir.js'

/**
 * claude-code 2.1.268 E52: the MEMORY.md truncation warning now says how many
 * lines were cut and where the cut starts (with an 80-char word-boundary
 * preview of the first cut line), instead of the bare "Only part of it was
 * loaded." sentence.
 *
 * Official 2.1.268 binary `ynt(e,n="index")` (byte-verified):
 *   let x=r[L.length]===`\n`?rn(L,`\n`)+1:0,v=L.length+1,R=r.indexOf(`\n`,v),
 *       A=r.slice(v,R<0?void 0:R).trim(),
 *       D=x===0?`everything after the first ${L.length} characters of line 1 was cut off`
 *              :`${o-x} of ${o} lines were cut off, starting at line ${x+1}${A?` ("${Kte(A,80)}")`:""}`
 *   q=n==="index"
 *     ?`${tc} is ${U}. Only part of it was loaded: ${D}. Keep index entries to one line under ~200 chars; move detail into topic files.`
 *     :`this memory file is ${U}. Only part of it was loaded: ${D}. Keep each memory file focused on one topic.`
 *   return{content:L+`\n\n> WARNING: ${q}`, ...}
 */

function makeLines(count: number, line: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => line(i + 1)).join('\n')
}

describe('2.1.268 E52 truncateEntrypointContent cut-detail warning', () => {
  test('under both caps → content unchanged, no warning, flags false', () => {
    const raw = '  line one\nline two  '
    const result = truncateEntrypointContent(raw)
    expect(result.content).toBe('line one\nline two')
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(false)
    expect(result.content).not.toContain('WARNING')
  })

  test('line-only truncation → "N of M lines were cut off, starting at line K" + quoted first cut line', () => {
    const raw = makeLines(250, n => `line ${n}`)
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(false)

    const kept = makeLines(MAX_ENTRYPOINT_LINES, n => `line ${n}`)
    const warning =
      `MEMORY.md is 250 lines (limit: 200). Only part of it was loaded: ` +
      `50 of 250 lines were cut off, starting at line 201 ("line 201"). ` +
      `Keep index entries to one line under ~200 chars; move detail into topic files.`
    expect(result.content).toBe(`${kept}\n\n> WARNING: ${warning}`)
  })

  test('byte-only truncation of one giant line → "everything after the first N characters of line 1 was cut off"', () => {
    const raw = 'a'.repeat(30000)
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)

    const warning =
      `MEMORY.md is 29.3KB (limit: 24.4KB) — index entries are too long. ` +
      `Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off. ` +
      `Keep index entries to one line under ~200 chars; move detail into topic files.`
    expect(result.content).toBe(
      `${'a'.repeat(MAX_ENTRYPOINT_BYTES)}\n\n> WARNING: ${warning}`,
    )
  })

  test('byte truncation at newline boundary → quotes first cut line truncated to 80 chars with ellipsis', () => {
    const raw = [
      'a'.repeat(10000),
      'b'.repeat(10000),
      'c'.repeat(10000),
    ].join('\n')
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(false)
    expect(result.wasByteTruncated).toBe(true)

    // Cut lands on the newline after line 2 (index 20001): 2 full lines kept,
    // 1 of 3 cut, first cut line previewed as 79 chars + '…' (official Kte).
    const warning =
      `MEMORY.md is 29.3KB (limit: 24.4KB) — index entries are too long. ` +
      `Only part of it was loaded: 1 of 3 lines were cut off, starting at line 3 ` +
      `("${'c'.repeat(79)}…"). ` +
      `Keep index entries to one line under ~200 chars; move detail into topic files.`
    const kept = `${'a'.repeat(10000)}\n${'b'.repeat(10000)}`
    expect(result.content).toBe(`${kept}\n\n> WARNING: ${warning}`)
  })

  test('first cut line whitespace-only → no quoted preview suffix', () => {
    const lines = [
      ...Array.from({ length: 200 }, () => 'x'),
      '   ',
      ...Array.from({ length: 9 }, () => 'x'),
    ]
    const result = truncateEntrypointContent(lines.join('\n'))
    expect(result.wasLineTruncated).toBe(true)
    expect(result.content).toContain(
      'Only part of it was loaded: 10 of 210 lines were cut off, starting at line 201. Keep',
    )
    expect(result.content).not.toContain('("')
  })

  test('both caps → "N lines and <size>" reason with newline-boundary cut detail', () => {
    // 250 lines × 200 chars = 50249 bytes trimmed → both caps fire. Line cut
    // leaves 200 lines (40199 chars), byte cut backs off to the newline ending
    // line 124 (index 24923) → 126 of 250 lines cut, starting at line 125.
    const raw = makeLines(250, () => 'x'.repeat(200))
    const result = truncateEntrypointContent(raw)
    expect(result.wasLineTruncated).toBe(true)
    expect(result.wasByteTruncated).toBe(true)

    const warning =
      `MEMORY.md is 250 lines and 49.1KB. Only part of it was loaded: ` +
      `126 of 250 lines were cut off, starting at line 125 ("${'x'.repeat(79)}…"). ` +
      `Keep index entries to one line under ~200 chars; move detail into topic files.`
    expect(result.content.endsWith(`\n\n> WARNING: ${warning}`)).toBe(true)
  })

  test("kind='memory' → 'this memory file is …' variant with 'its lines are too long'", () => {
    const raw = 'z'.repeat(30000)
    const result = truncateEntrypointContent(raw, 'memory')
    const warning =
      `this memory file is 29.3KB (limit: 24.4KB) — its lines are too long. ` +
      `Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off. ` +
      `Keep each memory file focused on one topic.`
    expect(result.content).toBe(
      `${'z'.repeat(MAX_ENTRYPOINT_BYTES)}\n\n> WARNING: ${warning}`,
    )
  })

  test("kind='memory' line-only → memory advice sentence", () => {
    const raw = makeLines(250, n => `line ${n}`)
    const result = truncateEntrypointContent(raw, 'memory')
    expect(result.content).toContain(
      `this memory file is 250 lines (limit: ${MAX_ENTRYPOINT_LINES}). Only part of it was loaded: 50 of 250 lines were cut off, starting at line 201 ("line 201"). Keep each memory file focused on one topic.`,
    )
    expect(result.content).not.toContain(ENTRYPOINT_NAME)
  })
})

describe('2.1.268 E52 truncatePreviewAtWordBoundary (official Kte)', () => {
  test('returns value unchanged when at or under max', () => {
    expect(truncatePreviewAtWordBoundary('hello', 80)).toBe('hello')
    expect(truncatePreviewAtWordBoundary('x'.repeat(80), 80)).toBe(
      'x'.repeat(80),
    )
  })

  test('cuts at the trailing partial word when the remainder keeps over half of max', () => {
    const value =
      'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'
    expect(truncatePreviewAtWordBoundary(value, 40)).toBe(
      'alpha beta gamma delta epsilon zeta…',
    )
  })

  test('falls back to the raw head when the word cut would keep at most half of max', () => {
    const value = `ab cd${'e'.repeat(100)}`
    expect(truncatePreviewAtWordBoundary(value, 40)).toBe(
      `ab cd${'e'.repeat(34)}…`,
    )
  })

  test('single long word → raw head + ellipsis', () => {
    expect(truncatePreviewAtWordBoundary('x'.repeat(100), 40)).toBe(
      `${'x'.repeat(39)}…`,
    )
  })

  test('never ends on a dangling high surrogate', () => {
    const value = '😀'.repeat(50) // 100 UTF-16 code units
    const result = truncatePreviewAtWordBoundary(value, 40)
    expect(result).toBe(`${'😀'.repeat(19)}…`)
    const lastUnitBeforeEllipsis = result.charCodeAt(result.length - 2)
    expect(lastUnitBeforeEllipsis >= 0xdc00).toBe(true) // low surrogate kept with pair
  })
})
