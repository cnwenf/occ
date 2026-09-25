import { describe, expect, test } from 'bun:test'
import { validateNullByteFreeFields } from '../nullByteValidation.js'

/**
 * CC 2.1.281 changelog #040 (security) — shared null-byte path validator.
 * Byte-verified against the v281 ELF `fy(e,n)` @201072355 (v280 had the
 * identical helper `l8()` @198504766 but wired only into Glob/Grep; v281
 * wires it into Read/Write/Edit/NotebookEdit validateInput — see
 * fileToolNullByte281.test.ts for the tool-level cases).
 */
describe('2.1.281 #040 — validateNullByteFreeFields (binary fy @201072355)', () => {
  test('returns the byte-exact deny result for a null byte in a field', () => {
    // Arrange
    const fields: [string, unknown][] = [['file_path', '/tmp/a\0b.txt']]

    // Act
    const result = validateNullByteFreeFields('Read', fields)

    // Assert
    expect(result).toEqual({
      result: false,
      message:
        'Read file_path cannot contain null bytes (\\0). Remove the null byte and try again.',
      errorCode: 2,
    })
  })

  test('names the first offending field when several contain null bytes', () => {
    // Arrange
    const fields: [string, unknown][] = [
      ['pattern', 'clean'],
      ['path', '/tmp/\0'],
    ]

    // Act
    const result = validateNullByteFreeFields('Glob', fields)

    // Assert
    expect(result).not.toBeNull()
    expect(result!.result).toBe(false)
    if (result !== null && result.result === false) {
      expect(result.message).toBe(
        'Glob path cannot contain null bytes (\\0). Remove the null byte and try again.',
      )
    }
  })

  test('returns null when no field contains a null byte', () => {
    // Arrange
    const fields: [string, unknown][] = [
      ['file_path', '/tmp/ordinary.txt'],
      ['content', 'hello'],
    ]

    // Act + Assert
    expect(validateNullByteFreeFields('Write', fields)).toBeNull()
  })

  test('ignores undefined and non-string values (fail-safe, no throw)', () => {
    // Arrange
    const fields: [string, unknown][] = [
      ['file_path', undefined],
      ['limit', 42],
      ['pages', null],
    ]

    // Act + Assert
    expect(validateNullByteFreeFields('Read', fields)).toBeNull()
  })
})
