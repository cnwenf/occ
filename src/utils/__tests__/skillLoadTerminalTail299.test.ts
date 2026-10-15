/**
 * CC 2.1.299 #128 — resume detector must not re-answer a FINISHED turn when
 * a skill loaded in the same step as the turn-ending tool.
 *
 * Official changelog (2.1.299): "Fixed cloud sessions and
 * `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` sometimes answering a finished turn
 * again after a restart, when a tool ended the turn and a skill loaded in the
 * same step."
 *
 * Binary forensics (v296 → v299, resume-detector cluster @225088xxx/216894xxx):
 *   - v296 attachment tail scan: `let be=h$t(e,Y); if(be!==void 0)return
 *     xce(be,r,n)` INSIDE `if(he.type==="user"&&w$(he))` (tool-result guard).
 *   - v299: `let Te=Eqt(e,_e); if(Te!==void 0)return xge(Te,r,n)` HOISTED
 *     OUTSIDE the `KB(Se)` guard — the committed-turn backfill now runs for
 *     EVERY user row the attachment tail scan reaches, so the scan looks
 *     through trailing rows (skill-load / context rows) to the underlying
 *     committed terminal tool_result → `xge` → `{kind:"none",
 *     because:"terminal_tool_result"}`.
 *   - `Aqt`(v299) ≡ `S$t`(v296): the official per-row terminal scan still
 *     reads only `content[0]` — the official compensates multi-block rows via
 *     the row-level `toolEndsTurn` stamp consumed by `wTt`/`Eqt`. OCC has no
 *     `endsTurn` plumbing (QueryEngine.ts classifyTurnEndingToolResultRow
 *     note), so the faithful OCC equivalent is scanning ALL tool_result
 *     blocks in `isTerminalToolResult`.
 *
 * Repro shape (triage-F #128): transcript ending
 *   assistant[Skill tool_use + SendUserMessage tool_use]
 *   → user[tool_result(skill) , tool_result(terminal)]   ← skill result FIRST
 *   → attachment(invoked_skills)
 * classified as interrupted pre-fix → phantom "Continue from where you left
 * off." injected on resume / auto re-answer under
 * CLAUDE_CODE_RESUME_INTERRUPTED_TURN (print.ts re-enqueue).
 *
 * KAIROS mock: conversationRecovery's BRIEF_TOOL_NAME / LEGACY_BRIEF_TOOL_NAME
 * / SEND_USER_FILE_TOOL_NAME constants are `feature('KAIROS')`-gated and null
 * in the shipping build, making the terminal classifier untestable (and
 * structurally dead) without the flag. The mock enables KAIROS/KAIROS_BRIEF at
 * import time only; every KAIROS-gated module in the import graph is benign
 * (BriefTool/prompt.ts = constants, sessionTranscript = no-op stub,
 * sessionStorage = one extra ephemeral-progress type).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

const actualFeatureFlags = { ...(await import('../featureFlags.js')) }
const realFeature = actualFeatureFlags.feature

mock.module('src/utils/featureFlags.js', () => ({
  ...actualFeatureFlags,
  feature: (name: string) =>
    name === 'KAIROS' || name === 'KAIROS_BRIEF' ? true : realFeature(name),
}))

// Cache-busting specifier: conversationRecovery computes BRIEF_TOOL_NAME &
// co. as module-level consts at evaluation time, and bun's mock.module
// registry is process-global across test files in one run — a sibling file's
// static import chain (e.g. planModeResume290 → planModeResume.js) can
// evaluate conversationRecovery with the REAL featureFlags first, permanently
// caching null terminal names. `?kairos=1` forces a fresh evaluation AFTER
// the mock above is installed, so the gated consts see KAIROS=true.
const { deserializeMessagesWithInterruptDetection } = await import(
  '../conversationRecovery.js?kairos=1'
)
const { createAttachmentMessage } = await import('../attachments.js')
const { createAssistantMessage, createUserMessage } = await import(
  '../messages.js'
)
type Message = import('../../types/message.js').Message

afterAll(() => {
  mock.module('src/utils/featureFlags.js', () => actualFeatureFlags)
})

/** Official BRIEF_TOOL_NAME / LEGACY_BRIEF_TOOL_NAME (BriefTool/prompt.ts). */
const TERMINAL_TOOL = 'SendUserMessage'
const SKILL_TOOL = 'Skill'

function invokedSkillsAttachment(): Message {
  return createAttachmentMessage({
    type: 'invoked_skills',
    skills: [{ name: 'pdf', path: '/skills/pdf', content: 'do pdf things' }],
  }) as unknown as Message
}

function skillStepAssistant(): Message {
  return createAssistantMessage({
    content: [
      { type: 'tool_use', id: 'toolu_skill', name: SKILL_TOOL, input: {} },
      { type: 'tool_use', id: 'toolu_brief', name: TERMINAL_TOOL, input: {} },
    ] as never,
  }) as unknown as Message
}

/** Skill tool_result ordered FIRST — masks the terminal result pre-fix. */
function skillFirstResultsRow(): Message {
  return createUserMessage({
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_skill', content: 'skill loaded' },
      { type: 'tool_result', tool_use_id: 'toolu_brief', content: 'message sent' },
    ],
  }) as unknown as Message
}

function terminalFirstResultsRow(): Message {
  return createUserMessage({
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_brief', content: 'message sent' },
      { type: 'tool_result', tool_use_id: 'toolu_skill', content: 'skill loaded' },
    ],
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

describe('CC 2.1.299 #128 — skill loaded in same step as terminal tool', () => {
  test('REPRO: invoked_skills attachment over skill-first terminal results → none', () => {
    // Arrange — the exact triage-F #128 tail shape
    const transcript: Message[] = [
      createUserMessage({ content: 'send the file' }) as unknown as Message,
      skillStepAssistant(),
      skillFirstResultsRow(),
      invokedSkillsAttachment(),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — turn COMPLETED; no phantom continuation injected
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('user-branch: multi-block tool_result with skill result first → none', () => {
    // Arrange — same step without the trailing attachment (fix (a):
    // isTerminalToolResult scans ALL tool_result blocks, not just content[0])
    const transcript: Message[] = [
      createUserMessage({ content: 'send the file' }) as unknown as Message,
      skillStepAssistant(),
      skillFirstResultsRow(),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('terminal result first in the row → none (pre-fix behavior preserved)', () => {
    // Arrange — content[0] IS the terminal result; passed even pre-fix
    const transcript: Message[] = [
      createUserMessage({ content: 'send the file' }) as unknown as Message,
      skillStepAssistant(),
      terminalFirstResultsRow(),
      invokedSkillsAttachment(),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continueMessages(result.messages)).toBe(0)
  })

  test('真中断: attachment over a NON-terminal tool_result stays interrupted', () => {
    // Arrange — Read result under the invoked_skills attachment: the turn was
    // genuinely killed mid-tool-loop
    const transcript: Message[] = [
      createUserMessage({ content: 'read and summarize' }) as unknown as Message,
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} },
        ] as never,
      }) as unknown as Message,
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read', content: 'file body' },
        ],
      }) as unknown as Message,
      invokedSkillsAttachment(),
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert — interrupted_turn converts to interrupted_prompt + continuation
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('真中断: attachment directly over assistant text stays interrupted', () => {
    // Arrange — the look-through must NOT skip past an assistant row
    const transcript: Message[] = [
      createUserMessage({ content: 'hi' }) as unknown as Message,
      createAssistantMessage({
        content: [{ type: 'text', text: 'thinking about it' }],
      }) as unknown as Message,
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
    expect(continueMessages(result.messages)).toBe(1)
  })

  test('真中断: plain non-terminal tool_result tail (no attachment) stays interrupted', () => {
    // Arrange
    const transcript: Message[] = [
      createUserMessage({ content: 'read it' }) as unknown as Message,
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} },
        ] as never,
      }) as unknown as Message,
      createUserMessage({
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read', content: 'body' },
        ],
      }) as unknown as Message,
    ]

    // Act
    const result = deserializeMessagesWithInterruptDetection(transcript)

    // Assert
    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continueMessages(result.messages)).toBe(1)
  })
})
