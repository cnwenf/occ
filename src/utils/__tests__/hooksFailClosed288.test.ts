import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { constants as BUFFER_CONSTANTS } from 'buffer'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled
// in cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import type { HooksSettings } from '../settings/types.js'

/**
 * claude-code 2.1.288 #57: PreToolUse/PermissionRequest hooks FAIL CLOSED.
 *
 * Official v288 binary forensics (all strings byte-extracted via dd):
 * - `vz=new Set(["PreToolUse","PermissionRequest"])` @199956866 — guarded set.
 * - `kHn="tengu_quiet_hopcroft"` @207801374 — GrowthBook opt-out key.
 * - `bq(e)`: guarded? try{ !(value===true && source==="payload" && !nonDefaultHost) }catch{ true }
 *   — opt-out gate; read failure fails CLOSED.
 * - `Mlt()`: Math.floor(buffer.constants.MAX_STRING_LENGTH/2) — size cap.
 * - `a2t(e,n)`: n.length>Mlt()&&bq(e) — oversize check AFTER stringify.
 * - `lee(e,n,r)`: builds {blockingError:{blockingError:r,command:n},
 *   ...(e==="PermissionRequest" && {permissionRequestResult:{behavior:"deny",message:r}})};
 *   returns undefined when !bq(e).
 * - `Ilt` @207801776 / `Olt` @207802077 — the two user-facing block messages
 *   (verbatim constants below).
 * - REPL matcher catch @~209523400: d2t telemetry → lee(Olt) → yield+return,
 *   else fail-open [].
 * - REPL serializer `_o` + per-hook block @209530200: stringify → a2t →
 *   RangeError("Hook input is over the size limit"); !ok → cleanup() →
 *   lee(`[cmd]: ${Ilt}${pluginSuffix}`) yield blocking, else C0e ?? legacy
 *   non_blocking_error.
 * - SDK path @209553300: matcher catch → d2t → bq? throw : []; stringify
 *   catch → logError + feature_bad → bq? throw : [].
 * - `d2t(e,n)`: logError(Error("Failed to match hooks",{cause:n})) +
 *   tengu_feature_bad{feature_name:`hook_${snakeCase(e)}`, error_code}.
 * - `C0e`: script-hook guard — `[label]: did not run (reason) — a EVENT
 *   guard that cannot run blocks` (dormant in OCC: no 'script' hook type).
 */

// ---------------------------------------------------------------------------
// Verbatim official message builders (byte-extracted, do not paraphrase)
// ---------------------------------------------------------------------------
const ILT_BASE = `Blocked: this call's input can't be written as JSON, so the hook could not check it. The input is too large, or contains a value that JSON can't represent (such as a BigInt or a circular reference). Retry with a smaller, plain input.`

function expectedIlt(jsonError?: string): string {
  return `${ILT_BASE}${jsonError === undefined ? '' : ` (JSON error: ${jsonError})`}`
}

function expectedOlt(hookEvent: string, detail?: string): string {
  return `Blocked: Claude Code could not work out which hooks apply to this call. Retry with a different input. If every call is blocked, check the ${hookEvent} hooks in /hooks or in your settings.${detail === undefined ? '' : ` (${detail})`}`
}

// ---------------------------------------------------------------------------
// Mocks (OCC-97: Bun's mock.module leaks across files — spread the real
// module, override only the seam, restore in afterAll)
// ---------------------------------------------------------------------------
const actualSnapshotModule = await import('../hooks/hooksConfigSnapshot.js')
const actualConfigModule = await import('../config.js')
const actualGrowthbookModule = await import(
  '../../services/analytics/growthbook.js'
)
const actualAnalyticsModule = await import('../../services/analytics/index.js')

let mockSnapshotError: Error | null = null
let mockedHooksConfig: HooksSettings | null = null
let mockOptOutValue: boolean | undefined 
let mockOptOutThrows = false
const capturedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []

mock.module('../hooks/hooksConfigSnapshot.js', () => ({
  ...actualSnapshotModule,
  getHooksConfigFromSnapshot: () => {
    if (mockSnapshotError) {
      throw mockSnapshotError
    }
    return mockedHooksConfig
  },
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
}))

mock.module('../config.js', () => ({
  ...actualConfigModule,
  checkHasTrustDialogAccepted: () => true,
}))

mock.module('../../services/analytics/growthbook.js', () => ({
  ...actualGrowthbookModule,
  getFeatureValue_CACHED_MAY_BE_STALE: (_key: string, fallback: unknown) => {
    if (mockOptOutThrows) {
      throw new Error('growthbook unavailable')
    }
    return mockOptOutValue ?? fallback
  },
}))

mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    capturedEvents.push({ name, metadata })
  },
}))

afterAll(() => {
  mock.module('../hooks/hooksConfigSnapshot.js', () => ({
    ...actualSnapshotModule,
  }))
  mock.module('../config.js', () => ({ ...actualConfigModule }))
  mock.module('../../services/analytics/growthbook.js', () => ({
    ...actualGrowthbookModule,
  }))
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalyticsModule,
  }))
})

const {
  GUARDED_HOOK_EVENTS,
  HOOK_FAIL_CLOSED_OPT_OUT_KEY,
  shouldFailClosedForHookEvent,
  getHookInputSizeLimit,
  isHookInputOverSizeLimit,
  buildHookFailClosedBlockingResult,
  hookInputNotJsonWritableMessage,
  hookMatchingFailedBlockingMessage,
  buildScriptGuardDidNotRunResult,
  getMatchingHooks,
  executePreToolHooks,
  executePermissionRequestHooks,
  executePostToolHooks,
  executeConfigChangeHooks,
} = await import('../hooks.js')

beforeAll(() => {
  delete process.env.CLAUDE_CODE_SIMPLE
})

afterEach(() => {
  mockSnapshotError = null
  mockedHooksConfig = null
  mockOptOutValue = undefined
  mockOptOutThrows = false
  capturedEvents.length = 0
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeToolUseContext(): never {
  return {
    getAppState: () => undefined,
    agentId: undefined,
    options: {},
  } as never
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of gen) {
    out.push(item)
  }
  return out
}

function preToolUseCommandConfig(command: string): HooksSettings {
  return {
    PreToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command }] },
    ],
  } as HooksSettings
}

function featureBadEvents(): Array<{ name: string; metadata: Record<string, unknown> }> {
  return capturedEvents.filter(e => e.name === 'tengu_feature_bad')
}

function circularInput(): Record<string, unknown> {
  const circular: Record<string, unknown> = { cmd: 'ls' }
  circular.self = circular
  return circular
}

/** Temporarily lower Bun's (writable) MAX_STRING_LENGTH constant. */
async function withSmallStringLimit<T>(
  limit: number,
  fn: () => Promise<T>,
): Promise<T> {
  const original = BUFFER_CONSTANTS.MAX_STRING_LENGTH
  try {
    ;(BUFFER_CONSTANTS as { MAX_STRING_LENGTH: number }).MAX_STRING_LENGTH =
      limit
    return await fn()
  } finally {
    ;(BUFFER_CONSTANTS as { MAX_STRING_LENGTH: number }).MAX_STRING_LENGTH =
      original
  }
}

// ---------------------------------------------------------------------------
// Unit: guarded set + opt-out gate (official vz / bq)
// ---------------------------------------------------------------------------
describe('2.1.288 #57 guarded events + opt-out gate', () => {
  test('guarded set is exactly PreToolUse + PermissionRequest', () => {
    expect([...GUARDED_HOOK_EVENTS].sort()).toEqual([
      'PermissionRequest',
      'PreToolUse',
    ])
  })

  test('opt-out key is tengu_quiet_hopcroft', () => {
    expect(HOOK_FAIL_CLOSED_OPT_OUT_KEY).toBe('tengu_quiet_hopcroft')
  })

  test('guarded event + config false → fail closed', () => {
    mockOptOutValue = false
    expect(shouldFailClosedForHookEvent('PreToolUse')).toBe(true)
    expect(shouldFailClosedForHookEvent('PermissionRequest')).toBe(true)
  })

  test('guarded event + config true → opted out (no fail-closed)', () => {
    mockOptOutValue = true
    expect(shouldFailClosedForHookEvent('PreToolUse')).toBe(false)
  })

  test('guarded event + config read throws → fail closed (official catch→true)', () => {
    mockOptOutThrows = true
    expect(shouldFailClosedForHookEvent('PreToolUse')).toBe(true)
  })

  test('non-guarded event → never fail closed', () => {
    mockOptOutValue = false
    expect(shouldFailClosedForHookEvent('PostToolUse')).toBe(false)
    expect(shouldFailClosedForHookEvent('Stop')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: size cap (official Mlt / a2t)
// ---------------------------------------------------------------------------
describe('2.1.288 #57 hook input size cap', () => {
  test('cap is Math.floor(MAX_STRING_LENGTH / 2), computed per call', async () => {
    expect(getHookInputSizeLimit()).toBe(
      Math.floor(BUFFER_CONSTANTS.MAX_STRING_LENGTH / 2),
    )
    await withSmallStringLimit(11, async () => {
      expect(getHookInputSizeLimit()).toBe(5)
      expect(isHookInputOverSizeLimit('PreToolUse', 'x'.repeat(6))).toBe(true)
      expect(isHookInputOverSizeLimit('PreToolUse', 'x'.repeat(5))).toBe(false)
      // a2t: n.length>Mlt()&&bq(e) — non-guarded / opted-out never oversize
      expect(isHookInputOverSizeLimit('PostToolUse', 'x'.repeat(6))).toBe(false)
      mockOptOutValue = true
      expect(isHookInputOverSizeLimit('PreToolUse', 'x'.repeat(6))).toBe(false)
    })
  })

  test('default limit is unaffected after restore', () => {
    expect(getHookInputSizeLimit()).toBe(
      Math.floor(BUFFER_CONSTANTS.MAX_STRING_LENGTH / 2),
    )
    expect(isHookInputOverSizeLimit('PreToolUse', 'x'.repeat(100))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: verbatim messages (official Ilt / Olt) + lee builder
// ---------------------------------------------------------------------------
describe('2.1.288 #57 message builders + blocking result', () => {
  test('hookInputNotJsonWritableMessage matches official Ilt verbatim', () => {
    expect(hookInputNotJsonWritableMessage()).toBe(ILT_BASE)
    expect(hookInputNotJsonWritableMessage(new Error('bad'))).toBe(
      `${ILT_BASE} (JSON error: bad)`,
    )
    expect(hookInputNotJsonWritableMessage('plain string error')).toBe(
      `${ILT_BASE} (JSON error: plain string error)`,
    )
  })

  test('hookMatchingFailedBlockingMessage matches official Olt verbatim', () => {
    expect(hookMatchingFailedBlockingMessage('PreToolUse')).toBe(
      expectedOlt('PreToolUse'),
    )
    expect(hookMatchingFailedBlockingMessage('PreToolUse', new Error('boom'))).toBe(
      expectedOlt('PreToolUse', 'boom'),
    )
  })

  test('buildHookFailClosedBlockingResult matches official lee shape', () => {
    // PreToolUse: blockingError only
    const pre = buildHookFailClosedBlockingResult(
      'PreToolUse',
      'PreToolUse:Bash',
      'msg',
    )
    expect(pre).toEqual({
      blockingError: { blockingError: 'msg', command: 'PreToolUse:Bash' },
    })
    expect(pre?.permissionRequestResult).toBeUndefined()

    // PermissionRequest: + deny permissionRequestResult
    const perm = buildHookFailClosedBlockingResult(
      'PermissionRequest',
      'PermissionRequest:Bash',
      'msg',
    )
    expect(perm).toEqual({
      blockingError: { blockingError: 'msg', command: 'PermissionRequest:Bash' },
      permissionRequestResult: { behavior: 'deny', message: 'msg' },
    })

    // Opted out → undefined (official: if(!bq(e))return)
    mockOptOutValue = true
    expect(
      buildHookFailClosedBlockingResult('PreToolUse', 'cmd', 'msg'),
    ).toBeUndefined()

    // Non-guarded → undefined
    mockOptOutValue = false
    expect(
      buildHookFailClosedBlockingResult('PostToolUse', 'cmd', 'msg'),
    ).toBeUndefined()
  })

  test('buildScriptGuardDidNotRunResult matches official C0e (dormant: no script hooks in OCC)', () => {
    const scriptHook = { type: 'script', command: 'guard.sh' } as never
    const result = buildScriptGuardDidNotRunResult(
      scriptHook,
      'PreToolUse',
      'guard.sh',
      'hook input: bad',
    )
    const expectedMessage = `[guard.sh]: did not run (hook input: bad) — a PreToolUse guard that cannot run blocks`
    expect(result).toEqual({
      blockingError: { blockingError: expectedMessage, command: 'guard.sh' },
      permissionRequestResult: undefined,
      outcome: 'blocking',
      hook: scriptHook,
    })
    // Official spreads lee() — for PermissionRequest the deny is included
    const permResult = buildScriptGuardDidNotRunResult(
      scriptHook,
      'PermissionRequest',
      'guard.sh',
      'reason',
    )
    expect(permResult?.blockingError?.blockingError).toContain(
      'did not run (reason)',
    )
    expect(permResult?.permissionRequestResult).toEqual({
      behavior: 'deny',
      message: permResult?.blockingError?.blockingError,
    })

    // Non-script hook → undefined (guard is script-only)
    expect(
      buildScriptGuardDidNotRunResult(
        { type: 'command', command: 'true' } as never,
        'PreToolUse',
        'true',
        'reason',
      ),
    ).toBeUndefined()
    // Non-guarded event → undefined
    expect(
      buildScriptGuardDidNotRunResult(
        scriptHook,
        'PostToolUse',
        'guard.sh',
        'reason',
      ),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getMatchingHooks: matcher failures propagate (official REPL/SDK catch them)
// ---------------------------------------------------------------------------
describe('2.1.288 #57 getMatchingHooks rethrows matcher failures', () => {
  test('snapshot getter throw rejects instead of fail-open []', async () => {
    mockSnapshotError = new Error('boom matcher')
    await expect(
      getMatchingHooks(undefined, 'sess', 'PreToolUse', {
        hook_event_name: 'PreToolUse',
      } as never),
    ).rejects.toThrow('boom matcher')
  })
})

// ---------------------------------------------------------------------------
// REPL path: executePreToolHooks / executePermissionRequestHooks
// ---------------------------------------------------------------------------
describe('2.1.288 #57 executePreToolHooks matcher failure fails closed', () => {
  test('PreToolUse matcher throw → blocked with exact Olt text + telemetry', async () => {
    mockSnapshotError = new Error('boom matcher')
    const results = await collect(
      executePreToolHooks(
        'Bash',
        'tu-1',
        { command: 'ls' },
        fakeToolUseContext(),
      ),
    )
    const blocking = results.filter(r => r.blockingError !== undefined)
    expect(blocking.length).toBe(1)
    expect(blocking[0]?.blockingError).toEqual({
      blockingError: expectedOlt('PreToolUse', 'boom matcher'),
      command: 'PreToolUse:Bash',
    })
    // d2t telemetry: tengu_feature_bad hook_pre_tool_use / hook_matching_failed
    const bad = featureBadEvents()
    expect(bad.length).toBeGreaterThanOrEqual(1)
    expect(bad[0]?.metadata.feature_name).toBe('hook_pre_tool_use')
    expect(bad[0]?.metadata.error_code).toBe('hook_matching_failed')
  })

  test('PermissionRequest matcher throw → deny with exact Olt text', async () => {
    mockSnapshotError = new Error('boom matcher')
    const results = await collect(
      executePermissionRequestHooks(
        'Bash',
        'tu-2',
        { command: 'ls' },
        fakeToolUseContext(),
      ),
    )
    const expectedMessage = expectedOlt('PermissionRequest', 'boom matcher')
    const blocking = results.filter(r => r.blockingError !== undefined)
    expect(blocking.length).toBe(1)
    expect(blocking[0]?.blockingError).toEqual({
      blockingError: expectedMessage,
      command: 'PermissionRequest:Bash',
    })
    const deny = results.filter(r => r.permissionRequestResult !== undefined)
    expect(deny.length).toBe(1)
    expect(deny[0]?.permissionRequestResult).toEqual({
      behavior: 'deny',
      message: expectedMessage,
    })
    expect(featureBadEvents()[0]?.metadata.feature_name).toBe(
      'hook_permission_request',
    )
  })

  test('opt-out (tengu_quiet_hopcroft=true) → old fail-open behavior', async () => {
    mockSnapshotError = new Error('boom matcher')
    mockOptOutValue = true
    const results = await collect(
      executePreToolHooks(
        'Bash',
        'tu-3',
        { command: 'ls' },
        fakeToolUseContext(),
      ),
    )
    expect(results.filter(r => r.blockingError !== undefined)).toEqual([])
  })

  test('non-guarded event (PostToolUse) matcher throw → fail-open unchanged', async () => {
    mockSnapshotError = new Error('boom matcher')
    const results = await collect(
      executePostToolHooks(
        'Bash',
        'tu-4',
        { command: 'ls' },
        { stdout: 'ok' },
        fakeToolUseContext(),
      ),
    )
    expect(results.filter(r => r.blockingError !== undefined)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// REPL path: JSON-unwritable / oversize hook input
// ---------------------------------------------------------------------------
describe('2.1.288 #57 hook input serialization failures fail closed', () => {
  test('circular tool_input → blocked with [cmd]: Ilt text + stringify telemetry', async () => {
    mockedHooksConfig = preToolUseCommandConfig('echo hi')
    const results = await collect(
      executePreToolHooks('Bash', 'tu-5', circularInput(), fakeToolUseContext()),
    )
    const blocking = results.filter(r => r.blockingError !== undefined)
    expect(blocking.length).toBe(1)
    const message = blocking[0]?.blockingError?.blockingError ?? ''
    expect(message.startsWith(`[echo hi]: ${ILT_BASE} (JSON error: `)).toBe(true)
    expect(message.endsWith(')')).toBe(true)
    expect(blocking[0]?.blockingError?.command).toBe('echo hi')
    // Batch-tail telemetry (official Mo)
    const bad = featureBadEvents()
    expect(bad.some(
      e =>
        e.metadata.feature_name === 'hook_pre_tool_use' &&
        e.metadata.error_code === 'hook_input_stringify_failed',
    )).toBe(true)
  })

  test('oversize tool_input → RangeError path blocks + hook_input_too_large telemetry', async () => {
    mockedHooksConfig = preToolUseCommandConfig('echo hi')
    await withSmallStringLimit(40, async () => {
      const results = await collect(
        executePreToolHooks(
          'Bash',
          'tu-6',
          { cmd: 'x'.repeat(100) },
          fakeToolUseContext(),
        ),
      )
      const blocking = results.filter(r => r.blockingError !== undefined)
      expect(blocking.length).toBe(1)
      expect(blocking[0]?.blockingError?.blockingError).toBe(
        `[echo hi]: ${expectedIlt('Hook input is over the size limit')}`,
      )
      const bad = featureBadEvents()
      expect(bad.some(
        e =>
          e.metadata.feature_name === 'hook_pre_tool_use' &&
          e.metadata.error_code === 'hook_input_too_large',
      )).toBe(true)
    })
  })

  test('oversize but opted out → not blocked (a2t includes bq gate)', async () => {
    mockedHooksConfig = preToolUseCommandConfig('echo hi')
    mockOptOutValue = true
    await withSmallStringLimit(40, async () => {
      const results = await collect(
        executePreToolHooks(
          'Bash',
          'tu-7',
          { cmd: 'x'.repeat(100) },
          fakeToolUseContext(),
        ),
      )
      // Opted out: oversize is not flagged, hook runs normally (echo hi may
      // execute; we only assert NO fail-closed blocking with the Ilt text).
      const failClosedBlocking = results.filter(
        r =>
          r.blockingError !== undefined &&
          (r.blockingError?.blockingError ?? '').includes(ILT_BASE),
      )
      expect(failClosedBlocking).toEqual([])
    })
  })

  test('non-guarded event (PostToolUse) circular input → legacy non_blocking_error, no block', async () => {
    mockedHooksConfig = {
      PostToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] },
      ],
    } as HooksSettings
    const results = await collect(
      executePostToolHooks(
        'Bash',
        'tu-8',
        circularInput(),
        { stdout: 'ok' },
        fakeToolUseContext(),
      ),
    )
    const blocking = results.filter(r => r.blockingError !== undefined)
    expect(blocking).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Outside-REPL (SDK/-p) path: guarded rethrow, non-guarded fail-open
// ---------------------------------------------------------------------------
describe('2.1.288 #57 executeHooksOutsideREPL', () => {
  test('non-guarded event (ConfigChange) matcher throw → fail-open []', async () => {
    mockSnapshotError = new Error('boom matcher')
    const results = await executeConfigChangeHooks('user_settings')
    expect(results).toEqual([])
  })
})
