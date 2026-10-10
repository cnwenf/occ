import { describe, expect, test } from 'bun:test'
import {
  containsReplacementChar,
  isValidUtf8Bytes,
  NOT_UTF8_REFUSAL_MESSAGE,
  REPLACEMENT_CHAR,
  shouldRefuseNonUtf8Edit,
  shouldRefuseUfffdWrite,
  UFFFD_WRITE_REFUSAL_MESSAGE,
} from '../utf8Safety.js'

/**
 * CC 2.1.296 — unit coverage for the non-UTF-8 refusal helper (aen / UTs).
 * The tool-level behavior is pinned by nonUtf8Refusal296.test.ts (Edit /
 * NotebookEdit) and ufffdWriteRefusal296.test.ts (Write); these tests cover
 * the pure predicates directly, including the utf16le carve-out (OCC
 * round-trips utf16le losslessly, unlike the official which always saves
 * UTF-8).
 */

// GBK "中文" — invalid UTF-8. latin1 "café" (trailing 0xE9) — invalid UTF-8.
const GBK_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
const LATIN1_BYTES = Buffer.from([0x63, 0x61, 0x66, 0xe9])
const VALID_MULTIBYTE = Buffer.from('café 日本語', 'utf8')

describe('utf8Safety — REPLACEMENT_CHAR + messages', () => {
  test('REPLACEMENT_CHAR is U+FFFD', () => {
    expect(REPLACEMENT_CHAR).toBe('�')
    expect(REPLACEMENT_CHAR.codePointAt(0)).toBe(0xfffd)
  })

  test('aen / UTs messages are the byte-verbatim official strings', () => {
    expect(NOT_UTF8_REFUSAL_MESSAGE).toStartWith(
      'File is not valid UTF-8.',
    )
    expect(NOT_UTF8_REFUSAL_MESSAGE).toInclude('Nothing was written.')
    expect(UFFFD_WRITE_REFUSAL_MESSAGE).toStartWith(
      'The file on disk is not valid UTF-8, and the new content holds U+FFFD',
    )
    expect(UFFFD_WRITE_REFUSAL_MESSAGE).toInclude('Nothing was written.')
  })
})

describe('utf8Safety — isValidUtf8Bytes', () => {
  test('true for ASCII, valid multibyte, and empty buffers', () => {
    expect(isValidUtf8Bytes(Buffer.from('hello', 'utf8'))).toBe(true)
    expect(isValidUtf8Bytes(VALID_MULTIBYTE)).toBe(true)
    expect(isValidUtf8Bytes(Buffer.alloc(0))).toBe(true)
  })

  test('false for GBK and latin1 byte sequences', () => {
    expect(isValidUtf8Bytes(GBK_BYTES)).toBe(false)
    expect(isValidUtf8Bytes(LATIN1_BYTES)).toBe(false)
  })

  test('false for a stray 0xFF byte (never valid in UTF-8)', () => {
    expect(isValidUtf8Bytes(Buffer.from([0x68, 0x69, 0xff, 0x65]))).toBe(false)
  })
})

describe('utf8Safety — containsReplacementChar', () => {
  test('true when U+FFFD is present, false otherwise', () => {
    expect(containsReplacementChar(`a${REPLACEMENT_CHAR}b`)).toBe(true)
    expect(containsReplacementChar(REPLACEMENT_CHAR)).toBe(true)
    expect(containsReplacementChar('plain text')).toBe(false)
    expect(containsReplacementChar('')).toBe(false)
  })
})

describe('utf8Safety — shouldRefuseNonUtf8Edit (aen gate)', () => {
  test('true for invalid bytes detected as utf8', () => {
    expect(shouldRefuseNonUtf8Edit(GBK_BYTES, 'utf8')).toBe(true)
    expect(shouldRefuseNonUtf8Edit(LATIN1_BYTES, 'utf8')).toBe(true)
  })

  test('false for valid utf8 bytes', () => {
    expect(shouldRefuseNonUtf8Edit(VALID_MULTIBYTE, 'utf8')).toBe(false)
    expect(shouldRefuseNonUtf8Edit(Buffer.from('hi'), 'utf8')).toBe(false)
  })

  test('false for the utf16le carve-out even with non-utf8-looking bytes', () => {
    // utf16le round-trips losslessly in OCC → the aen premise does not hold.
    expect(shouldRefuseNonUtf8Edit(GBK_BYTES, 'utf16le')).toBe(false)
  })
})

describe('utf8Safety — shouldRefuseUfffdWrite (UTs gate)', () => {
  const fffdContent = `x${REPLACEMENT_CHAR}y`

  test('true only when disk is invalid utf8 AND content holds U+FFFD', () => {
    expect(shouldRefuseUfffdWrite(GBK_BYTES, 'utf8', fffdContent)).toBe(true)
  })

  test('false when the new content is clean (no U+FFFD)', () => {
    expect(shouldRefuseUfffdWrite(GBK_BYTES, 'utf8', 'clean')).toBe(false)
  })

  test('false when the disk file is valid utf8', () => {
    expect(shouldRefuseUfffdWrite(VALID_MULTIBYTE, 'utf8', fffdContent)).toBe(
      false,
    )
  })

  test('false for the utf16le carve-out', () => {
    expect(shouldRefuseUfffdWrite(GBK_BYTES, 'utf16le', fffdContent)).toBe(
      false,
    )
  })
})
