import { describe, expect, test } from 'bun:test'
import {
  type BoundedStderrWriter,
  STDERR_DROP_STALE_MS,
  STDERR_UNFLUSHED_MAX_BYTES,
  createBoundedStderrWriter,
  stderrDroppedNote,
} from '../process.js'

/**
 * CC 2.1.299 (#029): "Fixed memory growing without bound when debug output
 * goes to stderr and the parent process stops reading it." Official class
 * `f` + `Fj` + helper `C` (byte-exact constants `m=1048576`, `O=1e4`;
 * `mayDrop` has 0 hits in v296 — the whole bounded writer is v299-NEW).
 *
 * Drop rule: `mayDrop && unflushed>=m && (droppedCount>0 || now-since>=O)`.
 * When the backlog later drains under the cap, one verbatim note marks the
 * gap (official `reportDropped`).
 */

type FakeWrite = { data: string; cb?: () => void }

function fakeStream(opts: {
  backedUp?: boolean
  destroyed?: boolean
  writableEnded?: boolean
}): {
  stream: NodeJS.WriteStream
  writes: FakeWrite[]
  flushOldest: () => void
  flushAll: () => void
} {
  const writes: FakeWrite[] = []
  const stream = {
    destroyed: opts.destroyed ?? false,
    writableEnded: opts.writableEnded ?? false,
    write(data: string, cb?: () => void): boolean {
      writes.push({ data, cb })
      // false = kernel buffer full (parent not reading).
      return !(opts.backedUp ?? false)
    },
  } as unknown as NodeJS.WriteStream
  return {
    stream,
    writes,
    flushOldest: () => {
      const next = writes.find(w => w.cb)
      const cb = next?.cb
      if (next) next.cb = undefined
      cb?.()
    },
    flushAll: () => {
      for (const w of [...writes]) w.cb?.()
    },
  }
}

function fakeClock(start = 1_700_000_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

const CHUNK = 'x'.repeat(STDERR_UNFLUSHED_MAX_BYTES / 4) // 256 KiB

function fillBacklog(
  writer: BoundedStderrWriter,
  chunks: number,
): void {
  for (let i = 0; i < chunks; i++) writer.write(CHUNK, true)
}

describe('createBoundedStderrWriter healthy stream (CC 2.1.299 #029)', () => {
  test('accepted writes never accumulate unflushed bytes', () => {
    const fake = fakeStream({ backedUp: false })
    const writer = createBoundedStderrWriter(fake.stream, fakeClock().now)
    writer.write('hello\n', true)
    writer.write('world\n', true)
    expect(writer.getUnflushedBytes()).toBe(0)
    expect(writer.getDroppedCount()).toBe(0)
    expect(fake.writes.map(w => w.data)).toEqual(['hello\n', 'world\n'])
  })

  test('destroyed or ended stream → write skipped, nothing counted', () => {
    for (const opts of [{ destroyed: true }, { writableEnded: true }]) {
      const fake = fakeStream(opts)
      const writer = createBoundedStderrWriter(fake.stream, fakeClock().now)
      writer.write('data', true)
      expect(fake.writes).toHaveLength(0)
      expect(writer.getUnflushedBytes()).toBe(0)
    }
  })
})

describe('createBoundedStderrWriter drop rule (CC 2.1.299 #029)', () => {
  test('backpressure accumulates unflushed bytes while parent stops reading', () => {
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, fakeClock().now)
    fillBacklog(writer, 3) // 768 KiB backed up
    expect(writer.getUnflushedBytes()).toBe((CHUNK.length * 3))
    expect(writer.getDroppedCount()).toBe(0)
  })

  test('under 1 MiB backlog → mayDrop writes still go through even when stale', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 3)
    clock.advance(STDERR_DROP_STALE_MS * 10)
    writer.write(CHUNK, true) // would reach exactly 1 MiB — still written
    expect(writer.getDroppedCount()).toBe(0)
    expect(fake.writes).toHaveLength(4)
  })

  test('over 1 MiB but fresher than 10 s → no drop yet', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 5) // 1.25 MiB
    clock.advance(STDERR_DROP_STALE_MS - 1)
    writer.write('still written', true)
    expect(writer.getDroppedCount()).toBe(0)
  })

  test('over 1 MiB AND over 10 s → mayDrop writes dropped and counted', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 5)
    clock.advance(STDERR_DROP_STALE_MS)
    const before = fake.writes.length
    writer.write('dropped-1', true)
    writer.write('dropped-2', true)
    expect(writer.getDroppedCount()).toBe(2)
    expect(fake.writes.length).toBe(before) // never reached the stream
    expect(writer.getUnflushedBytes()).toBe(CHUNK.length * 5)
  })

  test('droppedCount>0 keeps dropping without a fresh staleness window (official hysteresis)', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 5)
    clock.advance(STDERR_DROP_STALE_MS)
    writer.write('drop', true) // first drop (stale)
    // Drain under the cap so staleness would reset, but do NOT emit the note
    // yet: keep droppedCount alive by writing an important (mayDrop=false)
    // line first — official rule drops on `droppedCount>0` alone.
    expect(writer.getDroppedCount()).toBe(1)
    clock.advance(-1) // even with the clock rewound, the next drop fires
    writer.write('drop-again', true)
    expect(writer.getDroppedCount()).toBe(2)
  })

  test('mayDrop=false (important messages) always attempts the write', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 5)
    clock.advance(STDERR_DROP_STALE_MS * 2)
    writer.write('IMPORTANT\n', false)
    expect(writer.getDroppedCount()).toBe(0)
    expect(fake.writes.at(-1)?.data).toBe('IMPORTANT\n')
  })
})

describe('createBoundedStderrWriter reportDropped note (CC 2.1.299 #029)', () => {
  test('draining under 1 MiB after drops emits the verbatim note once', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 6) // 1.5 MiB backed up
    clock.advance(STDERR_DROP_STALE_MS)
    writer.write('dropped-1', true)
    writer.write('dropped-2', true)
    expect(writer.getDroppedCount()).toBe(2)

    // Flush 256 KiB → 1.25 MiB: still at/over cap, no note yet.
    fake.flushOldest()
    expect(fake.writes.some(w => w.data.includes('dropped before this line'))).toBe(false)
    // Flush another → 1 MiB exactly: `< m` is false, still no note.
    fake.flushOldest()
    expect(fake.writes.some(w => w.data.includes('dropped before this line'))).toBe(false)
    // Flush another → 0.75 MiB < cap: note emitted with mayDrop=false.
    fake.flushOldest()
    const note = fake.writes.at(-1)?.data ?? ''
    expect(note).toBe(
      '[stderr messages dropped before this line: 2. Whatever reads this stderr had not caught up for over 10 s and 1 MiB of output.]\n',
    )
    expect(writer.getDroppedCount()).toBe(0)
    // The note write itself goes through the same accounting and is also
    // backed up on this stalled stream (official reportDropped → write).
    expect(writer.getUnflushedBytes()).toBe(
      CHUNK.length * 3 + stderrDroppedNote(2).length,
    )
  })

  test('no drops → draining emits no note', () => {
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, fakeClock().now)
    fillBacklog(writer, 5)
    fake.flushAll()
    expect(fake.writes.some(w => w.data.includes('dropped before this line'))).toBe(false)
    expect(writer.getUnflushedBytes()).toBe(0)
  })

  test('flush callback is idempotent — double-fire does not double-decrement', () => {
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, fakeClock().now)
    writer.write(CHUNK, true)
    expect(writer.getUnflushedBytes()).toBe(CHUNK.length)
    const cb = fake.writes[0]?.cb
    cb?.()
    cb?.()
    expect(writer.getUnflushedBytes()).toBe(0)
  })

  test('giveUpOnUnflushed resets accounting and emits the pending note', () => {
    const clock = fakeClock()
    const fake = fakeStream({ backedUp: true })
    const writer = createBoundedStderrWriter(fake.stream, clock.now)
    fillBacklog(writer, 5)
    clock.advance(STDERR_DROP_STALE_MS)
    writer.write('dropped', true)
    expect(writer.getDroppedCount()).toBe(1)
    writer.giveUpOnUnflushed()
    // Prior unflushed bytes are abandoned; only the freshly-emitted note
    // (itself backed up on this stalled stream) remains accounted.
    expect(writer.getUnflushedBytes()).toBe(stderrDroppedNote(1).length)
    const note = fake.writes.at(-1)?.data ?? ''
    expect(note).toContain('stderr messages dropped before this line: 1')
    expect(writer.getDroppedCount()).toBe(0)
  })

  test('stderrDroppedNote matches the official verbatim format', () => {
    expect(stderrDroppedNote(42)).toBe(
      '[stderr messages dropped before this line: 42. Whatever reads this stderr had not caught up for over 10 s and 1 MiB of output.]\n',
    )
  })
})
