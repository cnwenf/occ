import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.110 e2e (Docker): Bash timeout clamped to max + autoScrollEnabled setting.
 */
describe("2.1.110 Bash timeout clamp (e2e)", () => {
  test("clampTimeoutMs clamps arbitrarily large values to the max", async () => {
    const script = `
import { clampTimeoutMs, getMaxTimeoutMs } from "${REPO_ROOT}/src/tools/BashTool/prompt.ts";
const max = getMaxTimeoutMs();
console.log(JSON.stringify({
  default: clampTimeoutMs(undefined, 120000, max),
  inRange: clampTimeoutMs(5000, 120000, max),
  clamped: clampTimeoutMs(9999999999, 120000, max),
  max,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.default).toBe(120000);
    expect(out.inRange).toBe(5000);
    expect(out.clamped).toBe(out.max);
    expect(out.max).toBeGreaterThan(0);
  });
});

describe("2.1.110 autoScrollEnabled setting (e2e)", () => {
  test("schema accepts autoScrollEnabled: false", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  ok: SettingsSchema().safeParse({ autoScrollEnabled: false }).success,
  rejected: SettingsSchema().safeParse({ autoScrollEnabled: "no" }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.ok).toBe(true);
    expect(out.rejected).toBe(false);
  });
});
