import { withTimeout } from './sleep.js'

/**
 * CC 2.1.299 (#028): bounded debug-log backlog — "Fixed memory growth under
 * heavy debug logging (--debug, --debug-file), and a hang on exit when the
 * debug log is on a disk or network mount that stops accepting writes."
 *
 * Official debug-manager class `Fn` (byte-verified @214763000–214837000
 * region in /tmp/cc-diff-299/v299/package/claude; v296 had NO backlog
 * accounting — unbounded `pendingWrite` chain + unbounded `await
 * this.pendingWrite` in registerCleanup):
 *
 * Constants (verbatim): `On=1048576` (1 MiB backlog cap), `Zi=1e4` (10 s
 * oldest-queued staleness), `Yi=5000` (5 s in-flight append → stuck),
 * `Tn=100` (drain poll ms), `Ji=262144` (per-append chunk merge cap — the
 * OCC async path appends one payload at a time, so no merge constant).
 *
 * Drop rule (verbatim shape, writeBatch non-exit arm):
 *   `s.droppedCount>0 ? s.length>=On/2
 *                      : s.length>=On && Date.now()-oldestQueuedAt>=Zi`
 * — start dropping only when the backlog is over 1 MiB AND the oldest queued
 * chunk has been waiting over 10 s; once dropping, keep dropping until the
 * backlog falls under half the cap (hysteresis).
 *
 * Dropped-note (verbatim `takeDroppedNote()`):
 *   `${ts} [WARN] debug messages not logged: ${n} since the line above,
 *    because writes to this log were over 10 s behind, with over 1 MiB
 *    waiting\n`
 *
 * Non-blocking exit drain (verbatim `drained()`): give up immediately when
 * the in-flight append is stuck; otherwise race the pending chain against a
 * 100 ms poll, looping while the append is not stuck.
 */

/** Official `On` — in-flight append backlog byte cap. */
export const DEBUG_BACKLOG_MAX_BYTES = 1048576

/** Official `Zi` — oldest-queued staleness before dropping starts. */
export const DEBUG_BACKLOG_STALE_MS = 10_000

/** Official `Yi` — in-flight append age that declares the sink stuck. */
export const DEBUG_APPEND_STUCK_MS = 5_000

/** Official `Tn` — drain poll interval / stuck-confirmation delay. */
export const DEBUG_DRAIN_POLL_MS = 100

/** Official `takeDroppedNote()` text (verbatim, timestamped at call). */
export function debugDroppedNote(droppedCount: number): string {
  return `${new Date().toISOString()} [WARN] debug messages not logged: ${droppedCount} since the line above, because writes to this log were over 10 s behind, with over 1 MiB waiting\n`
}

export type DebugBacklogLimiter = {
  /** Official drop rule (hysteresis included). */
  shouldDrop(): boolean
  /** Count a dropped message (official `s.droppedCount+=…`). */
  recordDropped(): void
  /**
   * Account an accepted payload enqueued for append. When no append is
   * in flight the queued append starts immediately (official
   * `e.appendSince=Date.now()` at appendOldest start).
   */
  accept(payloadBytes: number): void
  /**
   * Account an append settling (success or failure). While bytes remain
   * queued the next chained append starts now; otherwise the sink goes
   * idle and stuck detection disarms.
   */
  settle(payloadBytes: number): void
  /** Official `takeDroppedNote()`: WARN note text, resets the count. */
  takeDroppedNote(): string
  /** Official `isAppendStuck()` (single-threshold KISS of suspected→yes). */
  isAppendStuck(): boolean
  getBytes(): number
  getDroppedCount(): number
}

export function createDebugBacklogLimiter(
  now: () => number = Date.now,
): DebugBacklogLimiter {
  let bytes = 0
  let oldestQueuedAt = 0
  let appendSince = 0
  let droppedCount = 0

  return {
    shouldDrop(): boolean {
      return droppedCount > 0
        ? bytes >= DEBUG_BACKLOG_MAX_BYTES / 2
        : bytes >= DEBUG_BACKLOG_MAX_BYTES &&
            oldestQueuedAt !== 0 &&
            now() - oldestQueuedAt >= DEBUG_BACKLOG_STALE_MS
    },
    recordDropped(): void {
      droppedCount++
    },
    accept(payloadBytes: number): void {
      if (oldestQueuedAt === 0) oldestQueuedAt = now()
      bytes += payloadBytes
      if (appendSince === 0) appendSince = now()
    },
    settle(payloadBytes: number): void {
      bytes = Math.max(0, bytes - payloadBytes)
      if (bytes === 0) oldestQueuedAt = 0
      appendSince = bytes > 0 ? now() : 0
    },
    takeDroppedNote(): string {
      if (droppedCount === 0) return ''
      const note = debugDroppedNote(droppedCount)
      droppedCount = 0
      return note
    },
    isAppendStuck(): boolean {
      return appendSince !== 0 && now() - appendSince >= DEBUG_APPEND_STUCK_MS
    },
    getBytes(): number {
      return bytes
    },
    getDroppedCount(): number {
      return droppedCount
    },
  }
}

/**
 * Official `drained()` (KISS port): non-blocking final drain. Returns
 * immediately when the sink is already stuck; otherwise polls `pending`
 * every `pollMs` and gives up as soon as the sink is declared stuck — a
 * dead mount can never hang exit.
 */
export async function drainNonBlocking(
  pending: Promise<void>,
  isStuck: () => boolean,
  pollMs: number = DEBUG_DRAIN_POLL_MS,
): Promise<void> {
  if (isStuck()) return
  // Settle-aware mirror of the raced promise: both fulfillment and
  // rejection count as "drained" (the append chain already swallows errors).
  const settled = pending.then(
    () => true,
    () => true,
  )
  do {
    const drained = await Promise.race([
      settled,
      withTimeout(
        new Promise<false>(() => {}),
        pollMs,
        'debug log drain poll',
      ).catch(() => false),
    ])
    if (drained) return
  } while (!isStuck())
}
