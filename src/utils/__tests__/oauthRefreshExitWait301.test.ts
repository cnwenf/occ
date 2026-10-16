// CC 2.1.301 PORT #18 — await the in-flight OAuth token refresh before the
// analytics flush on the graceful-shutdown exit path.
//
// Official v301 (linux-x64 ELF, byte-verified @220443640, grep+dd — binary
// NEVER executed):
//   `async function MU({waitForOAuthRefresh:r=!0}={}){
//      if(r)await e6n();
//      try{let{flushAnalyticsSinks:e}=await import("/$bunfs/root/chunk-….js");
//          await e()}catch{}}
//    async function Lo(r){await MU(),process.exit(r);return}`
//   with `e6n(){try{await t.wait?.()}catch{}}` awaiting the singleton
//   in-flight refresh promise — no internal timeout (the outer shutdown
//   failsafe bounds it), and rejections are swallowed so exit never hangs or
//   fails because of a broken refresh.
//
// OCC port:
//   - src/utils/auth.ts: `waitForPendingOAuthRefresh()` awaits the existing
//     `pendingRefreshCheck` dedupe singleton (:1985), swallowing rejections;
//     resolves immediately when no refresh is in flight.
//   - src/utils/gracefulShutdown.ts: awaits it immediately BEFORE the
//     analytics flush (shutdown1PEventLogging/shutdownDatadog race), inside
//     the failsafe budget — matching the official MU ordering (refresh wait
//     first, analytics flush second).

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'

// --- mocks: install BEFORE requiring gracefulShutdown.js / auth.js ----------
// Passthrough-flag pattern: snapshots are spread copies of the REAL
// namespaces taken before mocking; flags flip off in afterAll so later files
// in the shared bun process see genuine behavior.

const actualAuth = { ...require('../auth.js') } as typeof import('../auth.js')
const callOrder: string[] = []
let authSpyActive = false
/** When false the spy blocks on oauthGate; when true it resolves at once. */
let oauthGateAutoRelease = false
/** Resolved by the ordering test to release gracefulShutdown's oauth wait. */
let oauthGateResolve: (() => void) | null = null
mock.module('../auth.js', () => ({
  ...actualAuth,
  waitForPendingOAuthRefresh: async () => {
    if (!authSpyActive) {
      return actualAuth.waitForPendingOAuthRefresh()
    }
    callOrder.push('oauth-wait')
    if (oauthGateAutoRelease) return
    await new Promise<void>(resolve => {
      oauthGateResolve = resolve
    })
  },
}))

const actualFirstParty = {
  ...require('../../services/analytics/firstPartyEventLogger.js'),
} as typeof import('../../services/analytics/firstPartyEventLogger.js')
let firstPartySpyActive = false
mock.module('../../services/analytics/firstPartyEventLogger.js', () => ({
  ...actualFirstParty,
  shutdown1PEventLogging: async () => {
    if (!firstPartySpyActive) return actualFirstParty.shutdown1PEventLogging()
    callOrder.push('analytics-1p')
  },
}))

const actualDatadog = {
  ...require('../../services/analytics/datadog.js'),
} as typeof import('../../services/analytics/datadog.js')
let datadogSpyActive = false
mock.module('../../services/analytics/datadog.js', () => ({
  ...actualDatadog,
  shutdownDatadog: async () => {
    if (!datadogSpyActive) return actualDatadog.shutdownDatadog()
    callOrder.push('datadog')
  },
}))

// gracefulShutdown's drainStdoutBeforeExit calls stream.end() on a non-TTY
// stdout — that would end the TEST RUNNER's stdout. No-op it while active.
const actualProcessUtils = { ...require('../process.js') } as typeof import('../process.js')
let processSpyActive = false
mock.module('../process.js', () => ({
  ...actualProcessUtils,
  drainStdoutBeforeExit: async () => {
    if (!processSpyActive) return actualProcessUtils.drainStdoutBeforeExit()
  },
}))

// The real hooks.js executeSessionEndHooks would read this machine's user
// settings and could run REAL SessionEnd hook commands. Stub the three
// functions gracefulShutdown imports.
const actualHooks = { ...require('../hooks.js') } as typeof import('../hooks.js')
let hooksSpyActive = false
mock.module('../hooks.js', () => ({
  ...actualHooks,
  executeSessionEndHooks: async (...args: unknown[]) => {
    if (!hooksSpyActive) {
      return (actualHooks.executeSessionEndHooks as Function)(...args)
    }
  },
  getSessionEndHookTimeoutMs: () =>
    hooksSpyActive
      ? 1500
      : (actualHooks.getSessionEndHookTimeoutMs as Function)(),
  getSessionEndHooksBudgetMs: () =>
    hooksSpyActive ? 1500 : (actualHooks.getSessionEndHooksBudgetMs as Function)(),
}))

// Require targets AFTER mock registration.
const {
  waitForPendingOAuthRefresh,
  _setPendingRefreshCheckForTesting,
} = require('../auth.js') as typeof import('../auth.js')
const {
  gracefulShutdown,
  resetShutdownState,
} = require('../gracefulShutdown.js') as typeof import('../gracefulShutdown.js')

// --- env hygiene --------------------------------------------------------------

const ENV_KEYS = ['NODE_ENV']
const savedEnv: Record<string, string | undefined> = {}
let exitSpy: ReturnType<typeof spyOn> | null = null
let savedExitCode: number | string | undefined

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  // forceExit is test-aware ONLY when NODE_ENV === 'test'; bun test sets it,
  // but pin it so the mocked process.exit fall-through path is guaranteed.
  process.env.NODE_ENV = 'test'
  callOrder.length = 0
  oauthGateResolve = null
  oauthGateAutoRelease = false
  resetShutdownState()
  savedExitCode = process.exitCode
  exitSpy = spyOn(process, 'exit').mockImplementation((() =>
    undefined) as never)
})

afterEach(() => {
  exitSpy?.mockRestore()
  exitSpy = null
  process.exitCode = savedExitCode as number
  resetShutdownState()
  _setPendingRefreshCheckForTesting(null)
  authSpyActive = false
  firstPartySpyActive = false
  datadogSpyActive = false
  processSpyActive = false
  hooksSpyActive = false
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

afterAll(() => {
  authSpyActive = false
  firstPartySpyActive = false
  datadogSpyActive = false
  processSpyActive = false
  hooksSpyActive = false
  // Release a dangling gate so a leaked await can't hold the process.
  oauthGateResolve?.()
  oauthGateResolve = null
})

// --- unit: waitForPendingOAuthRefresh (official `e6n`) ------------------------

describe('CC 2.1.301 #18 — waitForPendingOAuthRefresh (e6n)', () => {
  test('resolves immediately when no refresh is in flight', async () => {
    // Arrange — pendingRefreshCheck is null (the overwhelmingly common exit).
    _setPendingRefreshCheckForTesting(null)

    // Act/Assert — must not hang exit: resolves well inside a 250ms budget.
    const result = await Promise.race([
      waitForPendingOAuthRefresh().then(() => 'resolved'),
      new Promise<string>(resolve =>
        setTimeout(() => resolve('timeout'), 250),
      ),
    ])
    expect(result).toBe('resolved')
  })

  test('awaits an in-flight refresh promise to settlement', async () => {
    // Arrange — a refresh that settles ~30ms from now.
    let refreshDone = false
    _setPendingRefreshCheckForTesting(
      new Promise<boolean>(resolve => {
        setTimeout(() => {
          refreshDone = true
          resolve(true)
        }, 30)
      }),
    )

    // Act
    await waitForPendingOAuthRefresh()

    // Assert — the awaiter only returns after the refresh settled.
    expect(refreshDone).toBe(true)
  })

  test('swallows a rejected refresh (official e6n try/catch) — exit never fails on it', async () => {
    // Arrange
    _setPendingRefreshCheckForTesting(
      Promise.reject(new Error('refresh exploded')),
    )

    // Act/Assert — resolves (does not rethrow).
    await expect(waitForPendingOAuthRefresh()).resolves.toBeUndefined()
  })
})

// --- integration: gracefulShutdown ordering (official `MU`) -------------------

describe('CC 2.1.301 #18 — gracefulShutdown awaits the OAuth refresh before flushing analytics', () => {
  test(
    'analytics flush does not start until the in-flight OAuth refresh wait completes',
    async () => {
      // Arrange — all spies active; the oauth wait blocks on the gate.
      authSpyActive = true
      firstPartySpyActive = true
      datadogSpyActive = true
      processSpyActive = true
      hooksSpyActive = true

      // Act — start shutdown but do not await it yet.
      const shutdownPromise = gracefulShutdown(0, 'other')

      // Wait (bounded) until the oauth wait has been entered.
      const entered = await Promise.race([
        (async () => {
          while (!callOrder.includes('oauth-wait')) {
            await new Promise(resolve => setTimeout(resolve, 5))
          }
          return true
        })(),
        new Promise<boolean>(resolve =>
          setTimeout(() => resolve(false), 5000),
        ),
      ])
      expect(entered).toBe(true)

      // While the refresh wait is in flight, the analytics flush MUST NOT
      // have started (official MU: `if(r)await e6n()` BEFORE flushAnalyticsSinks).
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(callOrder).toEqual(['oauth-wait'])

      // Release the gate and let shutdown finish.
      oauthGateResolve?.()
      await shutdownPromise

      // Assert — full ordering, oauth wait first.
      expect(callOrder).toEqual(['oauth-wait', 'analytics-1p', 'datadog'])
      expect(exitSpy).toHaveBeenCalledWith(0)
    },
    15000,
  )

  test(
    'shutdown completes normally when no OAuth refresh is in flight (no hang)',
    async () => {
      // Arrange — spies active; the oauth wait resolves immediately (the
      // common case: pendingRefreshCheck === null resolves at once).
      authSpyActive = true
      firstPartySpyActive = true
      datadogSpyActive = true
      processSpyActive = true
      hooksSpyActive = true
      oauthGateAutoRelease = true

      // Act
      try {
        await gracefulShutdown(0, 'other')
      } finally {
        oauthGateAutoRelease = false
      }

      // Assert — oauth wait still happens first, then analytics.
      expect(callOrder[0]).toBe('oauth-wait')
      expect(callOrder).toContain('analytics-1p')
      expect(callOrder).toContain('datadog')
    },
    15000,
  )
})
