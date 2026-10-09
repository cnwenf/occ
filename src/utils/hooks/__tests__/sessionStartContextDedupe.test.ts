/**
 * SessionStart additionalContext resume dedupe (OCC-side fix) — unit tests.
 *
 * Covers both resume paths' shared logic (REPL.tsx resume + conversationRecovery
 * loadConversationForResume both call dedupeSessionStartHookMessages against the
 * restored transcript before pushing fresh SessionStart hook messages):
 *   - identical context already in the transcript → NOT re-injected;
 *   - changed/new context → still injected.
 */

import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  collectSessionStartContextFingerprints,
  dedupeSessionStartHookMessages,
  fingerprintSessionStartContext,
} from '../sessionStartContextDedupe.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeContextAttachmentMessage(
  content: string[],
  hookName = 'SessionStart',
): Message {
  return {
    type: 'attachment',
    attachment: {
      type: 'hook_additional_context',
      content,
      hookName,
      toolUseID: hookName,
      hookEvent: 'SessionStart',
    },
    uuid: `uuid-${content.join('-')}`,
    timestamp: '2026-10-10T00:00:00.000Z',
  } as unknown as Message
}

function makeOtherMessage(): Message {
  return {
    type: 'attachment',
    attachment: {
      type: 'hook_success',
      hookName: 'SessionStart',
      stdout: 'ran',
      stderr: '',
      exitCode: 0,
      toolUseID: 'SessionStart',
      hookEvent: 'SessionStart',
    },
    uuid: 'uuid-other',
    timestamp: '2026-10-10T00:00:00.000Z',
  } as unknown as Message
}

// ---------------------------------------------------------------------------
// fingerprintSessionStartContext
// ---------------------------------------------------------------------------

describe('fingerprintSessionStartContext', () => {
  test('is stable for identical hook identity + context', () => {
    // Act
    const a = fingerprintSessionStartContext('SessionStart', 'git status: clean')
    const b = fingerprintSessionStartContext('SessionStart', 'git status: clean')

    // Assert
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('differs when the context changes', () => {
    expect(fingerprintSessionStartContext('SessionStart', 'a')).not.toBe(
      fingerprintSessionStartContext('SessionStart', 'b'),
    )
  })

  test('differs when the hook identity changes', () => {
    expect(fingerprintSessionStartContext('SessionStart', 'a')).not.toBe(
      fingerprintSessionStartContext('Setup', 'a'),
    )
  })
})

// ---------------------------------------------------------------------------
// collectSessionStartContextFingerprints
// ---------------------------------------------------------------------------

describe('collectSessionStartContextFingerprints', () => {
  test('collects fingerprints from SessionStart context attachments only', () => {
    // Arrange
    const messages = [
      makeContextAttachmentMessage(['ctx-one', 'ctx-two']),
      makeOtherMessage(),
      makeContextAttachmentMessage(['ctx-three'], 'Setup'),
    ]

    // Act
    const fingerprints = collectSessionStartContextFingerprints(messages)

    // Assert — Setup attachment has hookEvent 'SessionStart' in the factory,
    // so all three entries are collected; the hook_success attachment is not.
    expect(fingerprints.size).toBe(3)
    expect(
      fingerprints.has(fingerprintSessionStartContext('SessionStart', 'ctx-one')),
    ).toBe(true)
    expect(fingerprints.has(fingerprintSessionStartContext('Setup', 'ctx-three'))).toBe(
      true,
    )
  })

  test('ignores non-attachment and malformed messages (restored-log data is untrusted)', () => {
    // Arrange
    const messages = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          hookEvent: 'SessionStart',
          hookName: 'SessionStart',
          content: ['ok', 42, null],
        },
      },
      { type: 'attachment', attachment: { type: 'hook_additional_context' } },
    ] as unknown as Message[]

    // Act
    const fingerprints = collectSessionStartContextFingerprints(messages)

    // Assert — malformed content arrays are skipped entirely
    expect(fingerprints.size).toBe(0)
  })

  test('returns an empty set for a transcript without SessionStart context', () => {
    expect(collectSessionStartContextFingerprints([]).size).toBe(0)
    expect(
      collectSessionStartContextFingerprints([makeOtherMessage()]).size,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// dedupeSessionStartHookMessages
// ---------------------------------------------------------------------------

describe('dedupeSessionStartHookMessages', () => {
  test('drops a fully duplicated context attachment (identical resume path)', () => {
    // Arrange — the restored transcript already carries the same context.
    const restored = [makeContextAttachmentMessage(['static project context'])]
    const fresh = [
      makeOtherMessage(),
      makeContextAttachmentMessage(['static project context']),
    ]

    // Act
    const deduped = dedupeSessionStartHookMessages(
      fresh as never,
      restored,
    )

    // Assert — only the non-context message survives
    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toBe(fresh[0])
  })

  test('keeps a changed context attachment (changed resume path)', () => {
    // Arrange
    const restored = [makeContextAttachmentMessage(['old context'])]
    const fresh = [makeContextAttachmentMessage(['new context'])]

    // Act
    const deduped = dedupeSessionStartHookMessages(fresh as never, restored)

    // Assert — same message object passes through untouched
    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toBe(fresh[0])
  })

  test('filters partially duplicated content entries into a new attachment message', () => {
    // Arrange
    const restored = [makeContextAttachmentMessage(['kept-before', 'dupe'])]
    const fresh = [makeContextAttachmentMessage(['dupe', 'brand-new'])]

    // Act
    const deduped = dedupeSessionStartHookMessages(fresh as never, restored)

    // Assert — new object, only the fresh entry, original untouched
    expect(deduped).toHaveLength(1)
    const attachment = (deduped[0] as unknown as {
      attachment: { content: string[] }
    }).attachment
    expect(attachment.content).toEqual(['brand-new'])
    const original = fresh[0] as unknown as {
      attachment: { content: string[] }
    }
    expect(original.attachment.content).toEqual(['dupe', 'brand-new'])
  })

  test('passes everything through when the restored transcript has no SessionStart context', () => {
    // Arrange
    const fresh = [
      makeOtherMessage(),
      makeContextAttachmentMessage(['anything']),
    ]

    // Act
    const deduped = dedupeSessionStartHookMessages(fresh as never, [])

    // Assert — identity of each element preserved
    expect(deduped).toHaveLength(2)
    expect(deduped[0]).toBe(fresh[0])
    expect(deduped[1]).toBe(fresh[1])
  })

  test('dedupes against contexts accumulated over multiple prior resumes', () => {
    // Arrange — two prior resume cycles each left their own attachment.
    const restored = [
      makeContextAttachmentMessage(['ctx-a']),
      makeContextAttachmentMessage(['ctx-b']),
    ]
    const fresh = [makeContextAttachmentMessage(['ctx-a', 'ctx-b', 'ctx-c'])]

    // Act
    const deduped = dedupeSessionStartHookMessages(fresh as never, restored)

    // Assert — only the genuinely new ctx-c is injected
    expect(deduped).toHaveLength(1)
    const attachment = (deduped[0] as unknown as {
      attachment: { content: string[] }
    }).attachment
    expect(attachment.content).toEqual(['ctx-c'])
  })

  test('does not mutate the inputs', () => {
    // Arrange
    const restored = [makeContextAttachmentMessage(['dupe'])]
    const fresh = [makeContextAttachmentMessage(['dupe'])]
    const freshCopy = [...fresh]

    // Act
    dedupeSessionStartHookMessages(fresh as never, restored)

    // Assert
    expect(fresh).toEqual(freshCopy)
    expect(restored).toHaveLength(1)
  })
})
