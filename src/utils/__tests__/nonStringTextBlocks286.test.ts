import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AssistantMessage, Message } from '../../types/message.js'

/**
 * CC 2.1.286 changelog: "Fixed API 400 errors after a tool or hook returned
 * an object, number or boolean instead of text, including in resumed
 * sessions."
 *
 * Official v286 (byte-identical logic in v285 — OCC was behind both):
 * - merge predicate rze (@208036567 in v286 / O2e @206887033 in v285):
 *   text blocks with non-string .text are filtered out of
 *   mergeAssistantMessages with a per-block warn tagged with the FIRST
 *   merged message's id.
 * - deserialize sanitizer SVo (@207008961 in v286 / v4o @205815035 in v285):
 *   on resume, non-string text blocks are stripped from assistant/user rows
 *   BEFORE the site:"resume" sanitize; rows whose content becomes empty are
 *   dropped entirely and one aggregated warn reports the count.
 */

// OCC-97: Bun's mock.module leaks across test files in the same worker.
// Spread the real module, override only logForDebugging, and restore after.
const actualDebug = await import('../debug.js')
const logCalls: string[] = []

mock.module('../debug.js', () => ({
  ...actualDebug,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    logCalls.push(`${opts?.level ?? 'debug'}:${message}`)
  },
}))

const { mergeAssistantMessages } = await import('../messages.js')
const { deserializeMessages } = await import('../conversationRecovery.js')

afterAll(() => {
  mock.module('../debug.js', () => ({ ...actualDebug }))
})

beforeEach(() => {
  logCalls.length = 0
})

function makeAssistant(
  id: string,
  uuid: string,
  content: unknown[],
): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: new Date().toISOString(),
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-test-model',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    costUSD: 0,
    durationMs: 0,
    isSidechain: false,
  } as unknown as AssistantMessage
}

function makeUser(uuid: string, content: unknown[]): Message {
  return {
    type: 'user',
    uuid,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content },
    isSidechain: false,
  } as unknown as Message
}

const MERGE_WARN = (id: string): string =>
  `warn:mergeAssistantMessages: text block with non-string .text (id=${id}) — dropped`

describe('CC 2.1.286 — mergeAssistantMessages non-string text-block guard', () => {
  test('drops object/number/boolean .text blocks and keeps string blocks', () => {
    const a = makeAssistant('msg_A', 'uuid-a', [
      { type: 'text', text: 'hello' },
      { type: 'text', text: { hookOutput: true } },
      { type: 'text', text: 42 },
    ])
    const b = makeAssistant('msg_B', 'uuid-b', [
      { type: 'text', text: true },
      { type: 'text', text: 'world' },
    ])

    const merged = mergeAssistantMessages(a, b)

    expect(merged.message.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ])
  })

  test('warns once per dropped block with the FIRST message id', () => {
    const a = makeAssistant('msg_A', 'uuid-a', [
      { type: 'text', text: 'kept' },
      { type: 'text', text: { obj: 1 } },
      { type: 'text', text: 7 },
    ])
    const b = makeAssistant('msg_B', 'uuid-b', [
      { type: 'text', text: false },
      { type: 'text', text: 'kept too' },
    ])

    mergeAssistantMessages(a, b)

    const mergeWarns = logCalls.filter(m =>
      m.startsWith('warn:mergeAssistantMessages:'),
    )
    expect(mergeWarns).toEqual([MERGE_WARN('msg_A'), MERGE_WARN('msg_A'), MERGE_WARN('msg_A')])
  })

  test('non-text blocks and empty-string text survive the merge', () => {
    const toolUse = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: { command: 'echo hi' },
    }
    const thinking = { type: 'thinking', thinking: 'pondering', signature: 'sig' }
    const a = makeAssistant('msg_A', 'uuid-a', [toolUse, { type: 'text', text: '' }])
    const b = makeAssistant('msg_B', 'uuid-b', [thinking])

    const merged = mergeAssistantMessages(a, b)

    expect(merged.message.content).toEqual([toolUse, { type: 'text', text: '' }, thinking])
    expect(logCalls.filter(m => m.startsWith('warn:mergeAssistantMessages:'))).toEqual([])
  })

  test('string-only content merges unchanged (regression)', () => {
    const a = makeAssistant('msg_A', 'uuid-a', [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])
    const b = makeAssistant('msg_B', 'uuid-b', [{ type: 'text', text: 'three' }])

    const merged = mergeAssistantMessages(a, b)

    expect(merged.message.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
    ])
    expect(logCalls).toEqual([])
  })
})

describe('CC 2.1.286 — deserializeMessages non-string text-block drop (resumed sessions)', () => {
  test('strips non-string text blocks and drops emptied messages, with one aggregated warn', () => {
    const assistant = makeAssistant('msg_r1', 'r-assistant-1', [
      { type: 'text', text: 'kept on resume' },
      { type: 'text', text: { partial: 'object' } },
    ])
    const user = makeUser('r-user-1', [{ type: 'text', text: 12345 }])

    const out = deserializeMessages([assistant, user] as Message[])

    const restored = out.find(m => (m as { uuid?: string }).uuid === 'r-assistant-1')
    expect(restored).toBeDefined()
    expect(
      (restored as { message: { content: unknown[] } }).message.content,
    ).toEqual([{ type: 'text', text: 'kept on resume' }])

    // The user row's content emptied out — the whole message is dropped.
    expect(out.find(m => (m as { uuid?: string }).uuid === 'r-user-1')).toBeUndefined()

    expect(logCalls).toContain(
      'warn:deserializeMessages: dropped non-string text block(s) from 2 message(s) — interrupted-stream artifact',
    )
  })

  test('all-string transcripts pass through with no drop warn (regression)', () => {
    const assistant = makeAssistant('msg_r2', 'r-assistant-2', [
      { type: 'text', text: 'clean' },
    ])
    const user = makeUser('r-user-2', [{ type: 'text', text: 'also clean' }])

    const out = deserializeMessages([assistant, user] as Message[])

    expect(out.find(m => (m as { uuid?: string }).uuid === 'r-assistant-2')).toBeDefined()
    expect(out.find(m => (m as { uuid?: string }).uuid === 'r-user-2')).toBeDefined()
    expect(
      logCalls.filter(m => m.includes('dropped non-string text block(s)')),
    ).toEqual([])
  })

  test('non-assistant/user rows are untouched by the drop pass', () => {
    const attachment = {
      type: 'attachment',
      uuid: 'r-attach-1',
      timestamp: new Date().toISOString(),
      attachment: { type: 'new_file', filename: '/some/file.ts' },
    } as unknown as Message

    const out = deserializeMessages([attachment])

    expect(out.find(m => (m as { uuid?: string }).uuid === 'r-attach-1')).toBeDefined()
    expect(
      logCalls.filter(m => m.includes('dropped non-string text block(s)')),
    ).toEqual([])
  })
})
