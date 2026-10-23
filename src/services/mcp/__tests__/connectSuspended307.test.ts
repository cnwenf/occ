/**
 * claude-code 2.1.307 PORT B2 — MCP sleep-recovery (`CONNECT_SUSPENDED`
 * redial). Official sources (linux ELF, byte-verified, never executed):
 *   - `Hie="CONNECT_SUSPENDED"`, `z=10` (max redials) @278908635
 *   - `aZs=1000` suspend-gap threshold
 *   - `CIt` timing capture `{clock, awakeStart: monotonicNow(), wallStart: now()}`
 *   - `RIt` formatter: `${Math.round(now()-wallStart)}ms, ${Math.round(monotonicNow()-awakeStart)}ms of it awake`
 *   - `Y0n` classifier: gap = wall−awake > 1000 AND gate
 *     `k("tengu_mcp_connect_suspend_redial", !0)` → verbatim message
 *     `MCP server "<name>" connection timed out. Your computer went to sleep or its clock changed while connecting.`
 *   - `X0n` redial loop: while redials<10 && failed && errorCode===CONNECT_SUSPENDED
 *     && isCurrentDial() && epoch unchanged → log verbatim
 *     `Connecting again after a sleep or a clock change (<c> of at most 10)`
 *     and dial again; at cap with currency → persist the failure (official `$o`).
 *   - failure path @279090513: CONNECT_TIMEOUT + gap → errorCode CONNECT_SUSPENDED
 *     + suspended message; telemetry reason:"suspended"; failure NOT written to
 *     the connection cache unless the cap was reached.
 *
 * Repo mock.module template: snapshot actuals BEFORE mocking, isolated
 * cache-busting specifier for client.js, heal + restore in afterAll.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

const realLog = { ...(await import('../../../utils/log.js')) }
const realAnalytics = { ...(await import('../../analytics/index.js')) }

let loggedDebug: Array<{ server: string; message: string }> = []
let loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
let suspend307MocksActive = true

const actualLogMCPDebug = realLog.logMCPDebug as (
  server: string,
  message: string,
) => void

mock.module('../../../utils/log.js', () => ({
  ...realLog,
  logMCPDebug: (server: string, message: string) => {
    if (suspend307MocksActive) {
      loggedDebug.push({ server, message })
    } else {
      actualLogMCPDebug(server, message)
    }
  },
}))

mock.module('../../analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata?: Record<string, unknown>) => {
    if (suspend307MocksActive) {
      loggedEvents.push({ name, metadata: metadata ?? {} })
    }
  },
}))

const {
  CONNECT_SUSPENDED,
  MAX_CONNECT_SUSPEND_REDIALS,
  SUSPEND_GAP_THRESHOLD_MS,
  captureConnectTiming,
  formatConnectTiming,
  detectSuspendedConnect,
  connectWithSuspendRedial,
  connectToServer,
  getServerCacheKey,
  bumpMcpReconnectEpoch,
} = await import('../client.js?occ-connect-suspended-307')

afterAll(() => {
  suspend307MocksActive = false
  mock.module('../../../utils/log.js', () => realLog)
  mock.module('../../analytics/index.js', () => realAnalytics)
})

afterEach(() => {
  loggedDebug = []
  loggedEvents = []
})

interface DialResult {
  name: string
  type: 'connected' | 'failed'
  errorCode?: string
}

function suspendedFailure(name = 'srv'): DialResult {
  return { name, type: 'failed', errorCode: CONNECT_SUSPENDED }
}

function otherFailure(name = 'srv', errorCode = 'ECONNREFUSED'): DialResult {
  return { name, type: 'failed', errorCode }
}

function success(name = 'srv'): DialResult {
  return { name, type: 'connected' }
}

// ---------------------------------------------------------------------------
// Constants + classifier + formatter
// ---------------------------------------------------------------------------

describe('2.1.307 B2 suspended-connect detection', () => {
  test('exports the official constants', () => {
    expect(CONNECT_SUSPENDED).toBe('CONNECT_SUSPENDED')
    expect(MAX_CONNECT_SUSPEND_REDIALS).toBe(10)
    expect(SUSPEND_GAP_THRESHOLD_MS).toBe(1000)
  })

  test('returns the verbatim suspended message when the wall/awake gap exceeds 1000ms', () => {
    // Arrange — wall elapsed 4000ms, awake elapsed 500ms → gap 3500ms.
    const timing = { wallStart: 10_000, awakeStart: 5_000 }

    // Act
    const message = detectSuspendedConnect('srv', timing, 14_000, 5_500)

    // Assert
    expect(message).toBe(
      'MCP server "srv" connection timed out. Your computer went to sleep or its clock changed while connecting.',
    )
  })

  test('returns undefined when the gap is at or below the threshold', () => {
    // Arrange — wall elapsed 1200ms, awake elapsed 200ms → gap exactly 1000.
    const atThreshold = { wallStart: 10_000, awakeStart: 5_000 }

    // Act / Assert — official uses a STRICT `>1000` comparison, so a gap of
    // exactly 1000 is NOT suspended; a gap of 950 is not either.
    expect(detectSuspendedConnect('srv', atThreshold, 11_200, 5_200)).toBe(
      undefined,
    )
    expect(
      detectSuspendedConnect('srv', atThreshold, 11_200, 5_250),
    ).toBeUndefined()
  })

  test('formats connect timing with wall ms and awake ms verbatim', () => {
    // Arrange
    const timing = { wallStart: 1_000, awakeStart: 2_000 }

    // Act / Assert — official RIt: `${Math.round(now-wallStart)}ms, ${Math.round(monotonic-awakeStart)}ms of it awake`
    expect(formatConnectTiming(timing, 3_500, 4_000)).toBe(
      '2500ms, 2000ms of it awake',
    )
    expect(formatConnectTiming(timing, 3_500.6, 4_000.4)).toBe(
      '2501ms, 2000ms of it awake',
    )
  })

  test('captures wall and monotonic starts at connect entry', () => {
    // Arrange
    const beforeWall = Date.now()
    const beforeAwake = performance.now()

    // Act
    const timing = captureConnectTiming()

    // Assert
    expect(timing.wallStart).toBeGreaterThanOrEqual(beforeWall)
    expect(timing.wallStart).toBeLessThanOrEqual(Date.now())
    expect(timing.awakeStart).toBeGreaterThanOrEqual(beforeAwake)
    expect(timing.awakeStart).toBeLessThanOrEqual(performance.now())
  })
})

// ---------------------------------------------------------------------------
// The redial loop (official X0n)
// ---------------------------------------------------------------------------

describe('2.1.307 B2 connectWithSuspendRedial', () => {
  test('redials after a suspended failure and returns the eventual success', async () => {
    // Arrange
    const results = [suspendedFailure(), success()]
    let dials = 0
    const dial = async () => results[Math.min(dials++, results.length - 1)]!

    // Act
    const result = await connectWithSuspendRedial(dial, () => true, () => {})

    // Assert
    expect(dials).toBe(2)
    expect(result.type).toBe('connected')
    expect(loggedDebug).toContainEqual({
      server: 'srv',
      message: 'Connecting again after a sleep or a clock change (1 of at most 10)',
    })
    // Official success counter g("mcp_connect_suspend_redial").
    expect(
      loggedEvents.some((e) => e.name === 'mcp_connect_suspend_redial'),
    ).toBe(true)
  })

  test('does not redial a non-suspended failure', async () => {
    // Arrange
    let dials = 0
    const dial = async () => {
      dials++
      return otherFailure()
    }

    // Act
    const result = await connectWithSuspendRedial(dial, () => true, () => {})

    // Assert
    expect(dials).toBe(1)
    expect(result.errorCode).toBe('ECONNREFUSED')
    expect(loggedDebug).toEqual([])
  })

  test('stops redialing at the cap of 10 and reports the final failure', async () => {
    // Arrange
    let dials = 0
    const dial = async () => {
      dials++
      return suspendedFailure()
    }
    let finalFailureCalls = 0

    // Act
    const result = await connectWithSuspendRedial(dial, () => true, () => {
      finalFailureCalls++
    })

    // Assert — initial dial + 10 redials; at cap with currency the failure
    // is persisted (official `c===z&&n()` → `$o`).
    expect(dials).toBe(11)
    expect(result.errorCode).toBe(CONNECT_SUSPENDED)
    expect(finalFailureCalls).toBe(1)
    expect(
      loggedDebug.filter((entry) =>
        entry.message.startsWith('Connecting again after a sleep'),
      ),
    ).toHaveLength(10)
    expect(loggedDebug).toContainEqual({
      server: 'srv',
      message: 'Connecting again after a sleep or a clock change (10 of at most 10)',
    })
    // Official f("mcp_connect_suspend_redial","slept_again").
    expect(
      loggedEvents.some(
        (e) =>
          e.name === 'mcp_connect_suspend_redial' && e.metadata.reason === 'slept_again',
      ),
    ).toBe(true)
  })

  test('does not persist the final failure when the dial is no longer current at the cap', async () => {
    // Arrange — currency holds through all 10 loop checks, then goes stale.
    let dials = 0
    const dial = async () => {
      dials++
      return suspendedFailure()
    }
    let checks = 0
    const isCurrentDial = () => ++checks <= 10
    let finalFailureCalls = 0

    // Act
    await connectWithSuspendRedial(dial, isCurrentDial, () => {
      finalFailureCalls++
    })

    // Assert
    expect(dials).toBe(11)
    expect(finalFailureCalls).toBe(0)
  })

  test('stops redialing when the dial generation goes stale', async () => {
    // Arrange
    let dials = 0
    const dial = async () => {
      dials++
      return suspendedFailure()
    }

    // Act
    await connectWithSuspendRedial(dial, () => false, () => {})

    // Assert — the loop condition fails before the first redial.
    expect(dials).toBe(1)
  })

  test('stops redialing when the reconnect epoch is bumped mid-loop', async () => {
    // Arrange
    let dials = 0
    const dial = async () => {
      dials++
      if (dials === 1) {
        // An external cache clear (clearServerCache / onclose) bumps the
        // epoch, abandoning in-flight redial loops (official `Dr()===s`).
        bumpMcpReconnectEpoch()
      }
      return suspendedFailure()
    }

    // Act
    await connectWithSuspendRedial(dial, () => true, () => {})

    // Assert
    expect(dials).toBe(1)
  })

  test('reports a non-suspended failure after redials with the failed counter', async () => {
    // Arrange — first dial suspended, second fails differently.
    const results = [suspendedFailure(), otherFailure()]
    let dials = 0
    const dial = async () => results[Math.min(dials++, results.length - 1)]!

    // Act
    const result = await connectWithSuspendRedial(dial, () => true, () => {})

    // Assert — official f("mcp_connect_suspend_redial","failed").
    expect(result.errorCode).toBe('ECONNREFUSED')
    expect(
      loggedEvents.some(
        (e) =>
          e.name === 'mcp_connect_suspend_redial' && e.metadata.reason === 'failed',
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// connectToServer integration — suspended classification + cache eviction
// ---------------------------------------------------------------------------

describe('2.1.307 B2 connectToServer suspended path', () => {
  test('classifies a sleep-collapsed connect timeout as CONNECT_SUSPENDED and evicts the failure from the cache', async () => {
    // Arrange — a stdio server that never completes the MCP handshake times
    // out fast; Date.now advances 1500ms per call so the wall/awake gap blows
    // past the 1000ms threshold while performance.now stays real.
    const previousTimeout = process.env.MCP_TIMEOUT
    process.env.MCP_TIMEOUT = '40'
    // The dial path constructs `new Client({version: MACRO.VERSION})` — the
    // build-time macro global must exist in tests (cli.tsx polyfills it in
    // production; test/preload.ts does not).
    const globalWithMacro = globalThis as { MACRO?: { VERSION?: string } }
    const hadMacro = 'MACRO' in globalWithMacro
    globalWithMacro.MACRO ??= { VERSION: '2.1.307-test' }
    const name = 'susp-srv-307'
    const config = {
      type: 'stdio',
      command: 'sleep',
      args: ['30'],
      scope: 'user',
    } as never
    let fakeNow = Date.now()
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => {
      const value = fakeNow
      fakeNow += 1500
      return value
    })
    // Stop the redial loop after the first dial: the epoch bump makes the
    // loop's `Dr()===s` check fail (single-dial integration, no 10 spawns).
    const promise = connectToServer(name, config)
    bumpMcpReconnectEpoch()

    try {
      // Act
      const result = await promise

      // Assert — verbatim suspended message + errorCode; the memo cache must
      // NOT retain the sleep-collapsed failure (next caller redials fresh).
      expect(result.type).toBe('failed')
      expect(result.errorCode).toBe(CONNECT_SUSPENDED)
      expect(result.error).toBe(
        `MCP server "${name}" connection timed out. Your computer went to sleep or its clock changed while connecting.`,
      )
      expect(connectToServer.cache.has(getServerCacheKey(name, config))).toBe(
        false,
      )
    } finally {
      nowSpy.mockRestore()
      if (!hadMacro) {
        delete globalWithMacro.MACRO
      }
      if (previousTimeout === undefined) {
        delete process.env.MCP_TIMEOUT
      } else {
        process.env.MCP_TIMEOUT = previousTimeout
      }
    }
  }, 30_000)
})
