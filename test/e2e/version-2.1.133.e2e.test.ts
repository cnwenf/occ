import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.133 e2e (Docker): worktree.baseRef setting + effort in hooks.
 */
describe("2.1.133 worktree.baseRef setting (e2e)", () => {
  test("schema accepts baseRef: fresh", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  fresh: SettingsSchema().safeParse({ worktree: { baseRef: "fresh" } }).success,
  head: SettingsSchema().safeParse({ worktree: { baseRef: "head" } }).success,
  invalid: SettingsSchema().safeParse({ worktree: { baseRef: "invalid" } }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.fresh).toBe(true);
    expect(out.head).toBe(true);
    expect(out.invalid).toBe(false);
  });
});

describe("2.1.133 effort in hook input (e2e)", () => {
  test("createBaseHookInput includes effort.level", async () => {
    const script = `
import { createBaseHookInput } from "${REPO_ROOT}/src/utils/hooks.ts";
const input = createBaseHookInput(undefined, "test-session-id");
console.log(JSON.stringify({ hasEffort: !!input.effort, level: input.effort?.level }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasEffort).toBe(true);
    expect(typeof out.level).toBe("string");
  });
});
