import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.96 e2e (Docker): the Bedrock bearer-token auth fix. The
 * bearer token must go through the SDK's apiKey field, and skipAuth must NOT
 * fire when a bearer token is present (the 2.1.94 regression stripped the
 * Authorization header → 403).
 */
describe("2.1.96 Bedrock bearer-token auth (e2e)", () => {
  test("bearer token: apiKey set, skipAuth false", async () => {
    const script = `
import { resolveBedrockAuthArgs } from "${REPO_ROOT}/src/services/api/client.ts";
const r = resolveBedrockAuthArgs({ skipBedrockAuth: false, bearerToken: "mytoken" });
console.log(JSON.stringify(r));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.apiKey).toBe("mytoken");
    expect(out.skipAuth).toBe(false);
    expect(out.authHeader).toBe("Bearer mytoken");
  });

  test("bearer token wins over skip_bedrock_auth (no skipAuth)", async () => {
    const script = `
import { resolveBedrockAuthArgs } from "${REPO_ROOT}/src/services/api/client.ts";
const r = resolveBedrockAuthArgs({ skipBedrockAuth: true, bearerToken: "mytoken" });
console.log(JSON.stringify(r));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.skipAuth).toBe(false);
    expect(out.apiKey).toBe("mytoken");
  });

  test("skip_bedrock_auth with no bearer: skipAuth true, no apiKey", async () => {
    const script = `
import { resolveBedrockAuthArgs } from "${REPO_ROOT}/src/services/api/client.ts";
const r = resolveBedrockAuthArgs({ skipBedrockAuth: true });
console.log(JSON.stringify(r));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.skipAuth).toBe(true);
    expect(out.apiKey).toBeUndefined();
  });
});
