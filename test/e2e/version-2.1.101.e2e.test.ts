import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.101 e2e (Docker): OS CA store trusted by default;
 * CLAUDE_CODE_CERT_STORE selects bundled/system.
 */
describe("2.1.101 CA cert stores (e2e)", () => {
  test("default is bundled + system", async () => {
    const script = `
delete process.env.CLAUDE_CODE_CERT_STORE;
const { resolveCertStores, DEFAULT_CERT_STORES } = await import("${REPO_ROOT}/src/utils/caCerts.ts");
console.log(JSON.stringify({ def: DEFAULT_CERT_STORES, resolved: resolveCertStores() }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.def).toEqual(["bundled", "system"]);
    expect(out.resolved).toEqual(["bundled", "system"]);
  });

  test("CLAUDE_CODE_CERT_STORE=bundled → bundled only", async () => {
    const script = `
process.env.CLAUDE_CODE_CERT_STORE = "bundled";
const { resolveCertStores } = await import("${REPO_ROOT}/src/utils/caCerts.ts");
console.log(JSON.stringify(resolveCertStores()));
`;
    expect(JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())).toEqual(["bundled"]);
  });

  test("CLAUDE_CODE_CERT_STORE=system → system only", async () => {
    const script = `
process.env.CLAUDE_CODE_CERT_STORE = "system";
const { resolveCertStores } = await import("${REPO_ROOT}/src/utils/caCerts.ts");
console.log(JSON.stringify(resolveCertStores()));
`;
    expect(JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())).toEqual(["system"]);
  });
});
