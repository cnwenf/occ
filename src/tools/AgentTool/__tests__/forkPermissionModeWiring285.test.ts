/**
 * CC 2.1.285 (security): fork permission-mode inheritance — WIRING test.
 *
 * The sibling forkPermissionMode285.test.ts pins the PURE helpers
 * (resolveAgentEffectivePermissionMode / resolveShouldAvoidPermissionPrompts).
 * This file pins the PRODUCTION WIRING: that runAgent's agentGetAppState
 * closure actually threads the inheritance into the subagent's built
 * toolPermissionContext, and that shouldAvoidPermissionPrompts resolves
 * through the same built context.
 *
 * Seam: runAgent's `onCacheSafeParams` callback receives the fully-built
 * agentToolUseContext BEFORE the query loop starts (runAgent.ts:937-950).
 * Capturing that context and invoking its getAppState() exercises the REAL
 * production agentGetAppState closure — no mocking of the inheritance logic.
 *
 * query() is mocked to an empty generator so runAgent completes without a
 * live API key. executeSubagentStartHooks and session-storage writes are
 * mocked to avoid real hook execution and disk I/O.
 *
 * Mutation target (reviewer probe test-03): runAgent.ts:583 — replacing
 * `resolveAgentEffectivePermissionMode(...)` with bare `agentPermissionMode`
 * drops the plan/dontAsk inheritance. These tests kill that mutant: the
 * captured subagent app state would expose mode 'bubble' instead of the
 * inherited 'plan'.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE importing runAgent so its transitive
// imports of query.js / hooks.js / sessionStorage.js resolve to the stubs.
// ---------------------------------------------------------------------------

let capturedQueryContext: unknown = null

const realQueryModule = await import('../../../query.js')
mock.module('../../../query.js', () => ({
  ...realQueryModule,
  // Intentionally empty async generator — runAgent's for-await loop must
  // complete immediately after the capture below; yielding nothing is the
  // point, not an oversight.
  // biome-ignore lint/correctness/useYield: empty generator by design
  query: async function* (params: Record<string, unknown>) {
    // Belt-and-suspenders capture (onCacheSafeParams is the primary seam).
    capturedQueryContext = params.toolUseContext
    // Empty generator — runAgent's for-await loop completes immediately.
  },
}))

const realHooksModule = await import('../../../utils/hooks.js')
mock.module('../../../utils/hooks.js', () => ({
  ...realHooksModule,
  executeSubagentStartHooks: async function* () {
    // No hooks configured — yields nothing.
  },
}))

// NOTE: sessionStorage.js is NOT mocked — runAgent's recordSidechainTranscript
// and writeAgentMetadata calls are fire-and-forget with .catch(), so real disk
// I/O failures are harmless. Mocking it would leak into resumeAgentPrompt.test.ts
// (Bun's mock.module crosses file boundaries in the same worker — OCC-97).

// ---------------------------------------------------------------------------
// Imports (resolved AFTER mocks are registered)
// ---------------------------------------------------------------------------

import {
  resetStateForTests,
  setIsInteractive,
  setPermissionPromptToolName,
} from '../../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AppState } from '../../../state/AppStateStore.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../../utils/fileStateCache.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import { FORK_AGENT } from '../forkSubagent.js'
import { runAgent } from '../runAgent.js'

// ---------------------------------------------------------------------------
// Restore real modules after all tests in this file complete.
// ---------------------------------------------------------------------------
afterAll(() => {
  mock.module('../../../query.js', () => realQueryModule)
  mock.module('../../../utils/hooks.js', () => realHooksModule)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal parent AppState carrying only the fields agentGetAppState reads. */
function makeParentAppState(mode: string): AppState {
  return {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: mode as AppState['toolPermissionContext']['mode'],
    },
    effortValue: undefined,
  } as unknown as AppState
}

/** Minimal parent ToolUseContext sufficient for runAgent's pre-query path. */
function makeParentContext(parentMode: string): ToolUseContext {
  const state = makeParentAppState(parentMode)
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-20250514',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' as const },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    messages: [],
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
    discoveredSkillNames: new Set<string>(),
  } as unknown as ToolUseContext
}

/**
 * Drive runAgent to completion and return the built agentToolUseContext.
 *
 * Primary capture: `onCacheSafeParams` (called at runAgent.ts:937, BEFORE the
 * query loop). Fallback: the query mock captures params.toolUseContext.
 * Either way the returned context carries the REAL agentGetAppState closure.
 */
async function captureForkContext(opts: {
  parentMode: string
  isAsync?: boolean
  agentDefinition?: Parameters<typeof runAgent>[0]['agentDefinition']
  canShowPermissionPrompts?: boolean
}): Promise<ToolUseContext> {
  let captured: ToolUseContext | null = null
  capturedQueryContext = null

  const parentContext = makeParentContext(opts.parentMode)
  const gen = runAgent({
    agentDefinition: opts.agentDefinition ?? FORK_AGENT,
    promptMessages: [],
    toolUseContext: parentContext,
    canUseTool: (async () => ({
      behavior: 'allow',
      updatedInput: {},
    })) as never,
    isAsync: opts.isAsync ?? false,
    canShowPermissionPrompts: opts.canShowPermissionPrompts,
    querySource: 'agent:builtin:fork',
    availableTools: [],
    useExactTools: true,
    override: {
      userContext: {},
      systemContext: {},
      systemPrompt: 'wiring-test-prompt' as unknown as SystemPrompt,
    },
    subagentDepth: 1,
    onCacheSafeParams: params => {
      captured = params.toolUseContext
    },
  })

  // Drive the generator. The query mock returns an empty generator so this
  // completes immediately. If the mock didn't take effect (module already
  // cached by another test file), query fails without an API key — the
  // context was already captured via onCacheSafeParams, so we can assert.
  try {
    for await (const _msg of gen) {
      // no messages expected
    }
  } catch {
    // Tolerated — see comment above.
  }

  const ctx = captured ?? (capturedQueryContext as ToolUseContext | null)
  if (!ctx) {
    throw new Error(
      'Failed to capture agent context — runAgent did not reach ' +
        'onCacheSafeParams or the query mock',
    )
  }
  return ctx
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAgent wiring: fork permission-mode inheritance (CC 2.1.285)', () => {
  beforeEach(() => {
    if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
    resetStateForTests()
    capturedQueryContext = null
  })

  afterEach(() => {
    resetStateForTests()
    capturedQueryContext = null
  })

  test('fork under plan mode: built context inherits plan (not bubble)', async () => {
    // Parent session is in plan mode; FORK_AGENT declares permissionMode
    // 'bubble'. The 2.1.285 fix makes the fork INHERIT 'plan' so it cannot
    // escape plan mode.
    const ctx = await captureForkContext({ parentMode: 'plan' })

    // Invoke the REAL production agentGetAppState closure.
    const builtState = ctx.getAppState()

    // Effective mode must be 'plan' (inherited), NOT 'bubble' (declared).
    expect(builtState.toolPermissionContext.mode).toBe('plan')
    // Fork (declared bubble) should NOT auto-deny permission prompts.
    expect(
      builtState.toolPermissionContext.shouldAvoidPermissionPrompts,
    ).toBeUndefined()
  })

  test('fork under dontAsk mode: built context inherits dontAsk', async () => {
    const ctx = await captureForkContext({ parentMode: 'dontAsk' })
    const builtState = ctx.getAppState()
    expect(builtState.toolPermissionContext.mode).toBe('dontAsk')
  })

  test('fork under default mode: built context keeps declared bubble', async () => {
    // Parent is 'default' — the bubble-inheritance branch only fires for
    // plan/dontAsk, so the declared 'bubble' mode is kept.
    const ctx = await captureForkContext({ parentMode: 'default' })
    const builtState = ctx.getAppState()
    expect(builtState.toolPermissionContext.mode).toBe('bubble')
  })

  test('shouldAvoidPermissionPrompts resolves through the built context (sync fork)', async () => {
    // Sync fork under plan mode. The shouldAvoidPrompts branch is keyed on
    // the DECLARED mode ('bubble'), not the effective mode ('plan'). Bubble
    // agents always prompt → shouldAvoidPermissionPrompts stays unset.
    const ctx = await captureForkContext({
      parentMode: 'plan',
      isAsync: false,
    })
    const builtState = ctx.getAppState()

    expect(builtState.toolPermissionContext.mode).toBe('plan')
    expect(
      builtState.toolPermissionContext.shouldAvoidPermissionPrompts,
    ).toBeUndefined()
  })

  test('async fork in print mode with prompt tool: prompts route to tool, not auto-denied', async () => {
    // CC 2.1.285: "Fixed `claude -p --permission-prompt-tool` background
    // subagent permission requests being auto-denied." With a prompt tool
    // configured, shouldAvoidPermissionPrompts stays false so the request
    // routes to the prompt tool.
    setIsInteractive(false)
    setPermissionPromptToolName('mcp__foo__prompt')

    const ctx = await captureForkContext({
      parentMode: 'plan',
      isAsync: true,
    })
    const builtState = ctx.getAppState()

    // Effective mode still inherits plan.
    expect(builtState.toolPermissionContext.mode).toBe('plan')
    // Bubble + print-mode-with-prompt-tool → shouldAvoidPrompts = false.
    expect(
      builtState.toolPermissionContext.shouldAvoidPermissionPrompts,
    ).toBeUndefined()
    // Async + !shouldAvoidPrompts → awaitAutomatedChecksBeforeDialog = true.
    expect(
      builtState.toolPermissionContext.awaitAutomatedChecksBeforeDialog,
    ).toBe(true)
  })
})
