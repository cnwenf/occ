import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.97 e2e (Docker): statusLine.refreshInterval setting validates,
 * and workspace.git_worktree is detected inside a linked git worktree.
 */
describe("2.1.97 statusLine.refreshInterval (e2e)", () => {
  test("schema accepts refreshInterval: 5", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  ok: SettingsSchema().safeParse({ statusLine: { type: "command", command: "echo hi", refreshInterval: 5 } }).success,
  rejected: SettingsSchema().safeParse({ statusLine: { type: "command", command: "echo hi", refreshInterval: 0 } }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ok).toBe(true);
    expect(out.rejected).toBe(false);
  });
});

describe("2.1.97 getLinkedGitWorktreePath (e2e)", () => {
  test("returns null in the main repo (no .git gitdir file)", async () => {
    const script = `
import { getLinkedGitWorktreePath } from "${REPO_ROOT}/src/utils/worktree.ts";
import { runWithCwdOverride } from "${REPO_ROOT}/src/utils/cwd.ts";
// /occ is the repo root — .git is excluded from the image, so this is null.
const result = runWithCwdOverride("/occ", () => getLinkedGitWorktreePath());
console.log(JSON.stringify({ result }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.result).toBeNull();
  });
});
