import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'
import { parsePDFPageRange } from '../../../utils/pdfUtils.js'

// CC 2.1.292 (occ149 P4): the official pages parser became STRICT.
// Byte-verified against the official 2.1.292 linux-x64 ELF (`Dns` @207454659):
//   /^(\d{1,9})(?:\s*(-)\s*(\d{1,9})?)?$/  matched against the TRIMMED input;
//   lastPage = last ?? (dash ? Infinity : first); reject first < 1 || last < first.
// The 2.1.291 parser (parseInt-lenient) silently degraded list-style inputs:
// parseInt("6,9,15") === 6 → { firstPage: 6, lastPage: 6 }. The anchored regex
// now returns null for those, and the caller emits the NEW official message
// (`V6e` @214916985):
//   `Invalid pages parameter: "${pages}". Give one page ("3") or one range
//    ("1-5"), not a list. To read several pages or ranges, read each one
//    separately. Pages are 1-indexed.` (errorCode 7)

function contextWithNoRules() {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        alwaysDenyRules: {},
        alwaysAllowRules: {},
        alwaysAskRules: {},
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

describe('parsePDFPageRange strict parser (CC 2.1.292 Dns port)', () => {
  test('accepts a single page "5"', () => {
    expect(parsePDFPageRange('5')).toEqual({ firstPage: 5, lastPage: 5 })
  })

  test('accepts a bounded range "1-10"', () => {
    expect(parsePDFPageRange('1-10')).toEqual({ firstPage: 1, lastPage: 10 })
  })

  test('accepts whitespace around the dash "1 - 10"', () => {
    expect(parsePDFPageRange('1 - 10')).toEqual({ firstPage: 1, lastPage: 10 })
  })

  test('accepts an open-ended range "3-"', () => {
    expect(parsePDFPageRange('3-')).toEqual({
      firstPage: 3,
      lastPage: Infinity,
    })
  })

  test('trims surrounding whitespace', () => {
    expect(parsePDFPageRange('  7  ')).toEqual({ firstPage: 7, lastPage: 7 })
  })

  test('rejects the 291-era silent degradation: comma list "6,9,15"', () => {
    // 291 parseInt path: parseInt("6,9,15") === 6 → { firstPage: 6, ... }
    expect(parsePDFPageRange('6,9,15')).toBeNull()
  })

  test('rejects empty string', () => {
    expect(parsePDFPageRange('')).toBeNull()
  })

  test('rejects whitespace-only string', () => {
    expect(parsePDFPageRange('   ')).toBeNull()
  })

  test('rejects zero page', () => {
    expect(parsePDFPageRange('0')).toBeNull()
  })

  test('rejects inverted range "10-1"', () => {
    expect(parsePDFPageRange('10-1')).toBeNull()
  })

  test('rejects non-numeric input "abc"', () => {
    expect(parsePDFPageRange('abc')).toBeNull()
  })

  test('rejects leading "+" ("+3") — regex is digits-only', () => {
    expect(parsePDFPageRange('+3')).toBeNull()
  })

  test('rejects more than 9 digits per number', () => {
    expect(parsePDFPageRange('1234567890')).toBeNull()
    expect(parsePDFPageRange('123456789')).toEqual({
      firstPage: 123456789,
      lastPage: 123456789,
    })
  })

  test('rejects trailing junk "3x" and "1-5x"', () => {
    expect(parsePDFPageRange('3x')).toBeNull()
    expect(parsePDFPageRange('1-5x')).toBeNull()
  })

  test('rejects double dash "1--5"', () => {
    expect(parsePDFPageRange('1--5')).toBeNull()
  })
})

describe('FileReadTool pages validation message (CC 2.1.292 V6e port)', () => {
  test('invalid pages returns the new 292 wording with errorCode 7', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'doc.pdf', pages: '6,9,15' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(7)
    expect(result.message).toBe(
      'Invalid pages parameter: "6,9,15". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.',
    )
  })

  test('no longer uses the 291 "Use formats like" wording', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'doc.pdf', pages: 'abc' } as never,
      contextWithNoRules(),
    )
    expect(result.message).not.toContain('Use formats like')
  })

  test('range exceeding the cap keeps the 291-era message with errorCode 8', async () => {
    const result = await FileReadTool.validateInput(
      { file_path: 'doc.pdf', pages: '1-100' } as never,
      contextWithNoRules(),
    )
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(8)
    expect(result.message).toBe(
      'Page range "1-100" exceeds maximum of 20 pages per request. Please use a smaller range.',
    )
  })
})
