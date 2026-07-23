import { describe, expect, test } from 'bun:test'
import {
  isMalformedAttachment,
  safeStringArray,
  reconstructAnnouncedAgentTypes,
} from '../attachments.js'
import { normalizeAttachmentForAPI } from '../messages.js'
import type { Message } from '../../types/message.js'

// CC 2.1.217 #10: --resume / --continue / /resume failed with a TypeError
// when a transcript held a malformed attachment entry. The fix skips/validates
// such entries instead of crashing.
//
// CC 2.1.218 #25: a resumed session failed every turn when its history held a
// malformed *delta* attachment (deferred_tools_delta / agent_listing_delta /
// mcp_instructions_delta). The per-turn API-prep path must skip malformed deltas.

describe('isMalformedAttachment', () => {
  test('flags null, undefined, non-objects, and entries with no string type', () => {
    expect(isMalformedAttachment(null)).toBe(true)
    expect(isMalformedAttachment(undefined)).toBe(true)
    expect(isMalformedAttachment('agent_listing_delta')).toBe(true)
    expect(isMalformedAttachment({})).toBe(true)
    expect(isMalformedAttachment({ type: 123 })).toBe(true)
    expect(isMalformedAttachment({ type: null })).toBe(true)
  })

  test('passes well-formed attachment-shaped objects', () => {
    expect(isMalformedAttachment({ type: 'todo_reminder' })).toBe(false)
    expect(
      isMalformedAttachment({
        type: 'agent_listing_delta',
        addedTypes: ['x'],
      }),
    ).toBe(false)
  })
})

describe('safeStringArray', () => {
  test('returns the array untouched for real arrays', () => {
    expect(safeStringArray(['a', 'b'])).toEqual(['a', 'b'])
    expect(safeStringArray([])).toEqual([])
  })

  test('returns [] for non-arrays (malformed delta fields)', () => {
    expect(safeStringArray(undefined)).toEqual([])
    expect(safeStringArray(null)).toEqual([])
    expect(safeStringArray('x')).toEqual([])
    expect(safeStringArray({ length: 2 })).toEqual([])
  })
})

function attachmentMessage(att: Record<string, unknown>): Message {
  return {
    type: 'attachment',
    attachment: att as never,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

describe('reconstructAnnouncedAgentTypes — malformed delta in history (CC 2.1.218 #25)', () => {
  test('does not throw when an agent_listing_delta lacks addedTypes/removedTypes', () => {
    const messages: Message[] = [
      attachmentMessage({ type: 'agent_listing_delta' }), // malformed: no arrays
      attachmentMessage({
        type: 'agent_listing_delta',
        addedTypes: ['researcher'],
        removedTypes: ['old-one'],
      }),
    ]
    const announced = reconstructAnnouncedAgentTypes(messages)
    expect(announced.has('researcher')).toBe(true)
    expect(announced.has('old-one')).toBe(false)
  })

  test('skips non-delta and malformed entries silently', () => {
    const messages: Message[] = [
      attachmentMessage({ type: 'todo_reminder', content: [] }),
      attachmentMessage({}), // malformed: no type
      attachmentMessage({ type: 'agent_listing_delta', addedTypes: 'nope' }), // malformed arrays
    ]
    expect(() => reconstructAnnouncedAgentTypes(messages)).not.toThrow()
    expect(reconstructAnnouncedAgentTypes(messages).size).toBe(0)
  })
})

describe('normalizeAttachmentForAPI — malformed entry resilience', () => {
  test('returns [] for a null / non-object / typeless attachment (no TypeError)', () => {
    // @ts-expect-error — deliberately malformed transcript entry
    expect(normalizeAttachmentForAPI(null)).toEqual([])
    // @ts-expect-error
    expect(normalizeAttachmentForAPI(undefined)).toEqual([])
    // @ts-expect-error
    expect(normalizeAttachmentForAPI({})).toEqual([])
    // @ts-expect-error
    expect(normalizeAttachmentForAPI({ type: 42 })).toEqual([])
  })

  test('returns [] for a malformed delta attachment (missing arrays) instead of throwing', () => {
    // @ts-expect-error — malformed delta (type present, arrays absent)
    expect(normalizeAttachmentForAPI({ type: 'agent_listing_delta' })).toEqual(
      [],
    )
    // @ts-expect-error
    expect(normalizeAttachmentForAPI({ type: 'deferred_tools_delta' })).toEqual(
      [],
    )
    // @ts-expect-error
    expect(normalizeAttachmentForAPI({ type: 'mcp_instructions_delta' })).toEqual(
      [],
    )
  })
})
