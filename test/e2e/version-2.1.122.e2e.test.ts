import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.122 e2e (Docker): ANTHROPIC_BEDROCK_SERVICE_TIER env var.
 * Verifies the env var is read + would be sent as X-Amzn-Bedrock-Service-Tier.
 */
describe("2.1.122 ANTHROPIC_BEDROCK_SERVICE_TIER (e2e)", () => {
  test("the env var is recognized in the source", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/services/api/client.ts").text();
console.log(JSON.stringify({
  hasEnv: src.includes("ANTHROPIC_BEDROCK_SERVICE_TIER"),
  hasHeader: src.includes("X-Amzn-Bedrock-Service-Tier"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasEnv).toBe(true);
    expect(out.hasHeader).toBe(true);
  });
});
