import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill — the bridgeMain import graph reads MACRO.VERSION.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * PORT (CC 2.1.286) — standalone-lane policy-refusal SHUTDOWN shape.
 *
 * Covers the two caller-side gaps the OCC-104 review found in
 * `runBridgeLoop`'s policy refusal (official standalone lane, byte-verified
 * @219444200+ in the v286 linux-x64 binary):
 *
 * 1. G4/P2 — the loop's tail is `return s.logVerbose("Environment offline."),kt`
 *    (`kt` = the refusal stored by `st`), but both callers discarded it, so a
 *    policy refusal was indistinguishable from a clean signal-driven teardown.
 *    Asserted here at the smallest observable seams: the loop's own return
 *    value (mutation-visible: commenting out `policyRefusal = refusal` in
 *    bridgeMain.ts makes this RED) and `consumeBridgePolicyRefusal`, the
 *    exported helper the interactive caller now consumes it through. The
 *    official CALLER-side consumption (exit code / offline semantics) is not
 *    recoverable from the binary — the helper is an OCC decision and is
 *    documented as such at its definition.
 * 2. G6/P3 — the loop-exit cleanup ran the official `Dt(),Wt(),s.clearStatus()`
 *    triple but never stopped the policyLimits singleton interval
 *    (`startBackgroundPolling` @:635/:676 → src/services/policyLimits/index.ts
 *    :791-809), so a refusal-driven return left the poller fetching/notifying.
 *    Observed here through a globalThis.setInterval/clearInterval liveness
 *    ledger (policyLimits keeps `pollingIntervalId` module-private): the
 *    refusal path must leave zero intervals it started, and the explicit-stop
 *    control must return to zero too.
 *
 * HERMETIC DESIGN — no mock.module anywhere (bun's mock.module is PERMANENT
 * process-wide; see attachBridgePolicyWatcher286.test.ts). The refusal is
 * driven through the REAL policyLimits cache by seeding its on-disk cache file
 * (`<CLAUDE_CONFIG_DIR>/policy-limits.json`, the exact shape
 * PolicyLimitsResponseSchema accepts), and the interval ledger wraps the real
 * timer functions and is restored in afterAll.
 */

// --- hermetic env: eligible Console API-key user, temp config dir
const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-bprs286-cfg-'))
const TEST_BRIDGE_DIR = await mkdtemp(join(tmpdir(), 'occ-bprs286-dir-'))
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
}
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-refusal286'
process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_UNIX_SOCKET
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
delete process.env.USER_TYPE

// --- interval liveness ledger (wraps the REAL timers; restored in afterAll).
// policyLimits' `pollingIntervalId` is module-private with no exported
// observable, so live-handle bookkeeping at the global timer seam is the
// least-invasive way to prove the poller was stopped.
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const liveIntervals = new Set<unknown>()
globalThis.setInterval = ((
  ...args: Parameters<typeof realSetInterval>
): ReturnType<typeof realSetInterval> => {
  const id = realSetInterval(...args)
  liveIntervals.add(id)
  return id
}) as typeof realSetInterval
globalThis.clearInterval = ((
  id?: Parameters<typeof realClearInterval>[0],
): void => {
  liveIntervals.delete(id)
  realClearInterval(id as never)
}) as typeof realClearInterval

/** Intervals started since `baseline` that are still live. */
const leakedIntervals = (baseline: ReadonlySet<unknown>): unknown[] =>
  [...liveIntervals].filter(id => !baseline.has(id))

// --- SUT + real collaborators (imported AFTER the env is hermetic)
const { runBridgeLoop, consumeBridgePolicyRefusal } = await import(
  '../bridgeMain.js'
)
const {
  _resetPolicyLimitsForTesting,
  startBackgroundPolling,
  stopBackgroundPolling,
  isPolicyLimitsEligible,
} = await import('../../services/policyLimits/index.js')
const { getGlobalClaudeFile } = await import('../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../utils/envUtils.js')
const { BRIDGE_POLICY_REMOTE_CONTROL_NOTICE: RC_NOTICE } = await import(
  '../bridgePolicyRefusal.js'
)

type BridgeApiClient = import('../types.js').BridgeApiClient
type BridgeConfig = import('../types.js').BridgeConfig
type BridgeLogger = import('../types.js').BridgeLogger
type SessionSpawner = import('../types.js').SessionSpawner

const makeStubApi = (): {
  api: BridgeApiClient
  deregisterEnvironment: ReturnType<typeof mock>
  pollForWork: ReturnType<typeof mock>
} => {
  const noopAsync = async (): Promise<void> => {}
  const deregisterEnvironment = mock(noopAsync)
  const pollForWork = mock(async (): Promise<null> => null)
  const api = {
    registerBridgeEnvironment: async () => ({
      environment_id: 'env_test',
      environment_secret: 'sec_test',
    }),
    pollForWork,
    acknowledgeWork: noopAsync,
    stopWork: noopAsync,
    deregisterEnvironment,
    sendPermissionResponseEvent: noopAsync,
    archiveSession: noopAsync,
    reconnectSession: noopAsync,
    heartbeatWork: async () => ({ lease_extended: true, state: 'active' }),
  } as unknown as BridgeApiClient
  return { api, deregisterEnvironment, pollForWork }
}

type LoggerCall = { method: string; args: unknown[] }

const makeStubLogger = (): { logger: BridgeLogger; calls: LoggerCall[] } => {
  const calls: LoggerCall[] = []
  const logger = new Proxy({} as BridgeLogger, {
    get:
      (_target: BridgeLogger, method: string) =>
      (...args: unknown[]): void => {
        calls.push({ method, args })
      },
  })
  return { logger, calls }
}

const loggedLines = (calls: LoggerCall[], method: string): unknown[] =>
  calls.filter(c => c.method === method).map(c => c.args[0])

const spawner = {
  spawn: () => {
    throw new Error('spawn must not be reached in these tests')
  },
} as unknown as SessionSpawner

const config: BridgeConfig = {
  dir: TEST_BRIDGE_DIR,
  machineName: 'test-host',
  branch: 'main',
  gitRepoUrl: null,
  maxSessions: 1,
  spawnMode: 'single-session',
  verbose: false,
  sandbox: false,
  bridgeId: 'bridge_test',
  workerType: 'claude_code',
  environmentId: 'env_test',
  apiBaseUrl: 'https://example.test',
  sessionIngressUrl: 'https://example.test',
}

/** Seed the real policyLimits disk cache (the shape its Zod schema accepts). */
const writePolicyCache = async (
  restrictions: Record<string, { allowed: boolean }>,
): Promise<void> => {
  const dir = getClaudeConfigHomeDir()
  mkdirSync(dir, { recursive: true })
  await writeFile(
    join(dir, 'policy-limits.json'),
    JSON.stringify({ restrictions }, null, 2),
    'utf-8',
  )
}

beforeEach(() => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
  _resetPolicyLimitsForTesting()
})

afterAll(async () => {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
  _resetPolicyLimitsForTesting()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
  await rm(TEST_BRIDGE_DIR, { recursive: true, force: true })
})

describe('runBridgeLoop policy-refusal shutdown — 2.1.286 standalone lane', () => {
  test('refusal-driven loop return propagates the refusal AND stops background polling', async () => {
    // Precondition: the poller must actually be startable in this hermetic
    // env, otherwise the leak assertion below would pass vacuously. This is
    // also the explicit-stop control — stopping returns to zero.
    expect(isPolicyLimitsEligible()).toBe(true)
    const baseline = new Set(liveIntervals)
    startBackgroundPolling()
    expect(leakedIntervals(baseline)).toHaveLength(1)
    stopBackgroundPolling()
    expect(leakedIntervals(baseline)).toEqual([])

    // Org policy refuses Remote Control before the loop even starts polling.
    await writePolicyCache({ allow_remote_control: { allowed: false } })
    const { api, deregisterEnvironment, pollForWork } = makeStubApi()
    const { logger, calls } = makeStubLogger()
    const controller = new AbortController()

    const refusal = await runBridgeLoop(
      config,
      'env_test',
      'sec_test',
      api,
      spawner,
      logger,
      controller.signal,
    )

    // Official loop tail `return s.logVerbose("Environment offline."),kt`.
    expect(refusal).toEqual({
      policy: 'allow_remote_control',
      kind: 'org_denied',
      detail: RC_NOTICE,
    })
    // The loop surfaced the official notice (unchanged behaviour).
    expect(loggedLines(calls, 'logStatus')).toContain(RC_NOTICE)
    // G6/P3: the poller started inside the loop is stopped by the loop-exit
    // cleanup — no residual fetching/notifying after a refusal-driven return.
    expect(leakedIntervals(baseline)).toEqual([])
    // Policy shutdown archives+deregisters; it never polls for work.
    expect(deregisterEnvironment).toHaveBeenCalledTimes(1)
    expect(pollForWork).not.toHaveBeenCalled()
  })

  test('control: explicit-stop (pre-aborted signal) exit returns undefined and leaves zero live intervals', async () => {
    await writePolicyCache({ allow_remote_control: { allowed: true } })
    const { api, deregisterEnvironment } = makeStubApi()
    const { logger } = makeStubLogger()
    const controller = new AbortController()
    controller.abort()
    const baseline = new Set(liveIntervals)

    const refusal = await runBridgeLoop(
      config,
      'env_test',
      'sec_test',
      api,
      spawner,
      logger,
      controller.signal,
    )

    expect(refusal).toBeUndefined()
    expect(leakedIntervals(baseline)).toEqual([])
    expect(deregisterEnvironment).toHaveBeenCalledTimes(1)
  })

  test('consumeBridgePolicyRefusal: distinct status line on refusal, no-op on undefined', () => {
    const { logger, calls } = makeStubLogger()

    expect(consumeBridgePolicyRefusal(undefined, logger)).toBe(false)
    expect(loggedLines(calls, 'logStatus')).toEqual([])

    const consumed = consumeBridgePolicyRefusal(
      {
        policy: 'allow_remote_control',
        kind: 'org_denied',
        detail: RC_NOTICE,
      },
      logger,
    )
    expect(consumed).toBe(true)
    const statusLines = loggedLines(calls, 'logStatus')
    expect(statusLines).toHaveLength(1)
    // Distinguishable from the loop's own official notice line, and it names
    // the policy + deny kind for the debug log.
    expect(statusLines[0]).not.toBe(RC_NOTICE)
    expect(String(statusLines[0])).toContain('allow_remote_control')
    expect(String(statusLines[0])).toContain('org_denied')
  })
})
