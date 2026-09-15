import { describe, expect, test } from 'bun:test'
import {
  createFileStateCacheWithSizeLimit,
  type FileState,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../fileStateCache.js'

/**
 * OCC-126 (self-acceptance security discovery — NOT an official-version port).
 *
 * `REPL.tsx` `restoreReadFileState` runs on BOTH the mount path (CLI
 * `--resume-session` / ResumeConversation, fresh process) and the in-session
 * `/resume` path (switching conversations mid-process). It rebuilds the
 * read-before-edit tracking cache from a transcript:
 *
 *   const extracted = extractReadFilesFromMessages(messages, cwd, SIZE)
 *   readFileState.current = mergeFileStateCaches(readFileState.current, extracted)
 *
 * `mergeFileStateCaches(first, second)` CLONES `first` and overlays `second`.
 * On the in-session path `first` still holds the PREVIOUS conversation's reads,
 * so a merge-only restore leaks them into the resumed session: the
 * read-before-edit guard would then accept an edit to a file the model only read
 * in the abandoned conversation, never in the one it resumed into.
 *
 * The fix clears `readFileState.current` before merging, so the restored cache
 * reflects exactly the resumed transcript — matching the /clear
 * (commands/clear/conversation.ts) and compact (services/compact/compact.ts)
 * idiom. On the mount path the cache is already empty, so the clear is a no-op.
 *
 * These tests pin that invariant at the unit-testable seam (the real
 * FileStateCache + mergeFileStateCaches). The live `/resume` REPL path is
 * exercised by the e2e REPL smoke (OCC-126 acceptance).
 */

function fileState(content: string, timestamp: number): FileState {
  return { content, timestamp, offset: undefined, limit: undefined }
}

describe('OCC-126 restoreReadFileState — clear-before-merge excludes stale prior-session reads', () => {
  test('merge-only (pre-fix) LEAKS a prior conversation read into the resumed session', () => {
    // `current` tracks a file read in the conversation being abandoned.
    const current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    current.set('/prior/abandoned.ts', fileState('old secret read', 1))

    // The resumed transcript read a DIFFERENT file only.
    const extracted = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    extracted.set('/resumed/active.ts', fileState('resumed read', 10))

    // Pre-fix behavior: merge without clearing.
    const merged = mergeFileStateCaches(current, extracted)

    // The stale prior-session read survives — this is the leak.
    expect(merged.has('/prior/abandoned.ts')).toBe(true)
    expect(merged.has('/resumed/active.ts')).toBe(true)
  })

  test('clear-then-merge (post-fix) restores EXACTLY the resumed transcript', () => {
    const current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    current.set('/prior/abandoned.ts', fileState('old secret read', 1))

    const extracted = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    extracted.set('/resumed/active.ts', fileState('resumed read', 10))

    // Post-fix behavior: clear the live cache, then merge.
    current.clear()
    const merged = mergeFileStateCaches(current, extracted)

    // Stale prior-session read is gone; resumed read is present.
    expect(merged.has('/prior/abandoned.ts')).toBe(false)
    expect(merged.has('/resumed/active.ts')).toBe(true)
    expect(merged.get('/resumed/active.ts')?.content).toBe('resumed read')
  })

  test('clear preserves a file the resumed transcript ALSO read (newer timestamp wins)', () => {
    const current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    current.set('/shared/file.ts', fileState('stale content', 1))

    const extracted = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    extracted.set('/shared/file.ts', fileState('fresh content', 20))

    current.clear()
    const merged = mergeFileStateCaches(current, extracted)

    expect(merged.has('/shared/file.ts')).toBe(true)
    expect(merged.get('/shared/file.ts')?.content).toBe('fresh content')
  })

  test('mount path: clearing an already-empty cache then merging is a correct no-op', () => {
    // Fresh process — `current` is empty, mirroring the mount useEffect path.
    const current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    const extracted = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
    extracted.set('/initial/read.ts', fileState('initial', 5))

    expect(() => current.clear()).not.toThrow()
    const merged = mergeFileStateCaches(current, extracted)

    expect(merged.has('/initial/read.ts')).toBe(true)
    expect(merged.size).toBe(1)
  })
})
