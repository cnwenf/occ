import { describe, expect, test } from 'bun:test'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import {
  buildLargeToolResultMessage,
  generatePreview,
  PREVIEW_SIZE_BYTES,
} from '../toolResultStorage.js'

/**
 * CC 2.1.309 (item 16) — the persisted-output preview builder routes its
 * final slice through the surrogate-safe slicer.
 *
 * Official 309 `mht` @247455011 (BIN309):
 *   function mht(e,n){if(e.length<=n)return{preview:e,hasMore:!1};
 *     let s=e.slice(0,n).lastIndexOf("\n"),i=s>n*0.5?s:n;
 *     return{preview:re(e,i),hasMore:!0}}
 * where `re` ≡ `fe` (BIN309 @278224106):
 *   function fe(e,t){if(t<=0)return"";return e.length<=t?e:
 *     e.slice(0,t).replace(/[\uD800-\uDBFF]$/,"")}
 *
 * 308 `Bmt` @246552671 used the raw `e.slice(0,a)`, so a preview cut landing
 * mid-emoji kept a trailing lone high surrogate; that surrogate is escaped by
 * JSON.stringify as a lone \udXXX and re-parsed as an unpaired code unit,
 * corrupting session transcripts (breaks `jq`).
 */

// A lone high surrogate left at the end of a string.
const LONE_HIGH_SURROGATE_TAIL = /[\uD800-\uDBFF]$/
// Any unpaired surrogate code unit, anywhere (the transcript-corrupting form).
const LONE_SURROGATE_ANYWHERE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('CC 2.1.309 (item 16) — generatePreview surrogate-safe cut', () => {
  test('cut landing mid-emoji yields no trailing lone surrogate', () => {
    // Arrange — a single long line of emoji so the newline-boundary search
    // fails (lastIndexOf('\n') === -1) and the cut falls back to maxBytes.
    // An ODD maxBytes lands inside the 6th surrogate pair (slice(0, 11) =
    // 5 whole pairs + lone high surrogate \uD83C).
    const maxBytes = 11
    const content = '🌍'.repeat(20) // 40 UTF-16 code units

    // Act
    const { preview, hasMore } = generatePreview(content, maxBytes)

    // Assert
    expect(hasMore).toBe(true)
    expect(LONE_HIGH_SURROGATE_TAIL.test(preview)).toBe(false)
    expect(preview).toBe('🌍'.repeat(5))
  })

  test('content within the limit is returned unchanged', () => {
    // Arrange
    const content = 'short 🌍 output'

    // Act
    const { preview, hasMore } = generatePreview(content, 100)

    // Assert
    expect(preview).toBe(content)
    expect(hasMore).toBe(false)
  })

  test('newline-boundary cut still applies when reasonably close to the limit', () => {
    // Arrange — newline past the 50% mark, then an emoji the hard cut would
    // split.
    const content = `${'x'.repeat(8)}\n${'🌍'.repeat(10)}`

    // Act
    const { preview, hasMore } = generatePreview(content, 10)

    // Assert — cut at the last newline (index 8), no lone surrogate.
    expect(hasMore).toBe(true)
    expect(preview).toBe('x'.repeat(8))
    expect(LONE_HIGH_SURROGATE_TAIL.test(preview)).toBe(false)
  })

  test('wrapped persisted-output banner JSON round-trips', () => {
    // Arrange — preview cut lands mid-emoji (odd cap → lone high surrogate
    // with a raw slice), then gets wrapped in the <persisted-output> banner
    // like persistToolResult does.
    const content = `🌍`.repeat(PREVIEW_SIZE_BYTES) // far past the preview cap
    const { preview, hasMore } = generatePreview(content, PREVIEW_SIZE_BYTES + 1)
    const message = buildLargeToolResultMessage({
      filepath: '/tmp/occ-test/toolu_123.txt',
      originalSize: content.length,
      isJson: false,
      preview,
      hasMore,
    })

    // Act — serialize the way a session transcript would.
    const roundTripped = JSON.parse(JSON.stringify({ content: message }))

    // Assert — no lone-surrogate corruption anywhere in the wrapped banner:
    // the round-trip is lossless and the raw message carries no unpaired
    // surrogate code units (those break jq / transcript parsers).
    expect(roundTripped.content).toBe(message)
    expect(LONE_SURROGATE_ANYWHERE.test(message)).toBe(false)
    expect(message).toContain('<persisted-output>')
    expect(message).toContain('</persisted-output>')
  })
})
