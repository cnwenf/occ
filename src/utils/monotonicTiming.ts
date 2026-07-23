/**
 * Monotonic clock for elapsed-duration measurement.
 *
 * Claude Code 2.1.218 #19: "Fixed rare negative or incorrect turn duration
 * measurements after a system clock adjustment by timing turns with a
 * monotonic clock."
 *
 * `Date.now()` (wall clock) can move backwards on NTP/manual clock
 * adjustments, producing negative or incorrect durations. `performance.now()`
 * is monotonic — it never goes backwards and is unaffected by wall-clock
 * adjustments — so it is the correct source for elapsed-time math.
 *
 * Use `monotonicNowMs()` for measuring durations (turn, tool, step).
 * Keep `Date.now()` for timestamp *labeling* (e.g. "when did this turn
 * happen") — never for elapsed-duration computation.
 */

/**
 * Returns a monotonic timestamp in milliseconds, suitable for elapsed-time
 * (duration) math. Guaranteed non-decreasing across calls and unaffected by
 * system clock adjustments. Not comparable to wall-clock time (`Date.now()`).
 */
export function monotonicNowMs(): number {
  return performance.now()
}
