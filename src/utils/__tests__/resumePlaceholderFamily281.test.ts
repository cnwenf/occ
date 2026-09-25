import { describe, expect, test } from 'bun:test'
import {
  CANCEL_MESSAGE,
  COPIED_SESSION_MESSAGE,
  createToolResultStopMessage,
  createUserInterruptionMessage,
  createUserMessage,
  createAssistantMessage,
  ensureToolResultPairing,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
  REJECT_MESSAGE,
  SESSION_ENDED_MESSAGE,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from '../messages.js'
import type { UserMessage, AssistantMessage } from '../../types/message.js'

/**
 * 2.1.281 alignment — PORT #015 resume placeholder family (kH/TH).
 *
 * Official v281 adds two resume placeholders (byte-verified from the linux-x64
 * ELF: constants @194405958, detection list `ee=[Ud,ok,kH,TH]` @194430158,
 * RESUME_TOLERATES_CONTEXT_APPENDS kH/TH exemption @203294880; v280 @191937283
 * had neither — 0→3 hits):
 *
 *   kH → SESSION_ENDED_MESSAGE  — the session ended before a dangling tool
 *                                 call's result was recorded.
 *   TH → COPIED_SESSION_MESSAGE — the call's result lives in the session this
 *                                 one was copied from, not here.
 *
 * Resume normalization must pair a transcript-tail dangling tool_use with the
 * *visible* kH placeholder (call+outcome the model can reason about) instead of
 * the generic internal-error filler. OCC has no session-copy/fork emitter, so TH
 * is defined + carried in the tolerance set now but never emitted yet.
 */

// Official `kH` — verbatim, byte-verified against the v281 ELF @194405958.
const OFFICIAL_KH =
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]"

// Official `TH` — verbatim, byte-verified against the v281 ELF @194406156.
const OFFICIAL_TH =
  "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. Check whether it took effect before relying on it or running it again.]"

/** A minimal assistant message carrying a single tool_use block. */
function assistantWithToolUse(id: string): AssistantMessage {
  return createAssistantMessage({
    content: [
      { type: 'tool_use', id, name: 'Bash', input: { command: 'echo hi' } },
    ] as never,
  })
}

/** Collect the tool_result blocks from a returned message (if it is a user). */
function toolResultBlocks(
  msg: UserMessage | AssistantMessage,
): Array<{ tool_use_id: string; content: unknown; is_error?: boolean }> {
  if (msg.type !== 'user' || !Array.isArray(msg.message.content)) return []
  return msg.message.content.flatMap(block =>
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'tool_result'
      ? [block as { tool_use_id: string; content: unknown; is_error?: boolean }]
      : [],
  )
}

describe('2.1.281 #015 — resume placeholder constant texts (byte-exact)', () => {
  test('SESSION_ENDED_MESSAGE matches official kH verbatim', () => {
    expect(SESSION_ENDED_MESSAGE).toBe(OFFICIAL_KH)
  })

  test('COPIED_SESSION_MESSAGE matches official TH verbatim', () => {
    expect(COPIED_SESSION_MESSAGE).toBe(OFFICIAL_TH)
  })

  test('kH and TH are distinct from each other and from the generic filler', () => {
    expect(SESSION_ENDED_MESSAGE).not.toBe(COPIED_SESSION_MESSAGE)
    expect(SESSION_ENDED_MESSAGE).not.toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(COPIED_SESSION_MESSAGE).not.toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
  })
})

describe('2.1.281 #015 — session-ended tail pairs dangling tool_use with kH', () => {
  test('transcript ending on an unmatched tool_use gets a kH synthetic tool_result', () => {
    // Arrange — a single assistant whose tool_use result was never recorded
    // (the session closed): the transcript literally ends here.
    const dangling = assistantWithToolUse('tu_session_end')

    // Act
    const result = ensureToolResultPairing([dangling])

    // Assert — a paired synthetic user tool_result was appended after the
    // assistant, carrying the visible kH placeholder (not the generic filler).
    expect(result).toHaveLength(2)
    expect(result[0]!.type).toBe('assistant')
    const synthetic = result[1]!
    const blocks = toolResultBlocks(synthetic)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tool_use_id).toBe('tu_session_end')
    expect(blocks[0]!.content).toBe(SESSION_ENDED_MESSAGE)
    expect(blocks[0]!.content).not.toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(blocks[0]!.is_error).toBe(true)
  })

  test('the dangling tool_use itself is preserved (call+outcome both visible)', () => {
    const dangling = assistantWithToolUse('tu_preserved')

    const result = ensureToolResultPairing([dangling])

    const assistantContent = result[0]!.message.content as Array<{
      type: string
      id?: string
    }>
    const toolUses = assistantContent.filter(b => b.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0]!.id).toBe('tu_preserved')
  })

  test('session-ended tail never emits the copied-session (TH) placeholder', () => {
    // OCC has no session-copy emitter; the tail case is always kH, never TH.
    const result = ensureToolResultPairing([assistantWithToolUse('tu_no_fork')])
    const blocks = toolResultBlocks(result[1]!)
    expect(blocks[0]!.content).not.toBe(COPIED_SESSION_MESSAGE)
  })
})

describe('2.1.281 #015 — mid-transcript gaps keep the generic filler (regression)', () => {
  test('a dangling tool_use followed by more messages uses SYNTHETIC_TOOL_RESULT_PLACEHOLDER, not kH', () => {
    // Arrange — the unmatched tool_use is NOT at the tail: a later user turn
    // exists, so this is an internal-error/compaction gap, not a session end.
    const dangling = assistantWithToolUse('tu_mid')
    const followingUser = createUserMessage({ content: 'hello' })
    const followingAssistant = createAssistantMessage({ content: 'hi there' })

    // Act
    const result = ensureToolResultPairing([
      dangling,
      followingUser,
      followingAssistant,
    ])

    // Assert — the synthetic tool_result prepended to the following user turn
    // keeps the generic placeholder; kH is reserved for the transcript tail.
    const patchedUser = result.find(
      m => m.type === 'user' && toolResultBlocks(m).length > 0,
    )!
    const blocks = toolResultBlocks(patchedUser)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tool_use_id).toBe('tu_mid')
    expect(blocks[0]!.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(blocks[0]!.content).not.toBe(SESSION_ENDED_MESSAGE)
  })
})

describe('2.1.281 #015 — placeholder tolerance list carries kH/TH', () => {
  test('SYNTHETIC_MESSAGES includes both new placeholders', () => {
    expect(SYNTHETIC_MESSAGES.has(SESSION_ENDED_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(COPIED_SESSION_MESSAGE)).toBe(true)
  })

  test('SYNTHETIC_MESSAGES still includes the pre-existing placeholder family', () => {
    expect(SYNTHETIC_MESSAGES.has(INTERRUPT_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(INTERRUPT_MESSAGE_FOR_TOOL_USE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(CANCEL_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(REJECT_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(NO_RESPONSE_REQUESTED)).toBe(true)
  })
})

describe('2.1.281 #015 — existing INTERRUPT/CANCEL/REJECT behavior unchanged', () => {
  test('placeholder constant values are untouched', () => {
    expect(INTERRUPT_MESSAGE).toBe('[Request interrupted by user]')
    expect(INTERRUPT_MESSAGE_FOR_TOOL_USE).toBe(
      '[Request interrupted by user for tool use]',
    )
  })

  test('createUserInterruptionMessage still selects the tool-use interrupt text', () => {
    const toolUse = createUserInterruptionMessage({ toolUse: true })
    const content = toolUse.message.content as Array<{ type: string; text: string }>
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toBe(INTERRUPT_MESSAGE_FOR_TOOL_USE)

    const plain = createUserInterruptionMessage({})
    const plainContent = plain.message.content as Array<{ type: string; text: string }>
    expect(plainContent[0]!.text).toBe(INTERRUPT_MESSAGE)
  })

  test('createToolResultStopMessage still emits CANCEL_MESSAGE as an errored tool_result', () => {
    const stop = createToolResultStopMessage('tu_stop')
    expect(stop.type).toBe('tool_result')
    expect(stop.tool_use_id).toBe('tu_stop')
    expect(stop.content).toBe(CANCEL_MESSAGE)
    expect(stop.is_error).toBe(true)
  })

  test('a properly paired transcript is left unchanged (no synthetic injected)', () => {
    const assistant = assistantWithToolUse('tu_paired')
    const userResult = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_paired',
          content: 'ok',
        },
      ] as never,
    })

    const result = ensureToolResultPairing([assistant, userResult])

    expect(result).toHaveLength(2)
    // No kH / generic filler injected — the real result is preserved.
    const blocks = toolResultBlocks(result[1]!)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.content).toBe('ok')
  })
})
