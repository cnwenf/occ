import { describe, expect, test } from 'bun:test'
import type { FileState } from 'src/utils/fileStateCache.js'
import {
  fileStateMatchesBaseline,
  fileStateMatchesBaselineOrTranscript,
  isFullyReadOfFileState,
} from 'src/utils/permissions/fileStateGuard.js'

/**
 * CC 2.1.295 (#088) — the k4/F/PLe helper trio.
 *
 * Official v295 introduces three predicates that the Edit/sed/NotebookEdit
 * freshness decisions are built from:
 *   k4  = `e!==void 0&&LA(e)&&!e.contentNotInModelContext`
 *         → isFullyReadOfFileState
 *   F   = `e.readBaseline!==void 0?dre(e.readBaseline,n):H$(e,n)`
 *         → fileStateMatchesBaseline (OCC has no readBaseline/contentHash,
 *           so F reduces to the official's own H$ content-compare fallback)
 *   PLe = `F(e,n)||e.contentFromTranscript===!0&&n.endsWith("\n")
 *          &&F(e,n.slice(0,-1))`
 *         → fileStateMatchesBaselineOrTranscript
 *
 * The #088 bug: a file whose contents changed WITHOUT the mtime advancing
 * still compared as "fresh" under v294's mtime-tolerant check; v295 requires
 * a content match via PLe. These tests pin the helper semantics.
 */

function fullRead(overrides: Partial<FileState> = {}): FileState {
  return {
    content: 'a\nb\nc',
    timestamp: 1000,
    offset: undefined,
    limit: undefined,
    ...overrides,
  }
}

describe('2.1.295 #088 isFullyReadOfFileState (k4)', () => {
  test('returns false for an undefined record', () => {
    expect(isFullyReadOfFileState(undefined)).toBe(false)
  })

  test('returns true for a plain full read record', () => {
    expect(isFullyReadOfFileState(fullRead())).toBe(true)
  })

  test('returns false when contentNotInModelContext is set', () => {
    // Arrange — a full-view record whose content the model never saw.
    const state = fullRead({ contentNotInModelContext: true })
    // Act / Assert
    expect(isFullyReadOfFileState(state)).toBe(false)
  })

  test('returns false when contentNotInModelContext is explicitly false', () => {
    expect(isFullyReadOfFileState(fullRead({ contentNotInModelContext: false }))).toBe(
      true,
    )
  })

  test('returns false for a partial view or offset read', () => {
    expect(isFullyReadOfFileState(fullRead({ isPartialView: true }))).toBe(false)
    expect(isFullyReadOfFileState(fullRead({ offset: 2 }))).toBe(false)
    expect(isFullyReadOfFileState(fullRead({ limit: 2 }))).toBe(false)
  })
})

describe('2.1.295 #088 fileStateMatchesBaseline (F)', () => {
  test('matches identical content', () => {
    expect(fileStateMatchesBaseline(fullRead({ content: 'x\ny' }), 'x\ny')).toBe(
      true,
    )
  })

  test('does not match changed content even when the timestamp is frozen', () => {
    // The frozen-mtime core of #088: content compare only — no mtime input.
    expect(
      fileStateMatchesBaseline(fullRead({ content: 'OLD' }), 'NEW'),
    ).toBe(false)
  })
})

describe('2.1.295 #088 fileStateMatchesBaselineOrTranscript (PLe)', () => {
  test('matches identical content regardless of contentFromTranscript', () => {
    expect(
      fileStateMatchesBaselineOrTranscript(fullRead({ content: 'x\n' }), 'x\n'),
    ).toBe(true)
  })

  test('tolerates a single missing trailing newline for transcript-seeded records', () => {
    // Arrange — official set-site @222713171 seeds contentFromTranscript:true
    // when restoring readFileState from a transcript; the restored content may
    // lack the disk's final newline.
    const state = fullRead({ content: 'x\ny', contentFromTranscript: true })
    // Act / Assert — disk ends with \n and slicing it off matches.
    expect(fileStateMatchesBaselineOrTranscript(state, 'x\ny\n')).toBe(true)
  })

  test('does NOT tolerate the trailing newline without contentFromTranscript', () => {
    const state = fullRead({ content: 'x\ny' })
    expect(fileStateMatchesBaselineOrTranscript(state, 'x\ny\n')).toBe(false)
  })

  test('does not tolerate a trailing newline when disk does not end with one', () => {
    const state = fullRead({ content: 'x\ny', contentFromTranscript: true })
    expect(fileStateMatchesBaselineOrTranscript(state, 'x\ny\nz')).toBe(false)
  })

  test('does not tolerate differences beyond the final newline', () => {
    const state = fullRead({ content: 'x\nDIFFERENT', contentFromTranscript: true })
    expect(fileStateMatchesBaselineOrTranscript(state, 'x\ny\n')).toBe(false)
  })
})
