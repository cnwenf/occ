import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext, ValidationResult } from '../../../Tool.js'

// MACRO polyfill (repo convention).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.300 (#65) — PermissionRequest path: the headless-agent
 * PermissionRequest hook consumer now runs `updatedInput` through the same
 * validation as PreToolUse (official `xCt` entry @225236572 +
 * caller @228137483):
 *   `let Q=await xCt(n,V.updatedInput,r,(be)=>n.validateInput?.(be,{...h,toolUseId:s}));
 *    if(Q.deny!==void 0)return Q.deny;let ye=Q.input,Se=ye??r;`
 *   xCt: undefined/empty-object → passthrough; deep-equal to shown input →
 *   the ORIGINAL shown object; else `aHe` with event "PermissionRequest",
 *   applies:true, shown:original — deny surfaces with
 *   `hookName:"PermissionRequest"`.
 *
 * Byte evidence for the deny strings lives in
 * src/services/tools/__tests__/hookUpdatedInputValidation300.test.ts header
 * (aHe @225233390 / YMt @225237068 / cde @225237420).
 */

// --- Mock seam (OCC-97 pattern): override executePermissionRequestHooks. ---

const actualHooksModule = await import('../../hooks.js')
type HookResult = { permissionRequestResult?: Record<string, unknown> }
let hookResults: HookResult[] = []
mock.module('../../hooks.js', () => ({
  ...actualHooksModule,
  executePermissionRequestHooks: async function* () {
    yield* hookResults
  },
}))

afterAll(() => {
  mock.module('../../hooks.js', () => ({ ...actualHooksModule }))
})

const { runPermissionRequestHooksForHeadlessAgent } = await import('../permissions.js')
const { HOOK_MODEL_INPUT_VALID_NOTE } = await import(
  '../hookUpdatedInputValidation.js'
)

const TOOL_NAME = 'FakeHeadlessTool'
const schema = z.strictObject({ cmd: z.string() })

function makeTool(
  validate?: (input: Record<string, unknown>) => Promise<ValidationResult | undefined>,
): Tool {
  return {
    name: TOOL_NAME,
    inputSchema: schema,
    ...(validate ? { validateInput: validate } : {}),
  } as unknown as Tool
}

function makeContext(): ToolUseContext {
  return {
    options: { tools: [], mcpClients: {}, mainLoopModel: 'claude-test' },
    abortController: new AbortController(),
    messages: [],
    readFileState: new Map(),
    getAppState: () => ({ toolPermissionContext: { mode: 'dontAsk' } }),
    setAppState: () => {},
  } as unknown as ToolUseContext
}

function run(
  tool: Tool,
  input: Record<string, unknown>,
  hookDecision: Record<string, unknown> | null,
) {
  hookResults = hookDecision === null ? [] : [{ permissionRequestResult: hookDecision }]
  return runPermissionRequestHooksForHeadlessAgent(
    tool,
    input,
    'tu_300_65_pr',
    makeContext(),
    'default',
    undefined,
  )
}

beforeEach(() => {
  hookResults = []
})

describe('2.1.300 #65 — PermissionRequest headless updatedInput validation (official xCt)', () => {
  test('allow + schema-invalid updatedInput → deny with the exact official message', async () => {
    const decision = await run(makeTool(), { cmd: 'ls' }, {
      behavior: 'allow',
      updatedInput: { cmd: 123 },
    })
    expect(decision).not.toBeNull()
    expect(decision!.behavior).toBe('deny')
    if (decision!.behavior === 'deny') {
      const message = decision!.message ?? ''
      expect(
        message.startsWith(
          `PermissionRequest hook for ${TOOL_NAME} returned updatedInput that failed schema validation: `,
        ),
      ).toBe(true)
      expect(message.endsWith(`\n${HOOK_MODEL_INPUT_VALID_NOTE}`)).toBe(true)
      expect(decision!.decisionReason).toMatchObject({
        type: 'hook',
        hookName: 'PermissionRequest',
      })
    }
  })

  test('allow + unknown keys → stripped input allowed (deep strip + re-parse)', async () => {
    const decision = await run(makeTool(), { cmd: 'ls' }, {
      behavior: 'allow',
      updatedInput: { cmd: 'ls', bogus: 1 },
    })
    expect(decision).not.toBeNull()
    expect(decision!.behavior).toBe('allow')
    if (decision!.behavior === 'allow') {
      expect(decision!.updatedInput).toEqual({ cmd: 'ls' })
    }
  })

  test('allow + valid updatedInput → allowed with the parsed input', async () => {
    const decision = await run(makeTool(), { cmd: 'ls' }, {
      behavior: 'allow',
      updatedInput: { cmd: 'ls -la' },
    })
    expect(decision!.behavior).toBe('allow')
    if (decision!.behavior === 'allow') {
      expect(decision!.updatedInput).toEqual({ cmd: 'ls -la' })
    }
  })

  test('allow + undefined updatedInput → original input preserved', async () => {
    const input = { cmd: 'ls' }
    const decision = await run(makeTool(), input, { behavior: 'allow' })
    expect(decision!.behavior).toBe('allow')
    if (decision!.behavior === 'allow') {
      expect(decision!.updatedInput).toEqual(input)
    }
  })

  test('allow + updatedInput deep-equal to the original → the ORIGINAL object is returned (SR shortcut)', async () => {
    const input = { cmd: 'ls' }
    const decision = await run(makeTool(), input, {
      behavior: 'allow',
      updatedInput: { cmd: 'ls' },
    })
    expect(decision!.behavior).toBe('allow')
    if (decision!.behavior === 'allow') {
      expect(decision!.updatedInput).toBe(input)
    }
  })

  test('allow + tool-refused updatedInput → deny with the exact "tool refused" message', async () => {
    const tool = makeTool(async () => ({
      result: false as const,
      message: 'nope',
      errorCode: 5,
    }))
    const decision = await run(tool, { cmd: 'ls' }, {
      behavior: 'allow',
      updatedInput: { cmd: 'rm -rf /' },
    })
    expect(decision!.behavior).toBe('deny')
    if (decision!.behavior === 'deny') {
      expect(decision!.message).toBe(
        `PermissionRequest hook for ${TOOL_NAME} returned updatedInput that the tool refused: nope\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
      )
    }
  })

  test('deny hook decisions pass through untouched (no updatedInput validation)', async () => {
    const decision = await run(makeTool(), { cmd: 'ls' }, {
      behavior: 'deny',
      message: 'blocked by hook',
    })
    expect(decision!.behavior).toBe('deny')
    if (decision!.behavior === 'deny') {
      expect(decision!.message).toBe('blocked by hook')
      expect(decision!.decisionReason).toMatchObject({
        type: 'hook',
        hookName: 'PermissionRequest',
      })
    }
  })

  test('no hook decision → null (caller proceeds to auto-deny)', async () => {
    const decision = await run(makeTool(), { cmd: 'ls' }, null)
    expect(decision).toBeNull()
  })
})
