import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { tokenCountWithEstimation } from '../tokens.js'

/**
 * Gap-288 #9 (official v2.1.288 `Nwt`/`HO`/`Fwt`/`Am`/`Dpe` cluster).
 *
 * Official v288 walk-back SKIPS assistant messages whose token usage sums to
 * zero (input + cache_creation + cache_read === 0, official `Nwt`) and keeps
 * walking to the last message with REAL usage. The anchor finder `Fwt` also
 * added a compact-boundary case returning {tokens:0, anchorIndex}.
 *
 * OCC bug being fixed: `tokenCountWithEstimation` was presence-only — it
 * stopped at the first message that merely HAD a `usage` object. A zero-usage
 * reply (e.g. a server-side tool-loop turn that reports 0 top-level tokens)
 * yielded 0, so `shouldAutoCompact` skipped and the NEXT request hit
 * "Prompt is too long".
 *
 * Symbol map (official → OCC):
 *   s7n  = sumInputTokens            Dpe = normalizeUsage
 *   ca   = isSkippedIterationType    pa  = isValidUsageIteration
 *   Ax   = getTokenCountFromUsageNormalized   Nwt = isZeroTokenUsage
 *   Fwt  = findTokenAnchor           Am  = tokenCountWithEstimation
 *   ii   = isCompactBoundaryMessage  fj  = getTokenUsage   ane = getAssistantMessageId
 */

const NON_SYNTHETIC_MODEL = 'claude-sonnet-4-6'

let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

type UsageFixture = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  iterations?: unknown[]
}

function makeAssistant(
  id: string,
  usage: UsageFixture,
  content: unknown[] = [],
): Message {
  return {
    type: 'assistant',
    uuid: nextUuid(),
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: NON_SYNTHETIC_MODEL,
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
  } as unknown as Message
}

function makeUser(content: string): Message {
  return {
    type: 'user',
    uuid: nextUuid(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  } as unknown as Message
}

function makeCompactBoundary(): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: nextUuid(),
    timestamp: new Date().toISOString(),
    compactMetadata: {},
    message: { role: 'system', content: [] },
  } as unknown as Message
}

describe('Gap-288 #9 — zero-usage walk-back (official Nwt/Fwt/Am)', () => {
  test('a zero-usage last assistant is skipped; the walk-back anchors on the prior real-usage message', () => {
    // Arrange: a real 5k-token turn, then a zero-input-usage reply.
    const messages: Message[] = [
      makeUser('hello there, this is some prompt text to estimate'),
      makeAssistant('resp-A', {
        input_tokens: 5000,
        output_tokens: 100,
      }),
      makeUser('a tool result interleaved after the real turn'),
      makeAssistant('resp-B', {
        // input + cache_creation + cache_read === 0 → official Nwt === true.
        input_tokens: 0,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]

    // Act
    const count = tokenCountWithEstimation(messages)

    // Assert: the anchor is resp-A (5000 + 100 = 5100) plus a tail estimate —
    // NOT the zero-usage resp-B (which the old presence-only walk-back took,
    // yielding just its 50 output tokens).
    expect(count).toBeGreaterThanOrEqual(5100)
  })

  test('an all-zero conversation yields 0 (no anchor, empty-content estimate)', () => {
    // Arrange: every assistant reports zero usage and carries no content.
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
      makeAssistant('resp-B', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ]

    // Act + Assert
    expect(tokenCountWithEstimation(messages)).toBe(0)
  })

  test('a trailing compact boundary anchors with 0 tokens', () => {
    // Arrange: a large real turn, then a compact boundary as the last row.
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 50_000,
        output_tokens: 500,
      }),
      makeCompactBoundary(),
    ]

    // Act + Assert: the boundary anchor discards the pre-boundary usage; only
    // messages AFTER the boundary are estimated (none here) → 0.
    expect(tokenCountWithEstimation(messages)).toBe(0)
  })

  test('a compact boundary discards pre-boundary usage but still estimates the tail', () => {
    // Arrange
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 50_000,
        output_tokens: 500,
      }),
      makeCompactBoundary(),
      makeUser('a short follow-up prompt after compaction'),
    ]

    // Act
    const count = tokenCountWithEstimation(messages)

    // Assert: the 50k pre-boundary turn is NOT counted; only the short tail.
    expect(count).toBeLessThan(5000)
    expect(count).toBeGreaterThan(0)
  })

  test('Dpe normalization: with a non-zero top-level sum, the last valid iteration wins', () => {
    // Arrange: server-side tool loop — top-level usage reports the FIRST turn
    // (1000), iterations carry every loop turn. Official `Dpe` reads iterations
    // ONLY when the top-level sum is non-zero (`s7n(n)===0||!Array.isArray(...)`
    // → return base), then takes the last non-skipped valid iteration:
    // `advisor_message`/`compaction` are skipped (official ca), the last valid
    // `message` iteration wins (official pa).
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 1000,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          {
            type: 'advisor_message',
            input_tokens: 9999,
            output_tokens: 9999,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          {
            type: 'message',
            input_tokens: 3000,
            output_tokens: 80,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      }),
    ]

    // Act
    const count = tokenCountWithEstimation(messages)

    // Assert: normalized usage = the iteration's 3000 + 80 = 3080 — NOT the
    // top-level 1000 + 10, and NOT the skipped advisor_message's 9999.
    expect(count).toBeGreaterThanOrEqual(3080)
    expect(count).toBeLessThan(9999)
  })

  test('Dpe guard: a ZERO top-level sum never reads iterations (the Nwt skip case)', () => {
    // Arrange: official Dpe returns the base zeros when s7n(base) === 0, even
    // with real iterations present — that message is exactly what Nwt flags and
    // Fwt walks past.
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          {
            type: 'message',
            input_tokens: 3000,
            output_tokens: 80,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      }),
    ]

    // Act + Assert: zero top-level → skipped → no anchor → empty estimate → 0.
    expect(tokenCountWithEstimation(messages)).toBe(0)
  })

  test('Dpe normalization: an all-zero iteration set fails pa and falls back to the top-level usage', () => {
    // Arrange: non-zero top-level (1000 + 50) with an all-zero `message`
    // iteration — pa requires a non-zero sum, so the candidate is rejected and
    // Dpe returns the base.
    const messages: Message[] = [
      makeAssistant('resp-A', {
        input_tokens: 1000,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        iterations: [
          {
            type: 'message',
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        ],
      }),
    ]

    // Act + Assert: falls back to base 1000 + 50 = 1050.
    expect(tokenCountWithEstimation(messages)).toBe(1050)
  })
})
