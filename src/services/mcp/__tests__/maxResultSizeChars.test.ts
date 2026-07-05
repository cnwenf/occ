import { describe, expect, test } from "bun:test";
import {
  MCP_MAX_RESULT_SIZE_CHARS_CEILING,
  resolveMcpMaxResultSizeChars,
} from "../client";

/**
 * claude-code 2.1.91: MCP tools can override their persisted result-size limit
 * via _meta["anthropic/maxResultSizeChars"], capped at 500K. Mirrors v91's
 * `A ? Math.min(O, Og1) : default` where Og1 = 500000.
 */
describe("2.1.91 resolveMcpMaxResultSizeChars", () => {
  const DEFAULT = 100_000;

  test("the ceiling is 500K (matches v91 Og1)", () => {
    expect(MCP_MAX_RESULT_SIZE_CHARS_CEILING).toBe(500_000);
  });

  test("returns the override when it is a positive number under the ceiling", () => {
    expect(resolveMcpMaxResultSizeChars(200_000, DEFAULT)).toBe(200_000);
  });

  test("clamps an override above the ceiling down to 500K", () => {
    expect(resolveMcpMaxResultSizeChars(1_000_000, DEFAULT)).toBe(500_000);
    expect(resolveMcpMaxResultSizeChars(999_999_999, DEFAULT)).toBe(500_000);
  });

  test("accepts exactly the ceiling", () => {
    expect(resolveMcpMaxResultSizeChars(500_000, DEFAULT)).toBe(500_000);
  });

  test("falls back to default when override is missing (undefined)", () => {
    expect(resolveMcpMaxResultSizeChars(undefined, DEFAULT)).toBe(DEFAULT);
  });

  test("falls back to default for non-number overrides", () => {
    expect(resolveMcpMaxResultSizeChars("100000", DEFAULT)).toBe(DEFAULT);
    expect(resolveMcpMaxResultSizeChars(true, DEFAULT)).toBe(DEFAULT);
    expect(resolveMcpMaxResultSizeChars({ n: 100 }, DEFAULT)).toBe(DEFAULT);
    expect(resolveMcpMaxResultSizeChars(null, DEFAULT)).toBe(DEFAULT);
  });

  test("falls back to default for non-positive numbers", () => {
    expect(resolveMcpMaxResultSizeChars(0, DEFAULT)).toBe(DEFAULT);
    expect(resolveMcpMaxResultSizeChars(-5, DEFAULT)).toBe(DEFAULT);
  });

  test("falls back to default for non-finite numbers", () => {
    expect(resolveMcpMaxResultSizeChars(Number.NaN, DEFAULT)).toBe(DEFAULT);
    expect(resolveMcpMaxResultSizeChars(Number.POSITIVE_INFINITY, DEFAULT)).toBe(
      DEFAULT,
    );
  });
});
