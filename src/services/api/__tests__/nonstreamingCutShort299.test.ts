// MACRO.VERSION polyfill must run before claude.ts is required
// (repo convention — see nonstreamingCapProduction288.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from 'src/types/message.js'
import {
  buildNonStreamingCutShortMessage,
  MAX_NON_STREAMING_TOKENS,
} from '../claude.js'

// Official Claude Code 2.1.299 (#125) — changelog: "Fixed replies cut off at
// the output token limit ending the turn silently, with no retry or error,
// after a request fell back to non-streaming mode." The fix is the official
// `QGn`/`ckn` pair: after yielding the non-streaming fallback assistant
// message, a max_tokens / model_context_window_exceeded stop yields a visible
// cut-short notice (the streaming path already had one).

function textOf(msg: AssistantMessage): string {
  const block = (msg.message.content as Array<{ type: string; text?: string }>)[0]
  return block?.type === 'text' ? (block.text ?? '') : ''
}

describe('buildNonStreamingCutShortMessage (2.1.299 #125)', () => {
  test('max_tokens stop below the non-streaming cap → visible notice with generic wording', () => {
    const requested = 32_000
    const notice = buildNonStreamingCutShortMessage(
      { stop_reason: 'max_tokens', usage: { output_tokens: requested } },
      requested,
    )
    expect(notice).toBeDefined()
    expect(notice?.isApiErrorMessage).toBe(true)
    expect(notice?.apiError).toBe('max_output_tokens')
    expect(textOf(notice!)).toContain(
      `Claude's response exceeded the ${requested} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
    )
  })

  test('max_tokens stop at/above the non-streaming cap → capped "cannot raise this limit" wording', () => {
    const requested = 128_000
    const notice = buildNonStreamingCutShortMessage(
      { stop_reason: 'max_tokens', usage: { output_tokens: MAX_NON_STREAMING_TOKENS } },
      requested,
    )
    expect(notice).toBeDefined()
    // Official: n = Math.min(requested, Gan) → the CAP is reported, and the
    // non-streaming variant explains CLAUDE_CODE_MAX_OUTPUT_TOKENS cannot help.
    expect(textOf(notice!)).toContain(
      `Claude's response exceeded the ${MAX_NON_STREAMING_TOKENS} output token maximum for a request sent without streaming. The CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable cannot raise this limit.`,
    )
    expect(textOf(notice!)).not.toContain('To configure this behavior')
  })

  test('requested exactly at the cap uses the non-streaming wording (official Bb >= Gan)', () => {
    const notice = buildNonStreamingCutShortMessage(
      { stop_reason: 'max_tokens' },
      MAX_NON_STREAMING_TOKENS,
    )
    expect(textOf(notice!)).toContain('for a request sent without streaming')
  })

  test('model_context_window_exceeded stop → context-window notice', () => {
    const notice = buildNonStreamingCutShortMessage(
      {
        stop_reason: 'model_context_window_exceeded',
        usage: { output_tokens: 1234 },
      },
      32_000,
    )
    expect(notice).toBeDefined()
    expect(notice?.apiError).toBe('max_output_tokens')
    expect(textOf(notice!)).toContain(
      'The model has reached its context window limit.',
    )
  })

  test('normal stop reasons yield NO notice (turn is not silently affected)', () => {
    for (const stopReason of ['end_turn', 'tool_use', 'stop_sequence', null]) {
      expect(
        buildNonStreamingCutShortMessage({ stop_reason: stopReason }, 32_000),
      ).toBeUndefined()
    }
  })

  test('missing usage does not throw (output_tokens defaults to 0)', () => {
    const notice = buildNonStreamingCutShortMessage(
      { stop_reason: 'model_context_window_exceeded' },
      8_000,
    )
    expect(notice).toBeDefined()
  })
})
