import { describe, expect, test } from 'bun:test'
import { safeSlice } from '../safeSlice.js'

/**
 * CC 2.1.309 (item 16) — surrogate-safe slicer.
 *
 * Official 309 replaced the raw `.slice(0, a)` in the persisted-output
 * preview builder with the shared surrogate-safe slicer:
 *
 *   function fe(e,t){if(t<=0)return"";return e.length<=t?e:
 *     e.slice(0,t).replace(/[\uD800-\uDBFF]$/,"")}
 *
 * Body is byte-identical in BIN309 @278224106 and BIN308 @277377970 (the
 * utility pre-existed; 309 only changed the preview call site to use it —
 * `mht` @247455011: `{preview:re(e,i),hasMore:!0}` vs 308 `Bmt`'s raw
 * `e.slice(0,a)` @246552671). Cutting a string at an arbitrary UTF-16 index
 * can leave a trailing lone high surrogate, which JSON.stringify escapes to
 * \udXXX and JSON.parse turns back into an unpaired code unit — corrupting
 * session transcripts (breaks `jq`).
 */

// A lone high surrogate left at the end of a string.
const LONE_HIGH_SURROGATE_TAIL = /[\uD800-\uDBFF]$/

describe('CC 2.1.309 (item 16) — safeSlice', () => {
  test('returns empty string when the limit is zero or negative', () => {
    // Arrange
    const input = 'hello'

    // Act & Assert — official `t<=0 → ""` guard.
    expect(safeSlice(input, 0)).toBe('')
    expect(safeSlice(input, -1)).toBe('')
  })

  test('returns the input unchanged when it fits within the limit', () => {
    // Arrange
    const input = 'hello 🌍'

    // Act & Assert — identity for length <= t (and at the exact boundary).
    expect(safeSlice(input, input.length)).toBe(input)
    expect(safeSlice(input, input.length + 10)).toBe(input)
  })

  test('strips a trailing lone high surrogate when the cut lands mid-emoji', () => {
    // Arrange — 'a' + '🌍' (surrogate pair: 🌍); slice(0, 2) keeps
    // only the high surrogate \uD83C.
    const input = 'a🌍'

    // Act
    const result = safeSlice(input, 2)

    // Assert
    expect(result).toBe('a')
    expect(LONE_HIGH_SURROGATE_TAIL.test(result)).toBe(false)
  })

  test('produces JSON-round-trip-stable output when cut mid-emoji', () => {
    // Arrange
    const input = 'line\n🌍🌍🌍 tail'

    // Act
    const result = safeSlice(input, 6) // 'line\n' + lone high surrogate \uD83C

    // Assert — JSON.stringify must not emit a lone \udXXX escape.
    expect(JSON.parse(JSON.stringify({ s: result })).s).toBe(result)
  })

  test('leaves complete surrogate pairs intact', () => {
    // Arrange
    const input = '🌍🌍🌍'

    // Act — cut on the pair boundary (3 pairs = 6 code units, keep 4).
    const result = safeSlice(input, 4)

    // Assert
    expect(result).toBe('🌍🌍')
  })
})
