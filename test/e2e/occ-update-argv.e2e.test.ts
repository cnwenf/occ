import { describe, expect, test, beforeEach, afterEach } from "bun:test";

// Monkey-patch child_process.spawnSync to record calls + simulate offline npm.
// update.ts imports { spawnSync } from 'child_process' at module top; the ESM
// named binding is live, so mutating the module's export reflects in update.ts.
type Call = { cmd: string; args: string[] };
let recorded: Call[] = [];
const cp = require("child_process");
const realSpawnSync = cp.spawnSync;

function fakeSpawnSync(cmd: string, args: string[], _opts?: unknown) {
  recorded.push({ cmd, args });
  // "npm view <pkg> version" → return failure (offline) so latestVersion() = null
  if (args.includes("view")) return { status: 1, stdout: "", stderr: "" };
  return { status: 0, stdout: "stubbed", stderr: "" };
}

describe("occ update argv", () => {
  beforeEach(() => {
    recorded = [];
    cp.spawnSync = fakeSpawnSync;
  });
  afterEach(() => {
    cp.spawnSync = realSpawnSync;
  });

  test("npm branch installs @cnwenf/occ globally", async () => {
    const prevMacro = (globalThis as any).MACRO;
    (globalThis as any).MACRO = { ...(prevMacro ?? {}), PACKAGE_URL: "@cnwenf/occ", VERSION: "2.1.204" };
    try {
      delete require.cache[require.resolve("../../src/commands/update/update.ts")];
      const mod = await import("../../src/commands/update/update.ts");
      await mod.call();
    } finally {
      (globalThis as any).MACRO = prevMacro;
    }
    const installCall = recorded.find((c) => c.args.includes("@cnwenf/occ@latest"));
    expect(installCall).toBeDefined();
    expect(installCall!.args).toContain("-g");
    expect(installCall!.args).toContain("install");
  });

  test("falsy PACKAGE_URL no-ops without spawning install", async () => {
    const prevMacro = (globalThis as any).MACRO;
    (globalThis as any).MACRO = { ...(prevMacro ?? {}), PACKAGE_URL: "", VERSION: "2.1.204" };
    try {
      delete require.cache[require.resolve("../../src/commands/update/update.ts")];
      const mod = await import("../../src/commands/update/update.ts");
      await mod.call();
    } finally {
      (globalThis as any).MACRO = prevMacro;
    }
    const installCall = recorded.find((c) => c.args.includes("@latest"));
    expect(installCall).toBeUndefined();
  });
});
