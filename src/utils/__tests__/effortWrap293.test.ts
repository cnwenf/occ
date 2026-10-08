import { describe, expect, test } from "bun:test";
import { cycleEffortLevel } from "../../components/ModelPicker";

/**
 * CC 2.1.293 changelog #7: `/model` effort ←/→ no longer wraps.
 *
 * Official diff (byte-verified via grep -aboF + dd, NEVER executed,
 * /tmp/cc-diff-293/{vprev,vver}/package/claude):
 *   vprev zFe @232902886 (2.1.292):
 *     if(k==="right")return he[(Me+1)%he.length];
 *     else return he[(Me-1+he.length)%he.length]
 *   vver  $0e @234071645 (2.1.293):
 *     if(k==="right")return he[Math.min(Ie+1,he.length-1)];
 *     else return he[Math.max(Ie-1,0)]
 * Sole semantic change: modulo wrap → clamp at both ends (filter, the
 * capability pre-clamp to 'high', and the last-entry resume for a level
 * absent from the ladder are all unchanged).
 *
 * The 292 wrap was a live bug surface: right-arrow at the highest level
 * wrapped to 'low', which the picker could then persist as the model's
 * default effort ("set as default" on the wrapped row).
 */

describe("293 #7: effort cycle clamps at both ends (no modulo wrap)", () => {
  test("at highest level, right arrow stays (full five-level ladder)", () => {
    expect(cycleEffortLevel("max", "right", true, true)).toBe("max");
  });

  test("at lowest level, left arrow stays", () => {
    expect(cycleEffortLevel("low", "left", true, true)).toBe("low");
  });

  test("middle levels still move in both directions (regression)", () => {
    expect(cycleEffortLevel("medium", "right", true, true)).toBe("high");
    expect(cycleEffortLevel("high", "left", true, true)).toBe("medium");
    expect(cycleEffortLevel("high", "right", true, true)).toBe("xhigh");
    expect(cycleEffortLevel("xhigh", "left", true, true)).toBe("high");
    expect(cycleEffortLevel("xhigh", "right", true, true)).toBe("max");
    expect(cycleEffortLevel("max", "left", true, true)).toBe("xhigh");
  });

  test("right-at-lowest still advances (no over-clamping)", () => {
    expect(cycleEffortLevel("low", "right", true, true)).toBe("medium");
  });

  test("clamp holds across includeMax/includeXhigh variants", () => {
    // ladder [low, medium, high, max] (no xhigh)
    expect(cycleEffortLevel("max", "right", true, false)).toBe("max");
    expect(cycleEffortLevel("low", "left", true, false)).toBe("low");
    // ladder [low, medium, high, xhigh] (no max)
    expect(cycleEffortLevel("xhigh", "right", false, true)).toBe("xhigh");
    expect(cycleEffortLevel("low", "left", false, true)).toBe("low");
    // ladder [low, medium, high]
    expect(cycleEffortLevel("high", "right", false, false)).toBe("high");
    expect(cycleEffortLevel("low", "left", false, false)).toBe("low");
  });

  test("clamp holds under a settings cap (267 dt ladder slice)", () => {
    expect(cycleEffortLevel("high", "right", true, true, "high")).toBe("high");
    expect(cycleEffortLevel("low", "left", true, true, "high")).toBe("low");
    expect(cycleEffortLevel("medium", "right", true, true, "medium")).toBe(
      "medium",
    );
  });

  test("over-cap current resumes from the last entry and clamps (no wrap)", () => {
    // 'xhigh' is not in the [low, medium] ladder → resume at last entry
    // 'medium'; 292 wrapped right back to 'low', 293 clamps.
    expect(cycleEffortLevel("xhigh", "right", true, true, "medium")).toBe(
      "medium",
    );
    expect(cycleEffortLevel("xhigh", "left", true, true, "medium")).toBe("low");
  });

  test("capability pre-clamp to 'high' then clamps at the ladder end", () => {
    // 'max'/'xhigh' with neither capability pre-clamps to 'high' (the last
    // entry of [low, medium, high]); 292 wrapped right to 'low', 293 stays.
    expect(cycleEffortLevel("max", "right", false, false)).toBe("high");
    expect(cycleEffortLevel("xhigh", "right", false, false)).toBe("high");
  });

  test("no save-on-wrap: right-at-highest never yields 'low' for any variant", () => {
    // The 292 bug: right-arrow past the top wrapped to 'low', which the
    // picker could persist as the model's default effort. For every
    // capability variant the top of the ladder must be a fixed point.
    const variants = [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const;
    for (const [includeMax, includeXhigh] of variants) {
      const top = includeXhigh
        ? includeMax
          ? "max"
          : "xhigh"
        : includeMax
          ? "max"
          : "high";
      const result = cycleEffortLevel(top, "right", includeMax, includeXhigh);
      expect(result).not.toBe("low");
      expect(result).toBe(top);
    }
  });
});
