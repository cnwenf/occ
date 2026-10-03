/**
 * CC 2.1.288 #11 — transcript recorder `parentWait` state machine.
 *
 * Ports the official v288 recorder `pSe` (@~229547500, window `w288_pw.txt`),
 * recovered in docs/gap-research-288/cluster-c-instructions-resume.md §#11.
 * Covers the task-mandated behaviors:
 *   - a snapshot arriving while a write is in flight is HELD, then REPLAYED
 *     after the in-flight write settles, and the REPLAYED write's
 *     `lastRecordedUuid` is the one kept (the v287 overtaken-drop bug);
 *   - writes are serialized (the replay does not start until write #1 settles);
 *   - a bare compact-boundary tail is SKIPPED (official `Xuo`);
 *   - the replay is registered with the exit-wait set (official `Zuo`/`FLt`),
 *     and the exit-wait awaits the replay + flushes (OCC durability divergence);
 *   - `tengu_transcript_parent_wait` telemetry fields are correct
 *     (settle, replay, cut_short head-reset, write_rejected).
 *
 * The recorder takes all side effects as injected deps, so these tests need no
 * module mocking, no React, and no disk — just deferred promises.
 */
import { beforeEach, describe, expect, jest, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'
import {
  isBareCompactBoundaryTail,
  TranscriptRecorder,
  TRANSCRIPT_PARENT_WAIT_EVENT,
  type TranscriptRecorderDeps,
  type TranscriptSnapshot,
  type TranscriptTelemetryMetadata,
  type TranscriptWriteFn,
} from '../transcriptRecorder.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e?: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the microtask queue so chained awaits inside the recorder progress. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

const userMsg = (uuid: string): Message =>
  ({ type: 'user', uuid }) as unknown as Message
const assistantMsg = (uuid: string): Message =>
  ({ type: 'assistant', uuid }) as unknown as Message
const compactBoundaryMsg = (uuid: string): Message =>
  ({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
  }) as unknown as Message

/**
 * Stand-in for the real `isCompactBoundaryMessage` (utils/messages.js). The
 * recorder takes the predicate as an injected dep so this module never loads
 * messages.js — avoiding its circular-init TDZ with sendNowCut.ts under bun's
 * shared test module registry.
 */
const fakeIsCompactBoundary = (m: Message): boolean =>
  m?.type === 'system' &&
  (m as { subtype?: string }).subtype === 'compact_boundary'

interface WriteCall {
  messages: Message[]
  parentHint: UUID | undefined
  allMessages: readonly Message[]
}

/**
 * Builds a recorder plus the spies/deferred-write plumbing a test drives.
 * Each `writeFn` call returns a fresh deferred the test resolves by index.
 */
function makeHarness() {
  const writeCalls: WriteCall[] = []
  const writeDeferreds: Array<Deferred<UUID | null>> = []
  const telemetry: Array<{ name: string; metadata: TranscriptTelemetryMetadata }> =
    []
  const exitWaits: Array<{ fn: () => Promise<void>; dereg: () => void }> = []
  let clock = 1_000

  const writeFn = ((
    messages: Message[],
    _teamInfo: unknown,
    parentHint: UUID | undefined,
    allMessages: readonly Message[],
  ) => {
    writeCalls.push({ messages, parentHint, allMessages })
    const d = deferred<UUID | null>()
    writeDeferreds.push(d)
    return d.promise
  }) as unknown as TranscriptWriteFn

  const flushSpy = jest.fn(async () => {})
  const emitTelemetry = jest.fn(
    (name: string, metadata: TranscriptTelemetryMetadata) => {
      telemetry.push({ name, metadata })
    },
  )
  const registerExitWait = jest.fn((fn: () => Promise<void>) => {
    let deregistered = false
    const dereg = () => {
      deregistered = true
    }
    exitWaits.push({ fn, dereg })
    return dereg
  })

  const deps: TranscriptRecorderDeps = {
    writeFn,
    registerExitWait: registerExitWait as unknown as TranscriptRecorderDeps['registerExitWait'],
    emitTelemetry,
    flush: flushSpy as unknown as () => Promise<void>,
    now: () => clock,
    isCompactBoundary: fakeIsCompactBoundary,
  }
  const recorder = new TranscriptRecorder(deps)

  return {
    recorder,
    writeCalls,
    writeDeferreds,
    telemetry,
    exitWaits,
    flushSpy,
    emitTelemetry,
    registerExitWait,
    advance: (ms: number) => {
      clock += ms
    },
    deregistered: () => exitWaits.map(() => false),
  }
}

function snapshot(
  messages: Message[],
  opts: Partial<TranscriptSnapshot> = {},
): TranscriptSnapshot {
  return {
    messages,
    options: {},
    parentHint: undefined,
    allMessages: messages,
    isIncremental: false,
    isHeadReset: false,
    ...opts,
  }
}

const uuid = (s: string): UUID => s as unknown as UUID

// ---------------------------------------------------------------------------
// Xuo — bare compact-boundary tail predicate (pure)
// ---------------------------------------------------------------------------
describe('CC 2.1.288 #11: isBareCompactBoundaryTail (official Xuo)', () => {
  test('true when the last user/assistant/boundary entry is a boundary', () => {
    // Arrange / Act
    const tail = isBareCompactBoundaryTail(
      [userMsg('u1'), assistantMsg('a1'), compactBoundaryMsg('cb1')],
      fakeIsCompactBoundary,
    )
    // Assert
    expect(tail).toBe(true)
  })

  test('false when a user/assistant message follows the boundary', () => {
    const tail = isBareCompactBoundaryTail(
      [compactBoundaryMsg('cb1'), userMsg('u1')],
      fakeIsCompactBoundary,
    )
    expect(tail).toBe(false)
  })

  test('false for an empty array (findLast → undefined)', () => {
    expect(isBareCompactBoundaryTail([], fakeIsCompactBoundary)).toBe(false)
  })

  test('false when the tail is an assistant turn (the normal, saveable case)', () => {
    expect(
      isBareCompactBoundaryTail(
        [userMsg('u1'), assistantMsg('a1')],
        fakeIsCompactBoundary,
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Hold / replay / serialization
// ---------------------------------------------------------------------------
describe('CC 2.1.288 #11: parentWait hold + replay', () => {
  let h: ReturnType<typeof makeHarness>
  beforeEach(() => {
    h = makeHarness()
  })

  test('a snapshot arriving during an in-flight write is held, not raced', async () => {
    // Arrange: first write in flight (deferred, unresolved).
    h.recorder.record(snapshot([userMsg('u1'), assistantMsg('a1')]))
    await flush()
    expect(h.writeCalls).toHaveLength(1)

    // Act: a second snapshot arrives while write #1 is still pending.
    h.recorder.record(snapshot([userMsg('u2'), assistantMsg('a2')]))
    await flush()

    // Assert: it was HELD — no second write started (v287 would have raced).
    expect(h.writeCalls).toHaveLength(1)
  })

  test('the held snapshot replays after the in-flight write settles', async () => {
    // Arrange
    h.recorder.record(snapshot([userMsg('u1'), assistantMsg('a1')]))
    h.recorder.record(snapshot([userMsg('u2'), assistantMsg('a2')]))
    await flush()
    expect(h.writeCalls).toHaveLength(1)

    // Act: settle write #1 → the replay of the held snapshot should start.
    h.writeDeferreds[0]!.resolve(uuid('a1'))
    await flush()

    // Assert: write #2 is the replayed held snapshot (u2/a2), started only now.
    expect(h.writeCalls).toHaveLength(2)
    expect(h.writeCalls[1]!.messages.map(m => m.uuid)).toEqual(['u2', 'a2'])
  })

  test('the REPLAYED write result is the lastParentUuid that is kept', async () => {
    // Arrange: two non-incremental (full-array) snapshots so the recorder's
    // result-based update applies (official `io && !Ge` ≡ OCC `!isIncremental`).
    h.recorder.record(snapshot([userMsg('u1'), assistantMsg('a1')]))
    h.recorder.record(snapshot([userMsg('u2'), assistantMsg('a2')]))
    await flush()

    // Act: settle write #1 with uuid1, then the replayed write #2 with uuid2.
    h.writeDeferreds[0]!.resolve(uuid('uuid-from-write-1'))
    await flush()
    h.writeDeferreds[1]!.resolve(uuid('uuid-from-replayed-write-2'))
    await flush()

    // Assert: the replayed write's uuid is kept (v287 dropped the overtaken result).
    expect(h.recorder.lastParentUuid).toBe(uuid('uuid-from-replayed-write-2'))
  })

  test('multiple overtaken snapshots coalesce to the newest (overtaken counts all)', async () => {
    // Arrange: one write in flight, three snapshots arrive during it.
    h.recorder.record(snapshot([assistantMsg('a0')]))
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.recorder.record(snapshot([assistantMsg('a2')]))
    h.recorder.record(snapshot([assistantMsg('a3')]))
    await flush()
    expect(h.writeCalls).toHaveLength(1)

    // Act: settle write #1 → only the NEWEST held snapshot (a3) replays.
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    // Assert
    expect(h.writeCalls).toHaveLength(2)
    expect(h.writeCalls[1]!.messages.map(m => m.uuid)).toEqual(['a3'])
    // The settle telemetry for write #1 reports 3 snapshots overtaken.
    const settle = h.telemetry.find(t => t.metadata.replayed === true)
    expect(settle?.metadata.snapshots_overtaken).toBe(3)
  })

  test('an incremental snapshot replays against the parentHint captured at record time', async () => {
    // Arrange: incremental write #1 chains from a known parent.
    h.recorder.record(
      snapshot([assistantMsg('a1')], {
        isIncremental: true,
        parentHint: uuid('parent-0'),
      }),
    )
    await flush()
    expect(h.writeCalls[0]!.parentHint).toBe(uuid('parent-0'))

    // Act: a second incremental snapshot is held with ITS captured parentHint,
    // then replayed after write #1 settles.
    h.recorder.record(
      snapshot([assistantMsg('a2')], {
        isIncremental: true,
        parentHint: uuid('parent-1'),
      }),
    )
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    // Assert: the replay used parent-1 (captured at record time), not a re-read.
    expect(h.writeCalls).toHaveLength(2)
    expect(h.writeCalls[1]!.parentHint).toBe(uuid('parent-1'))
  })
})

// ---------------------------------------------------------------------------
// Compact-boundary-tail skip
// ---------------------------------------------------------------------------
describe('CC 2.1.288 #11: bare compact-boundary tail is skipped', () => {
  test('record() does not start a write when the tail is a bare boundary', async () => {
    // Arrange
    const h = makeHarness()

    // Act: a snapshot ending on a compact boundary with no following turn.
    h.recorder.record(
      snapshot([userMsg('u1'), assistantMsg('a1'), compactBoundaryMsg('cb1')]),
    )
    await flush()

    // Assert: skipped entirely (official `if(Xuo(h))return`).
    expect(h.writeCalls).toHaveLength(0)
    expect(h.telemetry).toHaveLength(0)
  })

  test('a boundary tail is still skipped when a write is already in flight', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    await flush()
    expect(h.writeCalls).toHaveLength(1)

    // Boundary-tail snapshot arrives during the in-flight write → skipped, so
    // nothing is held for replay.
    h.recorder.record(snapshot([assistantMsg('a1'), compactBoundaryMsg('cb1')]))
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    expect(h.writeCalls).toHaveLength(1) // no replay
  })
})

// ---------------------------------------------------------------------------
// Exit-wait registration (official Zuo/FLt)
// ---------------------------------------------------------------------------
describe('CC 2.1.288 #11: exit-wait registration for the replay', () => {
  test('replaying a held snapshot registers an exit-wait cleanup', async () => {
    // Arrange
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.recorder.record(snapshot([assistantMsg('a2')]))
    await flush()
    expect(h.registerExitWait).not.toHaveBeenCalled()

    // Act: settle write #1 → replay starts → exit-wait registered.
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    // Assert
    expect(h.registerExitWait).toHaveBeenCalledTimes(1)
    expect(h.exitWaits).toHaveLength(1)
  })

  test('no exit-wait is registered when there is nothing to replay', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    expect(h.registerExitWait).not.toHaveBeenCalled()
  })

  test('invoking the exit-wait awaits the replay then flushes', async () => {
    // Arrange: get to a replay in flight.
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.recorder.record(snapshot([assistantMsg('a2')]))
    await flush()
    h.writeDeferreds[0]!.resolve(null) // settle #1 → replay (#2) in flight
    await flush()
    expect(h.exitWaits).toHaveLength(1)
    expect(h.flushSpy).not.toHaveBeenCalled()

    // Act: process exit invokes the cleanup while the replay is still pending.
    const exitDone = h.exitWaits[0]!.fn()
    await flush()
    // Flush must NOT have run yet — the replay write hasn't settled.
    expect(h.flushSpy).not.toHaveBeenCalled()

    // Settle the replay write → the cleanup's await resolves → flush runs.
    h.writeDeferreds[1]!.resolve(uuid('a2'))
    await exitDone
    await flush()

    // Assert
    expect(h.flushSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Telemetry (official tengu_transcript_parent_wait)
// ---------------------------------------------------------------------------
describe('CC 2.1.288 #11: tengu_transcript_parent_wait telemetry', () => {
  test('a plain settle reports the official field set', async () => {
    // Arrange
    const h = makeHarness()

    // Act
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.advance(42) // write takes 42ms
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    // Assert
    expect(h.telemetry).toHaveLength(1)
    expect(h.telemetry[0]!.name).toBe(TRANSCRIPT_PARENT_WAIT_EVENT)
    expect(h.telemetry[0]!.name).toBe('tengu_transcript_parent_wait')
    expect(h.telemetry[0]!.metadata).toEqual({
      write_ms: 42,
      snapshots_overtaken: 0,
      exit_waited: false,
      replayed: false,
      write_rejected: false,
    })
  })

  test('a replay settle reports replayed:true and the overtaken count', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.recorder.record(snapshot([assistantMsg('a2')]))
    h.recorder.record(snapshot([assistantMsg('a3')]))
    await flush()
    h.advance(10)
    h.writeDeferreds[0]!.resolve(null)
    await flush()

    // First emission = write #1 settle, which replayed the held snapshot.
    expect(h.telemetry[0]!.metadata).toEqual({
      write_ms: 10,
      snapshots_overtaken: 2,
      exit_waited: false,
      replayed: true,
      write_rejected: false,
    })

    // Settle the replay → a second emission with replayed:false.
    h.writeDeferreds[1]!.resolve(null)
    await flush()
    expect(h.telemetry).toHaveLength(2)
    expect(h.telemetry[1]!.metadata.replayed).toBe(false)
    expect(h.telemetry[1]!.metadata.snapshots_overtaken).toBe(0)
  })

  test('a head reset with a held snapshot emits {cut_short:true, replayed:false}', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')])) // write in flight
    h.recorder.record(snapshot([assistantMsg('a2')])) // held
    await flush()

    // Act: a compaction (head reset) arrives while a snapshot is held.
    h.recorder.record(
      snapshot([compactBoundaryMsg('cb'), userMsg('u1')], { isHeadReset: true }),
    )
    await flush()

    // Assert: the cut_short telemetry fired (exact official 2-field shape).
    const cutShort = h.telemetry.find(t => t.metadata.cut_short === true)
    expect(cutShort?.metadata).toEqual({ cut_short: true, replayed: false })
  })

  test('a rejected write reports write_rejected:true', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    await flush()

    // Act: the write promise rejects.
    h.writeDeferreds[0]!.reject(new Error('disk full'))
    await flush()

    // Assert
    expect(h.telemetry).toHaveLength(1)
    expect(h.telemetry[0]!.metadata.write_rejected).toBe(true)
    expect(h.telemetry[0]!.metadata.replayed).toBe(false)
  })

  test('every emission uses the exact official event name', async () => {
    const h = makeHarness()
    h.recorder.record(snapshot([assistantMsg('a1')]))
    h.recorder.record(snapshot([assistantMsg('a2')]))
    await flush()
    h.writeDeferreds[0]!.resolve(null)
    await flush()
    h.writeDeferreds[1]!.resolve(null)
    await flush()

    expect(h.telemetry.length).toBeGreaterThan(0)
    for (const t of h.telemetry) {
      expect(t.name).toBe('tengu_transcript_parent_wait')
    }
  })
})
