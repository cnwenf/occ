import { describe, expect, test } from 'bun:test'
import { backfillObservableInputSafely } from '../backfillObservableInput.js'
import { NULL_BYTE_PATH_ERROR_MESSAGE } from '../path.js'

/**
 * CC 2.1.281 changelog #040 (security) — guarded backfillObservableInput.
 * Byte-verified against the v281 ELF `cl()` @208557126: the v280 inline
 * call in query.ts ran UNGUARDED, so a `\0` inside a model-sent path made
 * expandPath throw out of the yield-serialization block and killed the whole
 * turn ("cannot be expanded (null byte" and "backfillObservableInput met a
 * path" markers: v280=0 / v281=2). v281 wraps the call: null-byte failures
 * log + skip the backfill, ANY other throw logs + is swallowed, and the
 * backfilled copy is returned only when fields were ADDED.
 */
describe('2.1.281 #040 — backfillObservableInputSafely (binary cl @208557126)', () => {
  test('returns the copy when backfill ADDED a field', () => {
    // Arrange
    const tool = {
      name: 'FakeTool',
      backfillObservableInput(input: Record<string, unknown>) {
        input.derived = 'added'
      },
    }
    const original = { file_path: '/tmp/a.txt' }

    // Act
    const result = backfillObservableInputSafely(tool, original)

    // Assert
    expect(result).toEqual({ file_path: '/tmp/a.txt', derived: 'added' })
    // the caller's original input is never mutated
    expect(original).toEqual({ file_path: '/tmp/a.txt' })
  })

  test('returns null when backfill only OVERWROTE existing fields (VCR-hash safety)', () => {
    // Arrange
    const tool = {
      name: 'FakeTool',
      backfillObservableInput(input: Record<string, unknown>) {
        input.file_path = '/expanded/tmp/a.txt'
      },
    }

    // Act
    const result = backfillObservableInputSafely(tool, {
      file_path: '~/a.txt',
    })

    // Assert
    expect(result).toBeNull()
  })

  test('survives the expandPath null-byte throw — returns null, does not propagate', () => {
    // Arrange — mirrors utils/path.ts expandPath's null-byte guard
    const tool = {
      name: 'Write',
      backfillObservableInput(input: Record<string, unknown>) {
        const path = input.file_path as string
        if (path.includes('\0')) {
          throw new Error(NULL_BYTE_PATH_ERROR_MESSAGE)
        }
        input.file_path = path
      },
    }

    // Act
    const result = backfillObservableInputSafely(tool, {
      file_path: '/tmp/a\0b.txt',
      content: 'x',
    })

    // Assert — turn survives; input passes through as the model sent it
    expect(result).toBeNull()
  })

  test('swallows ANY other backfill throw (fail-safe, official catch-all branch)', () => {
    // Arrange
    const tool = {
      name: 'FakeTool',
      backfillObservableInput(_input: Record<string, unknown>) {
        throw new TypeError('unexpected shape')
      },
    }

    // Act + Assert — must not throw
    expect(
      backfillObservableInputSafely(tool, { file_path: '/tmp/a.txt' }),
    ).toBeNull()
  })

  test('is a pass-through when the tool has no backfill implementation', () => {
    // Arrange
    const tool = { name: 'FakeTool' }

    // Act + Assert
    expect(backfillObservableInputSafely(tool, { a: 1 })).toBeNull()
  })
})
