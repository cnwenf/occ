import { describe, test, expect, beforeEach } from 'bun:test'
import type { Message } from '../../src/types/message.js'
import {
  getCurrentUsage,
  getCachedContextUsage,
  _resetContextUsageCacheForTesting,
} from '../../src/utils/tokens.js'

/**
 * 2.1.203 perf fix: the context-usage indicator (StatusLine) must not
 * re-analyze the transcript after every turn. getCachedContextUsage caches
 * the usage read by (messageCount, lastAssistantMessageId) so refresh ticks
 * / mode changes that re-run the status line don't recompute when the
 * transcript is unchanged.
 */

function assistantWithUsage(
  uuid: string,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): Message {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant',
      // Non-synthetic model so getTokenUsage recognizes the usage block.
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  } as unknown as Message
}

describe('getCachedContextUsage — context-usage indicator memoization (2.1.203)', () => {
  beforeEach(() => {
    _resetContextUsageCacheForTesting()
  })

  test('returns the same value as getCurrentUsage (correctness)', () => {
    const messages = [assistantWithUsage('a1', { input_tokens: 100, output_tokens: 50 })]
    const direct = getCurrentUsage(messages)
    const cached = getCachedContextUsage(messages, 'a1')
    expect(cached).toEqual(direct)
    expect(cached?.input_tokens).toBe(100)
    expect(cached?.output_tokens).toBe(50)
  })

  test('does NOT recompute when the transcript is unchanged (same reference)', () => {
    const messages = [assistantWithUsage('a1', { input_tokens: 100, output_tokens: 50 })]
    const first = getCachedContextUsage(messages, 'a1')
    // A second call with an unchanged transcript (same count + last
    // assistant id) — e.g. a refresh-interval tick or a permission-mode
    // change re-running the status line — must return the cached object,
    // not a freshly recomputed one.
    const second = getCachedContextUsage(messages, 'a1')
    expect(second).toBe(first) // reference equality => memoized
  })

  test('recomputes when the transcript actually changes (new last assistant id)', () => {
    const messages1 = [assistantWithUsage('a1', { input_tokens: 100, output_tokens: 50 })]
    const first = getCachedContextUsage(messages1, 'a1')

    // New turn → new assistant message with different usage.
    const messages2 = [
      ...messages1,
      assistantWithUsage('a2', { input_tokens: 300, output_tokens: 80 }),
    ]
    const second = getCachedContextUsage(messages2, 'a2')
    expect(second).not.toBe(first) // new object => recomputed
    expect(second?.input_tokens).toBe(300)
  })

  test('recomputes when message count changes even if last assistant id is stable', () => {
    // After an assistant turn, tool_result / user messages are appended.
    // The last assistant id stays the same but the transcript grew, so the
    // cache key (count + last id) changes and we recompute.
    const base = [assistantWithUsage('a1', { input_tokens: 100, output_tokens: 50 })]
    const first = getCachedContextUsage(base, 'a1')

    const grown = [...base, { type: 'user', uuid: 'u1' } as unknown as Message]
    const second = getCachedContextUsage(grown, 'a1')
    expect(second).not.toBe(first) // count changed => recomputed
    // Value is identical (usage comes from the same last assistant msg),
    // but the point is we did not serve a stale cached object across a
    // genuinely different transcript shape.
    expect(second).toEqual(first)
  })

  test('returns null when there is no usage-bearing message', () => {
    const messages = [{ type: 'user', uuid: 'u1' } as unknown as Message]
    const result = getCachedContextUsage(messages, null)
    expect(result).toBeNull()
  })
})
