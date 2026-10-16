/**
 * CC 2.1.301 #30 — "When a hook asks for permission, the prompt now shows
 * which plugin or skill owns it": the hook `decisionReason` gains
 * `hookPluginId`, threaded from the aggregated hook result.
 *
 * Byte evidence (official v2.1.301 linux-x64 ELF, re-verified this round):
 *   decision-reason construction @228172787:
 *     `{type:"hook",hookName:`PreToolUse:${n.name}`,hookSource:Re.hookSource,
 *        hookPluginId:Re.hookPluginId,reason:Re.hookPermissionDecisionReason,
 *        ...Re.heldForServedCall&&{heldForServedCall:!0}}`
 *   hook-result yield @229018962:
 *     `hookSource:Vs?.hookSource,...Vs?.pluginId!==void 0&&{hookPluginId:Vs.pluginId}`
 *   v300 has ZERO `hookPluginId` occurrences; v301 has 12 — field is new in 301.
 *   The PermissionRuleExplanation render site is byte-identical v300↔v301
 *   (@245353204 vs @247982380): the prompt renders `hookSource` only —
 *   hookPluginId is NOT rendered, so OCC's renderer stays unchanged.
 *
 * OCC note: `AggregatedHookResult` (src/utils/hooks.ts) does not yet carry
 * `hookPluginId` (out-of-scope file); toolHooks.ts reads it defensively so
 * the field flows as soon as the hook layer yields it. `MatchedHook` already
 * has `pluginId?: string` (hooks.ts:2653).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../../Tool.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

// --- Mock seams (hookUpdatedInputValidation300.test.ts pattern). ---
const actualHooksModule = await import('../../../utils/hooks.js')
type HookYield = Record<string, unknown>
let preToolHookResults: HookYield[] = []
mock.module('../../../utils/hooks.js', () => ({
  ...actualHooksModule,
  executePreToolHooks: async function* () {
    yield* preToolHookResults
  },
}))

const actualDebugModule = await import('../../../utils/debug.js')
mock.module('../../../utils/debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: () => {},
}))

afterAll(() => {
  mock.module('../../../utils/hooks.js', () => ({ ...actualHooksModule }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugModule }))
})

const { runPreToolUseHooks } = await import('../toolHooks.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')

const TOOL_NAME = 'FakePluginHookTool'

function makeTool(): Tool {
  return {
    name: TOOL_NAME,
    inputSchema: z.strictObject({ cmd: z.string() }),
  } as unknown as Tool
}

function makeToolUseContext(): ToolUseContext {
  return {
    options: { tools: [], mcpClients: {}, mainLoopModel: 'claude-test' },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({
      ...getDefaultAppState(),
      toolPermissionContext: {
        ...getDefaultAppState().toolPermissionContext,
        mode: 'default',
      },
    }),
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

async function collect() {
  const yields: Array<Record<string, unknown>> = []
  for await (const item of runPreToolUseHooks(
    makeToolUseContext(),
    makeTool(),
    { cmd: 'ls' },
    'tu_301_30',
    'msg_301_30',
    undefined as never,
    undefined as never,
    undefined,
  )) {
    yields.push(item as Record<string, unknown>)
  }
  return yields
}

type HookPermissionYield = {
  hookPermissionResult: {
    behavior: string
    decisionReason?: {
      type: string
      hookName?: string
      hookSource?: string
      hookPluginId?: string
      reason?: string
    }
  }
}

beforeEach(() => {
  preToolHookResults = []
})

describe('CC 2.1.301 #30 — hook ask/deny decision carries hookPluginId', () => {
  test('ask decision from a plugin hook → decisionReason.hookPluginId threaded', async () => {
    preToolHookResults = [
      {
        permissionBehavior: 'ask',
        hookSource: 'plugin:deploy-pack',
        hookPluginId: 'deploy-pack',
        hookPermissionDecisionReason: 'Plugin hook wants confirmation',
      },
    ]
    const yields = await collect()
    const ask = yields.find(
      y =>
        y.type === 'hookPermissionResult' &&
        (y as HookPermissionYield).hookPermissionResult.behavior === 'ask',
    ) as HookPermissionYield | undefined
    expect(ask).toBeDefined()
    expect(ask!.hookPermissionResult.decisionReason).toMatchObject({
      type: 'hook',
      hookName: `PreToolUse:${TOOL_NAME}`,
      hookSource: 'plugin:deploy-pack',
      hookPluginId: 'deploy-pack',
      reason: 'Plugin hook wants confirmation',
    })
  })

  test('deny decision from a plugin hook → decisionReason.hookPluginId threaded', async () => {
    preToolHookResults = [
      {
        permissionBehavior: 'deny',
        hookSource: 'plugin:guardrails',
        hookPluginId: 'guardrails',
        hookPermissionDecisionReason: 'blocked by plugin',
      },
    ]
    const yields = await collect()
    const deny = yields.find(
      y =>
        y.type === 'hookPermissionResult' &&
        (y as HookPermissionYield).hookPermissionResult.behavior === 'deny',
    ) as HookPermissionYield | undefined
    expect(deny).toBeDefined()
    expect(deny!.hookPermissionResult.decisionReason).toMatchObject({
      type: 'hook',
      hookSource: 'plugin:guardrails',
      hookPluginId: 'guardrails',
    })
  })

  test('allow decision from a skill hook → decisionReason.hookPluginId threaded', async () => {
    preToolHookResults = [
      {
        permissionBehavior: 'allow',
        hookSource: 'skill:pdf-tools',
        hookPluginId: 'pdf-tools',
      },
    ]
    const yields = await collect()
    const allow = yields.find(
      y =>
        y.type === 'hookPermissionResult' &&
        (y as HookPermissionYield).hookPermissionResult.behavior === 'allow',
    ) as HookPermissionYield | undefined
    expect(allow).toBeDefined()
    expect(allow!.hookPermissionResult.decisionReason).toMatchObject({
      type: 'hook',
      hookSource: 'skill:pdf-tools',
      hookPluginId: 'pdf-tools',
    })
  })

  test('settings hook without pluginId → hookPluginId stays undefined (no invention)', async () => {
    preToolHookResults = [
      {
        permissionBehavior: 'ask',
        hookSource: 'settings',
        hookPermissionDecisionReason: 'settings hook asks',
      },
    ]
    const yields = await collect()
    const ask = yields.find(
      y =>
        y.type === 'hookPermissionResult' &&
        (y as HookPermissionYield).hookPermissionResult.behavior === 'ask',
    ) as HookPermissionYield | undefined
    expect(ask).toBeDefined()
    const reason = ask!.hookPermissionResult.decisionReason!
    expect(reason.hookSource).toBe('settings')
    expect(reason.hookPluginId).toBeUndefined()
  })
})
