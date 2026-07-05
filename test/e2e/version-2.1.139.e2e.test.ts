import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.139 e2e (Docker): hook args/continueOnBlock schema + MCP CLAUDE_PROJECT_DIR.
 */
describe("2.1.139 hook args + continueOnBlock schema (e2e)", () => {
  test("BashCommandHookSchema accepts args + continueOnBlock", async () => {
    const script = `
import { HookCommandSchema } from "${REPO_ROOT}/src/schemas/hooks.ts";
const r = HookCommandSchema().safeParse({
  type: "command",
  command: "/usr/bin/my-hook",
  args: ["--flag", "value"],
  continueOnBlock: true,
});
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});

describe("2.1.139 MCP stdio CLAUDE_PROJECT_DIR (e2e)", () => {
  test("client.ts injects CLAUDE_PROJECT_DIR into stdio env", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/services/mcp/client.ts").text();
console.log(JSON.stringify({
  hasProjectDir: src.includes("CLAUDE_PROJECT_DIR: getProjectRoot()"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasProjectDir).toBe(true);
  });
});
