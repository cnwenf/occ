/**
 * CC 2.1.306 (#P7): subagent fallback model naming.
 *
 * Byte evidence (official linux-x64 ELFs, read-only):
 * - v304@254434741 (structured fallback yield):
 *   `yield{type:"query_model_change",toModel:ke},yield{type:"system",
 *    subtype:"model_fallback",content:pf(...),level:"warning",trigger:
 *    gt.reason,originalModel:gt.originalModel,fallbackModel:ke,isMeta:!1,
 *    timestamp:I.now(),uuid:I.uuid()}`
 * - v306@255040600 (`iu` scan): reverse walk, skip `isVirtual` /
 *   `isApiErrorMessage` assistants, track final model, bail on non-string or
 *   divergent assistant models, match `subtype==="model_fallback"` ∧
 *   `k4(n,s.fallbackModel)` ∧ `!k4(s.fallbackModel,s.originalModel)`.
 * - v306@241937594 (`k4`): `Wm(Dt(e))===Wm(Dt(n))` — normalized model
 *   equality (alias resolution + lowercase + canonicalization + `[1m]`
 *   suffix strip; `C1t` @240936550 re-appends the suffix to `Mt(qe(...))`
 *   output, proving the strip).
 * - v306@255043853 (finalize notice, official `smr`):
 *   `if(X)te.push({type:"text",text:`⚠ ${X.content}\n`});else if(ae.length>0
 *    ||(y?.length??0)>0){let Ce=iu(Q);if(Ce!==void 0)te.push({type:"text",
 *    text:`⚠ This agent switched to ${qo(Ce.fallbackModel)} because its
 *    earlier model could not be used.\n`})}` — harness notes `te` precede
 *   the report content (`At=[...te,...xe,...ke]`).
 *
 * OCC port: query.ts yields the structured pair; agentToolUtils.ts
 * `findAgentModelFallbackMessage` (iu) + `formatAgentModelFallbackNotice` +
 * finalizeAgentTool prepend.
 */
import { randomUUID } from 'crypto'
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import { createModelFallbackSystemMessage } from '../../../utils/messages.js'
import { renderModelName } from '../../../utils/model/model.js'

// agentToolUtils transitively reads MACRO.VERSION at call time (analytics +
// permission paths); mirror the cli.tsx polyfill before the dynamic import.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { findAgentModelFallbackMessage, formatAgentModelFallbackNotice, finalizeAgentTool } =
  await import('../agentToolUtils.js')

const MODEL_A = 'claude-sonnet-4-5'
const MODEL_B = 'claude-opus-5'

function makeAssistantMsg(
  model: string | undefined,
  text: string | undefined,
  extra: Record<string, unknown> = {},
): Message {
  const content: unknown[] = []
  if (text !== undefined) {
    content.push({ type: 'text', text })
  }
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model,
      content,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    uuid: randomUUID(),
    sessionId: 's',
    ...extra,
  } as unknown as Message
}

function makeFallbackMsg(originalModel: string, fallbackModel: string): Message {
  return {
    type: 'system',
    subtype: 'model_fallback',
    content: `Switched to ${fallbackModel} due to high demand for ${originalModel}`,
    level: 'warning',
    trigger: 'overloaded',
    originalModel,
    fallbackModel,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  } as unknown as Message
}

const METADATA = {
  prompt: 'do the thing',
  resolvedAgentModel: MODEL_A,
  isBuiltInAgent: false,
  startTime: 0,
  agentType: 'general-purpose',
  isAsync: false,
}

describe('CC 2.1.306 findAgentModelFallbackMessage (official iu)', () => {
  test('returns the fallback message when the final assistant model equals fallbackModel and differs from originalModel', () => {
    // Arrange
    const fallback = makeFallbackMsg(MODEL_A, MODEL_B)
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      fallback,
      makeAssistantMsg(MODEL_B, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBe(fallback)
  })

  test('matches under [1m] suffix normalization (official k4 strips suffixes)', () => {
    // Arrange — fallbackModel carries the [1m] suffix, API assistant model does not
    const fallback = makeFallbackMsg(MODEL_A, `${MODEL_B}[1m]`)
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      fallback,
      makeAssistantMsg(MODEL_B, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBe(fallback)
  })

  test('skips isVirtual and isApiErrorMessage assistant placeholders', () => {
    // Arrange — official: `if(s.type==="assistant"&&(s.isVirtual||s.isApiErrorMessage))continue`
    const fallback = makeFallbackMsg(MODEL_A, MODEL_B)
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      fallback,
      makeAssistantMsg(MODEL_B, 'done'),
      makeAssistantMsg(MODEL_A, undefined, { isApiErrorMessage: true }),
      makeAssistantMsg(MODEL_A, undefined, { isVirtual: true }),
    ]

    // Act + Assert — the trailing placeholders must not poison the final-model track
    expect(findAgentModelFallbackMessage(messages)).toBe(fallback)
  })

  test('returns undefined when fallbackModel equals originalModel (no real switch)', () => {
    // Arrange — official: `!k4(s.fallbackModel,s.originalModel)` gate
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeFallbackMsg(MODEL_A, `${MODEL_A}[1m]`),
      makeAssistantMsg(MODEL_A, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBeUndefined()
  })

  test('returns undefined when assistant models diverge from the final model', () => {
    // Arrange — official: `if(n??=y,!k4(y,n))return`
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeFallbackMsg(MODEL_A, MODEL_B),
      makeAssistantMsg(MODEL_B, 'mid'),
      makeAssistantMsg(MODEL_A, 'ended back on A'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBeUndefined()
  })

  test('returns undefined when the final assistant model is not a string', () => {
    // Arrange — official: `if(typeof y!=="string")return`
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeFallbackMsg(MODEL_A, MODEL_B),
      makeAssistantMsg(undefined, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBeUndefined()
  })

  test('returns undefined when no model_fallback message exists', () => {
    // Arrange
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeAssistantMsg(MODEL_B, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBeUndefined()
  })

  test('scans past a non-matching fallback message to an earlier matching one', () => {
    // Arrange — the newest fallback is a no-op (same model); the scan must
    // continue and match the earlier A→B switch that produced the final model.
    const earlier = makeFallbackMsg(MODEL_A, MODEL_B)
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      earlier,
      makeAssistantMsg(MODEL_B, 'mid'),
      makeFallbackMsg(MODEL_B, MODEL_B),
      makeAssistantMsg(MODEL_B, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBe(earlier)
  })

  test('returns undefined for an empty message list', () => {
    expect(findAgentModelFallbackMessage([])).toBeUndefined()
  })
})

describe('CC 2.1.306 formatAgentModelFallbackNotice (verbatim official text)', () => {
  test('embeds renderModelName(fallbackModel) in the official sentence', () => {
    expect(formatAgentModelFallbackNotice(MODEL_B)).toBe(
      `⚠ This agent switched to ${renderModelName(MODEL_B)} because its earlier model could not be used.\n`,
    )
  })
})

describe('CC 2.1.306 finalizeAgentTool harness notice emission', () => {
  test('prepends the notice when the agent ended on a fallback model with real output', () => {
    // Arrange
    const agentMessages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeFallbackMsg(MODEL_A, MODEL_B),
      makeAssistantMsg(MODEL_B, 'done report'),
    ]

    // Act
    const result = finalizeAgentTool(agentMessages, 'agent-id', METADATA)

    // Assert — official pushes the notice into harness notes BEFORE the
    // report content (`At=[...te,...xe,...ke]`).
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `⚠ This agent switched to ${renderModelName(MODEL_B)} because its earlier model could not be used.\n`,
    })
    expect(result.content[1]).toEqual({ type: 'text', text: 'done report' })
  })

  test('no notice when there was no model fallback', () => {
    // Arrange
    const agentMessages = [makeAssistantMsg(MODEL_A, 'plain report')]

    // Act
    const result = finalizeAgentTool(agentMessages, 'agent-id', METADATA)

    // Assert
    expect(result.content).toEqual([{ type: 'text', text: 'plain report' }])
  })

  test('no notice when fallbackModel equals originalModel', () => {
    // Arrange
    const agentMessages = [
      makeAssistantMsg(MODEL_A, 'working'),
      makeFallbackMsg(MODEL_A, MODEL_A),
      makeAssistantMsg(MODEL_A, 'done report'),
    ]

    // Act
    const result = finalizeAgentTool(agentMessages, 'agent-id', METADATA)

    // Assert
    expect(result.content).toEqual([{ type: 'text', text: 'done report' }])
  })

  test('no notice when the agent produced no text output (official ae.length>0 gate)', () => {
    // Arrange — final assistant message is pure tool_use, no text anywhere
    const toolUseOnly = {
      type: 'assistant',
      message: {
        role: 'assistant',
        model: MODEL_B,
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      uuid: randomUUID(),
      sessionId: 's',
    } as unknown as Message
    const agentMessages = [
      makeAssistantMsg(MODEL_A, undefined),
      makeFallbackMsg(MODEL_A, MODEL_B),
      toolUseOnly,
    ]

    // Act
    const result = finalizeAgentTool(agentMessages, 'agent-id', METADATA)

    // Assert
    expect(result.content).toHaveLength(0)
  })
})

describe('CC 2.1.306 createModelFallbackSystemMessage factory (official v304@254434741 shape)', () => {
  test('produces the structured system message with official field values and order', () => {
    // Act
    const message = createModelFallbackSystemMessage({
      content: 'Switched to opus due to high demand for sonnet',
      trigger: 'overloaded',
      originalModel: MODEL_A,
      fallbackModel: MODEL_B,
    })

    // Assert — field order mirrors the official object literal
    expect(Object.keys(message)).toEqual([
      'type',
      'subtype',
      'content',
      'level',
      'trigger',
      'originalModel',
      'fallbackModel',
      'isMeta',
      'timestamp',
      'uuid',
    ])
    expect(message.type).toBe('system')
    expect(message.subtype).toBe('model_fallback')
    expect(message.level).toBe('warning')
    expect(message.trigger).toBe('overloaded')
    expect(message.originalModel).toBe(MODEL_A)
    expect(message.fallbackModel).toBe(MODEL_B)
    expect(message.isMeta).toBe(false)
    expect(typeof message.timestamp).toBe('string')
    expect(typeof message.uuid).toBe('string')
  })

  test('the produced message is matched by findAgentModelFallbackMessage', () => {
    // Arrange — end-to-end: factory output flows through the iu scan
    const message = createModelFallbackSystemMessage({
      content: 'Switched to opus due to high demand for sonnet',
      trigger: 'overloaded',
      originalModel: MODEL_A,
      fallbackModel: MODEL_B,
    })
    const messages = [
      makeAssistantMsg(MODEL_A, 'working'),
      message as unknown as Message,
      makeAssistantMsg(MODEL_B, 'done'),
    ]

    // Act + Assert
    expect(findAgentModelFallbackMessage(messages)).toBe(message)
  })
})
