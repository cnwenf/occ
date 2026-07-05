import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.118 e2e (Docker): DISABLE_UPDATES env blocks all update paths.
 */
describe("2.1.118 DISABLE_UPDATES (e2e)", () => {
  test("DISABLE_UPDATES returns env reason with correct envVar", async () => {
    const script = `
delete process.env.DISABLE_AUTOUPDATER;
process.env.DISABLE_UPDATES = "1";
const { getAutoUpdaterDisabledReason } = await import("${REPO_ROOT}/src/utils/config.ts");
const r = getAutoUpdaterDisabledReason();
console.log(JSON.stringify({ type: r?.type, envVar: r?.envVar }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.type).toBe("env");
    expect(out.envVar).toBe("DISABLE_UPDATES");
  });
});
