import { describe, expect, test } from 'bun:test'
import { deserializeMessages } from '../conversationRecovery.js'
import type { Message, SerializedMessage } from '../../types/message.js'

/**
 * CC 2.1.217 #10 / 2.1.218 #25 wiring: a transcript can hold a malformed
 * attachment entry where `message.attachment` is not a well-formed object
 * with a string `type` (corrupted JSONL, partial write, old/unknown shape).
 * Before wiring the `isMalformedAttachment` guard into
 * `migrateLegacyAttachmentTypes`, accessing `.type`/`in` on a non-object
 * attachment threw a TypeError that crashed `--resume`/`/resume`.
 *
 * This test exercises the consumer wiring: `deserializeMessages` (which maps
 * `migrateLegacyAttachmentTypes` over the transcript) must not throw on a
 * malformed attachment entry.
 */
describe('CC 2.1.217 #10 wiring: malformed attachment guard in migrateLegacyAttachmentTypes', () => {
  test('a message whose attachment is null does not crash deserialize', () => {
    const malformed: SerializedMessage = {
      type: 'attachment',
      attachment: null as unknown as Record<string, unknown>,
      uuid: 'mal-null',
      timestamp: new Date().toISOString(),
    } as unknown as SerializedMessage

    // Must not throw; the malformed entry is skipped (returned as-is).
    // deserialize may append synthetic sentinels — we only assert no throw +
    // the original entry survives.
    const out = deserializeMessages([malformed] as Message[])
    const entry = out.find(m => (m as { uuid?: string }).uuid === 'mal-null')
    expect(entry).toBeDefined()
    expect((entry as { type: string }).type).toBe('attachment')
  })

  test('a message whose attachment has no type field does not crash', () => {
    const noType: SerializedMessage = {
      type: 'attachment',
      attachment: { filename: '/some/path' } as unknown as Record<string, unknown>,
      uuid: 'mal-notype',
      timestamp: new Date().toISOString(),
    } as unknown as SerializedMessage

    const out = deserializeMessages([noType] as Message[])
    const entry = out.find(m => (m as { uuid?: string }).uuid === 'mal-notype')
    expect(entry).toBeDefined()
  })

  test('a message whose attachment is a primitive string does not crash', () => {
    const primitive: SerializedMessage = {
      type: 'attachment',
      attachment: 'not-an-object' as unknown as Record<string, unknown>,
      uuid: 'mal-str',
      timestamp: new Date().toISOString(),
    } as unknown as SerializedMessage

    const out = deserializeMessages([primitive] as Message[])
    const entry = out.find(m => (m as { uuid?: string }).uuid === 'mal-str')
    expect(entry).toBeDefined()
  })

  test('a well-formed new_file attachment still migrates (guard is skip-only)', () => {
    const wellFormed: SerializedMessage = {
      type: 'attachment',
      attachment: {
        type: 'new_file',
        filename: '/some/file.ts',
      },
      uuid: 'wf-1',
      timestamp: new Date().toISOString(),
    } as unknown as SerializedMessage

    // deserialize appends synthetic sentinels after an attachment turn; we only
    // care that the migrated entry is present and migrated, not the head count.
    const out = deserializeMessages([wellFormed] as Message[])
    const migrated = out.find(
      m => (m as { uuid?: string }).uuid === 'wf-1',
    ) as unknown as { attachment: { type: string; displayPath?: string } } | undefined
    expect(migrated).toBeDefined()
    expect(migrated!.attachment.type).toBe('file')
    expect(migrated!.attachment.displayPath).toBeDefined()
  })
})
