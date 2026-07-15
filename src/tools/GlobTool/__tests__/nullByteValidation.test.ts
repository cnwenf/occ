import { describe, expect, test } from 'bun:test'
import { GlobTool } from '../GlobTool.js'

/**
 * 2.1.208 #14d: Glob crashes with unclear error when pattern/path contains
 * a null byte. Ported from Claude Code 2.1.210 binary SJn(vd, ...).
 *
 * The fix returns a clear validation error (errorCode 2) before any
 * filesystem work, matching the official string:
 *   `${GLOB_TOOL_NAME} ${field} cannot contain null bytes (\\0). Remove the null byte and try again.`
 */
describe('2.1.208 #14d — Glob null-byte validation', () => {
  test('rejects a null byte in pattern with the official error string', async () => {
    // Arrange
    const input = { pattern: 'foo\x00bar', path: undefined }

    // Act
    const result = await GlobTool.validateInput(input as any)

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(
      'Glob pattern cannot contain null bytes (\\0). Remove the null byte and try again.',
    )
  })

  test('rejects a null byte in path with the official error string', async () => {
    // Arrange
    const input = { pattern: '*.ts', path: '/tmp/bad\x00path' }

    // Act
    const result = await GlobTool.validateInput(input as any)

    // Assert
    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
    expect(result.message).toBe(
      'Glob path cannot contain null bytes (\\0). Remove the null byte and try again.',
    )
  })

  test('does not reject valid pattern/path without null bytes', async () => {
    // Arrange — path omitted so validation passes without touching the FS
    const input = { pattern: '*.ts', path: undefined }

    // Act
    const result = await GlobTool.validateInput(input as any)

    // Assert
    expect(result.result).toBe(true)
  })
})
