import { describe, expect, test, mock, beforeEach } from 'bun:test'

/**
 * CC 2.1.211 item 3.2d: "Fixed `/clear` not resetting the session cost
 * counter — the statusline's cost now starts at $0 after `/clear`."
 *
 * Binary recon evidence:
 *   v210 clear flow (offset 246308466):
 *     `yield{type:"conversation_reset",newConversationId:erd.randomUUID()},
 *      jKo({setCurrentAsParent:!0}),Gtd(),...`
 *     — NO call to XUt() (resetCostState).
 *
 *   v211 clear flow (offset 247196786):
 *     `yield{type:"conversation_reset",newConversationId:jod.randomUUID()},
 *      sJo(),W7e(),pXo({setCurrentAsParent:!0}),Rod(),...`
 *     — W7e() IS resetCostState (confirmed via symbol table: resetCostState:()=>W7e).
 *
 * The v211 fix inserts sJo() (session-end callback) + W7e() (resetCostState)
 * into the clear-conversation flow. OCC's clearConversation already runs
 * session-end hooks; the missing piece is resetCostState().
 *
 * This test exercises the REAL clearConversation function with REAL
 * bootstrap/state cost tracking. Only leaf collaborators (hooks, session
 * storage, analytics, shell, etc.) are mocked — the cost state module
 * is NOT mocked, so the test proves the real code path.
 */

// -- Mock leaf collaborators (heavy modules with many transitive deps) --
// These are leaf collaborators per Stage 3 rules — they do I/O / external work.
// The cost-tracking state module (bootstrap/state) is intentionally NOT mocked.

mock.module('../../../src/utils/hooks.js', () => ({
  executeSessionEndHooks: async () => {},
  getSessionEndHookTimeoutMs: () => 1500,
}))

// analytics mock REMOVED — a process-wide `mock.module` here leaked into
// unrelated test files (agentTelemetry attaches a test sink via the real
// attachAnalyticsSink; the leaked mock replaced the module so the sink never
// captured events). The real logEvent is already a no-op stub in OCC, so no
// mock is needed here.

mock.module('../../../src/commands/clear/caches.js', () => ({
  clearSessionCaches: () => {},
}))

mock.module('../../../src/utils/Shell.js', () => ({
  setCwd: () => {},
}))

mock.module('../../../src/utils/plans.js', () => ({
  clearAllPlanSlugs: () => {},
}))

// sessionStorage mock REMOVED — leaked process-wide; the getAgentTranscriptPath: () => ''
// override broke resumeModel/resumeAgentPrompt agent-metadata path resolution. The
// real sessionStorage functions are safe (no heavy boot); clearConversation
// reads CLAUDE_CONFIG_DIR which the test sets.
mock.module('../../../src/utils/sessionStart.js', () => ({
  processSessionStartHooks: async () => [],
}))

mock.module('../../../src/utils/worktree.js', () => ({
  getCurrentWorktreeSession: () => null,
}))

mock.module('../../../src/utils/log.js', () => ({
  logError: () => {},
}))

mock.module('../../../src/utils/commitAttribution.js', () => ({
  createEmptyAttributionState: () => ({}),
}))

mock.module('../../../src/utils/task/diskOutput.js', () => ({
  evictTaskOutput: () => {},
  initTaskOutputAsSymlink: () => {},
}))

mock.module('../../../src/tasks/InProcessTeammateTask/types.js', () => ({
  isInProcessTeammateTask: () => false,
}))

mock.module('../../../src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  isLocalAgentTask: () => false,
}))

// LocalShellTask/guards.js mock REMOVED — `isLocalShellTask: () => false`
// leaked process-wide into killShellTasks.js, so backgroundShellStop's killTask
// skipped the local_bash treeKill/shellCommand.kill path (guard returned false).
// The real isLocalShellTask checks task.type === 'local_bash' — safe to use
// un-mocked here (clearConversation has no local_bash tasks in this suite).

// -- Real imports (NOT mocked) --
import {
  addToTotalCostState,
  getTotalCostUSD,
  resetStateForTests,
  resetTotalDurationStateAndCost_FOR_TESTS_ONLY,
} from '../../../src/bootstrap/state.js'
import type { ModelUsage } from '../../../src/entrypoints/agentSdkTypes.js'
import { clearConversation } from '../../../src/commands/clear/conversation.js'

const TEST_MODEL = 'claude-sonnet-4-20250514'

function accrueCost(amount: number): void {
  const modelUsage: ModelUsage = {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: amount,
    contextWindow: 200000,
    maxOutputTokens: 16384,
  }
  addToTotalCostState(amount, modelUsage, TEST_MODEL)
}

describe('CC 2.1.211 #3.2d: /clear resets session cost counter', () => {
  beforeEach(() => {
    resetStateForTests()
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY()
  })

  test('cost is $0 after /clear when cost was accrued', async () => {
    // Arrange: accrue cost
    accrueCost(1.23)
    accrueCost(0.45)
    expect(getTotalCostUSD()).toBe(1.68) // pre-clear: non-zero

    // Act: run real clearConversation
    await clearConversation({
      setMessages: () => {},
      readFileState: { clear: () => {} } as never,
    })

    // Assert: cost counter reset to $0
    expect(getTotalCostUSD()).toBe(0)
  })

  test('cost is $0 after /clear even with large accrued cost', async () => {
    // Arrange: accrue a large cost
    accrueCost(99.99)
    expect(getTotalCostUSD()).toBe(99.99) // pre-clear: non-zero

    // Act
    await clearConversation({
      setMessages: () => {},
      readFileState: { clear: () => {} } as never,
    })

    // Assert
    expect(getTotalCostUSD()).toBe(0)
  })

  test('cost stays $0 after /clear when no cost was accrued', async () => {
    // Arrange: no cost accrued
    expect(getTotalCostUSD()).toBe(0)

    // Act
    await clearConversation({
      setMessages: () => {},
      readFileState: { clear: () => {} } as never,
    })

    // Assert: still $0 (no regression)
    expect(getTotalCostUSD()).toBe(0)
  })
})
