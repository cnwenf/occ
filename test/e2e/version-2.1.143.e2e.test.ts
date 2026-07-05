import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.143 e2e (Docker): stop hook block cap + worktree.bgIsolation.
 */
describe("2.1.143 stop hook block cap (e2e)", () => {
  test("CLAUDE_CODE_STOP_HOOK_BLOCK_CAP env is recognized", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/query.ts").text();
console.log(JSON.stringify({
  hasCap: src.includes("CLAUDE_CODE_STOP_HOOK_BLOCK_CAP"),
  hasBlockCap: src.includes("stop_hook_block_cap"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasCap).toBe(true);
    expect(out.hasBlockCap).toBe(true);
  });
});

describe("2.1.143 worktree.bgIsolation (e2e)", () => {
  test("schema accepts bgIsolation: none", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ worktree: { bgIsolation: "none" } });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
