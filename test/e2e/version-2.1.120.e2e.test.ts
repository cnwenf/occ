import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.120 e2e (Docker): AI_AGENT env for subprocesses.
 */
describe("2.1.120 AI_AGENT env (e2e)", () => {
  test("subprocessEnv sets AI_AGENT=Claude Code", async () => {
    const script = `
delete process.env.AI_AGENT;
const { subprocessEnv } = await import("${REPO_ROOT}/src/utils/subprocessEnv.ts");
const env = subprocessEnv();
console.log(JSON.stringify({ aiAgent: env.AI_AGENT }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.aiAgent).toBe("Claude Code");
  });
});
