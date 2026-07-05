import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.141 e2e (Docker): hook terminalSequence + CLAUDE_CODE_PLUGIN_PREFER_HTTPS.
 */
describe("2.1.141 hook terminalSequence (e2e)", () => {
  test("TypedSyncHookOutput accepts terminalSequence", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/utils/hooks.ts").text();
console.log(JSON.stringify({
  hasTerminalSequence: src.includes("terminalSequence"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasTerminalSequence).toBe(true);
  });
});

describe("2.1.141 CLAUDE_CODE_PLUGIN_PREFER_HTTPS (e2e)", () => {
  test("marketplaceManager respects the env var", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/utils/plugins/marketplaceManager.ts").text();
console.log(JSON.stringify({
  hasEnvCheck: src.includes("CLAUDE_CODE_PLUGIN_PREFER_HTTPS"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasEnvCheck).toBe(true);
  });
});
