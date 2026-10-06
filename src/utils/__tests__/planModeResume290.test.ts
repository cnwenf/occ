// Polyfill (repo convention — see structuredOutputIsError291.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import type { Message } from '../../types/message.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { planModeOnInteractiveResume } from '../planModeResume.js'

/**
 * CC 2.1.290 (cluster-f item E, changelog-entries-290.txt:99) — "Fixed plan
 * mode not being restored when resuming a session with `--continue` or
 * `--resume <session-id>` in the terminal."
 *
 * Byte-faithful expectations recovered from the official 2.1.290/2.1.291
 * linux-x64 ELF plan-resume chunk @229169372..229174700 (`hws` exported as
 * `planModeOnInteractiveResume`, transcript scan `M`, recorded-mode
 * normalizer `R`, eligibility `E`, transition `x`, deny matcher `_s`,
 * telemetry `S` → tengu_worker_permission_mode_restore). See
 * docs/gap-research-291/cluster-f-session-durability.md §E.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    ...overrides,
  } as ToolPermissionContext
}

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

function attachmentRow(type: string): Message {
  return {
    ...baseFields(),
    type: 'attachment',
    attachment: { type },
  } as unknown as Message
}

function assistantToolUseRow(
  blocks: Array<{ name: string; id: string }>,
): Message {
  return {
    ...baseFields(),
    type: 'assistant',
    message: {
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: blocks.map(b => ({ type: 'tool_use', id: b.id, name: b.name, input: {} })),
    },
  } as unknown as Message
}

function toolResultRow(
  results: Array<{
    toolUseId: string
    isError?: boolean
    content?: string
    awaitingLeaderApproval?: boolean
  }>,
): Message {
  const row = {
    ...baseFields(),
    type: 'user',
    message: {
      role: 'user',
      content: results.map(r => ({
        type: 'tool_result',
        tool_use_id: r.toolUseId,
        ...(r.isError ? { is_error: true } : {}),
        ...(r.content !== undefined ? { content: r.content } : {}),
      })),
    },
  } as Record<string, unknown>
  // Official h(e,n): toolUseResult.awaitingLeaderApproval===!0 marks the
  // result errored even without is_error (plan submitted to team lead).
  if (results.some(r => r.awaitingLeaderApproval)) {
    row.toolUseResult = { awaitingLeaderApproval: true }
  }
  return row as unknown as Message
}

function userTextRow(
  text: string,
  extra: { permissionMode?: string; isMeta?: boolean } = {},
): Message {
  return {
    ...baseFields(),
    type: 'user',
    ...(extra.permissionMode !== undefined
      ? { permissionMode: extra.permissionMode }
      : {}),
    ...(extra.isMeta !== undefined ? { isMeta: extra.isMeta } : {}),
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as Message
}

const EXIT_ID = 'toolu_exit_1'
const ENTER_ID = 'toolu_enter_1'

// ---------------------------------------------------------------------------

describe('CC 2.1.290 cluster-f E — planModeOnInteractiveResume', () => {
  test('stored plan mode + transcript not exited → restores plan', () => {
    const ctx = makeContext({ mode: 'default' })

    const restored = planModeOnInteractiveResume(ctx, {
      storedPermissionMode: 'plan',
      messages: [userTextRow('hello', { permissionMode: 'plan' })],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeDefined()
    expect(restored!.mode).toBe('plan')
    // Immutable — the input context is not mutated (official x(e) spreads).
    expect(ctx.mode).toBe('default')
  })

  test('stored plan mode but transcript shows plan_mode_exit → no restore', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: 'plan',
      messages: [attachmentRow('plan_mode'), attachmentRow('plan_mode_exit')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('absent stored mode + open plan transcript (plan_mode attachment) → restores', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [userTextRow('hi'), attachmentRow('plan_mode')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeDefined()
    expect(restored!.mode).toBe('plan')
  })

  test('plan_mode_reentry attachment also opens the transcript lane', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [attachmentRow('plan_mode_reentry')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('plan opened then later human row in default mode → suppressed to none', () => {
    // Official M(): scanning backward, a non-meta user row with a defined
    // permissionMode !== "plan" and human-like origin sets the suppress flag;
    // the earlier plan_mode attachment then resolves f() → "none".
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        userTextRow('now do it', { permissionMode: 'default' }),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('isMeta user row in default mode does NOT suppress the restore', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        userTextRow('system note', { permissionMode: 'default', isMeta: true }),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('approved ExitPlanMode after plan_mode → exited → no restore', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        toolResultRow([{ toolUseId: EXIT_ID }]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('REJECTED ExitPlanMode (is_error) keeps plan open → restores', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        toolResultRow([{ toolUseId: EXIT_ID, isError: true }]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('awaitingLeaderApproval toolUseResult counts as errored → plan stays open', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        toolResultRow([{ toolUseId: EXIT_ID, awaitingLeaderApproval: true }]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('"submitted to the team lead" result content counts as errored', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        toolResultRow([
          {
            toolUseId: EXIT_ID,
            content:
              'Your plan has been submitted to the team lead for approval',
          },
        ]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('approved ExitPlanMode with DUPLICATE tool_use id does not exit', () => {
    // Official M(): ExitPlanMode needs !s.has(id) (no duplicate ids); a
    // duplicated id is treated as untrusted for the exit decision.
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        attachmentRow('plan_mode'),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        assistantToolUseRow([{ name: 'ExitPlanMode', id: EXIT_ID }]),
        toolResultRow([{ toolUseId: EXIT_ID }]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('approved EnterPlanMode tool → open → restores', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        assistantToolUseRow([{ name: 'EnterPlanMode', id: ENTER_ID }]),
        toolResultRow([{ toolUseId: ENTER_ID }]),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('<command-name>/plan</command-name> user row → restores', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        userTextRow('  <command-name>/plan</command-name>\n<command-message>plan</command-message>'),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('latest user row stamped permissionMode plan → restores', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [
        userTextRow('first', { permissionMode: 'default' }),
        userTextRow('in plan now', { permissionMode: 'plan' }),
      ],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('invalid stored mode string falls to the transcript lane', () => {
    // Official R(): non-normalizable string → "invalid"; invalid behaves like
    // absent (transcript scan decides).
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: 'garbage-mode',
      messages: [attachmentRow('plan_mode')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored?.mode).toBe('plan')
  })

  test('startupModePinned → no restore even with an open transcript', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: 'plan',
      messages: [attachmentRow('plan_mode')],
      forkSession: false,
      startupModePinned: true,
    })

    expect(restored).toBeUndefined()
  })

  test('forkSession → no restore', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [attachmentRow('plan_mode')],
      forkSession: true,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('current mode already plan → no restore (eligibility E fails)', () => {
    const restored = planModeOnInteractiveResume(makeContext({ mode: 'plan' }), {
      storedPermissionMode: undefined,
      messages: [attachmentRow('plan_mode')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('deny rule on ExitPlanMode → no restore (eligibility E fails)', () => {
    // Official E(): !_s(ctx,U2) — an alwaysDenyRules entry matching
    // ExitPlanMode disables the restore.
    const restored = planModeOnInteractiveResume(
      makeContext({
        alwaysDenyRules: { cliArg: ['ExitPlanMode'] },
      } as Partial<ToolPermissionContext>),
      {
        storedPermissionMode: undefined,
        messages: [attachmentRow('plan_mode')],
        forkSession: false,
        startupModePinned: false,
      },
    )

    expect(restored).toBeUndefined()
  })

  test('empty transcript + absent stored mode → no restore', () => {
    const restored = planModeOnInteractiveResume(makeContext(), {
      storedPermissionMode: undefined,
      messages: [],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeUndefined()
  })

  test('restored context preserves the other context fields', () => {
    const ctx = makeContext({ mode: 'acceptEdits' })

    const restored = planModeOnInteractiveResume(ctx, {
      storedPermissionMode: undefined,
      messages: [attachmentRow('plan_mode')],
      forkSession: false,
      startupModePinned: false,
    })

    expect(restored).toBeDefined()
    expect(restored!.mode).toBe('plan')
    expect(restored!.alwaysDenyRules).toEqual(ctx.alwaysDenyRules)
    expect(restored!.alwaysAllowRules).toEqual(ctx.alwaysAllowRules)
  })
})
