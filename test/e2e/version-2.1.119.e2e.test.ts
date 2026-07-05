import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.119 e2e (Docker): CLAUDE_CODE_HIDE_CWD + prUrlTemplate setting.
 */
describe("2.1.119 prUrlTemplate setting (e2e)", () => {
  test("schema accepts prUrlTemplate", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  ok: SettingsSchema().safeParse({ prUrlTemplate: "https://review.example.com/pr/{number}" }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ok).toBe(true);
  });
});
