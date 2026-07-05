import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.111 e2e (Docker): xhigh effort level (Opus 4.7; others → high).
 */
describe("2.1.111 xhigh effort (e2e)", () => {
  test("EFFORT_LEVELS + modelSupportsXhighEffort + resolveAppliedEffort", async () => {
    const script = `
delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
import { EFFORT_LEVELS, isEffortLevel, modelSupportsXhighEffort, resolveAppliedEffort } from "${REPO_ROOT}/src/utils/effort.ts";
console.log(JSON.stringify({
  includes: EFFORT_LEVELS.includes("xhigh"),
  accepts: isEffortLevel("xhigh"),
  opus47: modelSupportsXhighEffort("claude-opus-4-7"),
  sonnet: modelSupportsXhighEffort("claude-sonnet-4-6"),
  kept: resolveAppliedEffort("claude-opus-4-7", "xhigh"),
  downgraded: resolveAppliedEffort("claude-sonnet-4-6", "xhigh"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.includes).toBe(true);
    expect(out.accepts).toBe(true);
    expect(out.opus47).toBe(true);
    expect(out.sonnet).toBe(false);
    expect(out.kept).toBe("xhigh");
    expect(out.downgraded).toBe("high");
  });
});
