import { describe, expect, test } from 'bun:test'
import { deserializeMessagesWithInterruptDetection } from '../conversationRecovery.js'
import { createAttachmentMessage } from '../attachments.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterUnresolvedToolUsesDetailed,
} from '../messages.js'
import type { Message } from '../../types/message.js'

/**
 * Official Claude Code 2.1.285 (OCC-102 #54 follow-up, review df-1): the
 * ended_at_max_turns S-branch suppression input must be TRAILING-REGION
 * scoped (official `ze`), not a global dropped-tool-use proxy.
 *
 * Binary v285 evidence (linux-x64 ELF, /tmp/official285/package/claude):
 *
 * ```js
 * // f0e = filterUnresolvedToolUses WITH options; after computing the GLOBAL
 * // unresolved set S (early-return when S.size===0 → ze stays empty), the
 * // trailing scan fills r.outTrailingUnresolvedToolUseIds (official `ze`):
 * if(r?.outTrailingUnresolvedToolUseIds){
 *   let B=af()?Vce:Zme,K=!1;                      // af()=tengu_foamy_spring
 *                                                 // default true → B=Vce
 *   for(let he=e.length-1;he>=0;he--){let ye=e[he];
 *     if(ye.type==="system"||ye.type==="progress"||ye.type==="attachment")continue;
 *     if(ye.type==="user"){let be=ye.message.content;
 *       if(Array.isArray(be)&&be.some((Re)=>Re.type==="tool_result"))continue;
 *       if(ye.interruptedByShutdown===!0||!K&&B(ye))continue;
 *       break}                                    // plain-text user row STOPS
 *     if(ye.type==="assistant")K=!0;
 *     if(ye.type==="assistant"&&Array.isArray(ye.message.content)){
 *       for(let be of ye.message.content)
 *         if(be.type==="tool_use"&&S.has(be.id))
 *           r.outTrailingUnresolvedToolUseIds.add(be.id)}}}
 *
 * // Vce — companion user rows the scan continues past (before any assistant):
 * function Vce(e){return e.type==="user"&&(e.turnCompanion===!0||
 *   typeof e.sourceToolUseID==="string"||M6n(e)||Zme(e))}
 * // M6n — isMeta loop-feedback rows: se prefixes / ae exact nudge texts /
 * // `${event}${O6n}` hook-feedback prefixes ($jr=["Stop","TeammateIdle",
 * // "TaskCreated","TaskCompleted"], O6n=" hook feedback:\n")
 * // Zme — gated on CLAUDE_CODE_RESUME_TOLERATES_CONTEXT_APPENDS (no OCC
 * // surface → always false, omitted per the Gap-121c convention)
 *
 * // caller (iHn): ze feeds BOTH consumers with the SAME trailing-scoped set:
 * //   Pt = ... : oHe(Ut, ze.size>0)                        // S-branch `n`
 * //   Zt = !vn && kind!=="none" && (ze.size>0||Et ? Qe : nHe(Ut))  // staleness walk set
 * ```
 *
 * df-1 divergence at HEAD: OCC fed `droppedUnresolvedToolUses`
 * (filteredToolUses.length !== sanitizedMessages.length — a GLOBAL length
 * delta) into both consumers, so ANY mid-transcript orphan unresolved
 * assistant row suppressed a legitimate trailing `max_turns_reached`
 * (exitCommitted===false) clean end → phantom "Continue from where you left
 * off." on resume where official v285 returns a clean ended_at_max_turns.
 *
 * OCC surface: src/utils/messages.ts filterUnresolvedToolUsesDetailed (f0e
 * trailing scan) + src/utils/conversationRecovery.ts
 * deserializeMessagesWithInterruptDetection (ze.size>0 threading).
 */

function maxTurnsAttachment(exitCommitted?: boolean): Message {
  return createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns: 3,
    turnCount: 4,
    ...(exitCommitted !== undefined ? { exitCommitted } : {}),
  }) as unknown as Message
}

function unresolvedToolUseRow(id: string): Message {
  return createAssistantMessage({
    content: [
      { type: 'tool_use', id, name: 'Bash', input: {} },
    ] as never,
  }) as unknown as Message
}

function continueMessages(messages: Message[]): number {
  return messages.filter(
    m =>
      m.type === 'user' &&
      (m as { isMeta?: boolean }).isMeta === true &&
      JSON.stringify(
        (m as { message?: { content?: unknown } }).message?.content ?? '',
      ).includes('Continue from where you left off.'),
  ).length
}

describe('2.1.285 df-1 — ze trailing-region scope, resume classification', () => {
  test('PROBE: mid-transcript orphan unresolved tool_use does NOT suppress a clean trailing max_turns end', () => {
    // Arrange — the reviewer's df-1 probe: an orphan unresolved assistant
    // tool_use row MID-transcript (dropped by the filter → the global length
    // delta flips true), then a plain user prompt, then a trailing
    // max_turns_reached attachment persisted with exitCommitted=false.
    // Official f0e trailing scan BREAKS at the plain-text user row, so the
    // orphan never enters ze → oHe(Ut, false) → V4o `if(M&&!n)` →
    // ended_at_max_turns → {kind:"none"}, no continuation.
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      unresolvedToolUseRow('toolu_orphan_mid'),
      createUserMessage({ content: 'next prompt' }) as unknown as Message,
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — clean ended_at_max_turns (official), NOT interrupted_prompt
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('control: same tail WITHOUT the orphan classifies clean (unchanged at HEAD)', () => {
    // Arrange — isolates the sole variable: the mid-transcript orphan row
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      createUserMessage({ content: 'next prompt' }) as unknown as Message,
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('true positive: genuinely TRAILING dropped unresolved tool_use still suppresses (interrupted_turn + continuation)', () => {
    // Arrange — the orphan IS the trailing cluster: scan collects it into ze
    // (assistant row after the attachment skip) → ze.size>0 → the S-branch
    // gate `if(M&&!n)` does NOT fire → interrupted_turn (must not regress)
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('mid orphan + trailing unresolved: suppression still fires from the TRAILING id', () => {
    // Arrange — both a mid-transcript orphan and a trailing unresolved row;
    // ze={toolu_trailing} (non-empty) → interrupted_turn, same as official
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      unresolvedToolUseRow('toolu_orphan_mid'),
      createUserMessage({ content: 'keep going' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('Stop hook feedback meta row after the trailing tool_use keeps suppression (official M6n/$jr continuation)', () => {
    // Arrange — official scan continues past `Stop hook feedback:\n...`
    // isMeta rows while !K (no assistant seen yet walking backward); OCC
    // persists exactly this row shape (src/utils/hooks.ts:2964)
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
      createUserMessage({
        content: 'Stop hook feedback:\nblocked: not done yet',
        isMeta: true,
      }) as unknown as Message,
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — ze={toolu_trailing} → interrupted_turn + continuation
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('sourceToolUseID companion row after the trailing tool_use keeps suppression (official Vce)', () => {
    // Arrange — `typeof e.sourceToolUseID==="string"` continues the scan
    const companion = {
      ...(createUserMessage({ content: 'skill context' }) as unknown as Message),
      sourceToolUseID: 'toolu_skill_1',
    } as unknown as Message
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
      companion,
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('interruptedByShutdown row continues the scan even AFTER an assistant row', () => {
    // Arrange — official: `ye.interruptedByShutdown===!0` continues
    // regardless of K; shape: two unresolved assistant rows separated by a
    // shutdown-marked user row. ze={toolu_b, toolu_a} → suppression holds.
    const shutdownRow = {
      ...(createUserMessage({ content: 'interrupted' }) as unknown as Message),
      interruptedByShutdown: true,
    } as unknown as Message
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_a'),
      shutdownRow,
      unresolvedToolUseRow('toolu_b'),
      maxTurnsAttachment(false),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })
})

function toolResultRow(toolUseId: string): Message {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
  }) as unknown as Message
}

function metaRow(text: string, isMeta = true): Message {
  return createUserMessage({ content: text, isMeta }) as unknown as Message
}

function systemRow(uuid: string): Message {
  return {
    type: 'system',
    subtype: 'turn_duration',
    content: '',
    uuid,
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

function trailingIds(messages: Message[]): Set<string> {
  return new Set(
    filterUnresolvedToolUsesDetailed(messages).trailingUnresolvedToolUseIds,
  )
}

describe('2.1.285 df-1 — filterUnresolvedToolUsesDetailed (official f0e trailing scan)', () => {
  test('mid-transcript orphan: row is filtered but the trailing set stays EMPTY (df-1 core pin)', () => {
    // Arrange — official scan starts at the tail and BREAKS at the plain
    // user row before any assistant row, so the orphan never enters ze
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      unresolvedToolUseRow('toolu_orphan_mid'),
      createUserMessage({ content: 'next prompt' }) as unknown as Message,
    ]

    // Act
    const result = filterUnresolvedToolUsesDetailed(transcript)

    // Assert — global filter still drops the orphan; trailing set is empty
    expect(result.messages.map(m => m.type)).toEqual(['user', 'user'])
    expect(result.trailingUnresolvedToolUseIds.size).toBe(0)
  })

  test('genuinely trailing unresolved id: set contains the id', () => {
    // Arrange
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
      maxTurnsAttachment(false),
    ]

    // Act
    const result = filterUnresolvedToolUsesDetailed(transcript)

    // Assert — scan: attachment skipped, assistant collected, user breaks
    expect(result.trailingUnresolvedToolUseIds).toEqual(
      new Set(['toolu_trailing']),
    )
    expect(result.messages.map(m => m.type)).toEqual(['user', 'attachment'])
  })

  test('mid orphan + trailing unresolved: set contains ONLY the trailing id (region scope)', () => {
    // Arrange
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      unresolvedToolUseRow('toolu_orphan_mid'),
      createUserMessage({ content: 'keep going' }) as unknown as Message,
      unresolvedToolUseRow('toolu_trailing'),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_trailing']))
  })

  test('no unresolved tool uses: same array reference + empty set (identity preserved)', () => {
    // Arrange — official f0e early-returns `e` when S.size===0
    const transcript = [
      createUserMessage({ content: 'run the task' }) as unknown as Message,
      unresolvedToolUseRow('toolu_1'),
      toolResultRow('toolu_1'),
    ]

    // Act
    const result = filterUnresolvedToolUsesDetailed(transcript)

    // Assert
    expect(result.messages).toBe(transcript)
    expect(result.trailingUnresolvedToolUseIds.size).toBe(0)
  })

  test('scan skips system and attachment rows while walking backward', () => {
    // Arrange — official: system/progress/attachment → continue
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_a'),
      systemRow('sys-1'),
      maxTurnsAttachment(false),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_a']))
  })

  test('tool_result user rows continue the scan', () => {
    // Arrange — official: user row whose content has a tool_result block →
    // continue (it belongs to the tool loop, not a fresh prompt)
    const transcript = [
      createUserMessage({ content: 'run' }) as unknown as Message,
      unresolvedToolUseRow('toolu_a'),
      unresolvedToolUseRow('toolu_b'),
      toolResultRow('toolu_b'),
    ]

    // Act
    const result = filterUnresolvedToolUsesDetailed(transcript)

    // Assert — toolu_b resolved by the result row; scan continues past it
    // and collects the still-unresolved toolu_a
    expect(result.trailingUnresolvedToolUseIds).toEqual(new Set(['toolu_a']))
  })

  test('plain user row STOPS the scan (region boundary)', () => {
    // Arrange — two unresolved assistant rows separated by a plain prompt;
    // only the one after the boundary is in the trailing region
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      createUserMessage({ content: 'next prompt' }) as unknown as Message,
      unresolvedToolUseRow('toolu_b'),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_b']))
  })

  test('meta loop-feedback continuation is bounded by !K (only before the first assistant row)', () => {
    // Arrange — official: `!K&&B(ye)` — once an assistant row was seen
    // walking backward, meta rows no longer continue the scan
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      metaRow('Stop hook feedback:\nblocked: first'),
      unresolvedToolUseRow('toolu_b'),
      metaRow('Stop hook feedback:\nblocked: second'),
    ]

    // Act / Assert — scan: meta(second) continues (!K), assistant b
    // collected (K=true), meta(first) then BREAKS → toolu_a excluded
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_b']))
  })

  test('interruptedByShutdown row continues the scan regardless of K', () => {
    // Arrange — official: `ye.interruptedByShutdown===!0` continues even
    // after an assistant row was seen
    const shutdownRow = {
      ...(createUserMessage({ content: 'interrupted' }) as unknown as Message),
      interruptedByShutdown: true,
    } as unknown as Message
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      shutdownRow,
      unresolvedToolUseRow('toolu_b'),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(
      new Set(['toolu_a', 'toolu_b']),
    )
  })

  test('sourceToolUseID companion row continues the scan (official Vce)', () => {
    // Arrange
    const companion = {
      ...(createUserMessage({ content: 'skill context' }) as unknown as Message),
      sourceToolUseID: 'toolu_skill_1',
    } as unknown as Message
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      companion,
      maxTurnsAttachment(false),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_a']))
  })

  test('non-meta row with hook-feedback text does NOT continue the scan (M6n requires isMeta)', () => {
    // Arrange — official M6n: `e.type!=="user"||e.isMeta!==!0 → false`
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      metaRow('Stop hook feedback:\nblocked', false),
    ]

    // Act / Assert — scan breaks at the non-meta row → empty trailing set,
    // even though the filter still drops the assistant row
    expect(trailingIds(transcript)).toEqual(new Set())
  })

  test('exact nudge text (ae table) continues the scan as isMeta row', () => {
    // Arrange — official ae includes the thinking-only nudge text verbatim
    // (byte-identical to OCC THINKING_ONLY_NUDGE_TEXT)
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      metaRow(
        '[Your previous response had no visible output. Please continue and produce a user-visible response.]',
      ),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_a']))
  })

  test('se-prefix meta row continues the scan', () => {
    // Arrange — official se prefixes include "[projects-reply-gate]"
    const transcript = [
      unresolvedToolUseRow('toolu_a'),
      metaRow('[projects-reply-gate] reply required'),
    ]

    // Act / Assert
    expect(trailingIds(transcript)).toEqual(new Set(['toolu_a']))
  })
})
