import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.144+2.1.145 e2e (Docker): /extra-usage→/usage-credits alias + Stop hook background_tasks/session_crons.
 */
describe("2.1.144 /usage-credits alias (e2e)", () => {
  test("extra-usage command has usage-credits alias", async () => {
    const script = `
import { extraUsage } from "${REPO_ROOT}/src/commands/extra-usage/index.ts";
console.log(JSON.stringify({ name: extraUsage.name, aliases: extraUsage.aliases }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.name).toBe("extra-usage");
    expect(out.aliases).toContain("usage-credits");
  });
});

describe("2.1.145 Stop hook background_tasks/session_crons (e2e)", () => {
  test("hooks.ts has background_tasks + session_crons in Stop input", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/utils/hooks.ts").text();
console.log(JSON.stringify({
  hasBgTasks: src.includes("background_tasks"),
  hasCrons: src.includes("session_crons"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasBgTasks).toBe(true);
    expect(out.hasCrons).toBe(true);
  });
});
