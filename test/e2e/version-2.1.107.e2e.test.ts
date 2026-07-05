import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.107 e2e (Docker): thinking_guidance gate (opus-4-6 +
 * loud_sugary_rock server flag).
 */
describe("2.1.107 thinking_guidance gate (e2e)", () => {
  test("disabled without the server flag; enabled with it for opus-4-6", async () => {
    const script = `
import { getGlobalConfig } from "${REPO_ROOT}/src/utils/config.ts";
import { getThinkingGuidanceSection, isThinkingGuidanceEnabled } from "${REPO_ROOT}/src/utils/context.ts";
const cfg = getGlobalConfig();
cfg.clientDataCache = {};
const off = isThinkingGuidanceEnabled("claude-opus-4-6");
cfg.clientDataCache = { loud_sugary_rock: "true" };
const on = isThinkingGuidanceEnabled("claude-opus-4-6");
const text = getThinkingGuidanceSection("claude-opus-4-6");
const nonOpus = isThinkingGuidanceEnabled("claude-sonnet-4-6");
console.log(JSON.stringify({ off, on, nonOpus, hasText: !!text, hasFreq: text?.includes("thinking frequency") }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.off).toBe(false);
    expect(out.on).toBe(true);
    expect(out.nonOpus).toBe(false);
    expect(out.hasText).toBe(true);
    expect(out.hasFreq).toBe(true);
  });
});
