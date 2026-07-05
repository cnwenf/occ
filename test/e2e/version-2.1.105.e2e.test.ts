import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.105 e2e (Docker):
 *   1. WebFetch strips <style>/<script> from fetched HTML
 *   2. PreCompact block sentinel is recognizable
 */
describe("2.1.105 WebFetch strips style/script (e2e)", () => {
  test("turndown service removes style/script/noscript/iframe contents", async () => {
    const script = `
import { getTurndownService } from "${REPO_ROOT}/src/tools/WebFetchTool/utils.ts";
const td = await getTurndownService();
const md = td.turndown('<body><p>visible</p><style>body{color:red}</style><script>secret()</script></body>');
console.log(JSON.stringify({ hasVisible: md.includes("visible"), hasCss: md.includes("color:red"), hasJs: md.includes("secret") }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasVisible).toBe(true);
    expect(out.hasCss).toBe(false);
    expect(out.hasJs).toBe(false);
  });
});

describe("2.1.105 PreCompact block sentinel (e2e)", () => {
  test("isPreCompactBlockError detects the sentinel", async () => {
    const script = `
import { PRECOMPACT_BLOCK_SENTINEL, isPreCompactBlockError } from "${REPO_ROOT}/src/services/compact/compact.ts";
console.log(JSON.stringify({
  blocked: isPreCompactBlockError(new Error(PRECOMPACT_BLOCK_SENTINEL + "hook.sh")),
  other: isPreCompactBlockError(new Error("unrelated")),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.blocked).toBe(true);
    expect(out.other).toBe(false);
  });
});
