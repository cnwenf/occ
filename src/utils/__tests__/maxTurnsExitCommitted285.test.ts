import { afterEach, describe, expect, test } from 'bun:test'
import { deserializeMessagesWithInterruptDetection } from '../conversationRecovery.js'
import { createAttachmentMessage, stampMaxTurnsExitCommitted } from '../attachments.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import {
  commitExit,
  isExitCommitted,
  resetExitCommitForTesting,
} from '../exitCommit.js'
import type { AttachmentMessage, Message } from '../../types/message.js'

/**
 * Official Claude Code 2.1.285 (OCC-102 #54): max-turns exit-commit
 * classification. Binary v285 evidence (linux-x64 ELF):
 *
 * ```js
 * // exit-commit module (chunk-anfpa5zs @201263005):
 * class t{committed=!1}var e=new t;
 * function eo(){return e.committed}   // isExitCommitted
 * function ane(){e.committed=!0}      // commitExit
 * // shutdown manager (@202994960): if(!this.shutdownInProgress)process.exitCode=e,ane()
 * // shutdown manager (@202997754): this.shutdownInProgress=!0,ane()
 *
 * // record-time stamp (GP @221287457, called @221275150 before keep/record):
 * function GP(e){try{if(e.type!=="attachment"||
 *   e.attachment.type!=="max_turns_reached")return e;
 *   let r=eo();if(r)i("tengu_max_turns_reached_exit_committed",{});
 *   return{...e,attachment:{...e.attachment,exitCommitted:r}}}
 *   catch(r){return u(r),e}}
 *
 * // resume classifier (V4o S-branch):
 * M||=B.type==="attachment"&&B.attachment.type==="max_turns_reached"
 *      &&B.attachment.exitCommitted===!1
 * ...
 * if(M&&!n)return{kind:"ended_at_max_turns"}
 * // wrapper (oHe): ended_at_max_turns → {state:{kind:"none"},endedAtMaxTurns:!0}
 * // caller: Ft=Pt.endedAtMaxTurns===!0&&Gt.kind==="none";
 * //         if(Ft)i("tengu_max_turns_turn_classified_complete",{auto_resume:w===!0})
 * ```
 *
 * OCC surface: exitCommit.ts (module), attachments.ts stampMaxTurnsExitCommitted
 * (GP), QueryEngine case 'attachment' (record switch wiring),
 * conversationRecovery.ts detectTurnInterruption/hasUncommittedMaxTurnsTail
 * (V4o) + deserializeMessagesWithInterruptDetection (oHe mapping).
 */

afterEach(() => {
  resetExitCommitForTesting()
})

describe('2.1.285 #54 exitCommit module (official eo/ane)', () => {
  test('defaults to not committed; commitExit flips it; reset restores', () => {
    // Arrange / Act / Assert
    expect(isExitCommitted()).toBe(false)
    commitExit()
    expect(isExitCommitted()).toBe(true)
    resetExitCommitForTesting()
    expect(isExitCommitted()).toBe(false)
  })
})

describe('2.1.285 #54 stampMaxTurnsExitCommitted (official GP)', () => {
  test('no-op (same reference) for non-max_turns_reached attachments', () => {
    // Arrange
    const msg = {
      type: 'attachment',
      attachment: { type: 'queued_command' },
      uuid: 'u1',
      timestamp: 't1',
    } as unknown as AttachmentMessage

    // Act
    const out = stampMaxTurnsExitCommitted(msg)

    // Assert — GP returns `e` unchanged for any other attachment type
    expect(out).toBe(msg)
  })

  test('stamps exitCommitted=false when the process has not committed', () => {
    // Arrange
    const msg = createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns: 5,
      turnCount: 6,
    })

    // Act
    const stamped = stampMaxTurnsExitCommitted(msg)

    // Assert — immutable: a NEW message, original untouched
    expect(stamped).not.toBe(msg)
    expect(
      (stamped.attachment as { exitCommitted?: boolean }).exitCommitted,
    ).toBe(false)
    expect(
      (msg.attachment as { exitCommitted?: boolean }).exitCommitted,
    ).toBeUndefined()
    expect(stamped.uuid).toBe(msg.uuid)
  })

  test('stamps exitCommitted=true after commitExit (shutdown in flight)', () => {
    // Arrange
    commitExit()
    const msg = createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns: 5,
      turnCount: 6,
    })

    // Act
    const stamped = stampMaxTurnsExitCommitted(msg)

    // Assert
    expect(
      (stamped.attachment as { exitCommitted?: boolean }).exitCommitted,
    ).toBe(true)
  })
})

/** The mid-tool-loop max-turns tail shape produced by query.ts. */
function maxTurnsTranscript(exitCommitted?: boolean): Message[] {
  const attachment = createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns: 3,
    turnCount: 4,
    ...(exitCommitted !== undefined ? { exitCommitted } : {}),
  })
  return [
    createUserMessage({ content: 'run the task' }) as unknown as Message,
    createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
      ] as never,
    }) as unknown as Message,
    createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
      ],
    }) as unknown as Message,
    attachment as unknown as Message,
  ]
}

function continueMessages(messages: Message[]): number {
  return messages.filter(
    m =>
      m.type === 'user' &&
      (m as { isMeta?: boolean }).isMeta === true &&
      JSON.stringify((m as { message?: { content?: unknown } }).message?.content ?? '').includes(
        'Continue from where you left off.',
      ),
  ).length
}

describe('2.1.285 #54 resume classification (official V4o/oHe)', () => {
  test('uncommitted max_turns tail classifies as complete (none)', () => {
    // Arrange — exitCommitted=false persisted at record time
    const transcript = maxTurnsTranscript(false)

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — official oHe maps ended_at_max_turns → {kind:"none"}
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('committed max_turns tail (shutdown race) stays interrupted_turn', () => {
    // Arrange — exitCommitted=true: the process was already exiting when the
    // attachment was recorded, so the cap-hit is NOT a clean end
    const transcript = maxTurnsTranscript(true)

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — interrupted_turn converts to interrupted_prompt with the
    // synthetic continuation message (pre-285 behavior preserved)
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('legacy tail (no exitCommitted field) stays interrupted_turn', () => {
    // Arrange — transcripts written by pre-2.1.285 builds lack the field;
    // the official `===!1` strict check keeps them on the old classification
    const transcript = maxTurnsTranscript(undefined)

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('non-max-turns attachment tail stays interrupted_turn', () => {
    // Arrange
    const transcript = [
      createUserMessage({ content: 'do it' }) as unknown as Message,
      createAttachmentMessage({
        type: 'queued_command',
        command: '/model',
        isLocalCommand: false,
      }) as unknown as Message,
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  })

  test('system rows between the user row and the attachment do not block the M scan', () => {
    // Arrange — official scan skips system/progress rows while accumulating M
    const transcript = [
      ...maxTurnsTranscript(false).slice(0, 3),
      {
        type: 'system',
        subtype: 'turn_duration',
        content: '',
        uuid: 'sys-1',
        timestamp: new Date().toISOString(),
      } as unknown as Message,
      createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns: 3,
        turnCount: 4,
        exitCommitted: false,
      }) as unknown as Message,
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('none')
  })

  test('dropped trailing unresolved tool uses suppress the classification (official !n gate)', () => {
    // Arrange — assistant tool_use with NO tool_result gets dropped by
    // filterUnresolvedToolUses (length delta → droppedUnresolvedToolUses,
    // OCC's proxy for the official ze.size>0 `n`); V4o's `if(M&&!n)` gate
    // then keeps the tail interrupted_turn
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_unresolved', name: 'Bash', input: {} },
        ] as never,
      }) as unknown as Message,
      createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns: 3,
        turnCount: 4,
        exitCommitted: false,
      }) as unknown as Message,
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  })
})
