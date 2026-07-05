import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.121 e2e (Docker): alwaysLoad MCP server config option.
 */
describe("2.1.121 alwaysLoad MCP config (e2e)", () => {
  test("stdio config accepts alwaysLoad: true", async () => {
    const script = `
import { McpStdioServerConfigSchema } from "${REPO_ROOT}/src/services/mcp/types.ts";
const r = McpStdioServerConfigSchema().safeParse({ command: "echo", args: [], alwaysLoad: true });
console.log(JSON.stringify({ success: r.success }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.success).toBe(true);
  });
});
