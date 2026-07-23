import { describe, test, expect } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import { getCurrentUsage } from '../../src/utils/tokens.js'
import { stripStaleUsageFromPreservedSegment } from '../../src/commands/context/context-noninteractive.js'

/**
 * CC 2.1.218 #7 (B6): /context reported stale pre-compact token usage after
 * compacting from the message picker.
 *
 * Bug: after a partial compact, messagesToKeep (the preserved segment) retain
 * their pre-compact token usage. getCurrentUsage scans backwards and returns
 * the last usage-bearing message — a kept message whose usage reflects the
 * pre-compact (larger) context, not the post-compact context.
 *
 * Fix: stripStaleUsageFromPreservedSegment clears usage from messages in the
 * compact boundary's preservedSegment (headUuid..tailUuid) so getCurrentUsage
 * falls through to the compact summary (fresh) or returns null (estimation).
 */

function assistantWithUsage(
  uuid: string,
  inputTokens: number,
): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function compactBoundary(
  uuid: string,
  preserved: { headUuid: string; tailUuid: string; anchorUuid: string },
): Message {
  return {
    type: 'system',
    uuid,
    subtype: 'compact_boundary',
    compactMetadata: { preservedSegment: preserved },
  } as any
}

describe('stripStaleUsageFromPreservedSegment', () => {
  test('returns messages as-is when there is no compact boundary', () => {
    const msgs = [assistantWithUsage('a1', 5000)]
    const result = stripStaleUsageFromPreservedSegment(msgs)
    expect(result).toBe(msgs)
    expect(getCurrentUsage(result)?.input_tokens).toBe(5000)
  })

  test('returns messages as-is when boundary has no preservedSegment', () => {
    const boundary = { type: 'system', uuid: 'b', subtype: 'compact_boundary', compactMetadata: {} } as any
    const msgs = [boundary, assistantWithUsage('a1', 5000)]
    const result = stripStaleUsageFromPreservedSegment(msgs)
    expect(getCurrentUsage(result)?.input_tokens).toBe(5000)
  })

  test('strips stale usage from preserved segment, leaving fresh summary usage', () => {
    // Post-compact layout:
    //   [boundary, summary(fresh 1000), keptHead(stale 8000), keptTail(stale 9000)]
    const boundary = compactBoundary('b1', { headUuid: 'k1', tailUuid: 'k2', anchorUuid: 's1' })
    const summary = assistantWithUsage('s1', 1000)      // fresh — compact response
    const keptHead = assistantWithUsage('k1', 8000)     // stale — pre-compact
    const keptTail = assistantWithUsage('k2', 9000)      // stale — pre-compact
    const msgs = [boundary, summary, keptHead, keptTail]

    // Before fix: getCurrentUsage returns 9000 (stale, from keptTail)
    expect(getCurrentUsage(msgs)?.input_tokens).toBe(9000)

    // After fix: stale usage stripped from k1/k2, falls back to summary (1000)
    const result = stripStaleUsageFromPreservedSegment(msgs)
    expect(getCurrentUsage(result)?.input_tokens).toBe(1000)
  })

  test('prefers fresh new-turn usage over summary when present after compact', () => {
    const boundary = compactBoundary('b1', { headUuid: 'k1', tailUuid: 'k1', anchorUuid: 's1' })
    const summary = assistantWithUsage('s1', 1000)
    const kept = assistantWithUsage('k1', 8000)         // stale
    const newTurn = assistantWithUsage('n1', 1200)       // fresh — post-compact turn
    const msgs = [boundary, summary, kept, newTurn]

    const result = stripStaleUsageFromPreservedSegment(msgs)
    // newTurn is after the preserved segment and should keep its usage
    expect(getCurrentUsage(result)?.input_tokens).toBe(1200)
  })

  test('returns null usage when no fresh usage-bearing message exists', () => {
    const boundary = compactBoundary('b1', { headUuid: 'k1', tailUuid: 'k1', anchorUuid: 's1' })
    // No summary usage; only a stale kept message
    const kept = assistantWithUsage('k1', 8000)
    const msgs = [boundary, kept]

    const result = stripStaleUsageFromPreservedSegment(msgs)
    expect(getCurrentUsage(result)).toBeNull()
  })

  test('does not mutate the original messages array', () => {
    const boundary = compactBoundary('b1', { headUuid: 'k1', tailUuid: 'k1', anchorUuid: 's1' })
    const summary = assistantWithUsage('s1', 1000)
    const kept = assistantWithUsage('k1', 8000)
    const msgs = [boundary, summary, kept]

    const result = stripStaleUsageFromPreservedSegment(msgs)
    // Original kept message still has its stale usage
    expect(getCurrentUsage(msgs)?.input_tokens).toBe(8000)
    // Result has stripped usage
    expect(getCurrentUsage(result)?.input_tokens).toBe(1000)
    // Original array is not mutated
    expect(msgs[2]).toBe(kept)
    expect(kept.message.usage.input_tokens).toBe(8000)
  })
})
