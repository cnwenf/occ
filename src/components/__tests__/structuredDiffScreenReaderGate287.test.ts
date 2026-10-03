import { describe, expect, test } from 'bun:test'
import { shouldUseColorDiff } from '../StructuredDiff.js'

/**
 * v2.1.287 Item 5 (option 1) — screen-reader gate for the color-diff path.
 *
 * Official intent (recovered in the cluster-e gap report): SR users must get
 * Text-based diff lines, which OCC's screen-reader serializer
 * (src/ink/screen-reader-render.ts) can walk (ink-text / ink-box), instead of
 * the <RawAnsi> color diff — the serializer has NO ink-raw-ansi case, so a
 * RawAnsi diff serializes to nothing and the whole diff is invisible to SR.
 *
 * `shouldUseColorDiff(skipHighlighting, syntaxHighlightingDisabled, screenReaderEnabled)`
 * is the pure predicate wired into StructuredDiff's render path:
 *   true  → renderColorDiff(...) → <RawAnsi>
 *   false → <StructuredDiffFallback> (plain Text, SR-visible)
 *
 * The pre-existing CLAUDE_CODE_SYNTAX_HIGHLIGHT env gate (colorDiff.ts) and the
 * skipHighlighting / syntaxHighlightingDisabled conditions are unchanged for
 * non-SR — this predicate only ADDS the SR condition.
 */
describe('v2.1.287 Item 5: shouldUseColorDiff screen-reader gate', () => {
  test('uses the color diff when nothing disables it (non-SR default)', () => {
    // Arrange / Act / Assert
    expect(shouldUseColorDiff(false, false, false)).toBe(true)
  })

  test('falls back to plain Text when the screen reader is enabled', () => {
    // The SR gate alone forces the Text fallback even with highlighting on.
    expect(shouldUseColorDiff(false, false, true)).toBe(false)
  })

  test('honors skipHighlighting independently of SR', () => {
    expect(shouldUseColorDiff(true, false, false)).toBe(false)
    expect(shouldUseColorDiff(true, false, true)).toBe(false)
  })

  test('honors syntaxHighlightingDisabled (CLAUDE_CODE_SYNTAX_HIGHLIGHT) independently of SR', () => {
    expect(shouldUseColorDiff(false, true, false)).toBe(false)
    expect(shouldUseColorDiff(false, true, true)).toBe(false)
  })

  test('non-SR behavior is byte-for-byte the original gate', () => {
    // Exhaustive over the two pre-existing gates with SR off — must match the
    // original `skipHighlighting || syntaxHighlightingDisabled ? null : color`.
    expect(shouldUseColorDiff(false, false, false)).toBe(true)
    expect(shouldUseColorDiff(false, true, false)).toBe(false)
    expect(shouldUseColorDiff(true, false, false)).toBe(false)
    expect(shouldUseColorDiff(true, true, false)).toBe(false)
  })

  test('SR enabled always forces the Text fallback regardless of other gates', () => {
    for (const skip of [false, true]) {
      for (const disabled of [false, true]) {
        expect(shouldUseColorDiff(skip, disabled, true)).toBe(false)
      }
    }
  })
})
