import { describe, expect, test } from "bun:test";
import {
  getMemoryCharThreshold,
  MIN_MEMORY_CHARACTER_COUNT,
} from "../memoryThreshold.js";

// 2.1.169 (J14): the CLAUDE.md "too long" threshold must scale with the active
// model's context window — larger context → larger threshold, floored at 40k.
describe("getMemoryCharThreshold", () => {
  test("returns the 40k floor for a 200k-token context (backward compatible)", () => {
    // Arrange
    const contextWindowTokens = 200_000;
    // 200000 * 0.05 * 4 = 40000, floored at 40000

    // Act
    const threshold = getMemoryCharThreshold(contextWindowTokens);

    // Assert
    expect(threshold).toBe(40_000);
  });

  test("scales up proportionally for a 1M-token context window", () => {
    // Arrange
    const contextWindowTokens = 1_000_000;
    // 1000000 * 0.05 * 4 = 200000

    // Act
    const threshold = getMemoryCharThreshold(contextWindowTokens);

    // Assert — larger context yields a proportionally larger threshold
    expect(threshold).toBe(200_000);
    expect(threshold).toBeGreaterThan(MIN_MEMORY_CHARACTER_COUNT);
  });

  test("scales monotonically: larger context never shrinks the threshold", () => {
    // Arrange
    const small = getMemoryCharThreshold(100_000);
    const medium = getMemoryCharThreshold(400_000);
    const large = getMemoryCharThreshold(800_000);

    // Assert
    expect(medium).toBeGreaterThanOrEqual(small);
    expect(large).toBeGreaterThanOrEqual(medium);
  });

  test("never drops below the 40k floor for small context windows", () => {
    // Arrange + Act
    const threshold = getMemoryCharThreshold(10_000);

    // Assert
    expect(threshold).toBe(MIN_MEMORY_CHARACTER_COUNT);
  });

  test("falls back to the floor for invalid / non-positive inputs", () => {
    // Assert — invalid context windows must not produce NaN / negative thresholds
    expect(getMemoryCharThreshold(0)).toBe(MIN_MEMORY_CHARACTER_COUNT);
    expect(getMemoryCharThreshold(-5)).toBe(MIN_MEMORY_CHARACTER_COUNT);
    expect(getMemoryCharThreshold(Number.NaN)).toBe(MIN_MEMORY_CHARACTER_COUNT);
    expect(getMemoryCharThreshold(Number.POSITIVE_INFINITY)).toBe(
      MIN_MEMORY_CHARACTER_COUNT,
    );
  });
});
