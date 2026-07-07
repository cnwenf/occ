import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.144+2.1.145 e2e (Docker): /usage-credits is primary, /extra-usage is a
 * 'Renamed to /usage-credits' stub (NOT an alias) + Stop hook background_tasks/session_crons.
 */
describe("2.1.144 /usage-credits primary + /extra-usage stub (e2e)", () => {
  test("usage-credits is the primary command; extra-usage is a 'Renamed to' stub", async () => {
    const script = `
import { usageCredits } from "${REPO_ROOT}/src/commands/usage-credits/index.ts";
import { extraUsage } from "${REPO_ROOT}/src/commands/extra-usage/index.ts";
console.log(JSON.stringify({
  usageCredits: { name: usageCredits.name, description: usageCredits.description },
  extraUsage: { name: extraUsage.name, description: extraUsage.description, isHidden: extraUsage.isHidden },
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    // Official 2.1.200: usage-credits is the primary command.
    expect(out.usageCredits.name).toBe("usage-credits");
    expect(out.usageCredits.description).toContain("usage credits");
    // extra-usage is a hidden "Renamed to /usage-credits" stub (NOT an alias).
    expect(out.extraUsage.name).toBe("extra-usage");
    expect(out.extraUsage.description).toContain("Renamed to /usage-credits");
    expect(out.extraUsage.isHidden).toBe(true);
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
