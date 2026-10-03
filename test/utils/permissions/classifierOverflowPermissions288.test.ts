import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.288 #65 — permissions.ts classifier-overflow branch (official v288
 * consumer delta recovered byte-verbatim from the 2.1.288 linux-x64 ELF,
 * perm region: registration `ri=$At()?zEt(...):void 0`, requested-only
 * telemetry, the Xr deny+compact arm BEFORE the headless throw, and the
 * unchanged v287 fallback when nothing registered).
 *
 * These tests drive the REAL hasPermissionsToUseTool with a mocked
 * classifyYoloAction returning {shouldBlock:true, transcriptTooLong:true}.
 */

const events: Array<{ name: string; metadata: Record<string, unknown> }> = []
let merryPopcorn = true
let classifierResponse: Record<string, unknown> = {
  shouldBlock: true,
  transcriptTooLong: true,
  unavailable: false,
}

const actualAnalytics = await import('src/services/analytics/index.js')
const actualGrowthbook = await import('src/services/analytics/growthbook.js')
const actualYolo = await import('src/utils/permissions/yoloClassifier.js')

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
mock.module('src/utils/permissions/yoloClassifier.js', () => ({
  ...actualYolo,
  classifyYoloAction: async () => classifierResponse,
}))

afterAll(() => {
  mock.module('src/services/analytics/index.js', () => ({
    ...actualAnalytics,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...actualGrowthbook,
  }))
  mock.module('src/utils/permissions/yoloClassifier.js', () => ({
    ...actualYolo,
  }))
})

const { hasPermissionsToUseTool } = await import(
  'src/utils/permissions/permissions.js'
)
const {
  _resetClassifierOverflowForTesting,
  takeClassifierOverflowPending,
} = await import('src/utils/permissions/classifierOverflowPending.js')
const { CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON } = await import(
  'src/utils/messages.js'
)
const { sanitizeToolNameForAnalytics } = await import(
  'src/services/analytics/metadata.js'
)

import type { Tool, ToolUseContext } from 'src/Tool.js'
import type { AssistantMessage, Message } from 'src/types/message.js'

const JOR_REASON =
  'Auto mode classifier transcript exceeded context window; will try to compact the conversation before the next request'

function createProbeTool(name = 'OverflowProbe'): Tool {
  // checkPermissions returns 'ask' in every mode so the auto-mode branch and
  // the acceptEdits fast-path probe both fall through to the classifier.
  return {
    name,
    userFacingName: () => name,
    inputSchema: {
      parse: (i: unknown) => i,
      safeParse: (i: unknown) => ({ success: true, data: i }),
    },
    checkPermissions: async () => ({
      behavior: 'ask' as const,
      message: 'Probe requires approval',
    }),
    description: async () => name,
    isMcp: false,
  } as unknown as Tool
}

function createContext(options: {
  mode?: string
  headless?: boolean
  epoch?: string
  agentId?: string
}): ToolUseContext {
  const messages = [
    {
      uuid: options.epoch ?? 'epoch-A',
      type: 'user',
      message: { role: 'user', content: 'hi' },
    },
  ] as unknown as Message[]
  return {
    agentId: options.agentId,
    messages,
    abortController: { signal: { aborted: false } },
    getAppState: () => ({
      toolPermissionContext: {
        mode: options.mode ?? 'auto',
        shouldAvoidPermissionPrompts: options.headless ?? false,
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
      },
      denialTracking: undefined,
    }),
    setAppState: (_fn: (prev: unknown) => unknown) => {},
    options: { isNonInteractiveSession: false, tools: [] },
    localDenialTracking: undefined,
  } as unknown as ToolUseContext
}

function createAssistantMessage(): AssistantMessage {
  return {
    message: { id: 'test-msg-id', content: [] },
  } as unknown as AssistantMessage
}

// Mirrors the per-turn autocompact check (official yHr → LFo → qEt) that
// primes canCompact=true so the overflow branch can register a pending
// compaction request.
function primeCanCompact(ctx: ToolUseContext, mode = 'auto'): void {
  takeClassifierOverflowPending(ctx, ctx.messages, mode, true)
}

function overflowEvents() {
  return events.filter(
    e => e.name === 'tengu_auto_mode_classifier_overflow_compact',
  )
}

async function runProbe(ctx: ToolUseContext, toolName = 'OverflowProbe') {
  return hasPermissionsToUseTool(
    createProbeTool(toolName),
    { action: 'probe' },
    ctx,
    createAssistantMessage(),
    `tool-use-${Math.random().toString(36).slice(2)}`,
  )
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY ??= 'test-placeholder'
  events.length = 0
  merryPopcorn = true
  classifierResponse = {
    shouldBlock: true,
    transcriptTooLong: true,
    unavailable: false,
  }
  _resetClassifierOverflowForTesting()
})

describe('CC 2.1.288 #65: classifier overflow → deny+compact arm', () => {
  test('overflow + canCompact → deny with jor reason, verbatim deny+compact message, requested telemetry', async () => {
    // Arrange
    const ctx = createContext({})
    primeCanCompact(ctx)
    // Act
    const result = await runProbe(ctx)
    // Assert
    expect(result.behavior).toBe('deny')
    const deny = result as {
      message?: string
      decisionReason?: Record<string, unknown>
    }
    expect(deny.decisionReason).toEqual({
      type: 'classifier',
      classifier: 'auto-mode',
      reason: JOR_REASON,
      noVerdict: true,
    })
    expect(deny.message).toBe(
      "OverflowProbe was not reviewed and did not run: the conversation is too long for auto mode's classifier. Claude Code will try to compact the conversation before the next request; if this action is still needed after that, issue it again and it will be reviewed normally.",
    )
    expect(overflowEvents()).toEqual([
      {
        name: 'tengu_auto_mode_classifier_overflow_compact',
        metadata: {
          stage: 'requested',
          arm: 'deny',
          toolName: sanitizeToolNameForAnalytics('OverflowProbe'),
          isMcp: false,
          isSubagent: false,
          headless: false,
          serverPath: false,
        },
      },
    ])
  })

  test('pending is registered with the denied tool name for the autocompact consumer', async () => {
    // Arrange
    const ctx = createContext({})
    primeCanCompact(ctx)
    // Act
    await runProbe(ctx)
    // Assert — qEt take reveals the registered pending
    const taken = takeClassifierOverflowPending(
      ctx,
      ctx.messages,
      'auto',
      true,
    )
    expect(taken.pending?.epoch).toBe('epoch-A')
    expect(taken.pending?.mode).toBe('auto')
    expect(taken.pending?.deniedToolNames).toEqual(['OverflowProbe'])
  })

  test('second overflow in the same epoch joins without a second requested event', async () => {
    // Arrange
    const ctx = createContext({})
    primeCanCompact(ctx)
    await runProbe(ctx, 'ToolOne')
    // Act
    await runProbe(ctx, 'ToolTwo')
    // Assert — only ONE requested telemetry event; denied names accumulate
    expect(overflowEvents().length).toBe(1)
    const taken = takeClassifierOverflowPending(
      ctx,
      ctx.messages,
      'auto',
      true,
    )
    expect(taken.pending?.deniedToolNames).toEqual(['ToolOne', 'ToolTwo'])
  })

  test('subagent overflow reports isSubagent:true', async () => {
    // Arrange
    const ctx = createContext({ agentId: 'agent-1' })
    primeCanCompact(ctx)
    // Act
    await runProbe(ctx)
    // Assert
    expect(overflowEvents()[0].metadata.isSubagent).toBe(true)
  })

  test('headless with a registered pending returns deny+compact instead of throwing (Xr arm precedes the throw)', async () => {
    // Arrange
    const ctx = createContext({ headless: true })
    primeCanCompact(ctx)
    // Act
    const result = await runProbe(ctx)
    // Assert
    expect(result.behavior).toBe('deny')
    expect(overflowEvents()[0].metadata.headless).toBe(true)
    expect(overflowEvents()[0].metadata.stage).toBe('requested')
  })

  test('headless WITHOUT a registerable pending still throws the verbatim AbortError (registration happens first)', async () => {
    // Arrange — no primeCanCompact: registry canCompact is unset so zEt
    // returns undefined and the v287 headless throw stays reachable.
    const ctx = createContext({ headless: true })
    // Act / Assert
    await expect(runProbe(ctx)).rejects.toThrow(
      'Agent aborted: auto mode classifier transcript exceeded context window in headless mode',
    )
    expect(overflowEvents().length).toBe(0)
  })

  test('flag off → unchanged v287 behavior: fall through to normal permission handling with the Ret reason', async () => {
    // Arrange
    merryPopcorn = false
    const ctx = createContext({})
    primeCanCompact(ctx)
    // Act
    const result = await runProbe(ctx)
    // Assert — the ask result passes through with the v287 decisionReason
    expect(result.behavior).toBe('ask')
    const asked = result as { decisionReason?: Record<string, unknown> }
    expect(asked.decisionReason).toEqual({
      type: 'other',
      reason: CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
    })
    expect(overflowEvents().length).toBe(0)
    const taken = takeClassifierOverflowPending(
      ctx,
      ctx.messages,
      'auto',
      true,
    )
    expect(taken.pending).toBeUndefined()
  })

  test('no canCompact prime (compaction unavailable) → v287 fallback even with the flag on', async () => {
    // Arrange
    const ctx = createContext({})
    // Act
    const result = await runProbe(ctx)
    // Assert
    expect(result.behavior).toBe('ask')
    const asked = result as { decisionReason?: Record<string, unknown> }
    expect(asked.decisionReason).toEqual({
      type: 'other',
      reason: CLASSIFIER_TRANSCRIPT_TOO_LONG_REASON,
    })
    expect(overflowEvents().length).toBe(0)
  })
})
