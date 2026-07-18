import { describe, expect, test } from 'bun:test'
import { shouldPromptForCommandLength, MAX_COMMAND_LENGTH_PROMPT } from '../bashPermissions'

/** M3 (CC 2.1.214): commands over 10,000 chars always prompt. Pure helper TDD. */

describe('M3 (2.1.214): command length prompt', () => {
  test('MAX_COMMAND_LENGTH_PROMPT is 10000', () => {
    expect(MAX_COMMAND_LENGTH_PROMPT).toBe(10000)
  })
  test('9999-char → false', () => {
    expect(shouldPromptForCommandLength('x'.repeat(9999))).toBe(false)
  })
  test('exactly 10000 → false (over = strictly greater)', () => {
    expect(shouldPromptForCommandLength('x'.repeat(10000))).toBe(false)
  })
  test('10001-char → true (always prompt)', () => {
    expect(shouldPromptForCommandLength('x'.repeat(10001))).toBe(true)
  })
  test('empty → false', () => {
    expect(shouldPromptForCommandLength('')).toBe(false)
  })
})
