import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.288 #65 — autoCompactIfNeeded consumer wiring (official yHr head:
 * `V=LFo(n,e,!K&&Df()&&g!==void 0&&!WO(g)&&!V$e(g)&&!qan(...))`; a pending
 * classifier-overflow forces compaction below the token threshold, bypasses
 * the failure circuit breaker, and the success result is wrapped via ojt —
 * VHt reminder attachment + compacted telemetry).
 */

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
const otelEvents: Array<{
  name: string
  metadata: Record<string, string | undefined>
}> = []
let compactCalls = 0
let compactError: Error | undefined

const actualAnalytics = await import('src/services/analytics/index.js')
const actualTelemetry = await import('src/utils/telemetry/events.js')
const actualCompact = await import('src/services/compact/compact.js')
const actualSessionMemory = await import(
  'src/services/compact/sessionMemoryCompact.js'
)

mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))
mock.module('src/utils/telemetry/events.js', () => ({
  ...actualTelemetry,
  logOTelEvent: async (
    name: string,
    metadata: Record<string, string | undefined> = {},
  ) => {
    otelEvents.push({ name, metadata })
  },
}))
mock.module('src/services/compact/compact.js', () => ({
  ...actualCompact,
  compactConversation: async () => {
    compactCalls++
    if (compactError) {
      throw compactError
    }
    return {
      boundaryMarker: { uuid: 'boundary-1' },
      summaryMessages: [],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 120000,
      postCompactTokenCount: 9000,
      truePostCompactTokenCount: 9500,
    }
  },
}))
mock.module('src/services/compact/sessionMemoryCompact.js', () => ({
  ...actualSessionMemory,
  trySessionMemoryCompaction: async () => null,
}))

afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
  mock.module('src/utils/telemetry/events.js', () => ({
    ...actualTelemetry,
  }))
  mock.module('src/services/compact/compact.js', () => ({
    ...actualCompact,
  }))
  mock.module('src/services/compact/sessionMemoryCompact.js', () => ({
    ...actualSessionMemory,
  }))
})

const { autoCompactIfNeeded } = await import(
  'src/services/compact/autoCompact.js'
)
const {
  _resetClassifierOverflowForTesting,
  registerClassifierOverflowPending,
  takeClassifierOverflowPending,
} = await import('src/utils/permissions/classifierOverflowPending.js')
const {
  _resetForTesting: resetAutoModeState,
} = await import('src/utils/permissions/autoModeState.js')

import type { ToolUseContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import type { CompactionResult } from 'src/services/compact/compact.js'

function makeMessages(epoch: string): Message[] {
  return [
    { uuid: epoch, type: 'user', message: { role: 'user', content: 'hi' } },
  ] as unknown as Message[]
}

function makeContext(mode = 'auto'): ToolUseContext {
  return {
    agentId: undefined,
    messages: makeMessages('epoch-A'),
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: { mode },
    }),
    options: { mainLoopModel: 'claude-sonnet-4-6' },
  } as unknown as ToolUseContext
}

const cacheSafeParams = {} as never

function overflowEvents() {
  return events.filter(
    e => e.name === 'tengu_auto_mode_classifier_overflow_compact',
  )
}

function overflowOtel() {
  return otelEvents.filter(e => e.name === 'compact_classifier_overflow')
}

// Registers a pending overflow compaction the way the permissions branch
// does after the per-turn autocompact check primed canCompact=true.
function seedPending(
  ctx: ToolUseContext,
  messages: Message[],
  deniedToolNames: string[],
): void {
  takeClassifierOverflowPending(ctx, messages, 'auto', true)
  for (const toolName of deniedToolNames) {
    registerClassifierOverflowPending(ctx, messages, {
      toolName,
      denied: true,
      mode: 'auto',
    })
  }
}

beforeEach(() => {
  events.length = 0
  otelEvents.length = 0
  compactCalls = 0
  compactError = undefined
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT
  _resetClassifierOverflowForTesting()
  resetAutoModeState()
})

describe('CC 2.1.288 #65: autoCompactIfNeeded overflow consumer', () => {
  test('no pending + below threshold → not_needed, unchanged v287 behavior', async () => {
    // Arrange
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    // Act
    const result = await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    expect(compactCalls).toBe(0)
    expect(overflowEvents().length).toBe(0)
  })

  test('pending forces compaction below the token threshold and appends the VHt reminder', async () => {
    // Arrange
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash', 'Write'])
    // Act
    const result = await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(compactCalls).toBe(1)
    expect(result.wasCompacted).toBe(true)
    const compactionResult = result.compactionResult as CompactionResult
    expect(compactionResult.attachments.length).toBe(1)
    const reminder = compactionResult.attachments[0] as unknown as {
      type: string
      attachment: { type: string; content: string }
    }
    expect(reminder.type).toBe('attachment')
    expect(reminder.attachment.type).toBe('critical_system_reminder')
    expect(reminder.attachment.content).toBe(
      'Auto mode could not review 2 earlier tool calls (Bash, Write) because the conversation was too long for its classifier, so those calls did not run. The conversation has now been compacted. If still needed, issue them again and they will be reviewed normally.',
    )
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'compacted',
      deniedCalls: 2,
      isSubagent: false,
      preCompactTokenCount: 120000,
      postCompactTokenCount: 9000,
      truePostCompactTokenCount: 9500,
    })
    expect(overflowOtel()[0].metadata).toEqual({ outcome: 'success' })
  })

  test('pending bypasses the consecutive-failure circuit breaker', async () => {
    // Arrange
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act — breaker would block a threshold compaction (3 >= MAX 3)
    const result = await autoCompactIfNeeded(messages, ctx, cacheSafeParams, 'repl_main_thread', {
      compacted: false,
      turnCounter: 1,
      turnId: 'turn-1',
      consecutiveFailures: 3,
    })
    // Assert
    expect(compactCalls).toBe(1)
    expect(result.wasCompacted).toBe(true)
  })

  test('stale epoch → dropped/stale telemetry, no compaction', async () => {
    // Arrange — pending registered for epoch-A, autocompact runs on epoch-B
    const ctx = makeContext()
    seedPending(ctx, makeMessages('epoch-A'), ['Bash'])
    // Act
    const result = await autoCompactIfNeeded(
      makeMessages('epoch-B'),
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    expect(compactCalls).toBe(0)
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'dropped',
      reason: 'stale',
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'skip',
      reason: 'stale',
    })
  })

  test('left auto mode → dropped/left_auto_mode telemetry, no compaction', async () => {
    // Arrange
    const ctx = makeContext()
    seedPending(ctx, makeMessages('epoch-A'), ['Bash'])
    const defaultCtx = makeContext('default')
    // Act
    const result = await autoCompactIfNeeded(
      makeMessages('epoch-A'),
      defaultCtx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    expect(compactCalls).toBe(0)
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'dropped',
      reason: 'left_auto_mode',
      isSubagent: false,
    })
  })

  test('compaction unavailable (auto-compact disabled) → skipped/unavailable, epoch spent', async () => {
    // Arrange
    process.env.DISABLE_AUTO_COMPACT = '1'
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act
    const result = await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    expect(compactCalls).toBe(0)
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'skipped',
      reason: 'unavailable',
      deniedCalls: 1,
      isSubagent: false,
    })
    // spentEpoch blocks re-registration for the same epoch
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    const blocked = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    expect(blocked).toBeUndefined()
  })

  test('compaction error → failed/error telemetry, failure OTEL, failure count increments', async () => {
    // Arrange
    compactError = new Error('boom')
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act
    const result = await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBe(1)
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'failed',
      reason: 'error',
      deniedCalls: 1,
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'failure',
      reason: 'error',
    })
  })

  test('user-abort error → skipped/aborted telemetry, epoch NOT spent (retryable)', async () => {
    // Arrange
    compactError = new Error(actualCompact.ERROR_MESSAGE_USER_ABORT)
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act
    const result = await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'repl_main_thread',
    )
    // Assert
    expect(result.wasCompacted).toBe(false)
    const telemetry = overflowEvents().map(e => e.metadata)
    expect(telemetry).toContainEqual({
      stage: 'skipped',
      reason: 'aborted',
      deniedCalls: 1,
      isSubagent: false,
    })
    // Epoch NOT spent — the next overflow re-registers
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    const retried = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    expect(retried).toBe('requested')
  })

  test('too-few-messages error with pending → failed/too_few_groups', async () => {
    // Arrange
    compactError = new Error(actualCompact.ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act
    await autoCompactIfNeeded(messages, ctx, cacheSafeParams, 'repl_main_thread')
    // Assert
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'failed',
      reason: 'too_few_groups',
      deniedCalls: 1,
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'failure',
      reason: 'too_few_groups',
    })
  })

  test('compact/session_memory forks do NOT consume or corrupt the parent pending', async () => {
    // Arrange
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act — a forked compact query re-enters with querySource 'compact'
    await autoCompactIfNeeded(messages, ctx, cacheSafeParams, 'compact')
    await autoCompactIfNeeded(messages, ctx, cacheSafeParams, 'session_memory')
    // Assert — pending survives untouched for the main loop
    const taken = takeClassifierOverflowPending(ctx, messages, 'auto', true)
    expect(taken.pending?.deniedToolNames).toEqual(['Bash'])
    expect(overflowEvents().length).toBe(0)
  })

  test('V$e query sources run the consumer with canCompact=false (skipped/unavailable)', async () => {
    // Arrange — official yHr computes canCompact=false for V$e sources
    // (prompt_suggestion/away_summary/agent_summary/hook_prompt); LFo then
    // reports skipped/unavailable when a pending exists.
    const ctx = makeContext()
    const messages = makeMessages('epoch-A')
    seedPending(ctx, messages, ['Bash'])
    // Act
    await autoCompactIfNeeded(
      messages,
      ctx,
      cacheSafeParams,
      'prompt_suggestion' as never,
    )
    // Assert
    expect(compactCalls).toBe(0)
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'skipped',
      reason: 'unavailable',
      deniedCalls: 1,
      isSubagent: false,
    })
  })
})
