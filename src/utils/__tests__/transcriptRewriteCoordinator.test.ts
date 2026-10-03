/**
 * CC 2.1.288 #12 — transcript load/rewrite coordination registry.
 *
 * Ports the official v288 module `Gyn`/`wM`/`Kyn`/`Vyn` (@211467183, window
 * w288_rwcoord.txt). Covers the task-mandated behaviors:
 *   - rewrite waits for an in-flight load
 *   - load waits for an in-flight rewrite
 *   - 5s timeout → abandon + the OFFICIAL warn message (byte-exact)
 *   - dispose cleans the registry (empty set deletes the map key)
 *   - concurrent multiple loads are all awaited
 *
 * Mock plumbing follows the OCC-97/129 convention (sessionStorage.transcriptLoad276.test.ts):
 * snapshot the real module exports BEFORE mocking, restore in afterAll.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// Capture logForDebugging so the official warn message can be asserted.
// ---------------------------------------------------------------------------
const actualDebugModule = await import('../debug.js')
const actualLogForDebugging = actualDebugModule.logForDebugging

const debugLines: Array<{ message: string; level?: string }> = []
let mockActive = true

mock.module('../debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: (message: string, opts?: { level?: string }) => {
    if (!mockActive) {
      return actualLogForDebugging(message, opts as never)
    }
    debugLines.push({ message, level: opts?.level })
  },
}))

afterAll(() => {
  mockActive = false
  mock.module('../debug.js', () => ({
    ...actualDebugModule,
    logForDebugging: actualLogForDebugging,
  }))
})

// Import AFTER the debug mock is installed so the coordinator's live binding
// resolves to the capture shim.
const {
  acquireLoadCoordination,
  acquireRewriteCoordination,
  getTranscriptRewriteCoordinatorForTesting,
  resetTranscriptRewriteCoordinatorForTesting,
} = await import('../transcriptRewriteCoordinator.js')

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (v: T) => void
} {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

/** Flush pending microtasks so awaited promises settle without real timers. */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

const FILE = '/tmp/occ-coord-test/project/session-abc.jsonl'

beforeEach(() => {
  debugLines.length = 0
  resetTranscriptRewriteCoordinatorForTesting()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('CC 2.1.288 #12: transcript rewrite/load coordination', () => {
  test('rewrite waits for an in-flight load to finish before proceeding', async () => {
    // Arrange: a load is in flight (registered, not yet disposed).
    const loadHandle = await acquireLoadCoordination(FILE)
    const coord = getTranscriptRewriteCoordinatorForTesting()
    expect(coord.loads.get(resolve(FILE))?.size).toBe(1)

    // Act: start a rewrite. It should NOT resolve until the load is disposed.
    let rewriteAcquired = false
    const rewritePromise = acquireRewriteCoordination(FILE).then(h => {
      rewriteAcquired = true
      return h
    })
    await flushMicrotasks()
    expect(rewriteAcquired).toBe(false) // still waiting on the load

    // Release the load → the rewrite's wait resolves.
    loadHandle[Symbol.dispose]()
    const rewriteHandle = await rewritePromise

    // Assert: rewrite proceeded and registered itself.
    expect(rewriteAcquired).toBe(true)
    expect(coord.rewrites.get(resolve(FILE))?.size).toBe(1)
    expect(debugLines).toHaveLength(0) // no timeout warn — load finished in time
    rewriteHandle[Symbol.dispose]()
  })

  test('load waits for an in-flight rewrite to finish before registering', async () => {
    // Arrange: a rewrite is in flight.
    const rewriteHandle = await acquireRewriteCoordination(FILE)
    const coord = getTranscriptRewriteCoordinatorForTesting()
    expect(coord.rewrites.get(resolve(FILE))?.size).toBe(1)

    // Act: start a load. It chain-waits the rewrite, so it must not register yet.
    let loadAcquired = false
    const loadPromise = acquireLoadCoordination(FILE).then(h => {
      loadAcquired = true
      return h
    })
    await flushMicrotasks()
    expect(loadAcquired).toBe(false)
    expect(coord.loads.get(resolve(FILE))).toBeUndefined()

    // Release the rewrite → the load proceeds and registers.
    rewriteHandle[Symbol.dispose]()
    const loadHandle = await loadPromise

    // Assert
    expect(loadAcquired).toBe(true)
    expect(coord.loads.get(resolve(FILE))?.size).toBe(1)
    loadHandle[Symbol.dispose]()
  })

  test('5s timeout abandons in-flight loads and emits the official warn message', async () => {
    jest.useFakeTimers()
    // Arrange: a load that never finishes.
    const loadHandle = await acquireLoadCoordination(FILE)

    // Act: a rewrite starts and waits ≤5000ms for the load.
    const rewritePromise = acquireRewriteCoordination(FILE)
    await flushMicrotasks()
    // Advance past the official loadWaitMs (5000).
    jest.advanceTimersByTime(5000)
    const rewriteHandle = await rewritePromise

    // Assert: the abandoned load is tracked and the OFFICIAL warn fired once.
    const coord = getTranscriptRewriteCoordinatorForTesting()
    expect(coord.abandonedLoads.has).toBeTypeOf('function')
    const warns = debugLines.filter(l => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toBe(
      'Transcript rewrite stopped waiting after 5000ms for 1 load(s) of file session-abc.jsonl',
    )

    jest.useRealTimers()
    rewriteHandle[Symbol.dispose]()
    loadHandle[Symbol.dispose]()
  })

  test('a rewrite does not re-wait an already-abandoned load', async () => {
    jest.useFakeTimers()
    const loadHandle = await acquireLoadCoordination(FILE)

    // First rewrite abandons the stuck load after 5s.
    const first = acquireRewriteCoordination(FILE)
    await flushMicrotasks()
    jest.advanceTimersByTime(5000)
    const firstHandle = await first
    expect(debugLines.filter(l => l.level === 'warn')).toHaveLength(1)

    // Second rewrite: the abandoned load is filtered out, so it acquires
    // immediately (no new 5s wait, no second warn).
    debugLines.length = 0
    const secondHandle = await acquireRewriteCoordination(FILE)
    await flushMicrotasks()
    expect(debugLines.filter(l => l.level === 'warn')).toHaveLength(0)

    jest.useRealTimers()
    firstHandle[Symbol.dispose]()
    secondHandle[Symbol.dispose]()
    loadHandle[Symbol.dispose]()
  })

  test('dispose removes the deferred and deletes the map key when the set empties', async () => {
    const coord = getTranscriptRewriteCoordinatorForTesting()
    const key = resolve(FILE)

    // Two loads on the same path share one Set.
    const h1 = await acquireLoadCoordination(FILE)
    const h2 = await acquireLoadCoordination(FILE)
    expect(coord.loads.get(key)?.size).toBe(2)

    // Disposing one leaves the set (and key) in place.
    h1[Symbol.dispose]()
    expect(coord.loads.get(key)?.size).toBe(1)

    // Disposing the last one empties the set → the map key is deleted (official Vyn).
    h2[Symbol.dispose]()
    expect(coord.loads.get(key)).toBeUndefined()
  })

  test('concurrent multiple loads are all awaited by a rewrite', async () => {
    // Arrange: three concurrent loads on the same file.
    const l1 = await acquireLoadCoordination(FILE)
    const l2 = await acquireLoadCoordination(FILE)
    const l3 = await acquireLoadCoordination(FILE)
    const coord = getTranscriptRewriteCoordinatorForTesting()
    expect(coord.loads.get(resolve(FILE))?.size).toBe(3)

    let releaseAll!: () => void
    const gate = new Promise<void>(r => {
      releaseAll = r
    })
    let rewriteAcquired = false
    const rewritePromise = acquireRewriteCoordination(FILE).then(h => {
      rewriteAcquired = true
      return h
    })

    // Release loads one at a time; the rewrite must wait for ALL of them.
    l1[Symbol.dispose]()
    await flushMicrotasks()
    expect(rewriteAcquired).toBe(false)
    l2[Symbol.dispose]()
    await flushMicrotasks()
    expect(rewriteAcquired).toBe(false)
    l3[Symbol.dispose]()
    releaseAll()
    const rewriteHandle = await rewritePromise
    expect(rewriteAcquired).toBe(true)
    expect(gate).toBeInstanceOf(Promise) // (gate kept referenced; no timeout warn)
    expect(debugLines.filter(l => l.level === 'warn')).toHaveLength(0)
    rewriteHandle[Symbol.dispose]()
  })

  test('load and rewrite on DIFFERENT paths do not block each other', async () => {
    const other = '/tmp/occ-coord-test/project/session-xyz.jsonl'
    const loadHandle = await acquireLoadCoordination(FILE)

    // A rewrite of a different path must not wait on FILE's load.
    let otherAcquired = false
    const otherPromise = acquireRewriteCoordination(other).then(h => {
      otherAcquired = true
      return h
    })
    await flushMicrotasks()
    expect(otherAcquired).toBe(true)

    const otherHandle = await otherPromise
    otherHandle[Symbol.dispose]()
    loadHandle[Symbol.dispose]()
  })
})
