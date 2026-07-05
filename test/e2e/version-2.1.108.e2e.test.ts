import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.108 e2e (Docker): /undo alias for /rewind + prompt-cache TTL env vars.
 */
describe("2.1.108 /undo alias for /rewind (e2e)", () => {
  test("rewind command exposes 'undo' as an alias", async () => {
    const script = `
import rewind from "${REPO_ROOT}/src/commands/rewind/index.ts";
console.log(JSON.stringify({ name: rewind.name, aliases: rewind.aliases }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.name).toBe("rewind");
    expect(out.aliases).toContain("undo");
    expect(out.aliases).toContain("checkpoint");
  });
});

describe("2.1.108 prompt-cache TTL env vars (e2e)", () => {
  test("FORCE_PROMPT_CACHING_5M forces 5m TTL; ENABLE_PROMPT_CACHING_1H opts into 1h", async () => {
    const script = `
import { should1hCacheTTL } from "${REPO_ROOT}/src/services/api/claude.ts";
delete process.env.ENABLE_PROMPT_CACHING_1H;
process.env.FORCE_PROMPT_CACHING_5M = "1";
const forced5m = should1hCacheTTL("repl_main_thread");
delete process.env.FORCE_PROMPT_CACHING_5M;
process.env.ENABLE_PROMPT_CACHING_1H = "1";
const opt1h = should1hCacheTTL("repl_main_thread");
console.log(JSON.stringify({ forced5m, opt1h }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.forced5m).toBe(false);
    expect(out.opt1h).toBe(true);
  });
});
