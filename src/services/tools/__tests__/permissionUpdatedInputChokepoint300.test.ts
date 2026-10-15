import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from 'src/utils/fileStateCache.js'
import { runToolUse } from '../toolExecution.js'

// MACRO polyfill (repo convention).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.300 (#65) — the tool-execution chokepoint: a permission handler's
 * `updatedInput` (canUseTool / PermissionRequest hook / permission-prompt
 * tool) that fails the tool's input schema now DENIES the call instead of
 * being passed to the tool.
 *
 * Byte evidence (v300 ELF @227310550, verbatim):
 *   `go.updatedInput!==void 0&&!cEe(go.updatedInput)` — an EMPTY plain
 *   object skips validation and (officially) falls to `AV(e.name,mt)`;
 *   `let Yr=ykr(e.inputSchema,go.updatedInput)` — the chokepoint parse
 *   IGNORES `unrecognized_keys` issues (they are tolerated here; the deep
 *   strip lives in `aHe` at the hook sites). `ykr` @227296608.
 *   Deny message `us` (@227310750 region):
 *     `The permission handler returned updatedInput for ${e.name} that failed schema validation: ${b0(e.name,hs)}\nThis is a configuration issue in your canUseTool callback, PermissionRequest hook, or permission-prompt tool — updatedInput must satisfy the tool's input schema. The tool input from the model was valid.`
 *     (NOTE the em-dash — — byte-verified.)
 *   Warn log: `Permission handler updatedInput for ${vy(e)} failed schema validation (${codes.join(",")})` (string table @107965908/@227311222).
 *   toolUseResult: `InputValidationError: permission handler updatedInput failed schema for ${e.name}`
 *   content: `<tool_use_error>${us}</tool_use_error>` (is_error tool_result).
 *   Analytics: span 'reject'/'permission_updated_input_invalid' + OTel
 *   'tool_permission_updated_input_invalid' + tengu_tool_use_error with
 *   errorCode 'PERMISSION_UPDATED_INPUT' (string table @107965868+).
 */

const TOOL_NAME = 'FakeChokeTool'
const schema = z.strictObject({ file_path: z.string() })

const callInputs: Array<Record<string, unknown>> = []

const fakeTool = {
  name: TOOL_NAME,
  inputSchema: schema,
  validateInput: async () => ({ result: true as const }),
  mapToolResultToToolResultBlockParam: (data: unknown, toolUseID: string) => ({
    type: 'tool_result' as const,
    content: String(data ?? ''),
    tool_use_id: toolUseID,
  }),
  call: async (input: Record<string, unknown>) => {
    callInputs.push(input)
    return { data: 'ok' }
  },
} as unknown as Tool

function makeContext(): ToolUseContext {
  return {
    options: { tools: [fakeTool], mcpClients: {}, mainLoopModel: 'claude-opus-5' },
    abortController: new AbortController(),
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({ ...getDefaultAppState() }),
  } as unknown as ToolUseContext
}

async function driveRunToolUse(updatedInput: Record<string, unknown> | undefined) {
  const ctx = makeContext()
  const canUseTool = (async () => ({
    behavior: 'allow' as const,
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  })) as never
  const assistantMessage = {
    uuid: 'asst-choke-300',
    message: { id: 'msg_choke_300', role: 'assistant', content: [] },
  } as never
  const toolUse = {
    id: 'toolu_choke_300',
    type: 'tool_use',
    name: TOOL_NAME,
    input: { file_path: '/tmp/occ-choke-model-input.txt' },
  } as never

  const updates: unknown[] = []
  for await (const update of runToolUse(toolUse, assistantMessage, canUseTool, ctx)) {
    updates.push(update)
  }
  return updates
}

beforeEach(() => {
  callInputs.length = 0
})

describe('2.1.300 #65 — permission-handler updatedInput chokepoint (official ykr deny block)', () => {
  test('schema-invalid updatedInput → deny with the exact official message, tool NOT called', async () => {
    const updates = await driveRunToolUse({ file_path: 123 } as never)

    expect(callInputs.length).toBe(0)
    const json = JSON.stringify(updates)
    expect(json).toContain('<tool_use_error>')
    expect(json).toContain(
      `The permission handler returned updatedInput for ${TOOL_NAME} that failed schema validation: `,
    )
    // Em-dash sentence, byte-verified from the v300 binary (—).
    expect(json).toContain(
      "This is a configuration issue in your canUseTool callback, PermissionRequest hook, or permission-prompt tool — updatedInput must satisfy the tool's input schema. The tool input from the model was valid.",
    )
    expect(json).toContain(
      `InputValidationError: permission handler updatedInput failed schema for ${TOOL_NAME}`,
    )
  })

  test('unknown-keys-only updatedInput passes the chokepoint (ykr ignores unrecognized_keys) and reaches the tool raw', async () => {
    const updates = await driveRunToolUse({
      file_path: '/tmp/occ-choke-updated.txt',
      extraUnknown: 1,
    })

    expect(callInputs.length).toBe(1)
    expect(callInputs[0]).toEqual({
      file_path: '/tmp/occ-choke-updated.txt',
      extraUnknown: 1,
    })
    expect(JSON.stringify(updates)).not.toContain('<tool_use_error>')
  })

  test('empty-object updatedInput skips validation entirely (official cEe guard) — model input is used', async () => {
    const updates = await driveRunToolUse({})

    expect(callInputs.length).toBe(1)
    expect(callInputs[0]).toEqual({ file_path: '/tmp/occ-choke-model-input.txt' })
    expect(JSON.stringify(updates)).not.toContain('<tool_use_error>')
  })

  test('valid updatedInput still flows to the tool (regression pin)', async () => {
    const updates = await driveRunToolUse({ file_path: '/tmp/occ-choke-valid.txt' })

    expect(callInputs.length).toBe(1)
    expect(callInputs[0]).toEqual({ file_path: '/tmp/occ-choke-valid.txt' })
    expect(JSON.stringify(updates)).not.toContain('<tool_use_error>')
  })

  test('missing required key (real schema issue, not unknown-key) also denies', async () => {
    const updates = await driveRunToolUse({ other: 'x' } as never)

    expect(callInputs.length).toBe(0)
    const json = JSON.stringify(updates)
    expect(json).toContain(
      `The permission handler returned updatedInput for ${TOOL_NAME} that failed schema validation: `,
    )
  })
})
