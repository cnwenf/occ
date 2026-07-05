import { afterEach, describe, expect, test } from "bun:test";
import { should1hCacheTTL } from "../claude";

/**
 * claude-code 2.1.108: ENABLE_PROMPT_CACHING_1H opts into 1h prompt-cache TTL
 * on API key/Bedrock/Vertex/Foundry; FORCE_PROMPT_CACHING_5M forces 5m TTL.
 * Both short-circuit before eligibility/GrowthBook checks.
 */
const SAVED_5M = process.env.FORCE_PROMPT_CACHING_5M;
const SAVED_1H = process.env.ENABLE_PROMPT_CACHING_1H;
afterEach(() => {
  if (SAVED_5M === undefined) {
    delete process.env.FORCE_PROMPT_CACHING_5M;
  } else {
    process.env.FORCE_PROMPT_CACHING_5M = SAVED_5M;
  }
  if (SAVED_1H === undefined) {
    delete process.env.ENABLE_PROMPT_CACHING_1H;
  } else {
    process.env.ENABLE_PROMPT_CACHING_1H = SAVED_1H;
  }
});

describe("2.1.108 prompt-cache TTL env vars", () => {
  test("FORCE_PROMPT_CACHING_5M forces 5m TTL (returns false)", () => {
    delete process.env.ENABLE_PROMPT_CACHING_1H;
    process.env.FORCE_PROMPT_CACHING_5M = "1";
    expect(should1hCacheTTL("repl_main_thread" as never)).toBe(false);
  });

  test("FORCE_PROMPT_CACHING_5M wins over ENABLE_PROMPT_CACHING_1H", () => {
    process.env.FORCE_PROMPT_CACHING_5M = "1";
    process.env.ENABLE_PROMPT_CACHING_1H = "1";
    expect(should1hCacheTTL("repl_main_thread" as never)).toBe(false);
  });

  test("ENABLE_PROMPT_CACHING_1H opts into 1h TTL (returns true)", () => {
    delete process.env.FORCE_PROMPT_CACHING_5M;
    process.env.ENABLE_PROMPT_CACHING_1H = "1";
    expect(should1hCacheTTL("repl_main_thread" as never)).toBe(true);
  });
});
