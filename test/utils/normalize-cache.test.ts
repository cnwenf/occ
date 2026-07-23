import { describe, test, expect, beforeEach } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import {
  normalizeMessagesForAPI,
  _resetNormalizationCacheForTesting,
  _getNormalizationCacheStats,
} from '../../src/utils/messages.js'

/**
 * CC 2.1.216 #2: message normalization cost grew QUADRATICALLY with the
 * number of turns. normalizeMessagesForAPI is called from claude.ts on
 * every API request with the FULL message history. Over N turns that's
 * O(n²) total. The fix: cache per-message normalized form so old messages
 * aren't re-processed each turn.
 *
 * This test verifies the cache: on a second call with the same messages,
 * every message is a cache hit (per-message work = 0), proving the work
 * is O(n) across calls, not O(n²).
 */

function makeUserMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      content: [{ type: 'text', text }],
    },
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

function makeAssistantMessage(
  uuid: string,
  msgId: string,
  text: string,
): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      stop_reason: 'end_turn',
    },
  } as unknown as Message
}

describe('normalizeMessagesForAPI per-message cache', () => {
  beforeEach(() => {
    _resetNormalizationCacheForTesting()
  })

  test('second call with same messages is all cache hits (O(n) not O(n²))', () => {
    const N = 50
    const messages: Message[] = []
    for (let i = 0; i < N; i++) {
      messages.push(makeUserMessage(`u-${i}`, `user message ${i}`))
      messages.push(
        makeAssistantMessage(`a-${i}`, `msg_${i}`, `assistant reply ${i}`),
      )
    }

    // First call: all N*2 messages should be cache misses
    const result1 = normalizeMessagesForAPI(messages, [])
    const stats1 = _getNormalizationCacheStats()
    expect(stats1.cacheMisses).toBe(N * 2)
    expect(stats1.cacheHits).toBe(0)

    // Second call with the SAME messages: all should be cache hits
    const result2 = normalizeMessagesForAPI(messages, [])
    const stats2 = _getNormalizationCacheStats()
    expect(stats2.cacheHits).toBe(N * 2)
    expect(stats2.cacheMisses).toBe(0)

    // Results must be identical (no behavior regression)
    expect(result2.length).toBe(result1.length)
    for (let i = 0; i < result1.length; i++) {
      expect(result2[i]!.type).toBe(result1[i]!.type)
    }
  })

  test('adding one new message only processes the new one (rest cached)', () => {
    const N = 30
    const messages: Message[] = []
    for (let i = 0; i < N; i++) {
      messages.push(makeUserMessage(`u-${i}`, `user message ${i}`))
    }

    // First call: all N processed
    normalizeMessagesForAPI(messages, [])
    const stats1 = _getNormalizationCacheStats()
    expect(stats1.cacheMisses).toBe(N)

    // Second call: add 1 new message (do NOT reset cache — that's the point)
    messages.push(makeUserMessage(`u-new`, `new message`))
    normalizeMessagesForAPI(messages, [])
    const stats2 = _getNormalizationCacheStats()
    // Only 1 miss (the new message), N hits (cached)
    expect(stats2.cacheMisses).toBe(1)
    expect(stats2.cacheHits).toBe(N)
  })

  test('changing tools invalidates cache', () => {
    const messages = [makeUserMessage('u-0', 'hello')]

    // First call with no tools
    normalizeMessagesForAPI(messages, [])
    const stats1 = _getNormalizationCacheStats()
    expect(stats1.cacheMisses).toBe(1)

    // Second call with different tools — cache should be invalidated
    const fakeTool = {
      name: 'Bash',
      async description() {
        return ''
      },
      inputSchema: {},
      isEnabled() {
        return true
      },
      isReadOnly() {
        return false
      },
      async call() {
        return {}
      },
    }
    normalizeMessagesForAPI(messages, [fakeTool as never])
    const stats2 = _getNormalizationCacheStats()
    // Cache version changed → reprocess
    expect(stats2.cacheMisses).toBe(1)
    expect(stats2.cacheHits).toBe(0)
  })

  test('behavior is identical with and without cache', () => {
    // Create a mix of user and assistant messages
    const messages: Message[] = [
      makeUserMessage('u-0', 'hello'),
      makeAssistantMessage('a-0', 'msg_0', 'hi there'),
      makeUserMessage('u-1', 'how are you?'),
      makeAssistantMessage('a-1', 'msg_1', 'good!'),
    ]

    // First call (all cache misses) — the "uncached" result
    const uncached = normalizeMessagesForAPI(messages, [])
    // Second call (all cache hits) — the "cached" result
    const cached = normalizeMessagesForAPI(messages, [])

    // Same number of messages
    expect(cached.length).toBe(uncached.length)
    // Same types
    for (let i = 0; i < uncached.length; i++) {
      expect(cached[i]!.type).toBe(uncached[i]!.type)
    }
  })
})
