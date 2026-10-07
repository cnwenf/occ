/**
 * CC 2.1.292 (occ149 P3): Agent tool `effort` parameter.
 *
 * Official 2.1.292 `Do` schema (@219359930) gained:
 *   effort:j(Hc).optional().describe("Reasoning effort for this agent. Set
 *     this ONLY when the user, or instructions such as CLAUDE.md or a skill,
 *     explicitly ask that this agent or delegated work run at a specific
 *     effort level, never on your own judgment; otherwise omit it and the
 *     agent runs at its usual effort."
 *     +(RZ()?' Ignored for subagent_type: "fork": a fork runs at your own
 *       effort.':""))
 *
 * OCC mapping: Hc ≡ EFFORT_LEVELS (['low','medium','high','xhigh','max'] —
 * the same constant the agent-frontmatter effort field validates against);
 * RZ() ≡ isForkSubagentEnabled(). Precedence in runAgent: tool `effort`
 * param > agentDefinition.effort (frontmatter) > inherited session
 * effortValue. The fork path drops the param (`effort: isForkPath ?
 * undefined : effort` in AgentTool call()).
 *
 * Wiring seam: same as forkPermissionModeWiring285.test.ts — runAgent's
 * onCacheSafeParams captures the built agentToolUseContext BEFORE the query
 * loop; its getAppState() exercises the REAL agentGetAppState closure where
 * the effortValue precedence chain lives. query() is mocked to an empty
 * generator so no live API key is needed.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE importing runAgent (see OCC-97 note in
// forkPermissionModeWiring285.test.ts; restored in afterAll).
// ---------------------------------------------------------------------------

let capturedQueryContext: unknown = null

const realQueryModule = await import('../../../query.js')
mock.module('../../../query.js', () => ({
  ...realQueryModule,
  // biome-ignore lint/correctness/useYield: empty generator by design
  query: async function* (params: Record<string, unknown>) {
    capturedQueryContext = params.toolUseContext
  },
}))

const realHooksModule = await import('../../../utils/hooks.js')
mock.module('../../../utils/hooks.js', () => ({
  ...realHooksModule,
  executeSubagentStartHooks: async function* () {
    // No hooks configured — yields nothing.
  },
}))

// ---------------------------------------------------------------------------
// Imports (resolved AFTER mocks are registered)
// ---------------------------------------------------------------------------

import {
  resetStateForTests,
} from '../../../bootstrap/state.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { AppState } from '../../../state/AppStateStore.js'
import { EFFORT_LEVELS, type EffortValue } from '../../../utils/effort.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../../utils/fileStateCache.js'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import { FORK_AGENT, isForkSubagentEnabled } from '../forkSubagent.js'
import type { AgentDefinition } from '../loadAgentsDir.js'
import { runAgent } from '../runAgent.js'

afterAll(() => {
  mock.module('../../../query.js', () => realQueryModule)
  mock.module('../../../utils/hooks.js', () => realHooksModule)
})

// ---------------------------------------------------------------------------
// Schema tests (pure — no runAgent drive needed)
// ---------------------------------------------------------------------------

describe('Agent tool inputSchema effort param (CC 2.1.292 Do port)', () => {
  test('effort is an optional enum of the official levels with verbatim base describe text', async () => {
    const { inputSchema } = await import('../AgentTool.js')
    const schema = inputSchema() as unknown as {
      shape: Record<string, { description?: string; unwrap: () => { options: readonly string[] } }>
    }
    const effortField = schema.shape.effort
    expect(effortField).toBeDefined()
    expect(effortField.unwrap().options).toEqual([...EFFORT_LEVELS])

    const base =
      'Reasoning effort for this agent. Set this ONLY when the user, or instructions such as CLAUDE.md or a skill, explicitly ask that this agent or delegated work run at a specific effort level, never on your own judgment; otherwise omit it and the agent runs at its usual effort.'
    const forkClause =
      ' Ignored for subagent_type: "fork": a fork runs at your own effort.'
    // RZ() ≡ isForkSubagentEnabled() — the clause is present exactly when
    // the fork gate is on.
    expect(effortField.description).toBe(
      base + (isForkSubagentEnabled() ? forkClause : ''),
    )
  })
})

// ---------------------------------------------------------------------------
// Wiring tests — precedence chain in runAgent's agentGetAppState closure
// ---------------------------------------------------------------------------

function makeParentAppState(sessionEffort?: EffortValue): AppState {
  return {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode: 'default',
    },
    effortValue: sessionEffort,
  } as unknown as AppState
}

function makeParentContext(sessionEffort?: EffortValue): ToolUseContext {
  const state = makeParentAppState(sessionEffort)
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

async function captureContext(opts: {
  sessionEffort?: EffortValue
  definitionEffort?: EffortValue
  toolEffort?: EffortValue
}): Promise<ToolUseContext> {
  let captured: ToolUseContext | null = null
  capturedQueryContext = null

  const agentDefinition = {
    ...FORK_AGENT,
    ...(opts.definitionEffort !== undefined
      ? { effort: opts.definitionEffort }
      : {}),
  } as AgentDefinition

  const parentContext = makeParentContext(opts.sessionEffort)
  const gen = runAgent({
    agentDefinition,
    promptMessages: [],
    toolUseContext: parentContext,
    canUseTool: (async () => ({
      behavior: 'allow',
      updatedInput: {},
    })) as never,
    isAsync: false,
    querySource: 'agent:builtin:fork',
    availableTools: [],
    useExactTools: true,
    effort: opts.toolEffort,
    override: {
      userContext: {},
      systemContext: {},
      systemPrompt: 'effort-wiring-test-prompt' as unknown as SystemPrompt,
    },
    subagentDepth: 1,
    onCacheSafeParams: params => {
      captured = params.toolUseContext
    },
  })

  try {
    for await (const _msg of gen) {
      // no messages expected — query mock yields nothing
    }
  } catch {
    // Tolerated: context was already captured via onCacheSafeParams.
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

describe('runAgent effort precedence (CC 2.1.292 P3 wiring)', () => {
  beforeEach(() => {
    if (process.env.NODE_ENV !== 'test') process.env.NODE_ENV = 'test'
    resetStateForTests()
    capturedQueryContext = null
  })

  afterEach(() => {
    resetStateForTests()
    capturedQueryContext = null
  })

  test('tool effort param beats definition frontmatter and session value', async () => {
    const ctx = await captureContext({
      sessionEffort: 'low',
      definitionEffort: 'medium',
      toolEffort: 'max',
    })
    expect(ctx.getAppState().effortValue).toBe('max')
  })

  test('definition frontmatter beats session value when no tool param', async () => {
    const ctx = await captureContext({
      sessionEffort: 'low',
      definitionEffort: 'high',
    })
    expect(ctx.getAppState().effortValue).toBe('high')
  })

  test('session effortValue is inherited when neither override is set', async () => {
    const ctx = await captureContext({ sessionEffort: 'medium' })
    expect(ctx.getAppState().effortValue).toBe('medium')
  })

  test('no effort anywhere → undefined (runAgent default)', async () => {
    const ctx = await captureContext({})
    expect(ctx.getAppState().effortValue).toBeUndefined()
  })
})
