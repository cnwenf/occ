import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.113 e2e (Docker): sandbox.network.deniedDomains setting.
 */
describe("2.1.113 sandbox.network.deniedDomains (e2e)", () => {
  test("schema accepts deniedDomains alongside allowedDomains", async () => {
    const script = `
import { SandboxSettingsSchema } from "${REPO_ROOT}/src/entrypoints/sandboxTypes.ts";
const r = SandboxSettingsSchema().safeParse({
  network: { allowedDomains: ["*.example.com"], deniedDomains: ["bad.example.com"] },
});
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
