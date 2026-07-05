import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.128 e2e (Docker): MCP "workspace" is a reserved server name.
 */
describe("2.1.128 MCP workspace reserved (e2e)", () => {
  test("'workspace' is rejected as a reserved name", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/services/mcp/config.ts").text();
console.log(JSON.stringify({
  hasWorkspaceCheck: src.includes("name === 'workspace'") || src.includes('name === "workspace"'),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasWorkspaceCheck).toBe(true);
  });
});
