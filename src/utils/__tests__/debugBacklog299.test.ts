import { describe, expect, test } from 'bun:test'
import {
  DEBUG_APPEND_STUCK_MS,
  DEBUG_BACKLOG_MAX_BYTES,
  DEBUG_BACKLOG_STALE_MS,
  createDebugBacklogLimiter,
  debugDroppedNote,
  drainNonBlocking,
} from '../debugBacklog.js'
import { sleep } from '../sleep.js'

/**
 * CC 2.1.299 (#028): bounded debug-log backlog — "Fixed memory growth under
 * heavy debug logging (--debug, --debug-file), and a hang on exit when the
 * debug log is on a disk or network mount that stops accepting writes."
 *
 * Official class `Fn` backlog semantics (byte-exact constants, see
 * debugBacklog.ts forensic header): drop rule with 1 MiB cap + 10 s staleness
 * + half-cap hysteresis, verbatim takeDroppedNote WARN text, 5 s append-stuck
 * detection, and non-blocking `drained()` exit drain.
 */

function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('createDebugBacklogLimiter drop rule (CC 2.1.299 #028)', () => {
  test('fresh limiter never drops and reports zero state', () => {
    const limiter = createDebugBacklogLimiter(fakeClock().now)
    expect(limiter.shouldDrop()).toBe(false)
    expect(limiter.getBytes()).toBe(0)
    expect(limiter.getDroppedCount()).toBe(0)
    expect(limiter.isAppendStuck()).toBe(false)
    expect(limiter.takeDroppedNote()).toBe('')
  })

  test('backlog over 1 MiB but younger than 10 s → no drop (both conditions required)', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(DEBUG_BACKLOG_MAX_BYTES + 1)
    clock.advance(DEBUG_BACKLOG_STALE_MS - 1)
    expect(limiter.shouldDrop()).toBe(false)
  })

  test('backlog over 1 MiB AND oldest queued over 10 s → drop', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(DEBUG_BACKLOG_MAX_BYTES)
    expect(limiter.shouldDrop()).toBe(false)
    clock.advance(DEBUG_BACKLOG_STALE_MS)
    expect(limiter.shouldDrop()).toBe(true)
  })

  test('hysteresis: once dropping, keeps dropping until backlog under half cap', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(DEBUG_BACKLOG_MAX_BYTES)
    clock.advance(DEBUG_BACKLOG_STALE_MS)
    expect(limiter.shouldDrop()).toBe(true)
    limiter.recordDropped()
    // Backlog drains to exactly half the cap → still dropping.
    limiter.settle(DEBUG_BACKLOG_MAX_BYTES / 2)
    expect(limiter.getBytes()).toBe(DEBUG_BACKLOG_MAX_BYTES / 2)
    expect(limiter.shouldDrop()).toBe(true)
    // One more byte below half → stops dropping even though still stale.
    limiter.settle(1)
    expect(limiter.shouldDrop()).toBe(false)
  })

  test('fully drained backlog resets staleness: a fresh accept needs a new 10 s wait', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(100)
    limiter.settle(100)
    clock.advance(DEBUG_BACKLOG_STALE_MS * 10)
    limiter.accept(DEBUG_BACKLOG_MAX_BYTES + 1)
    // Over cap, but the oldest queued chunk is brand new.
    expect(limiter.shouldDrop()).toBe(false)
    clock.advance(DEBUG_BACKLOG_STALE_MS)
    expect(limiter.shouldDrop()).toBe(true)
  })

  test('settle never drives bytes negative', () => {
    const limiter = createDebugBacklogLimiter(fakeClock().now)
    limiter.accept(10)
    limiter.settle(50)
    expect(limiter.getBytes()).toBe(0)
  })
})

describe('createDebugBacklogLimiter stuck detection (CC 2.1.299 #028)', () => {
  test('in-flight append older than 5 s → stuck; settle disarms', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(10) // starts the append (nothing in flight before)
    clock.advance(DEBUG_APPEND_STUCK_MS - 1)
    expect(limiter.isAppendStuck()).toBe(false)
    clock.advance(1)
    expect(limiter.isAppendStuck()).toBe(true)
    limiter.settle(10)
    expect(limiter.isAppendStuck()).toBe(false)
  })

  test('chained appends: settling with bytes still queued re-arms the stuck clock', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    limiter.accept(10)
    limiter.accept(10)
    clock.advance(DEBUG_APPEND_STUCK_MS + 1000)
    expect(limiter.isAppendStuck()).toBe(true)
    // First append finishes; second starts now → no longer stuck.
    limiter.settle(10)
    expect(limiter.isAppendStuck()).toBe(false)
    clock.advance(DEBUG_APPEND_STUCK_MS)
    expect(limiter.isAppendStuck()).toBe(true)
  })

  test('idle limiter (nothing accepted) is never stuck', () => {
    const clock = fakeClock()
    const limiter = createDebugBacklogLimiter(clock.now)
    clock.advance(DEBUG_APPEND_STUCK_MS * 100)
    expect(limiter.isAppendStuck()).toBe(false)
  })
})

describe('debugDroppedNote / takeDroppedNote (official verbatim text)', () => {
  test('note text is byte-exact apart from the ISO timestamp', () => {
    const note = debugDroppedNote(7)
    expect(note).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]{12}Z \[WARN\] debug messages not logged: 7 since the line above, because writes to this log were over 10 s behind, with over 1 MiB waiting\n$/,
    )
  })

  test('takeDroppedNote returns the note once and resets the count', () => {
    const limiter = createDebugBacklogLimiter(fakeClock().now)
    expect(limiter.takeDroppedNote()).toBe('')
    limiter.recordDropped()
    limiter.recordDropped()
    limiter.recordDropped()
    const note = limiter.takeDroppedNote()
    expect(note).toContain('[WARN] debug messages not logged: 3 since the line above')
    expect(limiter.getDroppedCount()).toBe(0)
    expect(limiter.takeDroppedNote()).toBe('')
  })
})

describe('drainNonBlocking (official drained(), CC 2.1.299 #028)', () => {
  test('returns immediately when the sink is already stuck', async () => {
    const start = Date.now()
    // A pending promise that never settles — a bare `await` would hang.
    await drainNonBlocking(new Promise<void>(() => {}), () => true, 20)
    expect(Date.now() - start).toBeLessThan(500)
  })

  test('resolves as soon as the pending chain drains', async () => {
    let drained = false
    const pending = sleep(120).then(() => {
      drained = true
    })
    await drainNonBlocking(pending, () => false, 20)
    expect(drained).toBe(true)
  })

  test('already-resolved pending returns on the first poll race', async () => {
    await drainNonBlocking(Promise.resolve(), () => false, 20)
  })

  test('rejected pending counts as drained (append chain swallows errors)', async () => {
    await drainNonBlocking(Promise.reject(new Error('mount gone')).catch(() => {}), () => false, 20)
    // A rejection that reaches drainNonBlocking directly must also not throw.
    await drainNonBlocking(Promise.reject(new Error('mount gone')), () => false, 20)
  })

  test('gives up mid-drain when the sink becomes stuck (fake slow sink)', async () => {
    // Simulates a dead network mount: the append never completes, and the
    // stuck detector flips after ~150 ms. drainNonBlocking must return
    // instead of hanging exit.
    const start = Date.now()
    let stuck = false
    const stuckFlipper = sleep(150).then(() => {
      stuck = true
    })
    await drainNonBlocking(new Promise<void>(() => {}), () => stuck, 20)
    await stuckFlipper
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect(elapsed).toBeLessThan(3000)
  })
})
