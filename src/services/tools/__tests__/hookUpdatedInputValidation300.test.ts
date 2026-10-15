import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext, ValidationResult } from '../../../Tool.js'

// MACRO polyfill (repo convention).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}
process.env.ANTHROPIC_API_KEY ??= 'occ-ci-test-key'

/**
 * CC 2.1.300 (#65) — "Changed hooks: `updatedInput` from PreToolUse and
 * PermissionRequest hooks is now validated like Claude's own input: unknown
 * keys are dropped, and input the tool rejects denies the call."
 *
 * Byte evidence (v300 ELF — full decompilation in the port notes):
 *   `aHe` (checker) @225233390 — order: unconditional YMt deny on real
 *     (non-`unrecognized_keys`) schema issues → `applies` early-return (raw
 *     input) → enforcement gate `me()||da("tengu_glimmering_newt",{safe:!0})`
 *     → `tengu_hook_rewrite_checked` telemetry → `__artifact` reserved-key
 *     pre-check (shown-value exemption `XMt`) → deep unknown-key strip
 *     (`iHe`/`tHe`) + re-parse → shown-key merge (`S_o`) → `validate` +
 *     backfill re-apply (`b_o`) → dropped-key count (`QMt`) → tool-refused /
 *     check-threw denies → `{ok:!0,input:h?H:n}`.
 *   `eHe` @225233640 region: "The tool input from the model was valid; the
 *     hook's rewrite of it was not."
 *   `ude`: `${event} hook${source===undefined||source==="settings" ? "" : ` (${source})`} for ${tool.name}`
 *   `YMt` @225237068: `${ude} returned updatedInput that failed schema validation: ${b0(...)}\n${eHe}`
 *   tool-refused deny: `${ude} returned updatedInput that the tool refused: ${w.message}\n${eHe}`
 *   check-threw deny: `${ude} returned updatedInput that the tool could not check: ${K}\nThe tool input from the model was valid.`
 *   reserved-key head: `${ude} returned updatedInput with a key starting with "__artifact" (in any letter case)`
 *     PreToolUse tail: `. Only Claude Code sets such keys. Remove the key from updatedInput. The tool was not run.`
 *     PermissionRequest tail: ` that Claude Code did not set, or did not set to that value. Only Claude Code sets such keys: send one back unchanged, and add none. The tool was not run.\n${eHe}`
 *   `ykr` @227296608 (chokepoint parse): safeParse, filter out
 *     `unrecognized_keys`, null when nothing real remains.
 *   PreToolUse caller (official `zfr` generator) @227259000: validation runs
 *     INSIDE the hook-result loop; `applies: permissionBehavior!=="deny"&&
 *     permissionBehavior!=="defer"`; deny → yield hookPermissionResult +
 *     `continue`; success → the CLEANED input replaces `updatedInput` for the
 *     allow/ask/passthrough yields.
 *
 * OCC deviations (documented):
 *   - Enforcement is the constant `true`: OCC's gate helper
 *     (checkStatsigFeatureGate_CACHED_MAY_BE_STALE) has no `{safe:!0}`
 *     param and returns false when GrowthBook is disabled; the changelog
 *     states the behavior unconditionally → enforce always (safe default).
 *   - `vy(e)` in the official warn logs is unresolved in the binary (two
 *     same-name candidates, neither a plausible tool-name getter); OCC uses
 *     `tool.name` (debug-level log, not user-visible).
 *   - `decideLocation:"ask-path"` (official `T_o` on PermissionRequest
 *     denies) is not ported — no OCC type/consumer for the field.
 */

// --- Mock seams (OCC-97 pattern). ---

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
const warnLogs: string[] = []
mock.module('../../../utils/debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: (msg: string, opts?: { level?: string }) => {
    if (opts?.level === 'warn') warnLogs.push(msg)
  },
}))

const actualAnalyticsModule = await import('../../analytics/index.js')
const analyticsEvents: Array<{ name: string; metadata: Record<string, unknown> }> = []
mock.module('../../analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    analyticsEvents.push({ name, metadata })
  },
}))

afterAll(() => {
  mock.module('../../../utils/hooks.js', () => ({ ...actualHooksModule }))
  mock.module('../../../utils/debug.js', () => ({ ...actualDebugModule }))
  mock.module('../../analytics/index.js', () => ({ ...actualAnalyticsModule }))
})

const {
  HOOK_MODEL_INPUT_VALID_NOTE,
  checkHookUpdatedInput,
  checkPermissionRequestUpdatedInput,
  findPermissionUpdatedInputSchemaIssues,
  isEmptyPlainObject,
} = await import('../../../utils/permissions/hookUpdatedInputValidation.js')
const { runPreToolUseHooks } = await import('../toolHooks.js')
const { getDefaultAppState } = await import('../../../state/AppStateStore.js')

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const TOOL_NAME = 'FakeRewriteTool'
const schema = z.strictObject({ cmd: z.string() })

function makeTool(
  validate?: (input: Record<string, unknown>) => Promise<ValidationResult | undefined>,
  backfill?: (input: Record<string, unknown>) => void,
): Tool {
  return {
    name: TOOL_NAME,
    inputSchema: schema,
    ...(validate ? { validateInput: validate } : {}),
    ...(backfill ? { backfillObservableInput: backfill } : {}),
  } as unknown as Tool
}

const okValidate = async () => ({ result: true as const })

function ctxFor(event: 'PreToolUse' | 'PermissionRequest') {
  return {
    event,
    applies: true,
    validate: okValidate,
  } as Parameters<typeof checkHookUpdatedInput>[2]
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

beforeEach(() => {
  preToolHookResults = []
  warnLogs.length = 0
  analyticsEvents.length = 0
})

// ---------------------------------------------------------------------------
// Unit: checkHookUpdatedInput (official aHe)
// ---------------------------------------------------------------------------

describe('2.1.300 #65 — checkHookUpdatedInput (official aHe)', () => {
  test('unknown keys are dropped (deep strip + re-parse)', async () => {
    const outcome = await checkHookUpdatedInput(
      makeTool(undefined, undefined),
      { cmd: 'ls', bogus: 1, nested: { keep: 'x', drop: 'y' } },
      ctxFor('PreToolUse'),
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toEqual({ cmd: 'ls' })
    }
    // dropped-key warn (official: "dropped N key(s) that the tool's schema does not know")
    expect(
      warnLogs.some(w =>
        w.includes(
          `PreToolUse hook's updatedInput for ${TOOL_NAME}: dropped 2 key(s) that the tool's schema does not know`,
        ),
      ),
    ).toBe(true)
  })

  test('valid input passes through as parsed data', async () => {
    const updated = { cmd: 'ls' }
    const outcome = await checkHookUpdatedInput(makeTool(), updated, ctxFor('PreToolUse'))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toEqual({ cmd: 'ls' })
    }
    expect(warnLogs.length).toBe(0)
  })

  test('real schema failure denies with the exact official message (YMt)', async () => {
    const outcome = await checkHookUpdatedInput(
      makeTool(),
      { cmd: 123 } as unknown as Record<string, unknown>,
      ctxFor('PreToolUse'),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.behavior).toBe('deny')
      const message = outcome.deny.message ?? ''
      expect(message.startsWith(
        `PreToolUse hook for ${TOOL_NAME} returned updatedInput that failed schema validation: `,
      )).toBe(true)
      expect(message.endsWith(`\n${HOOK_MODEL_INPUT_VALID_NOTE}`)).toBe(true)
      expect(HOOK_MODEL_INPUT_VALID_NOTE).toBe(
        "The tool input from the model was valid; the hook's rewrite of it was not.",
      )
      expect(outcome.deny.decisionReason).toMatchObject({
        type: 'hook',
        hookName: `PreToolUse:${TOOL_NAME}`,
        reason: message,
      })
    }
    expect(
      warnLogs.some(w =>
        w.startsWith(
          `PreToolUse hook's updatedInput for ${TOOL_NAME} failed schema validation (`,
        ),
      ),
    ).toBe(true)
  })

  test('hook source appears in the deny label (" (plugin:foo)")', async () => {
    const outcome = await checkHookUpdatedInput(makeTool(), { cmd: 123 } as never, {
      event: 'PreToolUse',
      source: 'plugin:foo',
      applies: true,
      validate: okValidate,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.message).toContain(
        `PreToolUse hook (plugin:foo) for ${TOOL_NAME} returned updatedInput that failed schema validation:`,
      )
      expect(outcome.deny.decisionReason).toMatchObject({ hookSource: 'plugin:foo' })
    }
  })

  test('applies=false: real schema issues STILL deny (unconditional head)', async () => {
    const outcome = await checkHookUpdatedInput(makeTool(), { cmd: 123 } as never, {
      event: 'PreToolUse',
      applies: false,
      validate: okValidate,
    })
    expect(outcome.ok).toBe(false)
  })

  test('applies=false: unknown keys are NOT stripped (raw input returned)', async () => {
    const raw = { cmd: 'ls', bogus: 1 }
    const outcome = await checkHookUpdatedInput(makeTool(), raw, {
      event: 'PreToolUse',
      applies: false,
      validate: okValidate,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toBe(raw)
    }
  })

  test('tool validateInput refusal denies with the exact official message', async () => {
    // Official callers wire r.validate to the tool's own validateInput
    // (`H=(K)=>n.validateInput?.(K,{...e,toolUseId:s})`) — mirror that here.
    const refuseValidate = async () =>
      ({ result: false as const, message: 'refused-by-tool', errorCode: 7 }) as ValidationResult
    const tool = makeTool(refuseValidate)
    const outcome = await checkHookUpdatedInput(tool, { cmd: 'ls' }, {
      event: 'PreToolUse',
      applies: true,
      validate: refuseValidate,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.message).toBe(
        `PreToolUse hook for ${TOOL_NAME} returned updatedInput that the tool refused: refused-by-tool\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
      )
    }
    expect(
      warnLogs.some(w =>
        w ===
        `PreToolUse hook's updatedInput for ${TOOL_NAME} was refused by the tool (code=7)`,
      ),
    ).toBe(true)
  })

  test('validateInput throw denies with "could not check" + the exact tail', async () => {
    const throwingValidate = async (): Promise<ValidationResult | undefined> => {
      throw new Error('kaboom')
    }
    const tool = makeTool(throwingValidate)
    const outcome = await checkHookUpdatedInput(tool, { cmd: 'ls' }, {
      event: 'PreToolUse',
      applies: true,
      validate: throwingValidate,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.message).toBe(
        `PreToolUse hook for ${TOOL_NAME} returned updatedInput that the tool could not check: kaboom\nThe tool input from the model was valid.`,
      )
    }
  })

  test('__artifact reserved key denies (PreToolUse wording, jMt decisionReason)', async () => {
    const outcome = await checkHookUpdatedInput(
      makeTool(),
      { cmd: 'ls', __artifactSigil: 'minted' },
      ctxFor('PreToolUse'),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.message).toBe(
        `PreToolUse hook for ${TOOL_NAME} returned updatedInput with a key starting with "__artifact" (in any letter case). Only Claude Code sets such keys. Remove the key from updatedInput. The tool was not run.`,
      )
      expect(outcome.deny.decisionReason).toMatchObject({
        type: 'other',
        reason: 'tool call carried a key only an artifact check mints',
      })
    }
  })

  test('__artifact reserved key denies (PermissionRequest wording via cde)', async () => {
    const outcome = await checkHookUpdatedInput(
      makeTool(),
      { cmd: 'ls', __ARTIFACTx: 'minted' },
      ctxFor('PermissionRequest'),
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.deny.message).toBe(
        `PermissionRequest hook for ${TOOL_NAME} returned updatedInput with a key starting with "__artifact" (in any letter case) that Claude Code did not set, or did not set to that value. Only Claude Code sets such keys: send one back unchanged, and add none. The tool was not run.\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
      )
      expect(outcome.deny.decisionReason).toMatchObject({
        type: 'hook',
        hookName: 'PermissionRequest',
      })
    }
  })

  test('shown-value exemption (XMt): an unchanged shown __artifact key is allowed', async () => {
    const shown = { cmd: 'ls', __artifactSigil: 'orig' }
    const outcome = await checkHookUpdatedInput(makeTool(), { ...shown }, {
      event: 'PermissionRequest',
      applies: true,
      validate: okValidate,
      shown,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      // S_o merge: the shown key survives even though the schema dropped it.
      expect(outcome.input).toEqual({ cmd: 'ls', __artifactSigil: 'orig' })
    }
  })

  test('shown __artifact key with a CHANGED value still denies', async () => {
    const shown = { cmd: 'ls', __artifactSigil: 'orig' }
    const outcome = await checkHookUpdatedInput(
      makeTool(),
      { cmd: 'ls', __artifactSigil: 'tampered' },
      { event: 'PermissionRequest', applies: true, validate: okValidate, shown },
    )
    expect(outcome.ok).toBe(false)
  })

  test('backfillObservableInput is re-applied to the cleaned input (b_o)', async () => {
    const tool = makeTool(okValidate, input => {
      input.observed = true
    })
    const outcome = await checkHookUpdatedInput(tool, { cmd: 'ls' }, ctxFor('PreToolUse'))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.input).toEqual({ cmd: 'ls', observed: true })
    }
  })

  test('tengu_hook_rewrite_checked telemetry fires with enforced=true', async () => {
    await checkHookUpdatedInput(makeTool(), { cmd: 'ls', bogus: 1 }, ctxFor('PreToolUse'))
    const evt = analyticsEvents.find(e => e.name === 'tengu_hook_rewrite_checked')
    expect(evt).toBeDefined()
    expect(evt!.metadata).toMatchObject({
      hook_event: 'PreToolUse',
      tool_name: TOOL_NAME,
      enforced: true,
    })
  })
})

// ---------------------------------------------------------------------------
// Unit: checkPermissionRequestUpdatedInput (official xCt)
// ---------------------------------------------------------------------------

describe('2.1.300 #65 — checkPermissionRequestUpdatedInput (official xCt)', () => {
  test('undefined updatedInput passes through untouched', async () => {
    const shown = { cmd: 'ls' }
    const out = await checkPermissionRequestUpdatedInput(
      makeTool(),
      undefined,
      shown,
      okValidate,
    )
    expect(out.deny).toBeUndefined()
    expect(out.input).toBeUndefined()
  })

  test('empty object passes through untouched', async () => {
    const empty = {}
    const out = await checkPermissionRequestUpdatedInput(makeTool(), empty, { cmd: 'ls' }, okValidate)
    expect(out.deny).toBeUndefined()
    expect(out.input).toBe(empty)
  })

  test('deep-equal to shown input returns the ORIGINAL shown object (SR shortcut)', async () => {
    const shown = { cmd: 'ls' }
    const out = await checkPermissionRequestUpdatedInput(makeTool(), { cmd: 'ls' }, shown, okValidate)
    expect(out.deny).toBeUndefined()
    expect(out.input).toBe(shown)
  })

  test('invalid updatedInput returns a deny (hookName PermissionRequest)', async () => {
    const out = await checkPermissionRequestUpdatedInput(
      makeTool(),
      { cmd: 123 } as never,
      { cmd: 'ls' },
      okValidate,
    )
    expect(out.deny).toBeDefined()
    expect(out.deny!.behavior).toBe('deny')
    expect(out.deny!.decisionReason).toMatchObject({
      type: 'hook',
      hookName: 'PermissionRequest',
    })
  })

  test('unknown keys stripped, cleaned input returned', async () => {
    const out = await checkPermissionRequestUpdatedInput(
      makeTool(),
      { cmd: 'ls', bogus: 1 },
      { cmd: 'old' },
      okValidate,
    )
    expect(out.deny).toBeUndefined()
    expect(out.input).toEqual({ cmd: 'ls' })
  })
})

// ---------------------------------------------------------------------------
// Unit: findPermissionUpdatedInputSchemaIssues (official ykr) + cEe
// ---------------------------------------------------------------------------

describe('2.1.300 #65 — chokepoint parse helpers (official ykr / cEe)', () => {
  test('only unrecognized keys → null (chokepoint tolerates)', () => {
    expect(findPermissionUpdatedInputSchemaIssues(schema, { cmd: 'ls', bogus: 1 })).toBeNull()
  })

  test('real schema issue → issues array', () => {
    const issues = findPermissionUpdatedInputSchemaIssues(schema, { cmd: 123 } as never)
    expect(issues).not.toBeNull()
    expect(issues!.length).toBeGreaterThan(0)
    expect(issues!.every(i => i.code !== 'unrecognized_keys')).toBe(true)
  })

  test('valid input → null', () => {
    expect(findPermissionUpdatedInputSchemaIssues(schema, { cmd: 'ls' })).toBeNull()
  })

  test('isEmptyPlainObject (official cEe)', () => {
    expect(isEmptyPlainObject({})).toBe(true)
    expect(isEmptyPlainObject({ a: 1 })).toBe(false)
    expect(isEmptyPlainObject([])).toBe(false)
    expect(isEmptyPlainObject(null)).toBe(false)
    expect(isEmptyPlainObject('x')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Wiring: runPreToolUseHooks (official zfr loop)
// ---------------------------------------------------------------------------

async function collectPreToolUseHooks(tool: Tool, input: Record<string, unknown>) {
  const yields: Array<Record<string, unknown>> = []
  for await (const item of runPreToolUseHooks(
    makeToolUseContext(),
    tool,
    input,
    'tu_300_65',
    'msg_300_65',
    undefined as never,
    undefined as never,
    undefined,
  )) {
    yields.push(item as Record<string, unknown>)
  }
  return yields
}

describe('2.1.300 #65 — runPreToolUseHooks wiring (official zfr)', () => {
  test('passthrough updatedInput with unknown keys → hookUpdatedInput yields the STRIPPED input', async () => {
    preToolHookResults = [{ updatedInput: { cmd: 'ls', bogus: 1 } }]
    const yields = await collectPreToolUseHooks(makeTool(), { cmd: 'ls' })
    const passthrough = yields.find(y => y.type === 'hookUpdatedInput')
    expect(passthrough).toBeDefined()
    expect(passthrough!.updatedInput).toEqual({ cmd: 'ls' })
  })

  test('allow + invalid updatedInput → deny hookPermissionResult with the exact message', async () => {
    preToolHookResults = [
      { permissionBehavior: 'allow', updatedInput: { cmd: 123 }, hookSource: 'settings' },
    ]
    const yields = await collectPreToolUseHooks(makeTool(), { cmd: 'ls' })
    const deny = yields.find(y => y.type === 'hookPermissionResult') as
      | { hookPermissionResult: { behavior: string; message?: string } }
      | undefined
    expect(deny).toBeDefined()
    expect(deny!.hookPermissionResult.behavior).toBe('deny')
    expect(deny!.hookPermissionResult.message!.startsWith(
      `PreToolUse hook for ${TOOL_NAME} returned updatedInput that failed schema validation: `,
    )).toBe(true)
    expect(deny!.hookPermissionResult.message!.endsWith(`\n${HOOK_MODEL_INPUT_VALID_NOTE}`)).toBe(true)
    // The hook's own allow must NOT be yielded.
    const allow = yields.find(
      y =>
        y.type === 'hookPermissionResult' &&
        (y as { hookPermissionResult: { behavior: string } }).hookPermissionResult.behavior === 'allow',
    )
    expect(allow).toBeUndefined()
  })

  test('allow + valid updatedInput → allow yields the (cleaned) updatedInput', async () => {
    preToolHookResults = [
      { permissionBehavior: 'allow', updatedInput: { cmd: 'safe', bogus: 2 } },
    ]
    const yields = await collectPreToolUseHooks(makeTool(), { cmd: 'ls' })
    const allow = yields.find(y => y.type === 'hookPermissionResult') as
      | { hookPermissionResult: { behavior: string; updatedInput?: unknown } }
      | undefined
    expect(allow).toBeDefined()
    expect(allow!.hookPermissionResult.behavior).toBe('allow')
    expect(allow!.hookPermissionResult.updatedInput).toEqual({ cmd: 'safe' })
  })

  test('tool-refusing updatedInput on passthrough → deny (input the tool rejects denies the call)', async () => {
    const tool = makeTool(async input =>
      input.cmd === 'rm -rf /'
        ? { result: false as const, message: 'dangerous command', errorCode: 3 }
        : { result: true as const },
    )
    preToolHookResults = [{ updatedInput: { cmd: 'rm -rf /' } }]
    const yields = await collectPreToolUseHooks(tool, { cmd: 'ls' })
    const deny = yields.find(y => y.type === 'hookPermissionResult') as
      | { hookPermissionResult: { behavior: string; message?: string } }
      | undefined
    expect(deny).toBeDefined()
    expect(deny!.hookPermissionResult.behavior).toBe('deny')
    expect(deny!.hookPermissionResult.message).toBe(
      `PreToolUse hook for ${TOOL_NAME} returned updatedInput that the tool refused: dangerous command\n${HOOK_MODEL_INPUT_VALID_NOTE}`,
    )
    // No passthrough yield for the refused input.
    expect(yields.find(y => y.type === 'hookUpdatedInput')).toBeUndefined()
  })
})
