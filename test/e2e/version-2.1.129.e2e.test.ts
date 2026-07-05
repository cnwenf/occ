import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.129 e2e (Docker): CLAUDE_CODE_FORCE_SYNC_OUTPUT env var.
 */
describe("2.1.129 CLAUDE_CODE_FORCE_SYNC_OUTPUT (e2e)", () => {
  test("force-enables synchronized output", async () => {
    const script = `
process.env.CLAUDE_CODE_FORCE_SYNC_OUTPUT = "1";
const { isSynchronizedOutputSupported } = await import("${REPO_ROOT}/src/ink/terminal.ts");
console.log(JSON.stringify({ supported: isSynchronizedOutputSupported() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.supported).toBe(true);
  });
});
