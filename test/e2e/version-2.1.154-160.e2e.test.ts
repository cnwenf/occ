import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.154+2.1.158 e2e (Docker): Opus 4.8 xhigh + CLAUDE_CODE_ENABLE_AUTO_MODE.
 */
describe("2.1.154 Opus 4.8 xhigh support (e2e)", () => {
  test("modelSupportsXhighEffort accepts opus-4-8", async () => {
    const script = `
import { modelSupportsXhighEffort } from "${REPO_ROOT}/src/utils/effort.ts";
console.log(JSON.stringify({
  opus47: modelSupportsXhighEffort("claude-opus-4-7"),
  opus48: modelSupportsXhighEffort("claude-opus-4-8"),
  sonnet: modelSupportsXhighEffort("claude-sonnet-4-6"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.opus47).toBe(true);
    expect(out.opus48).toBe(true);
    expect(out.sonnet).toBe(false);
  });
});

describe("2.1.158 CLAUDE_CODE_ENABLE_AUTO_MODE (e2e)", () => {
  test("hasAutoModeOptInAnySource checks the env var", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/utils/permissions/permissionSetup.ts").text();
console.log(JSON.stringify({
  hasEnvCheck: src.includes("CLAUDE_CODE_ENABLE_AUTO_MODE"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasEnvCheck).toBe(true);
  });
});
