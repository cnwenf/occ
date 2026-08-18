import { afterAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'

// CC 2.1.234 content-block healing (binary zKn): non-string text blocks are
// dropped and malformed thinking blocks healed instead of crashing on
// `.trim()`. Capture telemetry via a mocked analytics module, then import the
// unit under test.

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []

const actualAnalytics =
  await import('src/services/analytics/index.js')

mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))

afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
})

const { normalizeContentFromAPI } = await import('../messages.js')

const META = { requestId: 'req-123', messageId: 'msg-456' }

function textBlock(text: unknown) {
  return { type: 'text', text } as never
}

function thinkingBlock(thinking: unknown, signature: unknown) {
  return { type: 'thinking', thinking, signature } as never
}

describe('normalizeContentFromAPI content-block healing (CC 2.1.234)', () => {
  test('drops a text block whose text is not a string (the crash case)', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [textBlock(undefined)],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([])
    const healed = events.find(e => e.name === 'tengu_content_block_healed')
    expect(healed).toBeDefined()
    expect(healed!.metadata.blockType).toBe('text')
    expect(healed!.metadata.action).toBe('dropped')
    expect(healed!.metadata.missingText).toBe(true)
    expect(healed!.metadata.request_id).toBe('req-123')
    expect(healed!.metadata.messageID).toBe('msg-456')
  })

  test('keeps a valid text block and does not emit healing telemetry', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [textBlock('hello')],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([{ type: 'text', text: 'hello' }])
    expect(events.find(e => e.name === 'tengu_content_block_healed')).toBeUndefined()
  })

  test('keeps a whitespace text block but reports it with request/message ids', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [textBlock('\n\n')],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([{ type: 'text', text: '\n\n' }])
    const ws = events.find(e => e.name === 'tengu_model_whitespace_response')
    expect(ws).toBeDefined()
    expect(ws!.metadata.length).toBe(2)
    expect(ws!.metadata.request_id).toBe('req-123')
    expect(ws!.metadata.messageID).toBe('msg-456')
  })

  test('defaults request/message ids to unknown when meta is absent', () => {
    events.length = 0
    normalizeContentFromAPI([textBlock(42)], [])
    const healed = events.find(e => e.name === 'tengu_content_block_healed')
    expect(healed!.metadata.request_id).toBe('unknown')
    expect(healed!.metadata.messageID).toBe('unknown')
  })

  test('keeps a valid thinking block untouched', () => {
    events.length = 0
    const block = thinkingBlock('reasoning', 'sig-1')
    const result = normalizeContentFromAPI([block], [], undefined, META)
    expect(result).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
    ])
    expect(events.find(e => e.name === 'tengu_content_block_healed')).toBeUndefined()
  })

  test('heals a thinking block missing signature and reports it', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [thinkingBlock('reasoning', undefined)],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: '' },
    ])
    const healed = events.find(e => e.name === 'tengu_content_block_healed')
    expect(healed!.metadata.blockType).toBe('thinking')
    expect(healed!.metadata.action).toBe('healed')
    expect(healed!.metadata.missingThinking).toBe(false)
    expect(healed!.metadata.missingSignature).toBe(true)
  })

  test('heals a thinking block missing both fields', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [thinkingBlock(undefined, undefined)],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([
      { type: 'thinking', thinking: '', signature: '' },
    ])
    const healed = events.find(e => e.name === 'tengu_content_block_healed')
    expect(healed!.metadata.missingThinking).toBe(true)
    expect(healed!.metadata.missingSignature).toBe(true)
  })

  test('survives a mixed block array that used to crash (regression)', () => {
    events.length = 0
    const result = normalizeContentFromAPI(
      [
        textBlock(undefined),
        textBlock('ok'),
        thinkingBlock('t', undefined),
      ],
      [],
      undefined,
      META,
    )
    expect(result).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'thinking', thinking: 't', signature: '' },
    ])
  })

  test('returns [] for missing content', () => {
    expect(normalizeContentFromAPI(undefined as never, [])).toEqual([])
  })
})
