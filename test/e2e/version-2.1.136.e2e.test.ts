import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.136 e2e (Docker): autoMode.hard_deny setting.
 */
describe("2.1.136 autoMode.hard_deny (e2e)", () => {
  test("schema accepts hard_deny array", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({
  permissions: {
    autoMode: {
      allow: ["Bash(ls:*)"],
      soft_deny: ["Bash(rm:*)"],
      hard_deny: ["Bash(curl:*)"],
    },
  },
});
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
