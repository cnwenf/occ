import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.89: cleanupPeriodDays: 0 is rejected with a validation error
 * (schema moved from .nonnegative() → .positive()). This e2e runs the real OCC
 * SettingsSchema inside the Docker container against an invalid settings blob
 * and asserts the schema rejects 0 with a too_small code — the same contract
 * the interactive InvalidSettingsDialog enforces.
 */
describe("2.1.89 cleanupPeriodDays: 0 rejected (e2e, Docker)", () => {
  test("SettingsSchema rejects cleanupPeriodDays: 0", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ cleanupPeriodDays: 0 });
console.log(JSON.stringify({ success: r.success, code: r.success ? null : r.error.issues[0]?.code }));
`;
    const result =
      await $`bun -e ${script}`.quiet();
    const parsed = JSON.parse(result.stdout.toString().trim());
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe("too_small");
  });

  test("SettingsSchema accepts cleanupPeriodDays: 30", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ cleanupPeriodDays: 30 });
console.log(JSON.stringify({ success: r.success }));
`;
    const result = await $`bun -e ${script}`.quiet();
    const parsed = JSON.parse(result.stdout.toString().trim());
    expect(parsed.success).toBe(true);
  });
});
