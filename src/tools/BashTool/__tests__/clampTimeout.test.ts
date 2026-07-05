import { describe, expect, test } from "bun:test";
import { clampTimeoutMs, getMaxTimeoutMs } from "../prompt";

/**
 * claude-code 2.1.110: Bash tool enforces the documented maximum timeout
 * instead of accepting arbitrarily large values.
 */
describe("2.1.110 clampTimeoutMs", () => {
  const DEFAULT = 120_000;
  const MAX = getMaxTimeoutMs();

  test("falls back to default when no timeout is provided", () => {
    expect(clampTimeoutMs(undefined, DEFAULT, MAX)).toBe(DEFAULT);
  });

  test("falls back to default for a 0 (falsy) timeout", () => {
    expect(clampTimeoutMs(0, DEFAULT, MAX)).toBe(DEFAULT);
  });

  test("accepts a valid in-range timeout", () => {
    expect(clampTimeoutMs(5_000, DEFAULT, MAX)).toBe(5_000);
    expect(clampTimeoutMs(MAX, DEFAULT, MAX)).toBe(MAX);
  });

  test("clamps an arbitrarily large timeout down to the max", () => {
    expect(clampTimeoutMs(9_999_999_999, DEFAULT, MAX)).toBe(MAX);
    expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER, DEFAULT, MAX)).toBe(MAX);
  });

  test("the documented max is a positive finite number", () => {
    expect(Number.isFinite(MAX)).toBe(true);
    expect(MAX).toBeGreaterThan(0);
  });
});
