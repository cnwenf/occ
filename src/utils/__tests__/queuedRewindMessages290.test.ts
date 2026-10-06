// Polyfill (repo convention — see structuredOutputIsError291.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { Message } from '../../types/message.js'
import {
  withQueuedPromptMessages,
  findQueuedCommandForMessage,
} from '../queuedRewindMessages.js'

/**
 * CC 2.1.290 (cluster-f item F, changelog-entries-290.txt:20) — "Fixed
 * `/rewind` not listing a prompt sent while Claude was still working."
 *
 * Official mechanism (recovered byte-verbatim from the 2.1.290/2.1.291
 * linux-x64 ELF; see docs/gap-research-291/cluster-f-session-durability.md §F):
 *   LMe(h)  @232117xxx — maps undelivered queued_command prompt attachment
 *           rows into virtual user messages IN PLACE; identity-returns the
 *           input array when nothing changed.
 *   Rln(e,o) @217805353 — attachment → {uuid: source_uuid || row uuid,
 *           content: prompt, isMeta, origin: b3(origin, commandMode)}.
 *   tU(e)   @204690011 — queued_command && n_(origin) && !verifiedSlackHumanTurn.
 *   n_(e)   @204689971 — e?.kind === "human" (official enqueue stamps
 *           origin:{kind:"human"} on keyboard prompts @232019514).
 *   nNe(h,he) @229151684 — tool_use/tool_result split guard (N/A for OCC:
 *           queued prompts synthesize at the END, never mid tool-pair).
 *   Content guard — Array content with a non-object/null block → skip.
 *   Dedup     — uuid already present among transcript user rows → skip.
 *
 * OCC adaptation: OCC keeps queued prompts in the module-level commandQueue
 * (messageQueueManager.ts), not transcript attachment rows — so the transform
 * APPENDS synthesized rows after the real messages (they are always newer),
 * and the human-origin check maps OCC's `undefined = human (keyboard)`
 * QueuedCommand convention onto the official `{kind:"human"}` stamp, with
 * `bridgeOrigin` excluded (OCC's structural marker for remote-sourced input,
 * which the official excludes via its strict n_ origin check).
 */

function baseFields(): Record<string, unknown> {
  return {
    uuid: randomUUID(),
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp',
    sessionId: 'test-session',
    version: '2.1.290',
    timestamp: '2026-10-07T00:00:00.000Z',
  }
}

function userTextRow(text: string, uuid?: string): Message {
  return {
    ...baseFields(),
    ...(uuid ? { uuid } : {}),
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as Message
}

function queuedPrompt(
  overrides: Partial<QueuedCommand> = {},
): QueuedCommand {
  return {
    value: 'do the thing while you work',
    mode: 'prompt',
    ...overrides,
  }
}

describe('CC 2.1.290 cluster-f F — withQueuedPromptMessages', () => {
  test('empty queue → identity (official LMe: N?H:h)', () => {
    const messages = [userTextRow('hello')]

    const result = withQueuedPromptMessages(messages, [])

    expect(result).toBe(messages)
  })

  test('no synthesizable entries → identity', () => {
    const messages = [userTextRow('hello')]

    const result = withQueuedPromptMessages(messages, [
      queuedPrompt({ mode: 'bash' }),
      queuedPrompt({ isMeta: true }),
    ])

    expect(result).toBe(messages)
  })

  test('keyboard-queued prompt (origin undefined) is appended as a user row', () => {
    const messages = [userTextRow('first'), userTextRow('second')]
    const cmd = queuedPrompt({ value: 'queued while working' })

    const result = withQueuedPromptMessages(messages, [cmd])

    expect(result).toHaveLength(3)
    // Real rows preserved by identity (immutable prefix).
    expect(result[0]).toBe(messages[0])
    expect(result[1]).toBe(messages[1])
    const synthesized = result[2]!
    expect(synthesized.type).toBe('user')
    expect(synthesized.message.content).toBe('queued while working')
    // Appended AFTER real messages — queued prompts are always newer.
    expect(result.indexOf(synthesized)).toBe(2)
  })

  test('cmd.uuid becomes the synthesized row uuid (official source_uuid)', () => {
    const uuid = randomUUID()
    const cmd = queuedPrompt({ uuid })

    const result = withQueuedPromptMessages([], [cmd])

    expect(result).toHaveLength(1)
    expect(result[0]!.uuid).toBe(uuid)
  })

  test('dedup: existing user row with the same uuid → skipped (official k.has)', () => {
    const uuid = randomUUID()
    const messages = [userTextRow('delivered while selector opened', uuid)]

    const result = withQueuedPromptMessages(messages, [queuedPrompt({ uuid })])

    expect(result).toBe(messages)
  })

  test('two queued entries with the same uuid synthesize only once', () => {
    const uuid = randomUUID()

    const result = withQueuedPromptMessages([], [
      queuedPrompt({ uuid }),
      queuedPrompt({ uuid, value: 'duplicate' }),
    ])

    expect(result).toHaveLength(1)
  })

  test('non-prompt modes are skipped (official commandMode!=="prompt")', () => {
    const result = withQueuedPromptMessages(
      [],
      [
        queuedPrompt({ mode: 'bash', value: 'ls -la' }),
        queuedPrompt({ mode: 'task-notification', value: '<task>done</task>' }),
        queuedPrompt({ mode: 'orphaned-permission' }),
      ],
    )

    expect(result).toHaveLength(0)
  })

  test('isMeta entries are skipped (official Se.isMeta)', () => {
    const result = withQueuedPromptMessages([], [
      queuedPrompt({ isMeta: true, value: 'proactive tick' }),
    ])

    expect(result).toHaveLength(0)
  })

  test('non-human origins are skipped (official strict n_ check)', () => {
    const result = withQueuedPromptMessages(
      [],
      [
        queuedPrompt({ origin: { kind: 'channel' } as never }),
        queuedPrompt({ origin: { kind: 'task-notification' } as never }),
        queuedPrompt({ origin: { kind: 'peer' } as never }),
        queuedPrompt({ origin: { kind: 'webhook' } as never }),
      ],
    )

    expect(result).toHaveLength(0)
  })

  test('explicit human origin IS listed (official stamps {kind:"human"})', () => {
    const result = withQueuedPromptMessages([], [
      queuedPrompt({ origin: { kind: 'human' } as never }),
    ])

    expect(result).toHaveLength(1)
  })

  test('bridgeOrigin entries are skipped (OCC remote-input marker)', () => {
    const result = withQueuedPromptMessages([], [
      queuedPrompt({ bridgeOrigin: true, value: 'from mobile' }),
    ])

    expect(result).toHaveLength(0)
  })

  test('array content with a non-object block is skipped (official content guard)', () => {
    const result = withQueuedPromptMessages(
      [],
      [
        queuedPrompt({
          value: [{ type: 'text', text: 'ok' }, null] as never,
        }),
      ],
    )

    expect(result).toHaveLength(0)
  })

  test('valid ContentBlockParam[] value is synthesized as-is', () => {
    const value = [
      { type: 'text', text: 'blocks prompt' },
    ] as QueuedCommand['value']

    const result = withQueuedPromptMessages([], [queuedPrompt({ value })])

    expect(result).toHaveLength(1)
    expect(result[0]!.message.content).toEqual(value)
  })

  test('imagePasteIds are extracted from valid image pastedContents', () => {
    const cmd = queuedPrompt({
      pastedContents: {
        1: { id: 1, type: 'image', content: 'base64data', mediaType: 'image/png' },
        2: { id: 2, type: 'text', content: 'plain paste' },
        3: { id: 3, type: 'image', content: '', mediaType: 'image/png' },
      } as never,
    })

    const result = withQueuedPromptMessages([], [cmd])

    expect(result).toHaveLength(1)
    // Only the valid image (id 1) — empty-content images rejected by
    // isValidImagePaste, text pastes are not images.
    expect((result[0] as { imagePasteIds?: number[] }).imagePasteIds).toEqual([1])
  })

  test('multiple queue entries append in queue order', () => {
    const result = withQueuedPromptMessages(
      [userTextRow('real')],
      [
        queuedPrompt({ value: 'one' }),
        queuedPrompt({ mode: 'bash', value: 'skip-me' }),
        queuedPrompt({ value: 'two' }),
      ],
    )

    expect(result).toHaveLength(3)
    expect(result[1]!.message.content).toBe('one')
    expect(result[2]!.message.content).toBe('two')
  })

  test('input messages array is not mutated', () => {
    const messages = [userTextRow('real')]
    const copy = [...messages]

    withQueuedPromptMessages(messages, [queuedPrompt()])

    expect(messages).toEqual(copy)
    expect(messages).toHaveLength(1)
  })

  test('findQueuedCommandForMessage maps a synthesized row back to its entry', () => {
    const cmd = queuedPrompt({ value: 'find me' })

    const result = withQueuedPromptMessages([], [cmd])

    expect(findQueuedCommandForMessage(result[0]!)).toBe(cmd)
  })

  test('findQueuedCommandForMessage returns undefined for real messages', () => {
    const real = userTextRow('real')

    const result = withQueuedPromptMessages([real], [queuedPrompt()])

    expect(findQueuedCommandForMessage(result[0]!)).toBeUndefined()
  })
})

describe('CC 2.1.290 cluster-f F — synthesized rows reach the selector list', () => {
  test('synthesized row passes selectableUserMessagesFilter (the LISTING fix)', async () => {
    const { selectableUserMessagesFilter } = await import(
      '../../components/MessageSelector.js'
    )
    const cmd = queuedPrompt({ value: 'queued during work' })

    const result = withQueuedPromptMessages([userTextRow('real')], [cmd])

    expect(result.filter(selectableUserMessagesFilter)).toHaveLength(2)
  })
})
