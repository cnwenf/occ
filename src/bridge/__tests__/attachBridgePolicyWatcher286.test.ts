import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill — the initReplBridge import graph reads MACRO.VERSION.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * PORT (CC 2.1.286) — attachBridgePolicyWatcher (REPL lane).
 *
 * Official wiring (byte-verified @225854200+ in the v286 linux-x64 binary):
 *   Nl = memo(() => { gate on enabled&&connected; r = WAe(outboundOnly);
 *     if r===null return; clear-state (try/catch → `Policy disconnect
 *     failed`); notice+log+telemetry (try/catch → `Policy disconnect notice
 *     failed`) })
 *   effect: if ready && !killSwitch → D0(() => queueMicrotask(Nl)), Nl()
 *   once, unsubscribe on cleanup.
 *
 * OCC surface: handle.teardown() + onStateChange('failed', detail) replace
 * the official AppState clear (React-context-only store — documented
 * divergence); transcript append stays staged.
 *
 * HERMETIC DESIGN — no mock.module on bridgePolicyRefusal/policyLimits: bun
 * 1.3.14 mock.module restores do NOT propagate across test files (empirically
 * verified), so mocking those shared paths here would poison later files'
 * real modules. The refusal is driven through the REAL policyLimits cache:
 * an axios-level mock feeds refreshPolicyLimits, and mid-session org flips
 * are simulated by changing the payload and re-refreshing (which fires the
 * real onPolicyLimitsChange subscription). The analytics/debug/axios shims
 * below use the OCC-103 round-3 delegation + `mockActive` pattern (exemplar:
 * sessionStorage.parallelTRRecovery286.test.ts) — leak-free in a shared
 * `bun test` process, guarded by scripts/ci-test.sh (see the same-worker
 * leak-pair section there).
 */

// --- hermetic env: eligible Console API-key user, temp config dir
const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-at-286-'))
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
}
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-port286'
process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_UNIX_SOCKET
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

// --- leak-free delegation shims (analytics + debug + axios).
// bun's mock.module() is PERMANENT process-wide: an afterAll restore does NOT
// propagate to files loaded later in the same `bun test` process (documented
// in scripts/ci-test.sh:4-12; this file originally shipped the plain-spread
// capture variant and was the OCC-104 P2 cross-file polluter). Every shim
// therefore delegates to the REAL function captured by value unless
// `mockActive` is true — and the flag is flipped ONLY in this file's
// beforeEach/afterEach (never at module top level), so the shims stay
// transparent for every other file's tests regardless of load order.
let mockActive = false

const actualAnalytics = await import('../../services/analytics/index.js')
const actualLogEvent = actualAnalytics.logEvent
const telemetryEvents: Array<{ name: string; metadata: unknown }> = []
mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata?: unknown) => {
    if (!mockActive) {
      actualLogEvent(name, metadata as never)
      return
    }
    telemetryEvents.push({ name, metadata })
  },
}))

const actualDebug = await import('../../utils/debug.js')
const actualLogForDebugging = actualDebug.logForDebugging
const debugLines: Array<{ line: string; opts?: unknown }> = []
mock.module('../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (line: string, opts?: unknown) => {
    if (!mockActive) {
      actualLogForDebugging(line, opts as never)
      return
    }
    debugLines.push({ line, opts })
  },
}))

// --- axios shim: single module-scope registration, closure-controlled;
// passes through to the real axios.get whenever this file's tests are not
// running. The real default export AND its `get` method are captured BY VALUE
// pre-mock — delegating through `actualAxios.default.get` at call time would
// resolve the (possibly re-pointed) namespace binding and self-recurse into
// the shim.
const actualAxios = await import('axios')
const actualAxiosDefault = actualAxios.default
const actualAxiosGet = actualAxiosDefault.get
type Restrictions = Record<string, { allowed: boolean }>
let nextRestrictions: Restrictions = {}
const mockedGet = mock(
  async (url: string, config?: unknown): Promise<unknown> => {
    if (!mockActive) {
      return actualAxiosGet.call(actualAxiosDefault, url, config as never)
    }
    return { status: 200, data: { restrictions: nextRestrictions } }
  },
)
mock.module('axios', () => ({
  ...actualAxios,
  default: { ...actualAxiosDefault, get: mockedGet },
}))

// --- SUT + real collaborators (imported AFTER the mock registrations)
const { attachBridgePolicyWatcher } = await import('../initReplBridge.js')
const { refreshPolicyLimits, _resetPolicyLimitsForTesting } = await import(
  '../../services/policyLimits/index.js'
)
const { getGlobalClaudeFile } = await import('../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../utils/envUtils.js')
type ReplBridgeHandle = import('../replBridge.js').ReplBridgeHandle
type BridgeState = import('../replBridge.js').BridgeState

const RC_NOTICE =
  "Remote Control was turned off by your organization's policy."
const RC_DENIED: Restrictions = { allow_remote_control: { allowed: false } }
const RC_ALLOWED: Restrictions = { allow_remote_control: { allowed: true } }

const wipeConfigDir = (): void => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
}

const makeFakeHandle = (teardownImpl?: () => Promise<void>): {
  handle: ReplBridgeHandle
  teardown: ReturnType<typeof mock>
} => {
  const teardown = mock(teardownImpl ?? (async () => {}))
  const handle = {
    bridgeSessionId: 'sess_test',
    environmentId: 'env_test',
    sessionIngressUrl: 'https://example.test',
    writeMessages: () => {},
    writeSdkMessages: () => {},
    sendControlRequest: () => {},
    sendControlResponse: () => {},
    sendControlCancelRequest: () => {},
    sendResult: () => {},
    teardown,
  } as unknown as ReplBridgeHandle
  return { handle, teardown }
}

/** Flush queued microtasks + one macrotask turn. */
const flushAsync = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}

beforeEach(() => {
  // Capture window: ONLY this file's own tests see the shims; every other
  // file in the same process gets the real implementations (see above).
  mockActive = true
  nextRestrictions = {}
  telemetryEvents.length = 0
  debugLines.length = 0
  wipeConfigDir()
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
  _resetPolicyLimitsForTesting()
})

afterEach(() => {
  mockActive = false
})

afterAll(async () => {
  // Leak guard (OCC-97/129 convention): keep the delegation flag off and
  // re-pin the REAL function references captured pre-mock, so even a
  // freshly-loaded later file resolves the real implementations.
  mockActive = false
  _resetPolicyLimitsForTesting()
  // Re-pin with the BY-VALUE references captured pre-mock — spreading the
  // namespace here would copy bun's live (already re-pointed) bindings.
  mock.module('axios', () => ({
    ...actualAxios,
    default: actualAxiosDefault,
  }))
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
  mock.module('../../utils/debug.js', () => ({
    ...actualDebug,
    logForDebugging: actualLogForDebugging,
  }))
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('attachBridgePolicyWatcher — 2.1.286 REPL-lane policy disconnect', () => {
  test('checks once on attach: connected + refusal → teardown, failed state, official log line, telemetry', async () => {
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    const { handle, teardown } = makeFakeHandle()
    const stateChanges: Array<[string, string | undefined]> = []

    attachBridgePolicyWatcher(handle, {
      isConnected: () => true,
      onStateChange: (state, detail) => {
        stateChanges.push([state, detail])
      },
      outboundOnly: false,
    })

    expect(teardown).toHaveBeenCalledTimes(1)
    expect(stateChanges).toEqual([['failed', RC_NOTICE]])
    expect(
      debugLines.some(
        d =>
          d.line ===
          '[bridge:repl] Org policy now refuses the connected bridge (allow_remote_control: org_denied, outboundOnly=false); disconnected',
      ),
    ).toBe(true)
    expect(telemetryEvents).toEqual([
      {
        name: 'tengu_bridge_policy_teardown',
        metadata: {
          lane: 'repl',
          policy: 'allow_remote_control',
          deny_kind: 'org_denied',
          outbound_only: false,
        },
      },
    ])
  })

  test('gated on connection: refusal while disconnected does nothing (official enabled&&connected gate)', async () => {
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    const { handle, teardown } = makeFakeHandle()
    const onStateChange = mock(() => {})

    attachBridgePolicyWatcher(handle, {
      isConnected: () => false,
      onStateChange,
      outboundOnly: false,
    })

    expect(teardown).not.toHaveBeenCalled()
    expect(onStateChange).not.toHaveBeenCalled()
    expect(telemetryEvents).toEqual([])
  })

  test('subscription: fires the check via queueMicrotask, disconnects exactly once', async () => {
    nextRestrictions = RC_ALLOWED
    await refreshPolicyLimits()
    const { handle, teardown } = makeFakeHandle()
    attachBridgePolicyWatcher(handle, {
      isConnected: () => true,
      onStateChange: () => {},
      outboundOnly: false,
    })
    expect(teardown).not.toHaveBeenCalled()

    // Org turns Remote Control off mid-session — the 2.1.286 changelog bug.
    // The real refresh fires the real onPolicyLimitsChange subscription.
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    await flushAsync()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(telemetryEvents).toHaveLength(1)

    // A further identical-payload refresh does not even notify (snapshot diff);
    // and if it did, the policyShutdown latch would suppress re-entry.
    await refreshPolicyLimits()
    await flushAsync()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(telemetryEvents).toHaveLength(1)
  })

  test('reconnect re-check (official effect deps [ready]): a refusal that flips while disconnected tears down on reconnect', async () => {
    nextRestrictions = RC_ALLOWED
    await refreshPolicyLimits()
    const { handle, teardown } = makeFakeHandle()
    let connected = true
    let stateHook: ((state: BridgeState) => void) | undefined
    const stateChanges: Array<[string, string | undefined]> = []

    attachBridgePolicyWatcher(handle, {
      isConnected: () => connected,
      onStateChange: (state, detail) => {
        stateChanges.push([state, detail])
      },
      outboundOnly: false,
      registerStateHook: hook => {
        stateHook = hook
      },
    })
    expect(teardown).not.toHaveBeenCalled()

    // Transport drops. 'reconnecting' is not a ready/connected transition, so
    // it must not re-run the check either.
    connected = false
    stateHook?.('reconnecting')
    await flushAsync()
    expect(teardown).not.toHaveBeenCalled()

    // Org turns Remote Control off DURING the disconnect. The real
    // subscription fires the real check, but the official
    // enabled&&connected gate skips it — the SEC-1 blind spot.
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    await flushAsync()
    expect(teardown).not.toHaveBeenCalled()
    expect(stateChanges).toEqual([])
    expect(telemetryEvents).toEqual([])

    // Reconnect: the official effect deps are [ready], so Nl() runs again the
    // moment the bridge is ready/connected — the pending refusal is honored
    // immediately, exactly once, with the official notice + telemetry.
    connected = true
    stateHook?.('ready')
    await flushAsync()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(stateChanges).toEqual([['failed', RC_NOTICE]])
    expect(telemetryEvents).toEqual([
      {
        name: 'tengu_bridge_policy_teardown',
        metadata: {
          lane: 'repl',
          policy: 'allow_remote_control',
          deny_kind: 'org_denied',
          outbound_only: false,
        },
      },
    ])

    // A further ready/connected transition must not re-fire (policyShutdown
    // latch), and 'connected' is accepted exactly like 'ready'.
    stateHook?.('connected')
    await flushAsync()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(stateChanges).toEqual([['failed', RC_NOTICE]])
    expect(telemetryEvents).toHaveLength(1)
  })

  test('wrapped teardown unsubscribes and delegates (official effect cleanup)', async () => {
    nextRestrictions = RC_ALLOWED
    await refreshPolicyLimits()
    const { handle, teardown } = makeFakeHandle()
    const wrapped = attachBridgePolicyWatcher(handle, {
      isConnected: () => true,
      onStateChange: () => {},
      outboundOnly: false,
    })

    await wrapped.teardown()
    expect(teardown).toHaveBeenCalledTimes(1)

    // Post-unsubscribe denial must not re-run the check.
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    await flushAsync()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(telemetryEvents).toEqual([])
  })

  test('teardown failure logs the official error line and skips the notice path (official early return)', async () => {
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    const { handle } = makeFakeHandle(() => {
      throw new Error('teardown boom')
    })
    const onStateChange = mock(() => {})

    attachBridgePolicyWatcher(handle, {
      isConnected: () => true,
      onStateChange,
      outboundOnly: false,
    })

    expect(
      debugLines.some(
        d =>
          d.line ===
          '[bridge:repl] Policy disconnect failed: teardown boom' &&
          (d.opts as { level?: string })?.level === 'error',
      ),
    ).toBe(true)
    // Official returns before the notice/log/telemetry block.
    expect(onStateChange).not.toHaveBeenCalled()
    expect(telemetryEvents).toEqual([])
    expect(
      debugLines.some(d => d.line.includes('Org policy now refuses')),
    ).toBe(false)
  })
})
