/**
 * Stdout backpressure state machine for the renderer write path.
 *
 * Official 2.1.275 changelog #15: "Improved responsiveness when the
 * terminal is slow or output is paused (e.g. Ctrl+S or slow SSH)".
 *
 * BEHAVIORAL PORT — the official v276 implementation replaces
 * `process.stdout.write` with a non-blocking writer over a private
 * O_NONBLOCK fd (`dEr` @202546550, queue/drop/retry-timer machine
 * @202546300-202550000; constants `F=4194304,Q=25,L="\x1B[0m"` @202545120
 * and `Svr=16384,NDn=250` @202551697), ending each backpressure
 * "episode" with `onEpisodeEnd({durationMs,peakQueuedBytes,droppedBytes,
 * endedBy:"drain"|"flush"})` → renderer `handleStdoutBackpressure`
 * @202889122. OCC renders through its own Ink fork on Bun's stream
 * stdout, so instead of hijacking the fd this module observes the
 * stream-level contract: `write()` returning false (backpressure) and
 * the `drain` event (terminal resumed). The observable behavior is the
 * same:
 *
 *   1. write() → false enters the backpressured state; nothing blocks
 *      (no sync retry loop, no event-loop stall).
 *   2. While backpressured with a large backlog (>16 KiB — official
 *      `Svr`), the renderer holds/coalesces frames (see ink.tsx
 *      `frameHeldForBacklog`, official `queuePacedFrame` @202872507).
 *   3. If the stream backlog would exceed 4 MiB (official `F`), frames
 *      are DROPPED instead of buffered: their bytes are counted in
 *      `droppedBytes`, an attribute-reset (`\x1B[0m`, official `L`) is
 *      written so partial frames can't leave stray SGR state, and the
 *      monitor stays in dropping mode until drain.
 *   4. On `drain` the episode ends and the renderer resyncs (probe,
 *      reassert terminal modes, force full redraw) and emits the
 *      `tengu_stdout_backpressure` telemetry when
 *      `droppedBytes > 0 || durationMs >= 1000` (official gate
 *      @202889462).
 *   5. `flush()` mirrors the official exit-path flush (`a()` @202549320,
 *      called from `detachForShutdown`): ends an in-flight episode as
 *      `endedBy: "flush"` so bookkeeping/telemetry still fire at exit.
 *
 * Deviations from the official bytes (documented in the port report):
 *   - The official evicts its OWN queued bytes when the cap trips
 *     (`droppedBytes += queuedBytes + n.length`). A Bun/Node stream's
 *     internal buffer cannot be evicted, so OCC counts the bytes of
 *     frames REFUSED from that point on (dropping mode), preserving the
 *     "stop growing memory, repaint on drain" behavior.
 *   - The official retries with an exponential-backoff timer (cap 25 ms)
 *     because it owns the fd. Here the stream owns flushing and signals
 *     `drain`, so no retry timer is needed at the write level.
 *   - On a stdout `error` the official abandons + restores the original
 *     write (`B()`); OCC disables the monitor and ends the episode as
 *     `flush` (there is no hijacked write to restore).
 */
import { logForDebugging } from 'src/utils/debug.js'

/** Official `Svr=16384` @202551697 — backlog above which frames are held. */
export const FRAME_HOLD_THRESHOLD_BYTES = 16_384

/** Official `NDn=250` @202551697 — held-frame recheck interval. */
export const FRAME_HOLD_RETRY_MS = 250

/** Official `F=4194304` @202545120 — backlog cap; beyond this, drop frames. */
export const MAX_QUEUED_BYTES = 4_194_304

/** Official telemetry gate `durationMs>=1000` (@202889462 region). */
export const TELEMETRY_MIN_DURATION_MS = 1_000

/** Official `L=Buffer.from("\x1B[0m")` @202545120 — reset queued on drop. */
export const BACKPRESSURE_ATTRIBUTE_RESET = '\x1B[0m'

/** Episode summary delivered when backpressure ends (official `T()` payload). */
export type BackpressureEpisodeEnd = {
  durationMs: number
  peakQueuedBytes: number
  droppedBytes: number
  endedBy: 'drain' | 'flush'
}

/** Minimal stdout surface the monitor needs (Node/Bun Writable-compatible). */
export type BackpressureStdout = {
  write(data: string): boolean
  readonly writableLength?: number
  once(event: 'drain' | 'error', listener: () => void): unknown
  off(event: 'drain' | 'error', listener: () => void): unknown
}

/** Write-path gate consumed by `writeDiffToTerminal()` (terminal.ts). */
export type WriteBackpressureGate = {
  /** Returns false when the write must be dropped (bytes counted). */
  admitWrite(byteLength: number): boolean
  /** Records the boolean result of the actual `stdout.write()`. */
  observeWriteResult(ok: boolean): void
}

type Episode = {
  startedMs: number
  peakQueuedBytes: number
  droppedBytes: number
}

/**
 * Tracks stdout backpressure episodes for one stream. One monitor per
 * Ink instance; created in the Ink constructor (official:
 * `this.nonBlockingStdout = dEr(this.handleStdoutBackpressure)`
 * @202863820 region).
 */
export class StdoutBackpressureMonitor implements WriteBackpressureGate {
  private backpressured = false
  private dropping = false
  private disabled = false
  private episode: Episode | null = null

  constructor(
    private readonly stdout: BackpressureStdout,
    private readonly onEpisodeEnd: (episode: BackpressureEpisodeEnd) => void,
  ) {}

  /** True while a backpressure episode is in flight (write returned false). */
  get isBackpressured(): boolean {
    return this.backpressured
  }

  /** True once the backlog cap tripped and frames are being dropped. */
  get isDropping(): boolean {
    return this.dropping
  }

  /** True after a stdout `error` abandoned the monitor (official `B()`). */
  get isDisabled(): boolean {
    return this.disabled
  }

  /** droppedBytes counted so far in the in-flight episode (0 when idle). */
  get currentDroppedBytes(): number {
    return this.episode?.droppedBytes ?? 0
  }

  /** Stream-buffered bytes — OCC analog of official `queuedBytes()`. */
  queuedBytes(): number {
    return this.stdout.writableLength ?? 0
  }

  /**
   * Frame-hold decision for the renderer's paced scheduling — official
   * `queuePacedFrame()` @202872507:
   * `if(this.nonBlockingStdout!==null&&this.nonBlockingStdout.queuedBytes()>Svr)`.
   */
  shouldHoldFrames(): boolean {
    return (
      this.backpressured &&
      !this.disabled &&
      this.queuedBytes() > FRAME_HOLD_THRESHOLD_BYTES
    )
  }

  /**
   * Pre-write admission gate. Returns false (and counts the bytes as
   * dropped) when in dropping mode or when this write would push the
   * backlog past `MAX_QUEUED_BYTES` — official `U()` cap branch:
   * `if(e.queuedBytes+n.length>F){e.episode.droppedBytes+=...;e.dropping=!0;
   * t("nonBlockingStdout: terminal stopped reading; dropped ...")}`.
   */
  admitWrite(byteLength: number): boolean {
    if (!this.backpressured || this.disabled || this.episode === null) {
      return true
    }
    if (this.dropping) {
      this.episode.droppedBytes += byteLength
      return false
    }
    if (this.queuedBytes() + byteLength > MAX_QUEUED_BYTES) {
      this.episode.droppedBytes += byteLength
      this.dropping = true
      // Official queues `L` ("\x1B[0m") when dropping starts so partial
      // frames can't strand the terminal in a stale SGR state.
      try {
        this.stdout.write(BACKPRESSURE_ATTRIBUTE_RESET)
      } catch {
        // A failing reset write must not mask the drop itself.
      }
      logForDebugging(
        `stdoutBackpressure: terminal stopped reading; dropping frames (${this.episode.droppedBytes} bytes refused so far), will repaint when it resumes`,
        { level: 'warn' },
      )
      return false
    }
    return true
  }

  /**
   * Post-write observation. `ok === false` starts an episode (official:
   * the fd write returned EAGAIN/short write → `m()` enqueue + `W()`
   * retry). While an episode runs, tracks the peak backlog.
   */
  observeWriteResult(ok: boolean): void {
    if (this.disabled) return
    if (this.backpressured && this.episode !== null) {
      const queued = this.queuedBytes()
      if (queued > this.episode.peakQueuedBytes) {
        this.episode.peakQueuedBytes = queued
      }
    }
    if (!ok && !this.backpressured) {
      this.enterBackpressure()
    }
  }

  private enterBackpressure(): void {
    this.backpressured = true
    this.dropping = false
    this.episode = {
      startedMs: performance.now(),
      peakQueuedBytes: this.queuedBytes(),
      droppedBytes: 0,
    }
    logForDebugging(
      'stdoutBackpressure: active (stdout write returned false; coalescing frames until drain)',
    )
    this.stdout.once('drain', this.handleDrain)
    this.stdout.once('error', this.handleError)
  }

  private handleDrain = (): void => {
    this.endEpisode('drain')
  }

  /** Official `B()` abandon: stop monitoring, end the episode. */
  private handleError = (): void => {
    this.disabled = true
    this.endEpisode('flush')
  }

  /**
   * Exit-path flush — official `a()` (called from `detachForShutdown`
   * via `this.nonBlockingStdout?.flush()`): end an in-flight episode as
   * `endedBy: "flush"`. Stream-buffered bytes themselves are the
   * stream's (and `drainStdoutBeforeExit`'s) responsibility.
   */
  flush(): void {
    if (this.backpressured) {
      this.endEpisode('flush')
    }
  }

  /**
   * Teardown without firing `onEpisodeEnd` (post-unmount). Any pending
   * listeners are removed so a late `drain` can't touch a dead renderer.
   */
  detach(): void {
    this.removeListeners()
    this.backpressured = false
    this.dropping = false
    this.episode = null
  }

  private removeListeners(): void {
    try {
      this.stdout.off('drain', this.handleDrain)
      this.stdout.off('error', this.handleError)
    } catch {
      // Streams without full EventEmitter semantics — nothing to remove.
    }
  }

  private endEpisode(endedBy: 'drain' | 'flush'): void {
    const episode = this.episode
    this.backpressured = false
    this.dropping = false
    this.episode = null
    this.removeListeners()
    if (episode === null) return
    try {
      this.onEpisodeEnd({
        durationMs: Math.round(performance.now() - episode.startedMs),
        peakQueuedBytes: episode.peakQueuedBytes,
        droppedBytes: episode.droppedBytes,
        endedBy,
      })
    } catch (err) {
      // Official `T()` wraps onEpisodeEnd in try/catch and reports — a
      // throwing handler must never kill the write path.
      logForDebugging(`stdoutBackpressure: episode handler threw (${String(err)})`, {
        level: 'warn',
      })
    }
  }
}

/**
 * Enablement gate — official `pEr({envOverride:CLAUDE_CODE_NONBLOCKING_STDOUT,
 * isAnt:false, remoteFlag:tengu_event_loop_stall})` @202863820 region:
 * `return e ?? (n || o())`. OCC has no remote-flag infrastructure, so the
 * default is TTY-only (official `D()` refuses non-TTY with
 * `{reason:"not_a_tty"}`) and the official env var overrides both ways.
 */
export function shouldEnableStdoutBackpressure(stdout: {
  isTTY?: boolean | undefined
}): boolean {
  const override = process.env.CLAUDE_CODE_NONBLOCKING_STDOUT
  if (override !== undefined && override !== '') {
    return ['1', 'true', 'yes', 'on'].includes(override.toLowerCase().trim())
  }
  return !!stdout.isTTY
}
