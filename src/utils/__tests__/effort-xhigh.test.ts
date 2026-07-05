import { afterEach, describe, expect, test } from "bun:test";
import {
  EFFORT_LEVELS,
  isEffortLevel,
  modelSupportsXhighEffort,
  resolveAppliedEffort,
} from "../effort";

/**
 * claude-code 2.1.111: `xhigh` effort level between high and max (Opus 4.7);
 * other models fall back to 'high'.
 */
const SAVED = process.env.CLAUDE_CODE_EFFORT_LEVEL;
afterEach(() => {
  if (SAVED === undefined) {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  } else {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = SAVED;
  }
});

describe("2.1.111 xhigh effort level", () => {
  test("EFFORT_LEVELS includes xhigh between high and max", () => {
    expect(EFFORT_LEVELS).toContain("xhigh");
    expect(EFFORT_LEVELS.indexOf("xhigh")).toBeGreaterThan(EFFORT_LEVELS.indexOf("high"));
    expect(EFFORT_LEVELS.indexOf("xhigh")).toBeLessThan(EFFORT_LEVELS.indexOf("max"));
  });

  test("isEffortLevel accepts xhigh", () => {
    expect(isEffortLevel("xhigh")).toBe(true);
  });

  test("modelSupportsXhighEffort is true for opus-4-7, false for others", () => {
    expect(modelSupportsXhighEffort("claude-opus-4-7")).toBe(true);
    expect(modelSupportsXhighEffort("claude-opus-4-6")).toBe(false);
    expect(modelSupportsXhighEffort("claude-sonnet-4-6")).toBe(false);
  });

  test("resolveAppliedEffort keeps xhigh for opus-4-7", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("claude-opus-4-7", "xhigh")).toBe("xhigh");
  });

  test("resolveAppliedEffort downgrades xhigh to high for non-opus-4-7", () => {
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    expect(resolveAppliedEffort("claude-sonnet-4-6", "xhigh")).toBe("high");
    expect(resolveAppliedEffort("claude-opus-4-6", "xhigh")).toBe("high");
  });
});
