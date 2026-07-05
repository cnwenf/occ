import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.161-200 batch e2e (Docker): multiple settings schema additions.
 */
describe("2.1.163 requiredMinimumVersion/requiredMaximumVersion (e2e)", () => {
  test("schema accepts both", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ requiredMinimumVersion: "2.1.100", requiredMaximumVersion: "2.1.200" });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});

describe("2.1.166 fallbackModel (e2e)", () => {
  test("schema accepts string or array", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  str: SettingsSchema().safeParse({ fallbackModel: "claude-sonnet-4-6" }).success,
  arr: SettingsSchema().safeParse({ fallbackModel: ["a", "b", "c"] }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.str).toBe(true);
    expect(out.arr).toBe(true);
  });
});

describe("2.1.174+175 wheelScrollAcceleration + enforceAvailableModels (e2e)", () => {
  test("schema accepts both booleans", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
console.log(JSON.stringify({
  wheel: SettingsSchema().safeParse({ wheelScrollAccelerationEnabled: true }).success,
  enforce: SettingsSchema().safeParse({ enforceAvailableModels: true }).success,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.wheel).toBe(true);
    expect(out.enforce).toBe(true);
  });
});

describe("2.1.193 autoMode.classifyAllShell (e2e)", () => {
  test("schema accepts classifyAllShell", async () => {
    const script = `
import { SettingsSchema } from "${REPO_ROOT}/src/utils/settings/types.ts";
const r = SettingsSchema().safeParse({ permissions: { autoMode: { classifyAllShell: true } } });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});

describe("2.1.187 sandbox.credentials (e2e)", () => {
  test("schema accepts credentials.enabled", async () => {
    const script = `
import { SandboxSettingsSchema } from "${REPO_ROOT}/src/entrypoints/sandboxTypes.ts";
const r = SandboxSettingsSchema().safeParse({ credentials: { enabled: true } });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
