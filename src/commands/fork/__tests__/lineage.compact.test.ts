import { describe, expect, test } from 'bun:test'
import {
  type ForkContextRef,
  extractForkLineage,
  preserveForkLineageAcrossCompaction,
} from '../pointer.js'

// CC 2.1.218 #24: fork-session lineage was lost after compaction in headless
// and SDK sessions. The fork-context-ref pointer (parentSessionId +
// parentLastUuid) must survive a compaction so a fork resumed afterwards can
// still hydrate its prefix from the parent session.

const ref: ForkContextRef = {
  type: 'fork-context-ref',
  parentSessionId: 'parent-uuid-0001',
  parentLastUuid: 'msg-uuid-0099',
}

describe('extractForkLineage', () => {
  test('finds a fork-context-ref entry in a transcript entry list', () => {
    const entries = [
      { type: 'summary', summary: '...' },
      ref,
      { type: 'user', uuid: 'msg-uuid-0099' },
    ]
    expect(extractForkLineage(entries)).toEqual(ref)
  })

  test('returns null when no fork-context-ref is present', () => {
    expect(extractForkLineage([{ type: 'summary' }])).toBeNull()
    expect(extractForkLineage([])).toBeNull()
  })

  test('skips malformed fork-context-ref entries (missing parentSessionId)', () => {
    expect(
      extractForkLineage([
        { type: 'fork-context-ref', parentLastUuid: 'x' }, // missing parentSessionId
      ]),
    ).toBeNull()
  })
})

describe('preserveForkLineageAcrossCompaction (CC 2.1.218 #24)', () => {
  test('re-emits the fork-context-ref at the head of the post-compact transcript', () => {
    // Simulate compaction: the original history (including the pointer) is
    // replaced by a single compact-summary user message.
    const preCompact = [
      ref,
      { type: 'user', uuid: 'msg-uuid-0099', content: 'old turn' },
    ]
    const compactSummary = {
      type: 'user',
      uuid: 'compact-1',
      isCompactSummary: true,
      content: '<summary>',
    }

    const result = preserveForkLineageAcrossCompaction(preCompact, [
      compactSummary,
    ])

    // Lineage preserved at the head.
    expect(result[0]).toEqual(ref)
    // The compact summary follows.
    expect(result[1]).toEqual(compactSummary)
    // No duplication when the pointer wasn't in the post-compact list.
    expect(result.filter((e) => (e as { type?: string }).type === 'fork-context-ref').length).toBe(1)
  })

  test('is a no-op when no lineage existed before compaction', () => {
    const postCompact = [{ type: 'user', uuid: 'c1', isCompactSummary: true }]
    const result = preserveForkLineageAcrossCompaction([], postCompact)
    expect(result).toEqual(postCompact)
  })

  test('does not duplicate an existing post-compact pointer', () => {
    const postCompact = [ref, { type: 'user', uuid: 'c1' }]
    const result = preserveForkLineageAcrossCompaction([ref], postCompact)
    expect(
      result.filter((e) => (e as { type?: string }).type === 'fork-context-ref')
        .length,
    ).toBe(1)
  })
})
