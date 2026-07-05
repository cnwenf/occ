import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.142 e2e (Docker): Fast mode Opus 4.7 default + override env.
 */
describe("2.1.142 fast mode model (e2e)", () => {
  test("source has the override env + 4.7 support", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/utils/fastMode.ts").text();
console.log(JSON.stringify({
  hasOverride: src.includes("CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE"),
  hasOpus47: src.includes("opus-4-7"),
  hasOpusAlias: src.includes("'opus'"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasOverride).toBe(true);
    expect(out.hasOpus47).toBe(true);
    expect(out.hasOpusAlias).toBe(true);
  });
});
