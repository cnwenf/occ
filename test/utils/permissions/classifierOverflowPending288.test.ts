import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.288 #65 — auto mode classifier overflow now compacts.
 *
 * Unit tests for the pending-registry module (official symbols recovered
 * byte-verbatim from the 2.1.288 linux-x64 ELF):
 *   zEt/qEt/KEt/$Me/WEt/NMe (@208315655), $At gate (@208550061),
 *   LFo consumer / ojt post-compact / TY not-run handler (@209130xxx),
 *   VHt reminder builder (@209096408), jor reason constant.
 */

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
const otelEvents: Array<{
  name: string
  metadata: Record<string, string | undefined>
}> = []
let merryPopcorn = true

const actualAnalytics = await import('src/services/analytics/index.js')
const actualGrowthbook = await import('src/services/analytics/growthbook.js')
const actualTelemetry = await import('src/utils/telemetry/events.js')

mock.module('src/services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    events.push({ name, metadata: metadata ?? {} })
  },
}))
mock.module('src/services/analytics/growthbook.js', () => ({
  ...actualGrowthbook,
  getFeatureValue_CACHED_MAY_BE_STALE: (
    featureName: string,
    defaultValue: unknown,
  ) =>
    featureName === 'tengu_merry_popcorn'
      ? merryPopcorn
      : actualGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE(
          featureName,
          defaultValue,
        ),
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

afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
  mock.module('src/utils/telemetry/events.js', () => ({
    ...actualTelemetry,
  }))
})

const {
  CLASSIFIER_OVERFLOW_COMPACT_REASON,
  OVERFLOW_COMPACT_TELEMETRY_EVENT,
  _resetClassifierOverflowForTesting,
  buildOverflowCompactDenyMessage,
  buildOverflowCompactReminder,
  consumeClassifierOverflowForCompaction,
  finalizeOverflowCompaction,
  isClassifierOverflowCompactEnabled,
  registerClassifierOverflowPending,
  reportOverflowCompactionNotRun,
  takeClassifierOverflowPending,
} = await import('src/utils/permissions/classifierOverflowPending.js')

const {
  setAutoModeActive,
  setPlanModeAutoBashActive,
  _resetForTesting: resetAutoModeState,
  _resetPlanModeAutoBashForTesting: resetPlanModeAutoBash,
} = await import('src/utils/permissions/autoModeState.js')

import type { ToolUseContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'

function makeMessages(epoch: string): Message[] {
  return [
    { uuid: epoch, type: 'user', message: { role: 'user', content: 'hi' } },
  ] as unknown as Message[]
}

function makeContext(mode: string, agentId?: string): ToolUseContext {
  return {
    agentId,
    getAppState: () => ({
      toolPermissionContext: { mode },
    }),
  } as unknown as ToolUseContext
}

function overflowEvents() {
  return events.filter(e => e.name === OVERFLOW_COMPACT_TELEMETRY_EVENT)
}

function overflowOtel() {
  return otelEvents.filter(e => e.name === 'compact_classifier_overflow')
}

beforeEach(() => {
  events.length = 0
  otelEvents.length = 0
  merryPopcorn = true
  _resetClassifierOverflowForTesting()
  resetAutoModeState()
  resetPlanModeAutoBash()
})

describe('$At gate (tengu_merry_popcorn, default true)', () => {
  test('is enabled by default', () => {
    // Arrange / Act / Assert
    expect(isClassifierOverflowCompactEnabled()).toBe(true)
  })

  test('is disabled when the flag resolves false', () => {
    // Arrange
    merryPopcorn = false
    // Act / Assert
    expect(isClassifierOverflowCompactEnabled()).toBe(false)
  })
})

describe('zEt registration semantics', () => {
  test('registers "requested" when canCompact was primed and epoch is fresh', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    // Act
    const outcome = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Assert
    expect(outcome).toBe('requested')
    const taken = takeClassifierOverflowPending(ctx, messages, 'auto', true)
    expect(taken.pending).toBeDefined()
    expect(taken.pending?.epoch).toBe('epoch-A')
    expect(taken.pending?.deniedToolNames).toEqual(['Bash'])
    expect(taken.stale).toBeUndefined()
  })

  test('returns undefined without a primed canCompact entry', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    // Act
    const outcome = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Assert
    expect(outcome).toBeUndefined()
  })

  test('returns undefined when messages have no epoch (empty transcript)', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    // Act
    const outcome = registerClassifierOverflowPending(ctx, [], {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Assert
    expect(outcome).toBeUndefined()
  })

  test('second overflow in the same epoch returns "joined" and accumulates deniedToolNames', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const second = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Write',
      denied: true,
      mode: 'auto',
    })
    // Assert
    expect(second).toBe('joined')
    const taken = takeClassifierOverflowPending(ctx, messages, 'auto', true)
    expect(taken.pending?.deniedToolNames).toEqual(['Bash', 'Write'])
    expect(taken.pending?.toolName).toBe('Bash')
  })

  test('a new epoch starts a fresh pending ("requested" again)', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act — qEt refresh with the NEW epoch first (next turn's autocompact check)
    takeClassifierOverflowPending(ctx, makeMessages('epoch-B'), 'auto', true)
    const outcome = registerClassifierOverflowPending(
      ctx,
      makeMessages('epoch-B'),
      { toolName: 'Write', denied: true, mode: 'auto' },
    )
    // Assert
    expect(outcome).toBe('requested')
  })

  test('spentEpoch blocks re-registration for the same epoch', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    const taken = takeClassifierOverflowPending(ctx, messages, 'auto', true)
    // Act — KEt after a failed compaction marks the epoch spent
    reportOverflowCompactionNotRun(ctx, taken.pending!, {
      kind: 'failed',
      reason: 'error',
    })
    const again = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Assert
    expect(again).toBeUndefined()
  })

  test('subagent registry is keyed separately from main', () => {
    // Arrange
    const main = makeContext('auto')
    const sub = makeContext('auto', 'agent-1')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(main, messages, 'auto', true)
    takeClassifierOverflowPending(sub, messages, 'auto', true)
    // Act
    registerClassifierOverflowPending(main, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Assert — subagent has no pending
    const subTaken = takeClassifierOverflowPending(sub, messages, 'auto', true)
    expect(subTaken.pending).toBeUndefined()
  })
})

describe('qEt take semantics', () => {
  test('reports stale:"epoch" when the transcript epoch moved on', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const taken = takeClassifierOverflowPending(
      ctx,
      makeMessages('epoch-B'),
      'auto',
      true,
    )
    // Assert
    expect(taken.stale).toBe('epoch')
    expect(taken.pending?.epoch).toBe('epoch-A')
  })

  test('reports stale:"mode" when the permission mode changed', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const taken = takeClassifierOverflowPending(
      ctx,
      makeMessages('epoch-A'),
      'default',
      true,
    )
    // Assert
    expect(taken.stale).toBe('mode')
  })
})

describe('LFo consumer (consumeClassifierOverflowForCompaction)', () => {
  test('returns the pending request when fresh and canCompact', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      ctx,
      messages,
      true,
    )
    // Assert
    expect(pending?.deniedToolNames).toEqual(['Bash'])
    expect(overflowEvents().length).toBe(0)
  })

  test('drops a stale-epoch pending with dropped/stale telemetry', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      ctx,
      makeMessages('epoch-B'),
      true,
    )
    // Assert
    expect(pending).toBeUndefined()
    expect(overflowEvents()).toEqual([
      {
        name: OVERFLOW_COMPACT_TELEMETRY_EVENT,
        metadata: {
          stage: 'dropped',
          reason: 'stale',
          isSubagent: false,
        },
      },
    ])
    expect(overflowOtel()).toEqual([
      {
        name: 'compact_classifier_overflow',
        metadata: { outcome: 'skip', reason: 'stale' },
      },
    ])
  })

  test('drops a pending whose mode left auto (left_auto_mode)', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    const leftCtx = makeContext('default')
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      leftCtx,
      makeMessages('epoch-A'),
      true,
    )
    // Assert
    expect(pending).toBeUndefined()
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'dropped',
      reason: 'left_auto_mode',
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'skip',
      reason: 'left_auto_mode',
    })
  })

  test('mode change into plan+autoModeActive is NOT a left_auto_mode drop (qi)', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    setAutoModeActive(true)
    const planCtx = makeContext('plan')
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      planCtx,
      makeMessages('epoch-A'),
      true,
    )
    // Assert — still auto-like, pending survives
    expect(pending?.deniedToolNames).toEqual(['Bash'])
    expect(overflowEvents().length).toBe(0)
  })

  test('mode change into plan+planModeAutoBash is NOT a left_auto_mode drop', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    setPlanModeAutoBashActive(true)
    const planCtx = makeContext('plan')
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      planCtx,
      makeMessages('epoch-A'),
      true,
    )
    // Assert
    expect(pending?.deniedToolNames).toEqual(['Bash'])
  })

  test('compaction unavailable → TY skipped/unavailable, pending cleared, epoch spent', () => {
    // Arrange
    const ctx = makeContext('auto')
    const messages = makeMessages('epoch-A')
    takeClassifierOverflowPending(ctx, messages, 'auto', true)
    registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    const pending = consumeClassifierOverflowForCompaction(
      ctx,
      messages,
      false,
    )
    // Assert
    expect(pending).toBeUndefined()
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'skipped',
      reason: 'unavailable',
      deniedCalls: 1,
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'skip',
      reason: 'unavailable',
    })
    // Pending cleared + spentEpoch blocks re-registration for this epoch
    const again = registerClassifierOverflowPending(ctx, messages, {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    expect(again).toBeUndefined()
  })

  test('isSubagent is true for a subagent context', () => {
    // Arrange
    const ctx = makeContext('auto', 'agent-1')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    registerClassifierOverflowPending(ctx, makeMessages('epoch-A'), {
      toolName: 'Bash',
      denied: true,
      mode: 'auto',
    })
    // Act
    consumeClassifierOverflowForCompaction(ctx, makeMessages('epoch-B'), true)
    // Assert
    expect(overflowEvents()[0].metadata.isSubagent).toBe(true)
  })
})

describe('ojt finalize (finalizeOverflowCompaction)', () => {
  const baseResult = {
    boundaryMarker: { uuid: 'boundary' },
    summaryMessages: [],
    attachments: [{ uuid: 'pre-existing' }],
    hookResults: [],
    preCompactTokenCount: 120000,
    postCompactTokenCount: 9000,
    truePostCompactTokenCount: 9500,
  }

  test('appends the VHt reminder, emits compacted telemetry + success OTEL, keeps prior attachments', () => {
    // Arrange
    const ctx = makeContext('auto')
    const pending = {
      epoch: 'epoch-A',
      mode: 'auto',
      toolName: 'Bash',
      deniedToolNames: ['Bash', 'Write'],
    }
    // Act
    const result = finalizeOverflowCompaction(
      ctx,
      pending,
      baseResult as never,
    )
    // Assert — immutable: prior attachment kept, reminder appended
    expect(result.attachments.length).toBe(2)
    expect((result.attachments[0] as { uuid: string }).uuid).toBe(
      'pre-existing',
    )
    const reminder = result.attachments[1] as unknown as {
      type: string
      attachment: { type: string; content: string }
    }
    expect(reminder.type).toBe('attachment')
    expect(reminder.attachment.type).toBe('critical_system_reminder')
    expect(reminder.attachment.content).toBe(
      'Auto mode could not review 2 earlier tool calls (Bash, Write) because the conversation was too long for its classifier, so those calls did not run. The conversation has now been compacted. If still needed, issue them again and they will be reviewed normally.',
    )
    expect(baseResult.attachments.length).toBe(1)
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
})

describe('TY not-run handler (reportOverflowCompactionNotRun)', () => {
  const pending = {
    epoch: 'epoch-A',
    mode: 'auto',
    toolName: 'Bash',
    deniedToolNames: ['Bash'],
  }

  test('failed/error → failed telemetry, failure OTEL, spentEpoch set', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    // Act
    reportOverflowCompactionNotRun(ctx, pending, {
      kind: 'failed',
      reason: 'error',
    })
    // Assert
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
    const blocked = registerClassifierOverflowPending(
      ctx,
      makeMessages('epoch-A'),
      { toolName: 'Bash', denied: true, mode: 'auto' },
    )
    expect(blocked).toBeUndefined()
  })

  test('failed/aborted → skipped telemetry, skip OTEL, epoch NOT spent (retryable)', () => {
    // Arrange
    const ctx = makeContext('auto')
    takeClassifierOverflowPending(ctx, makeMessages('epoch-A'), 'auto', true)
    // Act
    reportOverflowCompactionNotRun(ctx, pending, {
      kind: 'failed',
      reason: 'aborted',
    })
    // Assert
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'skipped',
      reason: 'aborted',
      deniedCalls: 1,
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'skip',
      reason: 'aborted',
    })
    const retried = registerClassifierOverflowPending(
      ctx,
      makeMessages('epoch-A'),
      { toolName: 'Bash', denied: true, mode: 'auto' },
    )
    expect(retried).toBe('requested')
  })

  test('skipped/hook_blocked → skipped-stage telemetry with hook_blocked reason', () => {
    // Arrange
    const ctx = makeContext('auto')
    // Act
    reportOverflowCompactionNotRun(ctx, pending, {
      kind: 'skipped',
      reason: 'hook_blocked',
    })
    // Assert
    expect(overflowEvents()[0].metadata).toEqual({
      stage: 'skipped',
      reason: 'hook_blocked',
      deniedCalls: 1,
      isSubagent: false,
    })
    expect(overflowOtel()[0].metadata).toEqual({
      outcome: 'skip',
      reason: 'hook_blocked',
    })
  })
})

describe('VHt reminder builder (buildOverflowCompactReminder)', () => {
  test('zero denied calls → verbatim 0-denied text', () => {
    // Act
    const message = buildOverflowCompactReminder(0, []) as unknown as {
      attachment: { type: string; content: string }
    }
    // Assert
    expect(message.attachment.type).toBe('critical_system_reminder')
    expect(message.attachment.content).toBe(
      "The conversation was compacted because it had become too long for auto mode's classifier.",
    )
  })

  test('one denied call → verbatim singular text', () => {
    // Act
    const message = buildOverflowCompactReminder(1, ['Bash']) as unknown as {
      attachment: { type: string; content: string }
    }
    // Assert
    expect(message.attachment.content).toBe(
      'Auto mode could not review an earlier tool call (Bash) because the conversation was too long for its classifier, so that call did not run. The conversation has now been compacted. If still needed, issue it again and it will be reviewed normally.',
    )
  })

  test('multiple denied calls → verbatim plural text', () => {
    // Act
    const message = buildOverflowCompactReminder(2, [
      'Bash',
      'Write',
    ]) as unknown as { attachment: { type: string; content: string } }
    // Assert
    expect(message.attachment.content).toBe(
      'Auto mode could not review 2 earlier tool calls (Bash, Write) because the conversation was too long for its classifier, so those calls did not run. The conversation has now been compacted. If still needed, issue them again and they will be reviewed normally.',
    )
  })
})

describe('jor constant + deny message', () => {
  test('CLASSIFIER_OVERFLOW_COMPACT_REASON is the verbatim jor text', () => {
    expect(CLASSIFIER_OVERFLOW_COMPACT_REASON).toBe(
      'Auto mode classifier transcript exceeded context window; will try to compact the conversation before the next request',
    )
  })

  test('deny+compact arm message is verbatim', () => {
    expect(buildOverflowCompactDenyMessage('Bash')).toBe(
      "Bash was not reviewed and did not run: the conversation is too long for auto mode's classifier. Claude Code will try to compact the conversation before the next request; if this action is still needed after that, issue it again and it will be reviewed normally.",
    )
  })
})
