import { describe, expect, test } from 'bun:test'
import {
  TASK_NOTIFICATION_CHAR_CAP,
  truncateMiddleWithMarker,
} from '../truncateMiddle.js'

// Official Claude Code 2.1.252 (OCC-112 Gap-112c / changelog item 4):
// task-notification values are middle-truncated before enqueueing so a
// background task's very large failure output cannot push the conversation
// past the API request size limit. These tests pin the official `af`/`Cke`
// contract recovered from the 2.1.252 binary:
//   - values within cap + 1024 slack pass through untouched
//   - otherwise keep floor(cap/2) head chars and cap-floor(cap/2) tail chars
//   - joined by "\n\n... [N characters truncated] ...\n\n", N = removed chars
//   - nested markers inside the removed middle fold their claimed counts in
//   - slices never split a surrogate pair

describe('truncateMiddleWithMarker (2.1.252 task-notification cap)', () => {
  test('exports the official 100k task-notification cap', () => {
    expect(TASK_NOTIFICATION_CHAR_CAP).toBe(100_000)
  })

  test('returns values within cap + slack untouched', () => {
    // Arrange — exactly at the slack boundary
    const atBoundary = 'a'.repeat(10 + 1024)

    // Act / Assert
    expect(truncateMiddleWithMarker(atBoundary, 10)).toBe(atBoundary)
    expect(truncateMiddleWithMarker('short', 10)).toBe('short')
    expect(truncateMiddleWithMarker('', 10)).toBe('')
  })

  test('truncates one char past the slack boundary', () => {
    // Arrange
    const value = 'H'.repeat(600) + 'M'.repeat(435) // 1035 = cap(10)+slack(1024)+1

    // Act
    const result = truncateMiddleWithMarker(value, 10)

    // Assert — head 5, tail 5, marker reports all 1025 removed chars
    expect(result).toBe(
      `HHHHH\n\n... [1025 characters truncated] ...\n\nMMMMM`,
    )
  })

  test('keeps floor(cap/2) head and cap-floor(cap/2) tail chars', () => {
    // Arrange — odd cap: head 3, tail 4
    const value = 'A'.repeat(1500) + 'Z'.repeat(1500)

    // Act
    const result = truncateMiddleWithMarker(value, 7)

    // Assert
    expect(result).toBe(
      `AAA\n\n... [${3000 - 7} characters truncated] ...\n\nZZZZ`,
    )
    expect(result.startsWith('AAA\n\n...')).toBe(true)
    expect(result.endsWith('ZZZZ')).toBe(true)
  })

  test('folds nested markers in the removed middle into the total', () => {
    // Arrange — the removed middle contains a prior truncation marker
    // claiming 500 chars (the marker text itself is 38 chars long).
    const nestedMarker = '\n\n... [500 characters truncated] ...\n\n'
    expect(nestedMarker).toHaveLength(38)
    const value = 'A'.repeat(50) + nestedMarker + 'B'.repeat(2000) // 2088 chars

    // Act — head 5 / tail 5 survive; removed middle holds the nested marker.
    const result = truncateMiddleWithMarker(value, 10)

    // Assert — 2088-10 chars removed, plus 500-38 folded from the nested
    // marker = 2540.
    expect(result).toBe(
      `AAAAA\n\n... [2540 characters truncated] ...\n\nBBBBB`,
    )
  })

  test('does not split a surrogate pair at the head boundary', () => {
    // Arrange — the 5th UTF-16 unit is a high surrogate (𝕏 = D835 DD4F).
    const value = 'abcd' + '𝕏' + 'x'.repeat(2000) // 2006 chars

    // Act
    const result = truncateMiddleWithMarker(value, 10)

    // Assert — the dangling high surrogate is dropped from the head; the
    // removed count grows by the dropped unit.
    expect(result).toBe(
      `abcd\n\n... [1997 characters truncated] ...\n\nxxxxx`,
    )
  })

  test('does not split a surrogate pair at the tail boundary', () => {
    // Arrange — the tail slice would start on a low surrogate.
    const value = 'q'.repeat(2000) + '𝕏' + 'wwww' // 2006 chars

    // Act
    const result = truncateMiddleWithMarker(value, 10)

    // Assert — the dangling low surrogate is dropped from the tail.
    expect(result).toBe(
      `qqqqq\n\n... [1997 characters truncated] ...\n\nwwww`,
    )
  })

  test('result carries no lone surrogates', () => {
    // Arrange — sprinkle surrogate pairs through a large value
    const value = ('𝕏'.repeat(3) + 'z'.repeat(97)).repeat(3000) // 300k chars

    // Act
    const result = truncateMiddleWithMarker(value, TASK_NOTIFICATION_CHAR_CAP)

    // Assert — well-formed UTF-16 and close to the cap
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(result).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
    expect(result.length).toBeLessThanOrEqual(
      TASK_NOTIFICATION_CHAR_CAP + '\n\n... [999999999 characters truncated] ...\n\n'.length,
    )
  })
})
