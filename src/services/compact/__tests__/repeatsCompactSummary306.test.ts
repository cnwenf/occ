import { describe, expect, test } from 'bun:test'
import type { TranscriptMessage } from '../../../types/logs.js'
import type { Message } from '../../../types/message.js'
import { createUserMessage } from '../../../utils/messages.js'
import { removeExtraFields } from '../../../utils/sessionStorage.js'
import {
  inputRepeatsCompactSummary,
  truncateHeadForPTLRetry,
} from '../compact.js'

/**
 * Official Claude Code 2.1.306 (#P10) — the `repeatsCompactSummary` mechanism.
 *
 * Official forensics: compact-summary user messages carry dual flags
 * `isCompactSummary` / `repeatsCompactSummary` (repeats = this summary
 * re-summarizes a PRIOR summary, i.e. the oldest original messages have been
 * squeezed out). Field counts are 14=14 across the v304/v306 binaries — the
 * flags predate v306; the v306 fix is a STRING-LESS in-place logic change
 * extending the flag to the cloud-session / teammate compaction paths.
 *
 * The official withholding predicate (v304@254166900 ↔ v306@255517600,
 * byte-identical) reads the flags verbatim:
 *   e.isCompactSummary===!0||e.repeatsCompactSummary===!0||can(s?.content)
 * OCC has no withholding surface ("conversation summary withheld" = 0 hits),
 * so no predicate is introduced here — only the flag, its setters, and the
 * copy/serialization passthrough.
 *
 * OCC scope note (documented deviation): recipe step ④ (cloud/teammate paths
 * attaching a `[harness: …]` meta notice) is NOT implemented — the official
 * carried-turn notice structure ("carried from the parent session" ×3,
 * "trimmed for length" ×4 in both binaries) does not exist anywhere in OCC
 * src; OCC's only `[harness:` string is the AgentTool subagent-output
 * sanitizer marker, an unrelated mechanism. Per the never-invent-text rule
 * the port is flag + setters + passthrough only.
 */

// ── fixtures ────────────────────────────────────────────────────────────────

const plainUser = (content: string) =>
  ({
    type: 'user',
    message: { role: 'user', content },
  }) as unknown as Message

const summaryUser = (flags: {
  isCompactSummary?: boolean
  repeatsCompactSummary?: boolean
}) =>
  ({
    type: 'user',
    message: { role: 'user', content: 'compact summary' },
    isCompactSummary: flags.isCompactSummary,
    repeatsCompactSummary: flags.repeatsCompactSummary,
  }) as unknown as Message

const assistant = (id: string, content = 'text') =>
  ({
    type: 'assistant',
    message: { role: 'assistant', id, content: [{ type: 'text', text: content }] },
  }) as unknown as Message

// Plain-text assistant → getPromptTooLongTokenGap cannot parse a token gap →
// truncateHeadForPTLRetry falls back to dropping 20% of the API-round groups.
const ptlResponse = assistant('ptl-resp')

// ── the detection primitive ─────────────────────────────────────────────────

describe('#P10 inputRepeatsCompactSummary — re-compaction detection', () => {
  test('true when the input already contains a prior isCompactSummary user message', () => {
    // Arrange
    const messages = [
      summaryUser({ isCompactSummary: true }),
      assistant('a1'),
      plainUser('next turn'),
    ]

    // Act / Assert
    expect(inputRepeatsCompactSummary(messages)).toBe(true)
  })

  test('true when the input contains a prior repeatsCompactSummary user message', () => {
    // Arrange — a repeat-of-a-repeat chain (flag set by an earlier compaction).
    const messages = [
      summaryUser({ isCompactSummary: true, repeatsCompactSummary: true }),
      assistant('a1'),
    ]

    // Act / Assert
    expect(inputRepeatsCompactSummary(messages)).toBe(true)
  })

  test('false for a plain conversation and for empty input', () => {
    // Arrange
    const messages = [plainUser('hello'), assistant('a1'), plainUser('more')]

    // Act / Assert
    expect(inputRepeatsCompactSummary(messages)).toBe(false)
    expect(inputRepeatsCompactSummary([])).toBe(false)
  })

  test('ignores the flags on non-user messages (official predicate gates on type==="user")', () => {
    // Arrange — flags only exist on user messages; a stray flag on an
    // assistant entry must not trigger the repeat marking.
    const messages = [
      { ...assistant('a1'), isCompactSummary: true } as unknown as Message,
    ]

    // Act / Assert
    expect(inputRepeatsCompactSummary(messages)).toBe(false)
  })
})

// ── flag passthrough: factory + serialization copy ──────────────────────────

describe('#P10 repeatsCompactSummary passthrough', () => {
  test('createUserMessage sets the flag alongside isCompactSummary when asked', () => {
    // Act
    const msg = createUserMessage({
      content: 'summary',
      isCompactSummary: true,
      repeatsCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    // Assert
    expect(msg.isCompactSummary).toBe(true)
    expect(msg.repeatsCompactSummary).toBe(true)
  })

  test('createUserMessage leaves the flag undefined when not asked (first compaction)', () => {
    // Act
    const msg = createUserMessage({
      content: 'summary',
      isCompactSummary: true,
    })

    // Assert
    expect(msg.isCompactSummary).toBe(true)
    expect(msg.repeatsCompactSummary).toBeUndefined()
  })

  test('removeExtraFields (JSONL serialization copy) preserves the flag and still strips parentUuid/promptId', () => {
    // Arrange
    const msg = createUserMessage({
      content: 'summary',
      isCompactSummary: true,
      repeatsCompactSummary: true,
      promptId: 'p-1',
    })
    const transcript = [
      { ...msg, parentUuid: 'u-0', isSidechain: false },
    ] as unknown as TranscriptMessage[]

    // Act
    const [serialized] = removeExtraFields(transcript)

    // Assert — blacklist destructure: the new field rides the rest spread.
    expect(serialized?.repeatsCompactSummary).toBe(true)
    expect(serialized?.isCompactSummary).toBe(true)
    expect('parentUuid' in (serialized ?? {})).toBe(false)
    expect('promptId' in (serialized ?? {})).toBe(false)
  })
})

// ── PTL head-truncation path (the ptlAttempts > 0 flag term) ────────────────

describe('#P10 PTL retry head truncation squeezes out the oldest messages', () => {
  test('truncation with NO prior summary drops the oldest group — the flag comes from the ptlAttempts term, not the message scan', () => {
    // Arrange — 6 API-round groups: [u0] [a1,u1] [a2,u2] [a3,u3] [a4,u4] [a5].
    const oldest = plainUser('OLDEST original message')
    const messages = [
      oldest,
      assistant('a1'),
      plainUser('u1'),
      assistant('a2'),
      plainUser('u2'),
      assistant('a3'),
      plainUser('u3'),
      assistant('a4'),
      plainUser('u4'),
      assistant('a5'),
    ]

    // Act
    const truncated = truncateHeadForPTLRetry(messages, ptlResponse)

    // Assert — 20% fallback drops group 0; the assistant-first remainder gets
    // the synthetic PTL_RETRY_MARKER user head. The input scan alone would
    // NOT flag this summary (false) — the inline `ptlAttempts > 0` term is
    // what marks it repeatsCompactSummary.
    expect(truncated).not.toBeNull()
    expect(truncated?.some(m => m === oldest)).toBe(false)
    expect(truncated?.[0]?.type).toBe('user')
    expect(truncated?.[0]?.isMeta).toBe(true)
    expect(inputRepeatsCompactSummary(messages)).toBe(false)
  })

  test('re-compaction input reports repeats BEFORE any truncation; truncation then squeezes the prior summary out entirely', () => {
    // Arrange — the conversation already starts with a compact summary
    // (second compaction of the same session).
    const priorSummary = summaryUser({ isCompactSummary: true })
    const messages = [
      priorSummary,
      assistant('a1'),
      plainUser('u1'),
      assistant('a2'),
      plainUser('u2'),
    ]

    // Act
    const truncated = truncateHeadForPTLRetry(messages, ptlResponse)

    // Assert — the re-compaction flag does not need truncation…
    expect(inputRepeatsCompactSummary(messages)).toBe(true)
    // …and when truncation DOES drop the prior summary, only the
    // ptlAttempts term can still flag the new summary.
    expect(truncated).not.toBeNull()
    expect(truncated?.some(m => m === priorSummary)).toBe(false)
    expect(inputRepeatsCompactSummary(truncated ?? [])).toBe(false)
  })
})
