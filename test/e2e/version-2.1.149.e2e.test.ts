import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.149 e2e (Docker): allowAllClaudeAiMcps managed setting.
 */
describe("2.1.149 allowAllClaudeAiMcps (e2e)", () => {
  test("schema accepts allowAllClaudeAiMcps: true", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ allowAllClaudeAiMcps: true });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
