import { describe, expect, test } from 'bun:test'
import { FileReadTool } from '../FileReadTool.js'

/**
 * CC 2.1.295 (#079) — Read must treat an empty `pages` parameter as omitted
 * instead of rejecting it.
 *
 * Official v295 schema (@218369451), verbatim:
 *   pages:Yi((e)=>typeof e==="string"&&e.trim()===""?void 0:e,
 *     o().optional()).describe(...)
 * (Yi = z.preprocess, o() = z.string). The page-range parser (`Dns`/
 * parsePDFPageRange) is byte-identical v294↔v295 — the fix is purely a
 * schema-level preprocess that maps an empty / whitespace-only string to
 * `undefined` BEFORE validation. toolExecution feeds validateInput the
 * schema-PARSED data (`tool.validateInput(parsedInput.data, ...)`), so the
 * preprocess short-circuits the `if (pages !== undefined)` guard in
 * validateInput and the empty value is treated exactly like an omitted one.
 *
 * These tests pin the schema parse (the fix site). The strict-parser and
 * validateInput message behavior are covered by pdfPagesStrict292.test.ts.
 */

const schema = FileReadTool.inputSchema

function parsePages(pages: unknown) {
  return schema.safeParse({ file_path: '/a.pdf', pages })
}

describe('CC 2.1.295 (#079) — FileReadTool pages preprocess (empty → omitted)', () => {
  test('empty string pages is coerced to undefined (treated as omitted)', () => {
    // Arrange / Act
    const result = parsePages('')

    // Assert — parse succeeds and pages is dropped to undefined.
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBeUndefined()
    }
  })

  test('whitespace-only pages is coerced to undefined', () => {
    const result = parsePages('   ')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBeUndefined()
    }
  })

  test('tab/newline-only pages is coerced to undefined', () => {
    const result = parsePages('\t\n ')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBeUndefined()
    }
  })

  test('a valid non-empty pages string passes through unchanged', () => {
    const result = parsePages('1-5')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBe('1-5')
    }
  })

  test('a single page string passes through unchanged', () => {
    const result = parsePages('3')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBe('3')
    }
  })

  test('an omitted pages key still parses to undefined', () => {
    const result = schema.safeParse({ file_path: '/a.pdf' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pages).toBeUndefined()
    }
  })

  test('a non-string pages value is NOT silently coerced (rejected by inner schema)', () => {
    // The preprocess only maps empty strings to undefined; a number passes
    // through and the inner z.string().optional() rejects it.
    const result = parsePages(5)
    expect(result.success).toBe(false)
  })

  test('empty pages does not trip the strict-parser errorCode 7 path via the schema', () => {
    // Contrast with pdfPagesStrict292: parsePDFPageRange('') === null would
    // yield errorCode 7, but the schema drops '' to undefined first, so a
    // schema-parsed input never reaches that guard with an empty string.
    const result = parsePages('')
    expect(result.success).toBe(true)
    if (result.success) {
      expect('pages' in result.data && result.data.pages !== undefined).toBe(
        false,
      )
    }
  })
})
