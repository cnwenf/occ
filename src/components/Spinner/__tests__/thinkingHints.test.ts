import { describe, expect, test } from "bun:test";
import { THINKING_HINTS, getThinkingHint } from "../thinkingHints";

/**
 * claude-code 2.1.109: rotating thinking hints. Mirrors v109's `QgK` array
 * (14 entries, thresholds 1s..165s) + the "last afterMs <= elapsed" selector.
 */
describe("2.1.109 thinking hints", () => {
  test("the hint array matches v109's 14 entries", () => {
    expect(THINKING_HINTS).toHaveLength(14);
    expect(THINKING_HINTS[0]).toEqual({ afterMs: 1_000, text: "Hmm…" });
    expect(THINKING_HINTS[1]).toEqual({ afterMs: 6_000, text: "This one needs a moment…" });
    expect(THINKING_HINTS[13]).toEqual({ afterMs: 165_000, text: "Still here, still at it…" });
    // thresholds are strictly increasing
    for (let i = 1; i < THINKING_HINTS.length; i++) {
      expect(THINKING_HINTS[i]!.afterMs).toBeGreaterThan(THINKING_HINTS[i - 1]!.afterMs);
    }
  });

  test("returns null before the first threshold (1s)", () => {
    expect(getThinkingHint(0)).toBeNull();
    expect(getThinkingHint(999)).toBeNull();
  });

  test("returns the first hint at exactly 1s", () => {
    expect(getThinkingHint(1_000)).toBe("Hmm…");
  });

  test("returns the last hint whose afterMs <= elapsed", () => {
    expect(getThinkingHint(5_999)).toBe("Hmm…"); // < 6s
    expect(getThinkingHint(6_000)).toBe("This one needs a moment…");
    expect(getThinkingHint(35_999)).toBe("Weighing a few approaches…");
    expect(getThinkingHint(36_000)).toBe("Consulting the rubber duck…");
  });

  test("returns the final hint at/after the last threshold", () => {
    expect(getThinkingHint(165_000)).toBe("Still here, still at it…");
    expect(getThinkingHint(1_000_000)).toBe("Still here, still at it…");
  });
});
