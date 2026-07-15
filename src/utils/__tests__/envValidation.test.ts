import { describe, expect, test } from 'bun:test'
import { validateBoundedIntEnvVar } from '../envValidation.js'

/**
 * claude-code 2.1.208 #11: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and similar env vars
 * silently used the mantissa of scientific-notation values — `parseInt('1e6',10)`
 * stops at 'e' and returns 1. The fix parses scientific notation via `Number()`,
 * accepting only integer results, then falls back to `parseInt` otherwise.
 *
 * Mirrors CC 2.1.210 binary `aDe`:
 *   if (/^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/.test(i)) s = Number.isInteger(Number(i)) ? Number(i) : NaN
 *   else s = parseInt(o, 10)
 */
describe('2.1.208 #11 scientific-notation env vars', () => {
  test('1e6 parses to 1000000, not 1', () => {
    // Arrange
    const upperLimit = 10_000_000
    // Act
    const result = validateBoundedIntEnvVar(
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      '1e6',
      8192,
      upperLimit,
    )
    // Assert
    expect(result.effective).toBe(1_000_000)
    expect(result.status).toBe('valid')
  })

  test('1e3 parses to 1000', () => {
    const result = validateBoundedIntEnvVar('X', '1e3', 100, 10_000)
    expect(result.effective).toBe(1000)
    expect(result.status).toBe('valid')
  })

  test('2e3 is capped when it exceeds the upper limit', () => {
    const result = validateBoundedIntEnvVar('X', '2e3', 100, 1500)
    expect(result.effective).toBe(1500)
    expect(result.status).toBe('capped')
  })

  test('1.5e1 (== 15) is accepted because the result is an integer', () => {
    const result = validateBoundedIntEnvVar('X', '1.5e1', 100, 10_000)
    expect(result.effective).toBe(15)
    expect(result.status).toBe('valid')
  })

  test('1.5e0 (== 1.5) is rejected because the result is not an integer', () => {
    const result = validateBoundedIntEnvVar('X', '1.5e0', 100, 10_000)
    expect(result.status).toBe('invalid')
    expect(result.effective).toBe(100)
  })

  test('plain decimal 5000 still works', () => {
    const result = validateBoundedIntEnvVar('X', '5000', 100, 10_000)
    expect(result.effective).toBe(5000)
    expect(result.status).toBe('valid')
  })

  test('non-numeric "abc" falls back to default', () => {
    const result = validateBoundedIntEnvVar('X', 'abc', 100, 10_000)
    expect(result.status).toBe('invalid')
    expect(result.effective).toBe(100)
  })

  test('unset value uses the default', () => {
    const result = validateBoundedIntEnvVar('X', undefined, 100, 10_000)
    expect(result.effective).toBe(100)
    expect(result.status).toBe('valid')
  })

  test('negative scientific -1e3 is invalid (<=0)', () => {
    const result = validateBoundedIntEnvVar('X', '-1e3', 100, 10_000)
    expect(result.status).toBe('invalid')
    expect(result.effective).toBe(100)
  })
})
