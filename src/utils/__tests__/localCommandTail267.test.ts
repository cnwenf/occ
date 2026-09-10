import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { deserializeMessagesWithInterruptDetection } from '../conversationRecovery.js'
import {
  createAssistantMessage,
  createModelSwitchBreadcrumbs,
  createUserMessage,
  createSyntheticUserCaveatMessage,
  NO_RESPONSE_REQUESTED,
} from '../messages.js'
import {
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from '../../constants/xml.js'
import type { Message } from '../../types/message.js'

/**
 * CC 2.1.267 (#10, Gap-121c): a transcript ending on a COMPLETED local
 * command breadcrumb tail (e.g. a /model switch persisted by `-p` mode:
 * caveat + `<command-name>` record + `<local-command-stdout>` output — the
 * exact shape of createModelSwitchBreadcrumbs, mirroring official `mnr`)
 * must resume as kind 'none'.
 *
 * Red-test baseline: before the fix the trailing breadcrumb (a plain-text
 * non-meta user message) fell through detectTurnInterruption to
 * 'interrupted_prompt', so `-p --resume` treated the finished local command
 * as an unfinished user prompt, and deserialize spliced a
 * NO_RESPONSE_REQUESTED sentinel after it.
 *
 * Official v267 fix (byte-verified, L1993609): `PWn` calls `eBe(e,r)` first
 * in the user branch and guards the sentinel splice with `!eBe(Ae,Je)`.
 * `eBe` scans backward from the tail: reaching the opening caveat → complete;
 * else the chain must be all-isMeta user breadcrumbs. `bWn` gates: user type
 * only, no promptSource, and a caveat must be isMeta.
 */

function recordMessage(args: Record<string, unknown> = {}): Message {
  return createUserMessage({
    content: `<${COMMAND_NAME_TAG}>/model</${COMMAND_NAME_TAG}>\n<command-message>model</command-message>`,
    ...args,
  }) as unknown as Message
}

function stdoutMessage(
  text = 'Set model to Opus 5',
  args: Record<string, unknown> = {},
): Message {
  return createUserMessage({
    content: `<${LOCAL_COMMAND_STDOUT_TAG}>${text}</${LOCAL_COMMAND_STDOUT_TAG}>`,
    ...args,
  }) as unknown as Message
}

function systemMessage(): Message {
  return {
    type: 'system',
    subtype: 'informational',
    content: 'bookkeeping noise',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

function hasSentinel(messages: Message[]): boolean {
  return messages.some(
    m =>
      m.type === 'assistant' &&
      JSON.stringify(m.message?.content ?? '').includes(NO_RESPONSE_REQUESTED),
  )
}

const CONVERSATION = [
  createUserMessage({ content: 'hello' }) as unknown as Message,
  createAssistantMessage({ content: 'hi there' }) as unknown as Message,
]

describe('2.1.267 #10: completed local-command tail is not an interrupted prompt', () => {
  test('model-switch breadcrumb tail resumes as kind none, without sentinel', () => {
    // Arrange — exactly what `-p` mode persists after a set_model switch.
    const transcript = [
      ...CONVERSATION,
      ...createModelSwitchBreadcrumbs('claude-opus-5', 'Opus 5'),
    ]

    // Act
    const { messages, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert — red baseline: 'interrupted_prompt' + spliced sentinel.
    expect(turnInterruptionState.kind).toBe('none')
    expect(hasSentinel(messages)).toBe(false)
  })

  test('stderr output tail with opening caveat resumes as kind none', () => {
    // Arrange — official IK maps local-command-stderr to 'output' too.
    const transcript = [
      ...CONVERSATION,
      createSyntheticUserCaveatMessage() as unknown as Message,
      recordMessage(),
      createUserMessage({
        content: `<${LOCAL_COMMAND_STDERR_TAG}>command failed</${LOCAL_COMMAND_STDERR_TAG}>`,
      }) as unknown as Message,
    ]

    // Act
    const { turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('none')
  })

  test('all-isMeta breadcrumb chain without caveat falls back to complete', () => {
    // Arrange — official eBe's `o` accumulator: no caveat found, but every
    // breadcrumb in the chain is an isMeta user message → complete.
    const transcript = [
      ...CONVERSATION,
      recordMessage({ isMeta: true }),
      stdoutMessage('Set model to Opus 5', { isMeta: true }),
    ]

    // Act
    const { turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('none')
  })

  test('system/progress noise between breadcrumbs is skipped by the scan', () => {
    // Arrange — official eBe continues past system/progress/attachment.
    const transcript = [
      createSyntheticUserCaveatMessage() as unknown as Message,
      systemMessage(),
      recordMessage(),
      stdoutMessage(),
    ]

    // Act
    const { turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('none')
  })

  test('non-meta breadcrumb chain without caveat stays interrupted_prompt (official scope)', () => {
    // Arrange — eBe's fallback requires isMeta on every chain message;
    // without a caveat and without isMeta the tail is NOT exempt.
    const transcript = [...CONVERSATION, recordMessage(), stdoutMessage()]

    // Act
    const { messages, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(hasSentinel(messages)).toBe(true)
  })

  test('a non-meta caveat-tagged message is a real prompt, not a breadcrumb', () => {
    // Arrange — official bWn: kind 'caveat' requires isMeta === true.
    const transcript = [
      ...CONVERSATION,
      createUserMessage({
        content: `<${LOCAL_COMMAND_CAVEAT_TAG}>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</${LOCAL_COMMAND_CAVEAT_TAG}>`,
      }) as unknown as Message,
    ]

    // Act
    const { turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
  })

  test('promptSource-tagged messages are excluded from breadcrumb classification', () => {
    // Arrange — official bWn returns undefined when promptSource is set
    // (e.g. 'sdk'): those are real prompts even if content carries tags.
    // createUserMessage whitelists fields, so promptSource (which only
    // arrives via on-disk JSON from other builds) is attached post-hoc.
    const sdkTagged = {
      ...stdoutMessage('Set model to Opus 5'),
      promptSource: 'sdk',
    } as unknown as Message
    const transcript = [
      createSyntheticUserCaveatMessage() as unknown as Message,
      recordMessage(),
      sdkTagged,
    ]

    // Act
    const { turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
  })

  test('plain user prompt tail still resumes as interrupted_prompt (no regression)', () => {
    // Arrange — the pre-existing behavior for a genuine unfinished prompt.
    const transcript = [
      ...CONVERSATION,
      createUserMessage({ content: 'now refactor the auth module' }) as unknown as Message,
    ]

    // Act
    const { messages, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(hasSentinel(messages)).toBe(true)
  })
})
