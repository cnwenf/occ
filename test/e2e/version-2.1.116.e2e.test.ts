import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.116 e2e (Docker): update URL moved to downloads.claude.ai.
 */
describe("2.1.116 update URL (e2e)", () => {
  test("autoUpdater + nativeInstaller use downloads.claude.ai", async () => {
    const script = `
const a = await Bun.file("${REPO_ROOT}/src/utils/autoUpdater.ts").text();
const b = await Bun.file("${REPO_ROOT}/src/utils/nativeInstaller/download.ts").text();
console.log(JSON.stringify({
  auto: a.includes("downloads.claude.ai/claude-code-releases"),
  installer: b.includes("downloads.claude.ai/claude-code-releases"),
  noOld: !a.includes("storage.googleapis.com/claude-code-dist") && !b.includes("storage.googleapis.com/claude-code-dist"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.auto).toBe(true);
    expect(out.installer).toBe(true);
    expect(out.noOld).toBe(true);
  });
});
