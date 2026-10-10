import { describe, expect, test } from 'bun:test'
import {
  computeReconnectHoldoffMs,
  connectToServer,
  nextRapidDropCount,
  RAPID_DROP_THRESHOLD_MS,
  reconnectBackoffMs,
  _rapidDropCountsForTesting,
  _headlessRedialsInFlightForTesting,
  _activeHeadlessRedialsForTesting,
  _scheduleHeadlessRemoteRedialForTesting,
  getServerCacheKey,
} from '../client'
import type { ScopedMcpServerConfig } from '../types'

/**
 * claude-code 2.1.295 (item 3) — remote MCP reconnect rapid-drop backoff.
 *
 * Official binary evidence (`yDo` close-handler factory + `gnt` backoff):
 *
 *   nns = 1e4                                rapid-drop lifetime threshold
 *   gnt(a) = min(30_000, 1000 * 2^(a-1))     capped exponential hold-off
 *   rapidDrops = lifetime < 1e4 ? prev + 1 : 0
 *   holdoff = rapidDrops > 1 ? max(0, gnt(rapidDrops-1) - lifetime) : 0
 *
 * The shared/headless onclose path in client.ts redials dropped remote
 * transports using exactly these primitives (the interactive REPL keeps its
 * own reconnect loop in useManageMCPConnections).
 */
describe('2.1.295 reconnectBackoffMs (official gnt)', () => {
  test('doubles from the 1000ms base per attempt', () => {
    expect(reconnectBackoffMs(1)).toBe(1000)
    expect(reconnectBackoffMs(2)).toBe(2000)
    expect(reconnectBackoffMs(3)).toBe(4000)
    expect(reconnectBackoffMs(4)).toBe(8000)
    expect(reconnectBackoffMs(5)).toBe(16000)
  })

  test('caps at 30000ms', () => {
    // Arrange — uncapped 2^5 * 1000 would be 32000
    // Act & Assert
    expect(reconnectBackoffMs(6)).toBe(30000)
    expect(reconnectBackoffMs(10)).toBe(30000)
  })
})

describe('2.1.295 computeReconnectHoldoffMs (official hold-off T)', () => {
  test('reconnects immediately for the first rapid drop and healthy connections', () => {
    // Arrange & Act & Assert — attempt <= 1 keeps the old immediate redial
    expect(computeReconnectHoldoffMs(0, 500)).toBe(0)
    expect(computeReconnectHoldoffMs(1, 500)).toBe(0)
  })

  test('subtracts the connection lifetime already managed from the backoff', () => {
    // Arrange & Act & Assert
    // attempt 2 → gnt(1)=1000, lifetime 300 → hold 700
    expect(computeReconnectHoldoffMs(2, 300)).toBe(700)
    // attempt 3 → gnt(2)=2000, lifetime 1500 → hold 500
    expect(computeReconnectHoldoffMs(3, 1500)).toBe(500)
  })

  test('never goes negative when the lifetime exceeds the backoff', () => {
    // Arrange & Act & Assert — attempt 2 → gnt(1)=1000, lifetime 5000 → 0
    expect(computeReconnectHoldoffMs(2, 5000)).toBe(0)
  })

  test('clamps at the 30000ms ceiling for sustained flapping', () => {
    // Arrange & Act & Assert
    expect(computeReconnectHoldoffMs(7, 0)).toBe(30000)
    expect(computeReconnectHoldoffMs(20, 0)).toBe(30000)
  })
})

describe('2.1.295 nextRapidDropCount (official rapid-drop counting)', () => {
  test('increments the previous count when the drop was rapid', () => {
    // Arrange & Act & Assert
    expect(nextRapidDropCount(0, 9999)).toBe(1)
    expect(nextRapidDropCount(5, 9999)).toBe(6)
  })

  test('resets to zero when the connection lived past the threshold', () => {
    // Arrange & Act & Assert — strict `<` in the official: exactly 10000ms
    // is NOT rapid
    expect(RAPID_DROP_THRESHOLD_MS).toBe(10000)
    expect(nextRapidDropCount(5, 10000)).toBe(0)
    expect(nextRapidDropCount(5, 60000)).toBe(0)
  })
})

// --- dataflow-006 + redial wiring integration probes ------------------------
//
// scheduleHeadlessRemoteRedial is exercised end-to-end without any real
// network: the server ref carries a whitespace-only URL, which makes
// connectToServer short-circuit to `unconfigured` before any transport is
// created (CC 2.1.208 #43 guard). The redial therefore always takes the
// failed-dial branch deterministically and instantly.

/** Unique server name per probe so memo-cache / in-flight keys never collide. */
let probeCounter = 0
function makeProbeServerRef(): { name: string; ref: ScopedMcpServerConfig } {
  probeCounter++
  return {
    name: `probe-redial-${probeCounter}-${Date.now()}`,
    // Whitespace-only URL → connectToServer returns 'unconfigured' with no
    // transport, no sockets, no subprocesses.
    ref: { type: 'http', url: '   ', scope: 'user' } as ScopedMcpServerConfig,
  }
}

/** Poll until `pred()` holds or the deadline passes; fails the test on timeout. */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

describe('dataflow-006: rapidDropCounts map is pruned, not unbounded', () => {
  test('a stable connection (lifetime >= threshold) deletes the key instead of storing 0', async () => {
    // Arrange
    const { name, ref } = makeProbeServerRef()
    const key = getServerCacheKey(name, ref)
    // Seed a prior rapid-drop count so we can observe the prune on reset.
    _rapidDropCountsForTesting.set(key, 3)

    // Act — stable connection: nextRapidDropCount(3, 60000) === 0
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 60_000)

    // Assert — the pruning happens synchronously inside schedule()
    expect(_rapidDropCountsForTesting.has(key)).toBe(false)

    // Let the background redial settle so no dangling work leaks past the test.
    await waitFor(() => !_headlessRedialsInFlightForTesting.has(key))
  })

  test('a rapid drop stores the incremented count; the next stable drop prunes it', async () => {
    // Arrange
    const { name, ref } = makeProbeServerRef()
    const key = getServerCacheKey(name, ref)

    // Act — rapid drop (lifetime 100ms < 10000ms threshold)
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 100)

    // Assert — count stored
    expect(_rapidDropCountsForTesting.get(key)).toBe(1)
    await waitFor(() => !_headlessRedialsInFlightForTesting.has(key))

    // Act — connection then stays up past the threshold and drops again
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 60_000)

    // Assert — key removed entirely, not left holding 0 (the unbounded-growth bug)
    expect(_rapidDropCountsForTesting.has(key)).toBe(false)
    await waitFor(() => !_headlessRedialsInFlightForTesting.has(key))
  })
})

describe('redial wiring: in-flight race guard + lifecycle cleanup', () => {
  test('two rapid drops schedule exactly one redial; in-flight/active sets are empty afterwards and the failed dial is evicted from the memo cache', async () => {
    // Arrange
    const { name, ref } = makeProbeServerRef()
    const key = getServerCacheKey(name, ref)

    // Act — close the transport twice in quick succession (both rapid:
    // lifetime 5000ms → attempt 1 holdoff 0, attempt 2 holdoff
    // max(0, 1000-5000) = 0, so no real timers are armed).
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 5000)
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 5000)

    // Assert — the second schedule() hit the in-flight guard BEFORE creating
    // its own AbortController: exactly one delayed redial is active.
    expect(_headlessRedialsInFlightForTesting.has(key)).toBe(true)
    expect(_activeHeadlessRedialsForTesting.size).toBe(1)
    // The rapid-drop count still advanced on the guarded call (bookkeeping is
    // separate from scheduling).
    expect(_rapidDropCountsForTesting.get(key)).toBe(2)

    // Act — let the single redial run to completion (connectToServer
    // short-circuits to 'unconfigured' → failed-dial branch).
    await waitFor(
      () =>
        !_headlessRedialsInFlightForTesting.has(key) &&
        _activeHeadlessRedialsForTesting.size === 0,
    )

    // Assert — after the failure: in-flight guard released, active controller
    // cleaned up, and the failed dial was deleted from the memoize cache so
    // the next use gets a fresh dial.
    expect(_headlessRedialsInFlightForTesting.size).toBe(0)
    expect(_activeHeadlessRedialsForTesting.size).toBe(0)
    expect(connectToServer.cache.has(key)).toBe(false)

    // Cleanup — don't leak the count entry into other probes.
    _rapidDropCountsForTesting.delete(key)
  })

  test('a successful memo-cache entry is NOT created for the failed probe dial (cache.delete ran on the non-connected result)', async () => {
    // Arrange
    const { name, ref } = makeProbeServerRef()
    const key = getServerCacheKey(name, ref)

    // Act — single rapid drop, wait for the redial to finish
    _scheduleHeadlessRemoteRedialForTesting(name, ref, 100)
    await waitFor(() => !_headlessRedialsInFlightForTesting.has(key))

    // Assert — the memo cache holds no 'unconfigured' failure for this key
    expect(connectToServer.cache.has(key)).toBe(false)
    expect(_activeHeadlessRedialsForTesting.size).toBe(0)

    // Cleanup
    _rapidDropCountsForTesting.delete(key)
  })
})
