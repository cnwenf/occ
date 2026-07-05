import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.132 e2e (Docker): CLAUDE_CODE_SESSION_ID in subprocess env
 * + CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN opt-out.
 */
describe("2.1.132 CLAUDE_CODE_SESSION_ID (e2e)", () => {
  test("subprocessEnv sets CLAUDE_CODE_SESSION_ID", async () => {
    const script = `
delete process.env.CLAUDE_CODE_SESSION_ID;
const { subprocessEnv } = await import("${REPO_ROOT}/src/utils/subprocessEnv.ts");
const env = subprocessEnv();
console.log(JSON.stringify({ hasSid: typeof env.CLAUDE_CODE_SESSION_ID === "string" && env.CLAUDE_CODE_SESSION_ID.length > 0 }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasSid).toBe(true);
  });
});

describe("2.1.132 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN (e2e)", () => {
  test("disables fullscreen when set", async () => {
    const script = `
process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
const { isFullscreenEnvEnabled } = await import("${REPO_ROOT}/src/utils/fullscreen.ts");
console.log(JSON.stringify({ fullscreen: isFullscreenEnvEnabled() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.fullscreen).toBe(false);
  });
});
