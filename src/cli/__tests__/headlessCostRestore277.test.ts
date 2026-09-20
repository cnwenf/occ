import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.277 (A10): headless resume (`occ -p --resume <id>`) started cost
 * totals at ZERO — the official v277 registers the print-lane cost-state
 * recorder at startup ($b(), gated on session persistence) so totals are
 * saved at exit, and restores them from the transcript on resume (mZ()).
 *
 * OCC's equivalent mechanism is the project-config persistence layer
 * (cost-tracker.ts saveCurrentSessionCosts / restoreCostStateForSession —
 * the same one the interactive REPL uses via useCostSummary's exit hook and
 * sessionRestore.ts). This test wires those existing helpers into the
 * headless path and verifies behavior through them.
 */

process.env.NODE_ENV = 'test'
delete process.env.CLAUDE_CODE_USE_CCR_V2
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.276',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

// -- Mock leaf collaborators (spread-real keeps every other export intact) --
// E-9/P2: snapshot real export values into plain objects BEFORE mocking —
// `await import()` namespaces are live bindings that become the fake once
// mock.module() installs (pattern: diskOutputDrainGuard247.test.ts).

const realRecovery = { ...(await import('../../utils/conversationRecovery.js')) }
let resumeResult: {
  sessionId: string
  messages: unknown[]
  fullPath?: string
} | null = null
mock.module('../../utils/conversationRecovery.js', () => ({
  ...realRecovery,
  loadConversationForResume: async () => resumeResult,
}))

const realSessionStorage = { ...(await import('../../utils/sessionStorage.js')) }
mock.module('../../utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  resetSessionFilePointer: async () => {},
  restoreSessionMetadata: () => {},
}))

const realSessionRestore = { ...(await import('../../utils/sessionRestore.js')) }
mock.module('../../utils/sessionRestore.js', () => ({
  ...realSessionRestore,
  restoreSessionStateFromLog: () => {},
  restoreAgentFromSession: () => {},
}))

const { loadInitialMessages, registerHeadlessCostSaveOnExit } = await import(
  '../print.js'
)
const {
  addToTotalCostState,
  getSessionId,
  getTotalCostUSD,
  resetStateForTests,
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY,
} = await import('../../bootstrap/state.js')
const { getCurrentProjectConfig } = await import('../../utils/config.js')
const { restoreCostStateForSession } = await import('../../cost-tracker.js')

const FAKE_MESSAGE = {
  uuid: 'msg-1',
  type: 'user',
  message: { role: 'user', content: 'hi' },
  timestamp: '2026-09-20T00:00:00.000Z',
}

function seedStoredCosts(sessionId: string, cost: number): void {
  Object.assign(getCurrentProjectConfig(), {
    lastSessionId: sessionId,
    lastCost: cost,
    lastModelUsage: undefined,
  })
}

async function runResume(): Promise<void> {
  await loadInitialMessages(() => {}, {
    continue: false,
    teleport: null,
    resume: SESSION_ID,
    resumeSessionAt: undefined,
    forkSession: false,
    outputFormat: 'text',
    restoredWorkerState: Promise.resolve(null),
  } as never)
}

beforeEach(() => {
  resetStateForTests()
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY()
  resumeResult = {
    sessionId: SESSION_ID,
    messages: [FAKE_MESSAGE],
    fullPath: undefined,
  }
  Object.assign(getCurrentProjectConfig(), {
    lastSessionId: undefined,
    lastCost: undefined,
    lastModelUsage: undefined,
  })
})

describe('A10: headless resume restores prior cost totals', () => {
  test('resume restores stored session costs instead of starting at zero', async () => {
    seedStoredCosts(SESSION_ID, 5)
    expect(getTotalCostUSD()).toBe(0)

    await runResume()

    expect(getTotalCostUSD()).toBe(5)
  })

  test('resume of a session that was never saved keeps totals at zero', async () => {
    seedStoredCosts('some-other-session', 9)

    await runResume()

    expect(getTotalCostUSD()).toBe(0)
  })

  test('restoreCostStateForSession returns false when session id does not match', () => {
    seedStoredCosts('some-other-session', 9)
    expect(restoreCostStateForSession(SESSION_ID)).toBe(false)
  })
})

describe('A10: headless exit saves cost totals', () => {
  test('exit hook persists accrued totals for a later resume', () => {
    registerHeadlessCostSaveOnExit()
    addToTotalCostState(
      2.5,
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 2.5,
        contextWindow: 200000,
        maxOutputTokens: 16384,
      },
      'claude-sonnet-4-20250514',
    )

    // Simulate process exit — the registered hook runs saveCurrentSessionCosts.
    process.emit('exit' as never, 0 as never)

    const saved = getCurrentProjectConfig()
    expect(saved.lastCost).toBe(2.5)
    expect(saved.lastSessionId).toBe(getSessionId())
  })

  test('saved totals round-trip through restore for the same session id', () => {
    registerHeadlessCostSaveOnExit()
    addToTotalCostState(
      1.25,
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 1.25,
        contextWindow: 200000,
        maxOutputTokens: 16384,
      },
      'claude-sonnet-4-20250514',
    )
    process.emit('exit' as never, 0 as never)

    const savedSessionId = getCurrentProjectConfig().lastSessionId
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY()
    expect(getTotalCostUSD()).toBe(0)

    expect(restoreCostStateForSession(savedSessionId as string)).toBe(true)
    expect(getTotalCostUSD()).toBe(1.25)
  })
})

// E-9/P2: restore every module-level mock.module() so the shared-process
// `npm test` run does not leak these fakes into later test files. Bun's
// mock.restore() does NOT undo mock.module — re-mock with the load-time real
// snapshots (same pattern as diskOutputDrainGuard247.test.ts).
afterAll(() => {
  mock.module('../../utils/conversationRecovery.js', () => ({
    ...realRecovery,
  }))
  mock.module('../../utils/sessionStorage.js', () => ({
    ...realSessionStorage,
  }))
  mock.module('../../utils/sessionRestore.js', () => ({ ...realSessionRestore }))
})
