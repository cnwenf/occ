import { describe, expect, test } from "bun:test";
import {
  PRECOMPACT_BLOCK_SENTINEL,
  isPreCompactBlockError,
} from "../compact";

/**
 * claude-code 2.1.105: a PreCompact hook can block compaction by exiting with
 * code 2 or returning {"decision":"block"}. compactConversation throws a
 * sentinel-prefixed error so callers can catch it and continue uncompacted.
 */
describe("2.1.105 PreCompact block sentinel", () => {
  test("the sentinel is a recognizable prefix", () => {
    expect(PRECOMPACT_BLOCK_SENTINEL.startsWith("PreCompact")).toBe(true);
  });

  test("isPreCompactBlockError detects a thrown block error", () => {
    const err = new Error(`${PRECOMPACT_BLOCK_SENTINEL}my-hook.sh`);
    expect(isPreCompactBlockError(err)).toBe(true);
  });

  test("isPreCompactBlockError rejects unrelated errors", () => {
    expect(isPreCompactBlockError(new Error("some other failure"))).toBe(false);
    expect(isPreCompactBlockError(new Error("PreCompactother"))).toBe(false); // prefix must match fully
    expect(isPreCompactBlockError("not an error")).toBe(false);
    expect(isPreCompactBlockError(null)).toBe(false);
    expect(isPreCompactBlockError(undefined)).toBe(false);
  });

  test("a block error carries the blocking command after the sentinel", () => {
    const cmd = "p4 changes";
    const err = new Error(`${PRECOMPACT_BLOCK_SENTINEL}${cmd}`);
    expect(isPreCompactBlockError(err)).toBe(true);
    expect(err.message.slice(PRECOMPACT_BLOCK_SENTINEL.length)).toBe(cmd);
  });
});
