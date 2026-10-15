import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
// Hermetic for credential-less environments (CI runners).
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.300 (#28) — "Fixed agent hooks ignoring their `model`: aliases like
 * `haiku` now resolve, a subagent's model no longer overrides it, and an
 * unavailable model falls back to the caller's instead of allowing the action."
 *
 * Byte evidence (v300 ELF, docs/gap-research-300/triage-T2.md §28):
 *   executor head @227965400:
 *     `Ut=UIe(e.model??Ov()),qt=e.model===void 0?Ut:AIr(Ut),Wt=oc(y),
 *      tn=e.model===void 0&&Ie()==="gateway"&&…?Wt:qt`
 *     — alias-resolve (`AIr`) applies ONLY when hook.model is explicitly set.
 *   `AIr` @219020138: `function AIr(e){return jme(e.toLowerCase().trim())?Ot(e):e}`
 *     (isModelAlias(trim+lowercase) ? parseUserSpecifiedModel(orig) : orig)
 *   refusal detector @227966xxx loop head: `if($n===0)Xn=ORe(_n)` (FIRST
 *     assistant message only), `ORe` @229228103:
 *     `e.isApiErrorMessage===!0&&[400,403,404].includes(e.apiErrorStatus??0)&&!e.resendCannotCure`
 *   retry @227967443 (byte-verified):
 *     `if(Xn&&tn!==Wt&&e.model!==Wt&&!h.aborted&&!kG())
 *        return t(\`Hooks: ${tn} was refused, running the agent hook on ${Wt}\`),
 *          {...await jZe({...e,model:Wt},n,r,s,h,y,S,w),hook:e}`
 *     — placed BEFORE the max-turns branch; recursive re-run on the caller
 *     model; the ORIGINAL hook object is preserved on the returned result.
 *   `kG` @219010844: `a.CLAUDE_CODE_NO_MODEL_FALLBACK===!0` (env tripwire).
 *
 * OCC deviations (documented):
 *   - `UIe` (deniedModels redirect) pre-existed in v299 and was never ported
 *     (OCC has no "[deniedModels] helper request" surface) — out of scope.
 *   - The gateway branch is dead in OCC (getAPIProvider() never returns
 *     'gateway' — providers.ts:175).
 *   - OCC assistant messages carry no `apiErrorStatus`/`resendCannotCure`
 *     envelope fields (QueryEngine.ts:1563); the detector reads the official
 *     fields when present and falls back to OCC's `error` category
 *     ('invalid_request' = 400/404, 'authentication_failed' = 401/403).
 *   - The subagent-override half (`mainLoopModel: model` AFTER the options
 *     spread) already exists in OCC (execAgentHook.ts:140-146) — untouched.
 *   - execPromptHook is intentionally NOT changed: the v300 prompt-hook judge
 *     (@227953311) uses `be=e.model??Ov()` raw — no `AIr`, no retry (the
 *     triage sketch's execPromptHook.ts:138 line is a sketch over-extension).
 */

// --- Mock seams (OCC-97 pattern: snapshot real exports, override narrowly,
// restore in afterAll). ---

const actualQueryModule = await import('../../../query.js')
type QueryCall = { model: string | undefined; querySource: string | undefined }
const queryCalls: QueryCall[] = []
type QueryScript = (model: string) => AsyncGenerator<Record<string, unknown>, void>
let queryScript: QueryScript = async function* () {}
mock.module('../../../query.js', () => ({
  ...actualQueryModule,
  query: (args: { toolUseContext?: { options?: { mainLoopModel?: string } }; querySource?: string }) => {
    const model = args.toolUseContext?.options?.mainLoopModel
    queryCalls.push({ model, querySource: args.querySource })
    return queryScript(model ?? '')
  },
}))

const actualDebugModule = await import('../../debug.js')
const debugLogs: string[] = []
mock.module('../../debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: (msg: string) => {
    debugLogs.push(msg)
  },
}))

const actualMessagesModule = await import('../../messages.js')
mock.module('../../messages.js', () => ({
  ...actualMessagesModule,
  // The stream tap is UI plumbing; the fake messages below are not real
  // stream events, so neutralize it (createUserMessage stays real).
  handleMessageFromStream: () => {},
}))

const actualSessionStorageModule = await import('../../sessionStorage.js')
mock.module('../../sessionStorage.js', () => ({
  ...actualSessionStorageModule,
  getTranscriptPath: () => '/tmp/occ-test-transcript.jsonl',
  getAgentTranscriptPath: () => '/tmp/occ-test-agent-transcript.jsonl',
}))

afterAll(() => {
  mock.module('../../../query.js', () => ({ ...actualQueryModule }))
  mock.module('../../debug.js', () => ({ ...actualDebugModule }))
  mock.module('../../messages.js', () => ({ ...actualMessagesModule }))
  mock.module('../../sessionStorage.js', () => ({ ...actualSessionStorageModule }))
})

const { execAgentHook } = await import('../execAgentHook.js')
const { parseUserSpecifiedModel } = await import('../../model/model.js')
import type { ToolUseContext } from '../../../Tool.js'
import type { AgentHook } from '../../settings/types.js'

const CALLER_MODEL = 'claude-caller-main-loop-model'
const REFUSAL_LOG = (model: string) =>
  `Hooks: ${model} was refused, running the agent hook on ${CALLER_MODEL}`

function refusalMessage(model: string, withStatus = true): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: `uuid-refusal-${model}`,
    isApiErrorMessage: true,
    error: 'invalid_request',
    ...(withStatus ? { apiErrorStatus: 404 } : {}),
    message: {
      id: `msg_refusal_${model}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'model not available' }],
      model,
    },
  }
}

function structuredOutputMessage(ok: boolean, reason: string): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: 'uuid-structured',
    attachment: { type: 'structured_output', data: { ok, reason } },
  }
}

function makeContext(): ToolUseContext {
  let appState: Record<string, unknown> = {
    toolPermissionContext: { mode: 'dontAsk', alwaysAllowRules: { session: [] } },
    sessionHooks: new Map(),
  }
  return {
    options: { mainLoopModel: CALLER_MODEL, tools: [] },
    agentId: undefined,
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: unknown) => {
      appState =
        typeof updater === 'function'
          ? (updater as (prev: Record<string, unknown>) => Record<string, unknown>)(appState)
          : (updater as Record<string, unknown>)
    },
    setResponseLength: () => {},
    messages: [],
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

function makeHook(model?: string): AgentHook {
  return {
    type: 'agent',
    prompt: 'verify the condition',
    ...(model !== undefined ? { model } : {}),
  } as unknown as AgentHook
}

async function runHook(hook: AgentHook, signal?: AbortSignal) {
  return execAgentHook(
    hook,
    'TestHook',
    'Stop',
    '{}',
    signal ?? new AbortController().signal,
    makeContext(),
    'tu_300_28',
    [],
    undefined,
  )
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  queryCalls.length = 0
  debugLogs.length = 0
  queryScript = async function* () {}
  for (const key of [
    'CLAUDE_CODE_NO_MODEL_FALLBACK',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ]) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('2.1.300 #28 — agent hook model refusal falls back to the caller model', () => {
  test('refusal (apiErrorStatus 404) on the hook model retries on the caller model with the exact log line', async () => {
    queryScript = async function* (model: string) {
      if (model === 'hook-model-x') {
        yield refusalMessage(model)
        return
      }
      yield structuredOutputMessage(true, 'verified on caller model')
    }
    const hook = makeHook('hook-model-x')

    const result = await runHook(hook)

    expect(queryCalls.length).toBe(2)
    expect(queryCalls[0].model).toBe('hook-model-x')
    expect(queryCalls[1].model).toBe(CALLER_MODEL)
    expect(debugLogs).toContain(REFUSAL_LOG('hook-model-x'))
    expect(result.outcome).toBe('success')
    // Official: `{...await jZe({...e,model:Wt},…),hook:e}` — the ORIGINAL hook
    // object is preserved on the returned result.
    expect(result.hook).toBe(hook)
  })

  test('OCC error-category fallback (no apiErrorStatus field) also triggers the retry', async () => {
    queryScript = async function* (model: string) {
      if (model === 'hook-model-y') {
        yield refusalMessage(model, false)
        return
      }
      yield structuredOutputMessage(true, 'ok')
    }

    const result = await runHook(makeHook('hook-model-y'))

    expect(queryCalls.length).toBe(2)
    expect(queryCalls[1].model).toBe(CALLER_MODEL)
    expect(debugLogs).toContain(REFUSAL_LOG('hook-model-y'))
    expect(result.outcome).toBe('success')
  })

  test('rate_limit category (429) does NOT trigger the retry', async () => {
    queryScript = async function* (model: string) {
      yield {
        ...refusalMessage(model, false),
        error: 'rate_limit',
      }
    }

    const result = await runHook(makeHook('hook-model-z'))

    expect(queryCalls.length).toBe(1)
    expect(result.outcome).toBe('cancelled')
  })

  test('non-refusal finish (no structured output) does NOT retry', async () => {
    queryScript = async function* () {
      yield {
        type: 'assistant',
        uuid: 'uuid-normal',
        message: { id: 'msg_n', role: 'assistant', content: [], model: 'hook-model-n' },
      }
    }

    const result = await runHook(makeHook('hook-model-n'))

    expect(queryCalls.length).toBe(1)
    expect(result.outcome).toBe('cancelled')
  })

  test('CLAUDE_CODE_NO_MODEL_FALLBACK=true suppresses the retry (official kG tripwire)', async () => {
    process.env.CLAUDE_CODE_NO_MODEL_FALLBACK = 'true'
    queryScript = async function* (model: string) {
      yield refusalMessage(model)
    }

    const result = await runHook(makeHook('hook-model-x'))

    expect(queryCalls.length).toBe(1)
    expect(result.outcome).toBe('cancelled')
  })

  test('double refusal (caller model also refused) → cancelled, hook identity preserved', async () => {
    queryScript = async function* (model: string) {
      yield refusalMessage(model)
    }
    const hook = makeHook('hook-model-x')

    const result = await runHook(hook)

    expect(queryCalls.length).toBe(2)
    expect(queryCalls[1].model).toBe(CALLER_MODEL)
    expect(result.outcome).toBe('cancelled')
    expect(result.hook).toBe(hook)
  })

  test('hook.model === caller model → no retry (official tn!==Wt guard)', async () => {
    queryScript = async function* (model: string) {
      yield refusalMessage(model)
    }

    const result = await runHook(makeHook(CALLER_MODEL))

    expect(queryCalls.length).toBe(1)
    expect(result.outcome).toBe('cancelled')
  })

  test('aborted parent signal → no retry (official !h.aborted guard)', async () => {
    queryScript = async function* (model: string) {
      yield refusalMessage(model)
    }
    const controller = new AbortController()
    controller.abort()

    const result = await runHook(makeHook('hook-model-x'), controller.signal)

    expect(queryCalls.length).toBe(1)
    expect(result.outcome).toBe('cancelled')
  })
})

describe('2.1.300 #28 — agent hook model alias resolution (official AIr)', () => {
  test('"haiku" alias resolves to the model id, not the literal alias', async () => {
    queryScript = async function* () {
      yield structuredOutputMessage(true, 'ok')
    }

    await runHook(makeHook('haiku'))

    const expected = parseUserSpecifiedModel('haiku')
    expect(expected).not.toBe('haiku')
    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0].model).toBe(expected)
  })

  test('alias match is case/whitespace-insensitive ("  Haiku  " resolves)', async () => {
    queryScript = async function* () {
      yield structuredOutputMessage(true, 'ok')
    }

    await runHook(makeHook('  Haiku  '))

    // Official AIr: `jme(e.toLowerCase().trim())?Ot(e):e` — the check
    // normalizes, parseUserSpecifiedModel receives the ORIGINAL string.
    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0].model).toBe(parseUserSpecifiedModel('  Haiku  '))
    expect(queryCalls[0].model).not.toBe('  Haiku  ')
  })

  test('non-alias model string passes through unchanged (case preserved)', async () => {
    queryScript = async function* () {
      yield structuredOutputMessage(true, 'ok')
    }

    await runHook(makeHook('My-Custom-Model-123'))

    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0].model).toBe('My-Custom-Model-123')
  })

  test('hook.model undefined uses the small-fast model WITHOUT alias resolution', async () => {
    // Official: `qt=e.model===void 0?Ut:AIr(Ut)` — AIr only for explicit
    // hook.model. An env-provided alias-looking value stays raw.
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'haiku'
    queryScript = async function* () {
      yield structuredOutputMessage(true, 'ok')
    }

    await runHook(makeHook())

    expect(queryCalls.length).toBe(1)
    expect(queryCalls[0].model).toBe('haiku')
  })

  test('default model refusal also retries on the caller model (official e.model!==Wt with undefined)', async () => {
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'default-small-model'
    queryScript = async function* (model: string) {
      if (model === 'default-small-model') {
        yield refusalMessage(model)
        return
      }
      yield structuredOutputMessage(true, 'ok')
    }

    const result = await runHook(makeHook())

    expect(queryCalls.length).toBe(2)
    expect(queryCalls[1].model).toBe(CALLER_MODEL)
    expect(debugLogs).toContain(REFUSAL_LOG('default-small-model'))
    expect(result.outcome).toBe('success')
  })
})
