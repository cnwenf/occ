import { test, expect, describe } from 'bun:test'
import { shouldInvalidateReadFileStateAfterHooks } from '../hookReadFileStateGate.js'

// CC 2.1.216 #6 (a): @-mentions silently attach NOTHING after file-modifying
// hooks. PreToolUse hooks can modify files externally, but readFileState is
// never invalidated. If the mtime matches (coarse FS resolution), the
// already_read_file optimization returns empty content → model sees nothing.

describe('shouldInvalidateReadFileStateAfterHooks', () => {
  test('returns true when hooks ran (invalidate to prevent stale cache)', () => {
    expect(shouldInvalidateReadFileStateAfterHooks(true)).toBe(true)
  })

  test('returns false when no hooks ran (cache is still valid)', () => {
    expect(shouldInvalidateReadFileStateAfterHooks(false)).toBe(false)
  })

  test('the bug: without invalidation, hooks that modify files leave stale entries', () => {
    // The old code never invalidated readFileState after hooks. If a hook
    // modified a file whose mtime matched the cached timestamp, the
    // already_read_file optimization returned empty content.
    // The fix: invalidate after hooks run.
    const hooksRan = true
    const shouldInvalidate = shouldInvalidateReadFileStateAfterHooks(hooksRan)
    expect(shouldInvalidate).toBe(true) // must invalidate → no stale entries
  })

  test('the fix: invalidating forces fresh read on next @-mention', () => {
    // After invalidation, the next @-mention re-reads the file, getting
    // the hook-modified content instead of the stale cache.
    const hooksRan = true
    if (shouldInvalidateReadFileStateAfterHooks(hooksRan)) {
      // readFileState.clear() would be called here
      // → next @-mention re-reads the file → model sees the new content
    }
    expect(shouldInvalidateReadFileStateAfterHooks(hooksRan)).toBe(true)
  })
})
