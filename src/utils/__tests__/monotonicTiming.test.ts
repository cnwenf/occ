import { describe, expect, test } from "bun:test";
import { monotonicNowMs } from "../monotonicTiming";

/**
 * Claude Code 2.1.218 #19: "Fixed rare negative or incorrect turn duration
 * measurements after a system clock adjustment by timing turns with a
 * monotonic clock"
 *
 * OCC measured turn durations via `Date.now()` (wall clock), which can move
 * backwards on NTP/manual clock adjustments and yield negative or incorrect
 * durations. The fix: use a monotonic clock (`performance.now()`) for elapsed
 * duration math.
 *
 * Red: before the fix, the elapsed helper delegated to `Date.now()`, so a
 * mocked-backwards wall clock produced a negative elapsed. Green: the helper
 * delegates to `performance.now()`, which is monotonic and immune to wall
 * clock adjustments.
 */

describe("2.1.218 #19: monotonic clock for turn-duration timing", () => {
  test("elapsed stays non-negative when wall clock (Date.now) moves backwards", () => {
    const realDateNow = Date.now;
    const realPerfNow = performance.now;
    let dateValue = 1_000_000;
    try {
      Date.now = () => dateValue;
      performance.now = () => 5000; // monotonic advances independently
      const start = monotonicNowMs();
      // Simulate a system clock adjustment: Date.now() goes backwards.
      dateValue = 900_000;
      const end = monotonicNowMs();
      const elapsed = end - start;
      expect(elapsed).toBeGreaterThanOrEqual(0);
    } finally {
      Date.now = realDateNow;
      performance.now = realPerfNow;
    }
  });

  test("wall-clock diff would be negative but monotonic diff stays correct", () => {
    const realDateNow = Date.now;
    const realPerfNow = performance.now;
    let dateValue = 1_000_000;
    let monoValue = 5000;
    try {
      Date.now = () => dateValue;
      performance.now = () => monoValue;

      const wallStart = Date.now();
      const monoStart = monotonicNowMs();

      // Wall clock jumps backwards (NTP step); monotonic clock keeps advancing.
      dateValue = 900_000;
      monoValue = 6000;

      const wallElapsed = Date.now() - wallStart;
      const monoElapsed = monotonicNowMs() - monoStart;

      expect(wallElapsed).toBe(-100_000); // the bug: negative duration
      expect(monoElapsed).toBe(1000); // monotonic: correct, positive
      expect(monoElapsed).toBeGreaterThan(0);
    } finally {
      Date.now = realDateNow;
      performance.now = realPerfNow;
    }
  });

  test("two sequential reads are monotonically non-decreasing", () => {
    const realPerfNow = performance.now;
    let monoValue = 0;
    try {
      performance.now = () => monoValue;
      const a = monotonicNowMs();
      monoValue = 100;
      const b = monotonicNowMs();
      monoValue = 100;
      const c = monotonicNowMs();
      expect(b).toBeGreaterThanOrEqual(a);
      expect(c).toBeGreaterThanOrEqual(b);
    } finally {
      performance.now = realPerfNow;
    }
  });
});
