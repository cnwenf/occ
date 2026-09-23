import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import {
  buildInProgressToolResultMessage,
  IN_PROGRESS_TOOL_RESULT_PLACEHOLDER,
  stripInProgressAssistantMessage,
} from '../../src/commands/btw/btw.js'
import { SYNTHETIC_MODEL } from '../../src/utils/messages.js'
import type { Message } from '../../src/types/message.js'

/**
 * CC 2.1.280 changelog #072 — /btw: a dangling tool_use in the forked
 * context becomes an in-progress placeholder, not a failed one.
 *
 * Binary evidence (v280; all markers 0 hits in v278):
 *  - placeholder const k @212513086 (btw chunk):
 *    "[No result yet — this call is still in progress in the main
 *    conversation (running, awaiting approval, or queued)]"
 *  - synthesizer x() @212516927: filter !tv → findLast assistant → collect
 *    tool_result ids (all user messages) and tool_use ids (assistants whose
 *    message.id === last.message.id) → dangling → Ae({content:[tool_result
 *    blocks with content k], isMeta:!0}); no is_error anywhere.
 *  - runner p2n/wDt @212603046: strip trailing streaming assistant only
 *    when the turn is in progress (`a=o&&...stop_reason===null`,
 *    `let u=p?.()??!0`).
 */

function userMsg(content: unknown): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content },
  } as Message
}

function assistantMsg(
  id: string,
  blocks: unknown[],
  extra: Record<string, unknown> = {},
  messageExtra: Record<string, unknown> = {},
): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      id,
      role: 'assistant',
      model: 'claude-test',
      stop_reason: null,
      content: blocks,
      ...messageExtra,
    },
    ...extra,
  } as Message
}

function toolUse(id: string, name = 'Bash'): unknown {
  return { type: 'tool_use', id, name, input: {} }
}

function toolResult(toolUseId: string, content = 'ok'): unknown {
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

describe('IN_PROGRESS_TOOL_RESULT_PLACEHOLDER (byte-copy of official k @212513086)', () => {
  test('exact string with em dash', () => {
    expect(IN_PROGRESS_TOOL_RESULT_PLACEHOLDER).toBe(
      '[No result yet — this call is still in progress in the main conversation (running, awaiting approval, or queued)]',
    )
  })
})

describe('buildInProgressToolResultMessage (port of official x @212516927)', () => {
  test('dangling tool_use in the last assistant turn → synthesized isMeta user message', () => {
    const messages: Message[] = [
      userMsg('run a command'),
      assistantMsg('msg_1', [toolUse('tu_1')]),
    ]
    const synthesized = buildInProgressToolResultMessage(messages)
    expect(synthesized).toBeDefined()
    expect(synthesized?.type).toBe('user')
    expect(synthesized?.isMeta).toBe(true)
    const content = synthesized?.message?.content
    expect(Array.isArray(content)).toBe(true)
    expect(content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: IN_PROGRESS_TOOL_RESULT_PLACEHOLDER,
      },
    ])
    // Critical: NO is_error flag — the call is in progress, not failed.
    const block = (content as Array<Record<string, unknown>>)[0]!
    expect('is_error' in block).toBe(false)
  })

  test('all tool_results present → undefined', () => {
    const messages: Message[] = [
      userMsg('run a command'),
      assistantMsg('msg_1', [toolUse('tu_1')]),
      userMsg([toolResult('tu_1')]),
    ]
    expect(buildInProgressToolResultMessage(messages)).toBeUndefined()
  })

  test('no assistant message → undefined', () => {
    expect(buildInProgressToolResultMessage([userMsg('hi')])).toBeUndefined()
    expect(buildInProgressToolResultMessage([])).toBeUndefined()
  })

  test('partial results → only the dangling ids are synthesized, in order', () => {
    // One API response split across per-block AssistantMessages sharing the
    // same message.id (OCC yields one message per content block) — the
    // official matches by message.id, so tu_2/tu_3 are both collected.
    const messages: Message[] = [
      assistantMsg('msg_1', [toolUse('tu_1')]),
      assistantMsg('msg_1', [toolUse('tu_2')]),
      assistantMsg('msg_1', [toolUse('tu_3')]),
      userMsg([toolResult('tu_1'), toolResult('tu_3')]),
    ]
    const synthesized = buildInProgressToolResultMessage(messages)
    expect(synthesized?.message?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_2',
        content: IN_PROGRESS_TOOL_RESULT_PLACEHOLDER,
      },
    ])
  })

  test('only the LAST assistant turn counts (earlier dangling turns ignored)', () => {
    // tu_old never got a result, but the official x() only collects tool_use
    // ids from assistants whose message.id matches the LAST assistant's —
    // earlier turns are not synthesized.
    const messages: Message[] = [
      assistantMsg('msg_1', [toolUse('tu_old')]),
      assistantMsg('msg_2', [{ type: 'text', text: 'done' }], {}, { stop_reason: 'end_turn' }),
    ]
    expect(buildInProgressToolResultMessage(messages)).toBeUndefined()
  })

  test('tv-filtered messages are invisible to the scan (virtual / api-error / system / progress)', () => {
    // A dangling tool_use inside a SYNTHETIC api-error assistant (official
    // R3: isApiErrorMessage===true && model===SYNTHETIC_MODEL) and inside a
    // virtual assistant (official C3: isVirtual===true) must not synthesize.
    const messages: Message[] = [
      userMsg('hi'),
      assistantMsg(
        'msg_err',
        [toolUse('tu_err')],
        { isApiErrorMessage: true },
        { model: SYNTHETIC_MODEL },
      ),
      assistantMsg('msg_v', [toolUse('tu_v')], { isVirtual: true }),
      { type: 'progress', uuid: randomUUID(), data: {} } as Message,
      {
        type: 'system',
        uuid: randomUUID(),
        subtype: 'api_error',
      } as Message,
    ]
    expect(buildInProgressToolResultMessage(messages)).toBeUndefined()
  })

  test('filtered noise after the dangling assistant does not hide it', () => {
    // A real dangling assistant followed by system/progress noise still
    // synthesizes (findLast skips filtered types).
    const messages: Message[] = [
      assistantMsg('msg_1', [toolUse('tu_1')]),
      { type: 'progress', uuid: randomUUID(), data: {} } as Message,
      { type: 'system', uuid: randomUUID(), subtype: 'api_error' } as Message,
    ]
    const synthesized = buildInProgressToolResultMessage(messages)
    expect(synthesized?.message?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: IN_PROGRESS_TOOL_RESULT_PLACEHOLDER,
      },
    ])
  })

  test('thinking_drop attachments are filtered', () => {
    const messages: Message[] = [
      assistantMsg('msg_1', [toolUse('tu_1')]),
      {
        type: 'attachment',
        uuid: randomUUID(),
        attachment: { type: 'thinking_drop' },
      } as Message,
      userMsg([toolResult('tu_1')]),
    ]
    expect(buildInProgressToolResultMessage(messages)).toBeUndefined()
  })
})

describe('stripInProgressAssistantMessage (port of official p2n @212603046)', () => {
  const streaming = assistantMsg('msg_1', [{ type: 'text', text: 'partial' }])
  const finished = assistantMsg('msg_2', [{ type: 'text', text: 'done' }], {}, { stop_reason: 'end_turn' })

  test('turn in progress (default true) → trailing streaming assistant is stripped', () => {
    const first = userMsg('hi')
    const messages: Message[] = [first, streaming]
    expect(stripInProgressAssistantMessage(messages)).toEqual([first])
    expect(stripInProgressAssistantMessage(messages, true)).toHaveLength(1)
  })

  test('turn NOT in progress → trailing streaming assistant is kept', () => {
    const messages: Message[] = [userMsg('hi'), streaming]
    const out = stripInProgressAssistantMessage(messages, false)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe(streaming)
  })

  test('finished assistant (stop_reason set) is never stripped', () => {
    const messages: Message[] = [userMsg('hi'), finished]
    expect(stripInProgressAssistantMessage(messages, true)).toHaveLength(2)
    expect(stripInProgressAssistantMessage(messages, false)).toHaveLength(2)
  })

  test('non-assistant tail is untouched', () => {
    const messages: Message[] = [userMsg('hi')]
    expect(stripInProgressAssistantMessage(messages, true)).toHaveLength(1)
  })

  test('returns a copy, never mutates the input array', () => {
    const messages: Message[] = [userMsg('hi'), streaming]
    const out = stripInProgressAssistantMessage(messages, false)
    expect(out).not.toBe(messages)
    expect(messages).toHaveLength(2)
  })
})
