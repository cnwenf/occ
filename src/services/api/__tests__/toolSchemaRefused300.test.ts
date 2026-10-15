import { APIError } from '@anthropic-ai/sdk'
import type Anthropic from '@anthropic-ai/sdk'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.300 (#36): "Fixed a conversation failing on every turn with a 400
 * error when the API rejected an MCP tool's input schema; Claude Code now
 * sends that tool without parameters for the rest of the conversation."
 *
 * Official v300 `AGe` module @225850721 (byte-verified):
 *   import{isDeepStrictEqual as aFo}from"util";var lFo=8,U1t={type:"object"};
 *   function j1t(e){return at($i(e))}                       // schema hash
 *   function W1t(e,n){…}                                    // substitution
 *   class AGe{…resolve(e,n,r,s){…}}                         // 400 resolver
 *   Kg gate @222761037: e.name?.startsWith("mcp__")||e.isMcp===!0
 *   regex @107537522: /\btools\.(\d+)\.(?:custom\.)?input_schema\b/
 *   retry token @240729: `retry:tool-schema-refused-${this.#t}`
 *   flag: k("tengu_calm_crescent",!0)
 *   note @107537731: "the API refused this tool's input schema"
 *
 * Wiring: 4th heal hook in withRetry (after retryContext1mBetaRefused),
 * substitution at the params builder (`gd=W1t(gd,st)` @227858355).
 */

process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

const GROWTHBOOK_PATH = '../../analytics/growthbook.js'
let realGrowthbook: Record<string, unknown> = {}
let calmCrescentOverride: ((flag: string, dflt: boolean) => boolean) | null =
  null

beforeAll(async () => {
  realGrowthbook = { ...((await import(GROWTHBOOK_PATH)) as object) }
  // OCC-97 seam: narrowly override the feature getter so the
  // tengu_calm_crescent off-switch can be exercised; everything else passes
  // through to the real module.
  mock.module(GROWTHBOOK_PATH, () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: <T,>(flag: string, dflt: T): T => {
      if (flag === 'tengu_calm_crescent' && calmCrescentOverride) {
        return calmCrescentOverride(flag, dflt as boolean) as T
      }
      return (
        realGrowthbook.getFeatureValue_CACHED_MAY_BE_STALE as (
          f: string,
          d: T,
        ) => T
      )(flag, dflt)
    },
  }))
})

afterAll(() => {
  mock.module(GROWTHBOOK_PATH, () => ({ ...realGrowthbook }))
})

const { extractRefusedToolSchemaIndex } =
  require('../errorUtils.js') as typeof import('../errorUtils.js')
const {
  applyRefusedToolSchemas,
  clearRefusedToolSchemas,
  createToolSchemaRefusedResolver,
  getMcpSchemaRefusalNotes,
  isMcpToolRefForSchemaRefusal,
  TOOL_SCHEMA_REFUSED_CAP,
} = require('../refusedToolSchemas.js') as typeof import('../refusedToolSchemas.js')
const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

function apiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

/** tools.N.input_schema 400 the way the API sends it (official regex). */
function schemaRefused400(index: number, custom = false): APIError {
  const field = custom
    ? `tools.${index}.custom.input_schema`
    : `tools.${index}.input_schema`
  return apiError(
    400,
    `${field}: Input schema is invalid. Please ensure the schema is a valid JSON Schema object.`,
  )
}

interface SentTool {
  name: string
  input_schema?: Record<string, unknown>
  eager_input_streaming?: boolean
  [key: string]: unknown
}

function mcpTool(name: string, props = 'a'): SentTool {
  return {
    name,
    input_schema: {
      type: 'object',
      properties: { [props]: { type: 'string' } },
      required: [props],
    },
  }
}

function mcpLookup(name: string) {
  if (!name.startsWith('mcp__')) return undefined
  const [, serverName, toolName] = name.split('__')
  return {
    isMcp: true as const,
    mcpInfo: { serverName: serverName ?? 'srv', toolName: toolName ?? 'tool' },
  }
}

const ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_ENTERPRISE',
  'USER_TYPE',
] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  calmCrescentOverride = null
  clearRefusedToolSchemas()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  calmCrescentOverride = null
  clearRefusedToolSchemas()
})

describe('extractRefusedToolSchemaIndex (official AGe regex @107537522)', () => {
  test('extracts the tool index from a tools.N.input_schema 400', () => {
    expect(extractRefusedToolSchemaIndex(schemaRefused400(2))).toBe(2)
    expect(extractRefusedToolSchemaIndex(schemaRefused400(0))).toBe(0)
    expect(extractRefusedToolSchemaIndex(schemaRefused400(17))).toBe(17)
  })

  test('extracts the index from the tools.N.custom.input_schema shape', () => {
    expect(extractRefusedToolSchemaIndex(schemaRefused400(3, true))).toBe(3)
  })

  test('returns undefined for non-matching messages', () => {
    expect(
      extractRefusedToolSchemaIndex(apiError(400, 'invalid beta flag')),
    ).toBeUndefined()
    expect(
      extractRefusedToolSchemaIndex(
        apiError(400, 'tools.2.model: Extra inputs are not permitted'),
      ),
    ).toBeUndefined()
  })

  test('returns undefined for non-400 statuses', () => {
    const err = new APIError(
      422,
      { message: 'tools.2.input_schema: bad' },
      'tools.2.input_schema: bad',
      undefined,
    )
    expect(extractRefusedToolSchemaIndex(err)).toBeUndefined()
  })

  test('returns undefined for non-APIError values', () => {
    expect(extractRefusedToolSchemaIndex(new Error('tools.2.input_schema'))).toBeUndefined()
    expect(extractRefusedToolSchemaIndex(undefined)).toBeUndefined()
    expect(extractRefusedToolSchemaIndex('tools.2.input_schema')).toBeUndefined()
  })
})

describe('isMcpToolRefForSchemaRefusal (official Kg @222761037)', () => {
  test('matches the mcp__ name prefix', () => {
    expect(isMcpToolRefForSchemaRefusal({ name: 'mcp__srv__tool' })).toBe(true)
  })
  test('matches isMcp === true', () => {
    expect(
      isMcpToolRefForSchemaRefusal({ name: 'custom_tool', isMcp: true }),
    ).toBe(true)
  })
  test('rejects plain tools', () => {
    expect(isMcpToolRefForSchemaRefusal({ name: 'Bash' })).toBe(false)
    expect(isMcpToolRefForSchemaRefusal({ name: 'Bash', isMcp: false })).toBe(
      false,
    )
    expect(isMcpToolRefForSchemaRefusal({})).toBe(false)
  })
})

describe('createToolSchemaRefusedResolver (official AGe.resolve)', () => {
  test('records the refused MCP tool and returns the retry token', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [mcpTool('mcp__srv__one'), mcpTool('mcp__srv__two')]
    const token = resolver.resolve(schemaRefused400(1), sent, mcpLookup)
    expect(token).toBe('retry:tool-schema-refused-1')
    // Conversation-scoped substitution kicks in for later param builds.
    const next = applyRefusedToolSchemas(sent)
    expect(next[0]).toBe(sent[0]) // untouched — same reference
    expect(next[1].input_schema).toEqual({ type: 'object' })
  })

  test('the substitution strips eager_input_streaming (official W1t destructure)', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [
      { ...mcpTool('mcp__srv__one'), eager_input_streaming: true },
    ]
    resolver.resolve(schemaRefused400(0), sent, mcpLookup)
    const next = applyRefusedToolSchemas(sent)
    expect('eager_input_streaming' in next[0]).toBe(false)
    expect(next[0].input_schema).toEqual({ type: 'object' })
    // Other fields are preserved.
    expect(next[0].name).toBe('mcp__srv__one')
  })

  test('does nothing when the map is empty — same array reference (official r.size===0)', () => {
    const sent: SentTool[] = [mcpTool('mcp__srv__one')]
    expect(applyRefusedToolSchemas(sent)).toBe(sent)
  })

  test('skips tools whose schema changed after the refusal (hash mismatch)', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [mcpTool('mcp__srv__one', 'a')]
    resolver.resolve(schemaRefused400(0), sent, mcpLookup)
    // Same tool name, but the schema the server now advertises differs.
    const changed: SentTool[] = [mcpTool('mcp__srv__one', 'b')]
    const next = applyRefusedToolSchemas(changed)
    expect(next[0].input_schema).toEqual(changed[0].input_schema)
    expect(next[0].input_schema).not.toEqual({ type: 'object' })
  })

  test('refusal state persists across resolver instances (conversation lifetime)', () => {
    const first = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [mcpTool('mcp__srv__one')]
    first.resolve(schemaRefused400(0), sent, mcpLookup)
    // The next request (new resolver instance, same conversation) still
    // substitutes the refused schema at its params builder.
    const second = createToolSchemaRefusedResolver()
    const resent = applyRefusedToolSchemas([mcpTool('mcp__srv__one')])
    expect(resent[0].input_schema).toEqual({ type: 'object' })
    // If the API 400s again on the already-flattened tool, the
    // already_replaced guard stops the heal loop.
    expect(
      second.resolve(schemaRefused400(0), resent, mcpLookup),
    ).toBeUndefined()
  })

  test('returns undefined when the tool at the index is not MCP (no_mcp_tool_at_index)', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [{ name: 'Bash', input_schema: { type: 'object' } }]
    // Bash has input_schema {type:"object"} → would also trip already_replaced;
    // use a non-object schema to isolate the MCP gate.
    sent[0].input_schema = { type: 'object', properties: { c: { type: 'string' } } }
    expect(
      resolver.resolve(schemaRefused400(0), sent, mcpLookup),
    ).toBeUndefined()
    expect(applyRefusedToolSchemas(sent)).toBe(sent)
  })

  test('returns undefined when the index is out of range', () => {
    const resolver = createToolSchemaRefusedResolver()
    expect(
      resolver.resolve(schemaRefused400(5), [mcpTool('mcp__srv__one')], mcpLookup),
    ).toBeUndefined()
  })

  test('returns undefined when the sent schema is already {type:"object"} (already_replaced)', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [{ name: 'mcp__srv__one', input_schema: { type: 'object' } }]
    expect(
      resolver.resolve(schemaRefused400(0), sent, mcpLookup),
    ).toBeUndefined()
  })

  test('returns undefined when tengu_calm_crescent is off (switched_off)', () => {
    calmCrescentOverride = () => false
    const resolver = createToolSchemaRefusedResolver()
    expect(
      resolver.resolve(schemaRefused400(0), [mcpTool('mcp__srv__one')], mcpLookup),
    ).toBeUndefined()
  })

  test(`caps replacements at ${8} per resolver instance (official lFo=8, bound_reached)`, () => {
    const resolver = createToolSchemaRefusedResolver()
    expect(TOOL_SCHEMA_REFUSED_CAP).toBe(8)
    for (let i = 0; i < TOOL_SCHEMA_REFUSED_CAP; i++) {
      const sent: SentTool[] = [mcpTool(`mcp__srv__tool${i}`, `p${i}`)]
      expect(resolver.resolve(schemaRefused400(0), sent, mcpLookup)).toBe(
        `retry:tool-schema-refused-${i + 1}`,
      )
    }
    const overflow: SentTool[] = [mcpTool('mcp__srv__toolX', 'px')]
    expect(
      resolver.resolve(schemaRefused400(0), overflow, mcpLookup),
    ).toBeUndefined()
    // A fresh resolver instance gets a fresh per-request counter, but the
    // already-recorded tools are still substituted conversation-wide.
    const fresh = createToolSchemaRefusedResolver()
    expect(
      fresh.resolve(
        schemaRefused400(0),
        [mcpTool('mcp__srv__toolY', 'py')],
        mcpLookup,
      ),
    ).toBe('retry:tool-schema-refused-1')
  })

  test('records the MCP-server note with the official string', () => {
    const resolver = createToolSchemaRefusedResolver()
    const err = schemaRefused400(0)
    resolver.resolve(err, [mcpTool('mcp__srv__one')], mcpLookup)
    const notes = getMcpSchemaRefusalNotes()
    const note = notes.get('srv')
    expect(note).toBeDefined()
    expect(note).toContain(
      "the API refused this tool's input schema",
    )
    expect(note).toBe(
      `Tool "one": the API refused this tool's input schema. Claude can still call the tool in this conversation, but does not see its parameters. Fix the schema on the MCP server, then start a new conversation. The API said: ${err.message}`,
    )
  })

  test('non-400 errors are ignored', () => {
    const resolver = createToolSchemaRefusedResolver()
    const err = new APIError(
      500,
      { message: 'tools.0.input_schema: bad' },
      'tools.0.input_schema: bad',
      undefined,
    )
    expect(
      resolver.resolve(err, [mcpTool('mcp__srv__one')], mcpLookup),
    ).toBeUndefined()
  })

  test('clearRefusedToolSchemas empties the conversation-scoped map', () => {
    const resolver = createToolSchemaRefusedResolver()
    const sent: SentTool[] = [mcpTool('mcp__srv__one')]
    resolver.resolve(schemaRefused400(0), sent, mcpLookup)
    clearRefusedToolSchemas()
    expect(applyRefusedToolSchemas([mcpTool('mcp__srv__one')])).toEqual([
      mcpTool('mcp__srv__one'),
    ])
  })
})

describe('withRetry heal hook (4th hook: retryToolSchemaRefused)', () => {
  const fakeClient = {} as Anthropic
  const baseOptions = {
    model: 'claude-sonnet-4-5',
    thinkingConfig: { type: 'disabled' as const },
  }

  async function drain<T>(
    gen: AsyncGenerator<unknown, T>,
  ): Promise<{ result: T; yielded: unknown[] }> {
    const yielded: unknown[] = []
    let next = await gen.next()
    while (!next.done) {
      yielded.push(next.value)
      next = await gen.next()
    }
    return { result: next.value, yielded }
  }

  test('a tools.N.input_schema 400 fires the hook and retries without consuming budget', async () => {
    const attempts: number[] = []
    const hook = mock((error: APIError) => {
      return extractRefusedToolSchemaIndex(error) !== undefined
    })
    let calls = 0
    const gen = withRetry(
      async () => fakeClient,
      async (_client, attempt) => {
        attempts.push(attempt)
        calls++
        if (calls === 1) throw schemaRefused400(2)
        return 'ok'
      },
      { ...baseOptions, retryToolSchemaRefused: hook },
    )
    const { result } = await drain(gen)
    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(hook).toHaveBeenCalledTimes(1)
    // attempt-- on heal → both calls see the same attempt number.
    expect(attempts[0]).toBe(attempts[1])
  })

  test('the hook returning false lets the 400 fail as non-retryable', async () => {
    const hook = mock((_error: APIError) => false)
    const gen = withRetry(
      async () => fakeClient,
      async () => {
        throw schemaRefused400(2)
      },
      { ...baseOptions, retryToolSchemaRefused: hook },
    )
    await expect(drain(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(hook).toHaveBeenCalledTimes(1)
  })

  test('non-matching 400s never reach the hook', async () => {
    const hook = mock((_error: APIError) => true)
    const gen = withRetry(
      async () => fakeClient,
      async () => {
        throw apiError(400, 'prompt is too long')
      },
      { ...baseOptions, retryToolSchemaRefused: hook },
    )
    await expect(drain(gen)).rejects.toBeInstanceOf(CannotRetryError)
    expect(hook).not.toHaveBeenCalled()
  })
})
