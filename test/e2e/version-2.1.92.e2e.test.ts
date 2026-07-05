import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.92 e2e (Docker): deterministic, model-independent checks.
 *   1. /tag and /vim slash commands are no longer registered
 *   2. forceRemoteSettingsRefresh policy setting validates
 */
async function run(script: string): Promise<any> {
  const result = await $`bun -e ${script}`.quiet();
  return JSON.parse(result.stdout.toString().trim());
}

describe("2.1.92 removed slash commands (e2e)", () => {
  test("/tag and /vim are not in the registered command sets", async () => {
    const script = `
import { INTERNAL_ONLY_COMMANDS, REMOTE_SAFE_COMMANDS, getCommandName } from "${REPO_ROOT}/src/commands.ts";
const a = INTERNAL_ONLY_COMMANDS.map(getCommandName);
const b = [...REMOTE_SAFE_COMMANDS].map(getCommandName);
console.log(JSON.stringify({ tag: a.includes("tag") || b.includes("tag"), vim: a.includes("vim") || b.includes("vim") }));
`;
    const out = await run(script);
    expect(out.tag).toBe(false);
    expect(out.vim).toBe(false);
  });
});

describe("2.1.92 forceRemoteSettingsRefresh (e2e)", () => {
  test("SettingsSchema accepts forceRemoteSettingsRefresh: true", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({ success: SettingsSchema().safeParse({ forceRemoteSettingsRefresh: true }).success }));
`;
    expect((await run(script)).success).toBe(true);
  });
});
