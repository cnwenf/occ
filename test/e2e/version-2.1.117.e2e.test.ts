import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.117 e2e (Docker): cleanupPeriodDays sweep covers
 * tasks/shell-snapshots/backups.
 */
describe("2.1.117 cleanup sweep (e2e)", () => {
  test("cleanupOldMiscConfigDirs is callable", async () => {
    const script = `
import { cleanupOldMiscConfigDirs } from "${REPO_ROOT}/src/utils/cleanup.ts";
const r = await cleanupOldMiscConfigDirs();
console.log(JSON.stringify({ ok: typeof r.messages === "number" }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ok).toBe(true);
  });
});
