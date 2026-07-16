import { afterEach, describe, expect, test } from "bun:test";
import { getGlobalConfig } from "../config";
import {
  getThinkingGuidanceSection,
  isThinkingGuidanceEnabled,
} from "../context";

/**
 * claude-code 2.1.107: `thinking_guidance` dynamic system-prompt section gated
 * on opus-4-6 model + the server-side `loud_sugary_rock` flag (v107's FH7).
 */
const cfg = getGlobalConfig();
const savedCache = cfg.clientDataCache;
afterEach(() => {
  cfg.clientDataCache = savedCache;
});

describe("2.1.107 thinking_guidance gate", () => {
  test("disabled for non-opus-4-6 models", () => {
    cfg.clientDataCache = { loud_sugary_rock: "true" };
    expect(isThinkingGuidanceEnabled("claude-sonnet-4-6")).toBe(false);
    expect(isThinkingGuidanceEnabled("claude-haiku-4-5")).toBe(false);
    expect(getThinkingGuidanceSection("claude-sonnet-4-6")).toBeNull();
  });

  test("disabled for opus-4-6 when the server flag is off", () => {
    cfg.clientDataCache = {};
    expect(isThinkingGuidanceEnabled("claude-opus-4-6")).toBe(false);
    cfg.clientDataCache = { loud_sugary_rock: "false" };
    expect(isThinkingGuidanceEnabled("claude-opus-4-6")).toBe(false);
    expect(getThinkingGuidanceSection("claude-opus-4-6")).toBeNull();
  });

  // Previously gated with skipIf(CI) because getGlobalConfig()/clientDataCache
  // state leaked across test files in `bun test`'s shared process. Fixed by
  // ci.yml per-file process isolation (scripts/ci-test.sh) — each file gets its
  // own bun process, so no global-config state leak.
  test(
    "enabled for opus-4-6 when loud_sugary_rock === 'true' — returns the guidance text",
    () => {
    cfg.clientDataCache = { loud_sugary_rock: "true" };
    expect(isThinkingGuidanceEnabled("claude-opus-4-6")).toBe(true);
    const text = getThinkingGuidanceSection("claude-opus-4-6");
    expect(text).not.toBeNull();
    expect(text).toContain("# System reminders");
    expect(text).toContain("thinking frequency");
    expect(text).toContain("do not mention them");
  });
});
