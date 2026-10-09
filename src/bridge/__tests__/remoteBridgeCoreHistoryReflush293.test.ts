/**
 * CC 2.1.293 #19 — env-less bridge v2 must NOT re-upload the initial history
 * after a 401 credential recovery once the initial flush promise has settled.
 *
 * Official fix (byte-verified in the vver 2.1.293 ELF; vprev 2.1.292 still
 * carries the bug):
 *
 *   vprev recoverFromAuthFailure:  `... Nt=le||Ho; <rebuild>`  — the
 *     unconditional `initialFlushDone = false` reset — DELETED in vver.
 *   vver onConnect flush block (verbatim, minified names):
 *     if(!mr&&G&&G.length>0&&!Gr){mr=!0;let v=w,_=Ea(G),R=Promise.withResolvers();
 *       _.catch((B)=>t(`[remote-bridge] flushHistory failed: ${B}`)).finally(()=>{
 *         if(R.resolve(),w!==v||O||Q||De)return;Wt(),yr()}),
 *       Vn=Promise.all([_,R.promise]),Vn.catch(()=>{})}
 *     handle field: firstHistoryFlush:()=>Vn
 *
 *   i.e. promise-settle tracking — a deferred (`R`) resolved UNCONDITIONALLY
 *   at the TOP of `.finally` (before the transport-swap guards), composed as
 *   `Vn = Promise.all([flush, deferred])`. The recovery reset became
 *   conditional: only an UNSETTLED flush may re-arm the re-flush (its
 *   writeBatch may have silently no-op'd on the closed uploader).
 *
 * OCC RED/GREEN (triage-293.md §19):
 *   ① settled initial flush → 401 → rebuild → history must NOT be re-sent
 *      on the new transport (RED against current code: it IS re-sent).
 *   ② 401 while the flush writeBatch is unsettled → EXACTLY ONE re-send on
 *      the rebuilt transport, and the stale flush's late settle must not
 *      drain/announce again (regression guard — passes pre-fix too).
 *
 * The official flushHistory (`Ea`) has NO UUID dedup — verified in both vprev
 * and vver extracts — so none is added here (task: "add UUID dedup if the
 * official extract shows it" → it does not).
 *
 * Mock plumbing follows the OCC-97/129 leak-free delegation convention
 * (exemplars: attachBridgePolicyWatcher286.test.ts,
 * sessionStorage.parallelTRRecovery286.test.ts): every shim delegates to the
 * REAL function captured by value unless `mockActive` is true, and the flag is
 * flipped ONLY in beforeEach/afterEach/afterAll.
 */
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// MACRO polyfill — the bridge import graph reads MACRO.VERSION.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-19-293-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR

// ---------------------------------------------------------------------------
// Leak-free delegation shims
// ---------------------------------------------------------------------------
let mockActive = false

// --- analytics
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

// --- debug log capture
const actualDebug = await import('../../utils/debug.js')
const actualLogForDebugging = actualDebug.logForDebugging
const debugLines: string[] = []
mock.module('../../utils/debug.js', () => ({
  ...actualDebug,
  logForDebugging: (line: string, opts?: unknown) => {
    if (!mockActive) {
      actualLogForDebugging(line, opts as never)
      return
    }
    debugLines.push(line)
  },
}))

// --- axios (teardown archiveSession must not hit the network)
const actualAxios = await import('axios')
const actualAxiosDefault = actualAxios.default
const actualAxiosPost = actualAxiosDefault.post
mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...actualAxiosDefault,
    post: (async (...args: unknown[]) => {
      if (!mockActive) {
        return actualAxiosPost(...(args as [never, never, never]))
      }
      return { status: 200, data: {} }
    }) as typeof actualAxiosPost,
  },
}))

// --- env-less bridge config: fast deterministic timings
const actualCfgMod = await import('../envLessBridgeConfig.js')
const actualGetCfg = actualCfgMod.getEnvLessBridgeConfig
const TEST_CFG: typeof actualCfgMod.DEFAULT_ENV_LESS_BRIDGE_CONFIG = {
  ...actualCfgMod.DEFAULT_ENV_LESS_BRIDGE_CONFIG,
  init_retry_max_attempts: 1,
  init_retry_base_delay_ms: 1,
  init_retry_jitter_fraction: 0,
  init_retry_max_delay_ms: 500,
  http_timeout_ms: 1000,
  connect_timeout_ms: 5000,
  teardown_archive_timeout_ms: 500,
}
mock.module('../envLessBridgeConfig.js', () => ({
  ...actualCfgMod,
  getEnvLessBridgeConfig: async () =>
    mockActive ? TEST_CFG : await actualGetCfg(),
}))

// --- codeSessionApi: scripted session create + credentials
const actualCodeSession = await import('../codeSessionApi.js')
const actualCreateCodeSession = actualCodeSession.createCodeSession
const actualFetchRemoteCredentials = actualCodeSession.fetchRemoteCredentials
let nextSessionId = 'cse_test19'
let credentialEpoch = 0
mock.module('../codeSessionApi.js', () => ({
  ...actualCodeSession,
  createCodeSession: async (...args: Parameters<typeof actualCreateCodeSession>) => {
    if (!mockActive) return actualCreateCodeSession(...args)
    return nextSessionId
  },
  fetchRemoteCredentials: async (
    ...args: Parameters<typeof actualFetchRemoteCredentials>
  ) => {
    if (!mockActive) return actualFetchRemoteCredentials(...args)
    credentialEpoch += 1
    return {
      worker_jwt: `jwt-${credentialEpoch}`,
      api_base_url: 'https://api.test',
      expires_in: 3600,
      worker_epoch: credentialEpoch,
    }
  },
}))

// --- trustedDevice: no stored token in tests
const actualTrusted = await import('../trustedDevice.js')
const actualGetTrustedDeviceToken = actualTrusted.getTrustedDeviceToken
mock.module('../trustedDevice.js', () => ({
  ...actualTrusted,
  getTrustedDeviceToken: () =>
    mockActive ? undefined : actualGetTrustedDeviceToken(),
}))

// --- transport factory: controllable fakes
type Batch = { events: unknown[]; release: () => void }
type FakeTransport = {
  writeBatchCalls: unknown[][]
  writeCalls: unknown[]
  batches: Batch[]
  closed: boolean
  connectCount: number
  holdFirstBatch: boolean
  releaseHeldBatches(): void
  fireClose(code?: number): void
  impl: unknown
}
const transports: FakeTransport[] = []
let holdFirstBatchOnTransportIndex = -1

const actualTransportMod = await import('../replBridgeTransport.js')
const actualCreateV2 = actualTransportMod.createV2ReplTransport

function makeFakeTransport(): FakeTransport {
  const index = transports.length
  let onConnectCb: (() => void) | undefined
  let onCloseCb: ((code?: number) => void) | undefined
  const fake = {
    writeBatchCalls: [] as unknown[][],
    writeCalls: [] as unknown[],
    batches: [] as Batch[],
    closed: false,
    connectCount: 0,
    holdFirstBatch: index === holdFirstBatchOnTransportIndex,
    releaseHeldBatches() {
      for (const b of fake.batches.splice(0)) b.release()
    },
    fireClose(code?: number) {
      // Real SSE delivers close asynchronously — mirror that.
      setTimeout(() => {
        if (!fake.closed) onCloseCb?.(code)
      }, 0)
    },
    impl: undefined as unknown,
  } satisfies FakeTransport
  fake.impl = {
    write: async (message: unknown) => {
      fake.writeCalls.push(message)
    },
    writeBatch: (events: unknown[]) => {
      fake.writeBatchCalls.push(events)
      if (fake.holdFirstBatch && fake.batches.length === 0) {
        return new Promise<void>(resolve => {
          fake.batches.push({ events, release: resolve })
        })
      }
      return Promise.resolve()
    },
    close: () => {
      fake.closed = true
    },
    isConnectedStatus: () => !fake.closed,
    getStateLabel: () => 'fake',
    setOnData: () => {},
    setOnClose: (cb: (code?: number) => void) => {
      onCloseCb = cb
    },
    setOnConnect: (cb: () => void) => {
      onConnectCb = cb
    },
    connect: () => {
      fake.connectCount += 1
      // Real transport fires onConnect off the SSE open event (async) —
      // a synchronous fire here would race rebuildTransport's post-connect
      // drainFlushGate() in a way production never does.
      setTimeout(() => {
        if (!fake.closed) onConnectCb?.()
      }, 0)
    },
    getLastSequenceNum: () => 0,
    get droppedBatchCount() {
      return 0
    },
    reportState: () => {},
    reportMetadata: () => {},
    reportDelivery: () => {},
    flush: async () => {},
  }
  return fake
}

mock.module('../replBridgeTransport.js', () => ({
  ...actualTransportMod,
  createV2ReplTransport: async (
    opts: Parameters<typeof actualCreateV2>[0],
  ) => {
    if (!mockActive) return actualCreateV2(opts)
    const fake = makeFakeTransport()
    transports.push(fake)
    return fake.impl as Awaited<ReturnType<typeof actualCreateV2>>
  },
}))

// Module under test — imported AFTER the shims are registered.
const { initEnvLessBridgeCore } = await import('../remoteBridgeCore.js')
type Handle = Awaited<ReturnType<typeof initEnvLessBridgeCore>>

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function userMessage(text: string): never {
  return {
    type: 'user',
    uuid: randomUUID(),
    parentUuid: null,
    isMeta: false,
    timestamp: new Date().toISOString(),
    sessionId: 'local-session',
    cwd: '/tmp/occ-19-293',
    version: '2.1.293',
    gitBranch: null,
    userType: 'external',
    isSidechain: false,
    message: { role: 'user', content: text },
  } as never
}

function assistantMessage(text: string): never {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    sessionId: 'local-session',
    cwd: '/tmp/occ-19-293',
    version: '2.1.293',
    gitBranch: null,
    userType: 'external',
    isSidechain: false,
    message: {
      role: 'assistant',
      id: `msg_${randomUUID()}`,
      type: 'message',
      model: 'claude-test',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {},
    },
  } as never
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 3000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

let handle: Handle = null
let stateChanges: Array<{ state: string; detail?: string }> = []

async function initBridge(initialCount: number): Promise<void> {
  const initialMessages = [userMessage('hello history'), assistantMessage('hi')]
  const capped = initialMessages.slice(0, initialCount)
  handle = await initEnvLessBridgeCore({
    baseUrl: 'https://bridge.test',
    orgUUID: 'org-test',
    title: 'test session',
    getAccessToken: () => 'oauth-token',
    onAuth401: async () => true,
    toSDKMessages: msgs =>
      msgs.map(m => ({
        type: m.type,
        uuid: m.uuid,
        session_id: 'local-session',
      })) as never,
    initialHistoryCap: 100,
    initialMessages: capped as never,
    onStateChange: (state, detail) => {
      stateChanges.push({ state: state as string, detail })
    },
  })
  expect(handle).not.toBeNull()
}

beforeEach(() => {
  mockActive = true
  transports.length = 0
  telemetryEvents.length = 0
  debugLines.length = 0
  stateChanges = []
  credentialEpoch = 0
  holdFirstBatchOnTransportIndex = -1
})

afterEach(async () => {
  for (const t of transports) t.releaseHeldBatches()
  await handle?.teardown()
  handle = null
  mockActive = false
})

afterAll(async () => {
  mockActive = false
  mock.module('../../services/analytics/index.js', () => ({
    ...actualAnalytics,
    logEvent: actualLogEvent,
  }))
  mock.module('../../utils/debug.js', () => ({
    ...actualDebug,
    logForDebugging: actualLogForDebugging,
  }))
  mock.module('axios', () => ({
    ...actualAxios,
    default: { ...actualAxiosDefault, post: actualAxiosPost },
  }))
  mock.module('../envLessBridgeConfig.js', () => ({
    ...actualCfgMod,
    getEnvLessBridgeConfig: actualGetCfg,
  }))
  mock.module('../codeSessionApi.js', () => ({
    ...actualCodeSession,
    createCodeSession: actualCreateCodeSession,
    fetchRemoteCredentials: actualFetchRemoteCredentials,
  }))
  mock.module('../trustedDevice.js', () => ({
    ...actualTrusted,
    getTrustedDeviceToken: actualGetTrustedDeviceToken,
  }))
  mock.module('../replBridgeTransport.js', () => ({
    ...actualTransportMod,
    createV2ReplTransport: actualCreateV2,
  }))
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CC 2.1.293 #19 — recovery must not re-send settled initial history', () => {
  test('① settled flush → 401 recovery → rebuilt transport does NOT re-flush history', async () => {
    await initBridge(2)
    // Initial flush runs on transport #0 and settles (auto-resolving batch).
    await waitFor(() => transports.length === 1, 3000, 'transport #0')
    await waitFor(
      () => transports[0].writeBatchCalls.length === 1,
      3000,
      'initial history flush batch',
    )
    await waitFor(
      () => stateChanges.some(s => s.state === 'connected'),
      3000,
      'connected after settled flush',
    )
    expect(transports[0].writeBatchCalls[0]).toHaveLength(2)

    // 401 on the settled-flush transport → OAuth refresh + rebuild.
    transports[0].fireClose(401)
    await waitFor(() => transports.length === 2, 3000, 'rebuilt transport #1')
    await waitFor(
      () => stateChanges.filter(s => s.state === 'connected').length >= 2,
      3000,
      'connected after rebuild',
    )
    // Settle window: a buggy re-flush would land on transport #1 right after
    // its onConnect — give it ample time to (incorrectly) appear.
    await sleep(50)

    expect(transports[1].writeBatchCalls.length).toBe(0)
    const totalHistoryBatches =
      transports[0].writeBatchCalls.length + transports[1].writeBatchCalls.length
    expect(totalHistoryBatches).toBe(1)
    expect(stateChanges.some(s => s.state === 'reconnecting')).toBe(true)
  })

  test('② 401 while flush unsettled → exactly one re-send; late settle does not double-fire', async () => {
    holdFirstBatchOnTransportIndex = 0
    await initBridge(2)
    await waitFor(() => transports.length === 1, 3000, 'transport #0')
    // Flush started but its writeBatch is held pending (unsettled).
    await waitFor(
      () => transports[0].writeBatchCalls.length === 1,
      3000,
      'held flush batch',
    )
    await sleep(20)
    expect(stateChanges.some(s => s.state === 'connected')).toBe(false)

    // 401 mid-flush: writeBatch may have silently no-op'd on the closed
    // uploader — recovery must re-arm the flush exactly once.
    transports[0].fireClose(401)
    await waitFor(() => transports.length === 2, 3000, 'rebuilt transport #1')
    await waitFor(
      () => transports[1].writeBatchCalls.length === 1,
      3000,
      'exactly one re-send on rebuilt transport',
    )
    await waitFor(
      () => stateChanges.some(s => s.state === 'connected'),
      3000,
      'connected after re-flush',
    )

    // Now let the STALE flush settle — its .finally must trip the
    // transport-swap guard: no extra batches, no second 'connected'.
    transports[0].releaseHeldBatches()
    await sleep(50)
    expect(transports[0].writeBatchCalls.length).toBe(1)
    expect(transports[1].writeBatchCalls.length).toBe(1)
    expect(
      stateChanges.filter(s => s.state === 'connected').length,
    ).toBe(1)
  })
})
