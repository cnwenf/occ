/**
 * CC 2.1.275 changelog #15 — "Improved responsiveness when the terminal
 * is slow or output is paused (e.g. Ctrl+S or slow SSH)".
 *
 * Behavioral-port tests for the stdout backpressure state machine:
 *   - src/ink/stdout-backpressure.ts  (StdoutBackpressureMonitor, gate)
 *   - src/ink/terminal.ts             (writeDiffToTerminal gate + return)
 *   - src/ink/terminal-querier.ts     (resync/owed/barrier)
 *   - src/ink/ink.tsx                 (frameHeldForBacklog coalescing,
 *                                      handleStdoutBackpressure episode-end,
 *                                      tengu_stdout_backpressure telemetry)
 *
 * Official v276 binary markers mirrored (offsets in the port report):
 *   handleStdoutBackpressure @202889122, frameHeldForBacklog @202872507,
 *   tengu_stdout_backpressure @202889462, F/Q/L @202545120,
 *   Svr/NDn @202551697, querier.resync @202543231.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import React from 'react'
import Box from '../components/Box.js'
import Text from '../components/Text.js'
import type { Diff } from '../frame.js'
import Ink from '../ink.js'
import {
  BACKPRESSURE_ATTRIBUTE_RESET,
  FRAME_HOLD_THRESHOLD_BYTES,
  MAX_QUEUED_BYTES,
  StdoutBackpressureMonitor,
  shouldEnableStdoutBackpressure,
  type BackpressureEpisodeEnd,
} from '../stdout-backpressure.js'
import { writeDiffToTerminal, type Terminal } from '../terminal.js'
import { TerminalQuerier, decrqm } from '../terminal-querier.js'
import { BSU, ESU } from '../termio/dec.js'
import { CURSOR_HOME, ERASE_SCREEN } from '../termio/csi.js'
import type { TerminalResponse } from '../parse-keypress.js'

// ── Helpers ────────────────────────────────────────────────────────────

type MockStdout = NodeJS.WriteStream & {
  writes: string[]
  writeReturn: boolean
  writableLength: number
}

function makeMockStdout(opts: { isTTY?: boolean } = {}): MockStdout {
  const emitter = new EventEmitter() as EventEmitter & {
    columns: number
    rows: number
    isTTY: boolean
    writes: string[]
    writeReturn: boolean
    writableLength: number
    write: (chunk: string) => boolean
  }
  emitter.columns = 80
  emitter.rows = 24
  // isTTY default false: skips the constructor's resize/SIGCONT listener
  // registration and unmount()'s writeSync(1) cleanup block, keeping the
  // instance hermetic (same pattern as nativeCursorSeq.test.ts). Tests
  // that need forceRedraw()/reassertTerminalModes() opt into isTTY=true.
  emitter.isTTY = opts.isTTY ?? false
  emitter.writes = []
  emitter.writeReturn = true
  emitter.writableLength = 0
  emitter.write = (chunk: string): boolean => {
    emitter.writes.push(String(chunk))
    return emitter.writeReturn
  }
  return emitter as unknown as MockStdout
}

function makeMockStdin(): NodeJS.ReadStream {
  const emitter = new EventEmitter() as EventEmitter & {
    isTTY: boolean
    setEncoding: () => void
    setRawMode: () => void
    resume: () => void
    pause: () => void
    read: () => null
    unref: () => void
    ref: () => void
  }
  emitter.isTTY = false
  emitter.setEncoding = (): void => {}
  emitter.setRawMode = (): void => {}
  emitter.resume = (): void => {}
  emitter.pause = (): void => {}
  emitter.read = (): null => null
  emitter.unref = (): void => {}
  emitter.ref = (): void => {}
  return emitter as unknown as NodeJS.ReadStream
}

type TelemetryEvent = {
  duration_ms: number
  peak_queued_bytes: number
  dropped_bytes: number
}

function makeInk(
  opts: { isTTY?: boolean; attachMonitor?: boolean } = {},
): {
  ink: Ink
  stdout: MockStdout
  telemetry: TelemetryEvent[]
} {
  const stdout = makeMockStdout({ isTTY: opts.isTTY })
  const ink = new Ink({
    stdout,
    stdin: makeMockStdin(),
    stderr: makeMockStdout(),
    exitOnCtrlC: false,
    patchConsole: false,
    isScreenReaderEnabled: false,
  })
  // Official 2.1.276 identity gate (`n.stdout===process.stdout`, enforced
  // inside shouldEnableStdoutBackpressure): a mock stdout never passes, so
  // the constructor no longer attaches a monitor even with the env override
  // set or isTTY:true. These integration suites exercise the renderer ↔
  // monitor cooperation, so inject the exact monitor instance the
  // constructor would create in production (test seam). The constructor
  // gate itself is asserted in the `gate:` test below.
  if (opts.attachMonitor !== false) {
    const seam = ink as unknown as {
      nonBlockingStdout: StdoutBackpressureMonitor | null
      handleStdoutBackpressure: (episode: BackpressureEpisodeEnd) => void
    }
    seam.nonBlockingStdout = new StdoutBackpressureMonitor(
      stdout,
      seam.handleStdoutBackpressure,
    )
  }
  const telemetry: TelemetryEvent[] = []
  // Per-instance telemetry capture — avoids polluting the global analytics
  // sink queue (src/services/analytics) across test files.
  ink.emitBackpressureTelemetry = (m: TelemetryEvent): void => {
    telemetry.push(m)
  }
  return { ink, stdout, telemetry }
}

/** Accessor for Ink's private paced scheduler (throttled deferredRender). */
function pacedScheduleRender(ink: Ink): void {
  const schedule = (ink as unknown as { scheduleRender: () => void })
    .scheduleRender
  schedule()
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const tree = (label: string): React.ReactNode =>
  React.createElement(Box, null, React.createElement(Text, null, label))

const ENV_KEY = 'CLAUDE_CODE_NONBLOCKING_STDOUT'
let savedEnvKey: string | undefined
let envKeyWasSet = false

beforeEach(() => {
  envKeyWasSet = ENV_KEY in process.env
  savedEnvKey = process.env[ENV_KEY]
  // 2.1.276: the env override can no longer force-enable the monitor on a
  // mock stream (identity gate refuses non-process.stdout; makeInk injects
  // the monitor directly instead). Keep the env clean so the gate/unit
  // tests below flip it deterministically.
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (envKeyWasSet) process.env[ENV_KEY] = savedEnvKey
  else delete process.env[ENV_KEY]
})

// ── Suite A: StdoutBackpressureMonitor unit ────────────────────────────

describe('StdoutBackpressureMonitor (official nonBlockingStdout episode machine)', () => {
  function setup(): {
    stdout: MockStdout
    monitor: StdoutBackpressureMonitor
    episodes: BackpressureEpisodeEnd[]
  } {
    const stdout = makeMockStdout()
    const episodes: BackpressureEpisodeEnd[] = []
    const monitor = new StdoutBackpressureMonitor(stdout, e => episodes.push(e))
    return { stdout, monitor, episodes }
  }

  test('stays idle while writes succeed — no episode, admit always true', () => {
    const { monitor, episodes } = setup()
    expect(monitor.isBackpressured).toBe(false)
    expect(monitor.admitWrite(1000)).toBe(true)
    monitor.observeWriteResult(true)
    expect(monitor.isBackpressured).toBe(false)
    expect(episodes.length).toBe(0)
  })

  test('write() returning false enters backpressure without blocking; drain ends the episode', () => {
    const { stdout, monitor, episodes } = setup()
    const t0 = Date.now()
    stdout.writeReturn = false
    // observeWriteResult must return synchronously — no retry loop, no
    // event-loop stall (the official port's core responsiveness promise).
    monitor.observeWriteResult(false)
    expect(Date.now() - t0).toBeLessThan(50)
    expect(monitor.isBackpressured).toBe(true)
    stdout.emit('drain')
    expect(episodes.length).toBe(1)
    expect(episodes[0]!.endedBy).toBe('drain')
    expect(episodes[0]!.droppedBytes).toBe(0)
    expect(typeof episodes[0]!.durationMs).toBe('number')
    expect(monitor.isBackpressured).toBe(false)
  })

  test('shouldHoldFrames mirrors official queuedBytes()>Svr gate (16384)', () => {
    const { stdout, monitor } = setup()
    expect(monitor.shouldHoldFrames()).toBe(false)
    monitor.observeWriteResult(false)
    stdout.writableLength = FRAME_HOLD_THRESHOLD_BYTES // 16384 — NOT above
    expect(monitor.shouldHoldFrames()).toBe(false)
    stdout.writableLength = FRAME_HOLD_THRESHOLD_BYTES + 1
    expect(monitor.shouldHoldFrames()).toBe(true)
    stdout.emit('drain')
    expect(monitor.shouldHoldFrames()).toBe(false)
  })

  test('admitWrite drops frames past the 4 MiB cap, writes the attribute reset once, counts droppedBytes', () => {
    const { stdout, monitor, episodes } = setup()
    monitor.observeWriteResult(false)
    stdout.writableLength = MAX_QUEUED_BYTES
    expect(monitor.admitWrite(10)).toBe(false)
    expect(monitor.isDropping).toBe(true)
    // Official L = Buffer.from("\x1B[0m") queued when dropping starts.
    expect(stdout.writes).toEqual([BACKPRESSURE_ATTRIBUTE_RESET])
    // Dropping mode persists until drain; no second reset write.
    expect(monitor.admitWrite(5)).toBe(false)
    expect(stdout.writes.length).toBe(1)
    expect(monitor.currentDroppedBytes).toBe(15)
    stdout.emit('drain')
    expect(episodes[0]!.droppedBytes).toBe(15)
    expect(monitor.isDropping).toBe(false)
  })

  test('admitWrite admits while under the cap and trips exactly at cap overflow', () => {
    const { stdout, monitor } = setup()
    monitor.observeWriteResult(false)
    stdout.writableLength = MAX_QUEUED_BYTES - 100
    // (MAX-100) + 50 ≤ MAX → admitted, no dropping mode.
    expect(monitor.admitWrite(50)).toBe(true)
    expect(monitor.isDropping).toBe(false)
    // (MAX-100) + 200 > MAX → refused, dropping mode engaged.
    expect(monitor.admitWrite(200)).toBe(false)
    expect(monitor.isDropping).toBe(true)
    stdout.emit('drain')
  })

  test('peakQueuedBytes tracks the maximum backlog during the episode', () => {
    const { stdout, monitor, episodes } = setup()
    stdout.writableLength = 1000
    monitor.observeWriteResult(false)
    stdout.writableLength = 5000
    monitor.observeWriteResult(false) // still one episode, peak updates
    stdout.writableLength = 3000
    monitor.observeWriteResult(true)
    stdout.emit('drain')
    expect(episodes.length).toBe(1)
    expect(episodes[0]!.peakQueuedBytes).toBe(5000)
  })

  test('flush() ends an in-flight episode as endedBy:"flush" (official exit path)', () => {
    const { monitor, episodes } = setup()
    monitor.observeWriteResult(false)
    monitor.flush()
    expect(episodes.length).toBe(1)
    expect(episodes[0]!.endedBy).toBe('flush')
    expect(monitor.isBackpressured).toBe(false)
    // Idempotent: a second flush with no episode does nothing.
    monitor.flush()
    expect(episodes.length).toBe(1)
  })

  test('stdout error disables the monitor and ends the episode (official B() abandon)', () => {
    const { stdout, monitor, episodes } = setup()
    monitor.observeWriteResult(false)
    stdout.emit('error', new Error('EIO'))
    expect(episodes.length).toBe(1)
    expect(episodes[0]!.endedBy).toBe('flush')
    expect(monitor.isDisabled).toBe(true)
    // Disabled: further false writes never start a new episode.
    monitor.observeWriteResult(false)
    expect(episodes.length).toBe(1)
    expect(monitor.isBackpressured).toBe(false)
  })

  test('a throwing episode handler never kills the write path', () => {
    const stdout = makeMockStdout()
    const monitor = new StdoutBackpressureMonitor(stdout, () => {
      throw new Error('handler boom')
    })
    monitor.observeWriteResult(false)
    expect(() => stdout.emit('drain')).not.toThrow()
    expect(monitor.isBackpressured).toBe(false)
  })

  test('detach() removes listeners so a late drain cannot fire the handler', () => {
    const { stdout, monitor, episodes } = setup()
    monitor.observeWriteResult(false)
    monitor.detach()
    stdout.emit('drain')
    expect(episodes.length).toBe(0)
  })

  test('a second drain after the episode ended is a no-op', () => {
    const { stdout, monitor, episodes } = setup()
    monitor.observeWriteResult(false)
    stdout.emit('drain')
    stdout.emit('drain')
    expect(episodes.length).toBe(1)
  })

  test('shouldEnableStdoutBackpressure: on process.stdout, env override wins, else TTY default', () => {
    // Identity holds (process.stdout) → the official pEr({envOverride,...})
    // semantics apply: env override wins, otherwise the TTY default.
    process.env[ENV_KEY] = '1'
    expect(shouldEnableStdoutBackpressure(process.stdout)).toBe(true)
    process.env[ENV_KEY] = 'TRUE'
    expect(shouldEnableStdoutBackpressure(process.stdout)).toBe(true)
    process.env[ENV_KEY] = '0'
    expect(shouldEnableStdoutBackpressure(process.stdout)).toBe(false)
    delete process.env[ENV_KEY]
    expect(shouldEnableStdoutBackpressure(process.stdout)).toBe(
      !!process.stdout.isTTY,
    )
  })

  test('shouldEnableStdoutBackpressure: non-process.stdout refused even with isTTY:true + env override (2.1.276 identity gate)', () => {
    // df-04 probe: official constructor gate checks `n.stdout===process.stdout`
    // FIRST — embedded/test-stub streams must never be attached to a
    // frame-dropping monitor, whatever the env override or isTTY claim.
    process.env[ENV_KEY] = '1'
    expect(shouldEnableStdoutBackpressure({ isTTY: true })).toBe(false)
    expect(shouldEnableStdoutBackpressure(makeMockStdout({ isTTY: true }))).toBe(
      false,
    )
    delete process.env[ENV_KEY]
    expect(shouldEnableStdoutBackpressure({ isTTY: true })).toBe(false)
    expect(shouldEnableStdoutBackpressure({ isTTY: false })).toBe(false)
    expect(shouldEnableStdoutBackpressure({})).toBe(false)
  })
})

// ── Suite B: writeDiffToTerminal gate ──────────────────────────────────

describe('writeDiffToTerminal backpressure gate', () => {
  const diff: Diff = [{ type: 'stdout', content: 'hello' }]

  function terminalWith(stdout: MockStdout): Terminal {
    return { stdout, stderr: makeMockStdout() }
  }

  test('without a gate the legacy path is byte-identical (BSU + content + ESU)', () => {
    const stdout = makeMockStdout()
    const ok = writeDiffToTerminal(terminalWith(stdout), diff)
    expect(ok).toBe(true)
    expect(stdout.writes).toEqual([BSU + 'hello' + ESU])
  })

  test('empty diff writes nothing and returns false', () => {
    const stdout = makeMockStdout()
    const admitted: number[] = []
    const ok = writeDiffToTerminal(terminalWith(stdout), [], false, {
      admitWrite: (n: number) => {
        admitted.push(n)
        return true
      },
      observeWriteResult: () => {},
    })
    expect(ok).toBe(false)
    expect(stdout.writes.length).toBe(0)
    expect(admitted.length).toBe(0)
  })

  test('gate admits: buffer length is passed, write result is observed', () => {
    const stdout = makeMockStdout()
    const admitted: number[] = []
    const observed: boolean[] = []
    const ok = writeDiffToTerminal(terminalWith(stdout), diff, false, {
      admitWrite: (n: number) => {
        admitted.push(n)
        return true
      },
      observeWriteResult: (r: boolean) => observed.push(r),
    })
    expect(ok).toBe(true)
    expect(admitted).toEqual([(BSU + 'hello' + ESU).length])
    expect(observed).toEqual([true])
    expect(stdout.writes).toEqual([BSU + 'hello' + ESU])
  })

  test('gate refuses: frame is dropped, nothing reaches the stream', () => {
    const stdout = makeMockStdout()
    const observed: boolean[] = []
    const ok = writeDiffToTerminal(terminalWith(stdout), diff, false, {
      admitWrite: () => false,
      observeWriteResult: (r: boolean) => observed.push(r),
    })
    expect(ok).toBe(false)
    expect(stdout.writes.length).toBe(0)
    expect(observed.length).toBe(0)
  })

  test('write() returning false is reported to the gate and the caller', () => {
    const stdout = makeMockStdout()
    stdout.writeReturn = false
    const observed: boolean[] = []
    const ok = writeDiffToTerminal(terminalWith(stdout), diff, false, {
      admitWrite: () => true,
      observeWriteResult: (r: boolean) => observed.push(r),
    })
    expect(ok).toBe(false)
    expect(observed).toEqual([false])
    // The frame WAS handed to the stream (buffered there) — only the
    // signal is false.
    expect(stdout.writes).toEqual([BSU + 'hello' + ESU])
  })
})

// ── Suite C: TerminalQuerier resync / owed / barrier ───────────────────

describe('TerminalQuerier resync (official @202543231)', () => {
  const DA1: TerminalResponse = { type: 'da1', params: [64] }
  const SENTINEL_SEQ = '\x1b[c' // csi('c')

  function querierWith(stdout: MockStdout): TerminalQuerier {
    return new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)
  }

  test('owed() counts pending queries and sentinels; da1 drain clears them', async () => {
    const stdout = makeMockStdout()
    const q = querierWith(stdout)
    expect(q.owed()).toBe(0)
    const p = q.send(decrqm(2026))
    const f = q.flush()
    expect(q.owed()).toBe(2)
    q.onResponse(DA1)
    await expect(p).resolves.toBeUndefined() // no decrpm before da1 → unsupported
    await f
    expect(q.owed()).toBe(0)
  })

  test('resync({probe:false}) resolves all pending without writing a sentinel', async () => {
    const stdout = makeMockStdout()
    const q = querierWith(stdout)
    const p = q.send(decrqm(2026))
    const f = q.flush()
    q.resync({ probe: false })
    await expect(p).resolves.toBeUndefined()
    await f
    expect(q.owed()).toBe(0)
    // Only the query request + flush sentinel already written — no extra.
    expect(stdout.writes.filter(w => w === SENTINEL_SEQ).length).toBe(1)
  })

  test('resync({probe:true}) writes a DA1 sentinel and swallows responses until it returns', async () => {
    const stdout = makeMockStdout()
    const q = querierWith(stdout)
    const stale = q.send(decrqm(2026))
    q.resync({ probe: true })
    await expect(stale).resolves.toBeUndefined()
    expect(stdout.writes.at(-1)).toBe(SENTINEL_SEQ)

    // Barrier installed: a stale response matching a NEW query must be
    // swallowed while the barrier is at the front.
    const fresh = q.send(decrqm(2027))
    const staleDecrpm = { type: 'decrpm', mode: 2027, status: 2 } as unknown as TerminalResponse
    q.onResponse(staleDecrpm) // arrives BEFORE the barrier's da1 → swallowed
    let settled = false
    void fresh.then(() => {
      settled = true
    })
    await sleep(5)
    expect(settled).toBe(false)

    // The barrier's own DA1 reply clears it…
    q.onResponse(DA1)
    // …and post-resync responses now resolve normally.
    q.onResponse(staleDecrpm)
    await expect(fresh).resolves.toMatchObject({ type: 'decrpm', mode: 2027 })
  })

  test('resync({probe:true}) skips the sentinel while input is detached', () => {
    const stdout = makeMockStdout()
    const q = querierWith(stdout)
    q.isInputAttached = false
    void q.send(decrqm(2026))
    const before = stdout.writes.length
    q.resync({ probe: true })
    expect(stdout.writes.length).toBe(before) // no barrier write
  })

  test('regression: normal match-before-sentinel flow still resolves with the response', async () => {
    const stdout = makeMockStdout()
    const q = querierWith(stdout)
    const p = q.send(decrqm(2026))
    const response = { type: 'decrpm', mode: 2026, status: 1 } as unknown as TerminalResponse
    q.onResponse(response)
    await expect(p).resolves.toMatchObject({ type: 'decrpm', mode: 2026 })
    expect(q.owed()).toBe(0)
  })
})

// ── Suite D: Ink integration ───────────────────────────────────────────

describe('Ink stdout backpressure integration (2.1.275 #15)', () => {
  const liveInks: Ink[] = []

  function tracked(
    opts: { isTTY?: boolean; attachMonitor?: boolean } = {},
  ): {
    ink: Ink
    stdout: MockStdout
    telemetry: TelemetryEvent[]
  } {
    const made = makeInk(opts)
    liveInks.push(made.ink)
    return made
  }

  afterEach(() => {
    while (liveInks.length > 0) {
      const ink = liveInks.pop()
      try {
        ink?.unmount()
      } catch {
        // already unmounted
      }
    }
  })

  test('gate: identity — a non-process.stdout stream never gets a constructor-attached monitor', () => {
    // Official 2.1.276 constructor gate @202863820:
    // `n.stdout===process.stdout&&(SPt()||pEr({envOverride:
    // CLAUDE_CODE_NONBLOCKING_STDOUT,...}))` — identity is checked FIRST,
    // so a mock stream is refused with the env override on, with isTTY:true,
    // and with both. (The env/TTY semantics for the real process.stdout are
    // covered by the shouldEnableStdoutBackpressure unit tests above; the
    // renderer↔monitor cooperation is covered here via makeInk's injected
    // monitor seam.)
    process.env[ENV_KEY] = '1'
    expect(tracked({ attachMonitor: false }).ink.stdoutBackpressure).toBeNull()
    expect(
      tracked({ isTTY: true, attachMonitor: false }).ink.stdoutBackpressure,
    ).toBeNull()
    process.env[ENV_KEY] = '0'
    expect(
      tracked({ isTTY: true, attachMonitor: false }).ink.stdoutBackpressure,
    ).toBeNull()
    delete process.env[ENV_KEY]
    expect(
      tracked({ isTTY: true, attachMonitor: false }).ink.stdoutBackpressure,
    ).toBeNull()
  })

  test('normal writes: zero behavior change — frame written, no episode, no telemetry', async () => {
    const { ink, stdout, telemetry } = tracked()
    ink.render(tree('hello-normal'))
    await sleep(30)
    expect(stdout.writes.join('')).toContain('hello-normal')
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(false)
    expect(ink.heldFramesCount).toBe(0)
    expect(telemetry.length).toBe(0)
  })

  test('write() returning false puts the renderer in backpressured state (no blocking)', async () => {
    const { ink, stdout } = tracked()
    stdout.writeReturn = false
    const t0 = Date.now()
    ink.render(tree('slow-terminal'))
    await sleep(30)
    // The render call itself never blocked on the slow stream.
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(true)
    // The frame was still handed to the stream (it buffers).
    expect(stdout.writes.join('')).toContain('slow-terminal')
  })

  test('frames held while backpressured with a big backlog; drain releases the coalesced frame', async () => {
    const { ink, stdout, telemetry } = tracked()
    stdout.writeReturn = false
    ink.render(tree('frame-a'))
    await sleep(30)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(true)
    const writesAfterFirst = stdout.writes.length

    // Backlog grows past the hold threshold (official Svr=16384).
    stdout.writableLength = FRAME_HOLD_THRESHOLD_BYTES + 1
    pacedScheduleRender(ink)
    await sleep(30)
    expect(ink.isFrameHeldForBacklog).toBe(true)
    expect(ink.heldFramesCount).toBeGreaterThanOrEqual(1)
    expect(stdout.writes.length).toBe(writesAfterFirst) // nothing painted

    // The 250ms retry timer (official NDn) rechecks and re-holds.
    await sleep(320)
    expect(ink.isFrameHeldForBacklog).toBe(true)
    expect(ink.heldFramesCount).toBeGreaterThanOrEqual(2)
    expect(stdout.writes.length).toBe(writesAfterFirst)

    // Terminal resumes → drain: held flag clears, paced render is
    // rescheduled (official scheduleFrame), no drops → no telemetry.
    stdout.writeReturn = true
    stdout.writableLength = 0
    stdout.emit('drain')
    await sleep(50)
    expect(ink.isFrameHeldForBacklog).toBe(false)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(false)
    expect(telemetry.length).toBe(0) // droppedBytes=0 && durationMs<1000
  })

  test('drain after drops: resync probe, mode reassert, full redraw of the LATEST frame, telemetry', async () => {
    // isTTY=true so forceRedraw()/reassertTerminalModes() are not skipped.
    const { ink, stdout, telemetry } = tracked({ isTTY: true })
    const querier = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)
    ink.attachQuerier(querier)

    stdout.writeReturn = false
    ink.render(tree('drop-old'))
    await sleep(30)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(true)

    // A pending query must be resolved by the drain resync (probe).
    const pendingQuery = querier.send(decrqm(2026))

    // Backlog hits the 4 MiB cap → the next frame is DROPPED.
    stdout.writableLength = MAX_QUEUED_BYTES
    ink.render(tree('drop-new'))
    // Drive the paint directly as well: under NODE_ENV=test the reconciler
    // commits via onImmediateRender (synchronous onRender), but in paced
    // mode deferredRender would HOLD this frame (backlog > 16 KiB) instead
    // of reaching the drop gate. The direct call makes the drop path
    // deterministic in both scheduling modes (2nd call is an empty-diff
    // no-op in test mode).
    ;(ink as unknown as { onRender: () => void }).onRender()
    await sleep(30)
    expect(stdout.writes.join('')).not.toContain('drop-new')
    expect(stdout.writes).toContain(BACKPRESSURE_ATTRIBUTE_RESET)

    // Terminal resumes.
    stdout.writeReturn = true
    stdout.writableLength = 0
    stdout.emit('drain')
    await sleep(50)

    // Official handleStdoutBackpressure @202889122: droppedBytes>0 &&
    // drain → querier.resync({probe:true}) + reassertTerminalModes() +
    // forceRedraw().
    await expect(pendingQuery).resolves.toBeUndefined()
    expect(stdout.writes).toContain('\x1b[c') // resync DA1 probe sentinel
    expect(stdout.writes).toContain(ERASE_SCREEN + CURSOR_HOME) // forceRedraw
    // The full repaint carries the LATEST content — the dropped frame.
    const afterDrain = stdout.writes.join('')
    expect(afterDrain).toContain('drop-new')

    // Telemetry gate: droppedBytes>0 → tengu_stdout_backpressure fires.
    expect(telemetry.length).toBe(1)
    expect(telemetry[0]!.dropped_bytes).toBeGreaterThan(0)
    expect(telemetry[0]!.peak_queued_bytes).toBeGreaterThanOrEqual(0)
    expect(typeof telemetry[0]!.duration_ms).toBe('number')
  })

  test('telemetry gate: fires on durationMs>=1000 without drops, silent below', async () => {
    const { ink, telemetry } = tracked()
    const handler = (
      ink as unknown as {
        handleStdoutBackpressure: (e: BackpressureEpisodeEnd) => void
      }
    ).handleStdoutBackpressure

    handler({ durationMs: 999, peakQueuedBytes: 10, droppedBytes: 0, endedBy: 'drain' })
    expect(telemetry.length).toBe(0)

    handler({ durationMs: 1000, peakQueuedBytes: 10, droppedBytes: 0, endedBy: 'drain' })
    expect(telemetry.length).toBe(1)
    expect(telemetry[0]).toEqual({
      duration_ms: 1000,
      peak_queued_bytes: 10,
      dropped_bytes: 0,
    })

    handler({ durationMs: 5, peakQueuedBytes: 99, droppedBytes: 7, endedBy: 'flush' })
    expect(telemetry.length).toBe(2)
    expect(telemetry[1]).toEqual({
      duration_ms: 5,
      peak_queued_bytes: 99,
      dropped_bytes: 7,
    })
  })

  test('drainStdin resolves in-flight querier promises without probing (official owed()>0 → resync({probe:false}))', async () => {
    const { ink, stdout } = tracked()
    const querier = new TerminalQuerier(stdout as unknown as NodeJS.WriteStream)
    ink.attachQuerier(querier)
    const pending = querier.send(decrqm(2026))
    expect(querier.owed()).toBe(1)
    const writesBefore = stdout.writes.length
    ink.drainStdin()
    await expect(pending).resolves.toBeUndefined()
    expect(querier.owed()).toBe(0)
    // probe:false → no barrier sentinel written.
    expect(stdout.writes.length).toBe(writesBefore)
  })

  test('unmount flushes an in-flight episode (exit path intact, no telemetry for a fast clean episode)', async () => {
    const { ink, stdout, telemetry } = tracked()
    stdout.writeReturn = false
    ink.render(tree('exit-mid-episode'))
    await sleep(30)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(true)
    ink.unmount()
    await sleep(10)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(false)
    expect(telemetry.length).toBe(0) // droppedBytes=0, durationMs<1000
    liveInks.length = 0 // already unmounted
  })

  test('detachForShutdown flushes and detaches the monitor first (official nonBlockingStdout?.flush())', async () => {
    const { ink, stdout } = tracked()
    stdout.writeReturn = false
    ink.render(tree('shutdown-mid-episode'))
    await sleep(30)
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(true)
    ink.detachForShutdown()
    expect(ink.stdoutBackpressure?.isBackpressured).toBe(false)
    expect(ink.stdoutBackpressure?.isDisabled).toBe(false)
    // A late drain must not touch the detached renderer.
    expect(() => stdout.emit('drain')).not.toThrow()
  })
})
