import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.144–2.1.198 command rename/removal alignment e2e.
 *
 * Verifies OCC's command registry matches the OFFICIAL 2.1.200 binary for the
 * rename/removal workstream:
 *   E12 — /usage-credits is the real command; /extra-usage is a "Renamed to
 *          /usage-credits" stub that delegates to it.
 *   E16 — /agents slash command is a "(removed)" stub (wizard removed in 2.1.198).
 *   E17 — /output-style command is removed entirely (no command registered).
 *   E13 — /cost + /stats merged into /usage as aliases (single /usage command).
 *
 * Per aligning-with-official-binary: expected shapes are verified against the
 * official binary via strings extraction. Source-grep + runtime registration
 * checks (getBuiltInCommandByName finds commands regardless of isEnabled).
 */

describe("2.1.144+ command rename/removal alignment (e2e, vs official 2.1.200)", () => {
  test("E12 /usage-credits is registered with the official description", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const cmd = getBuiltInCommandByName("usage-credits");
console.log(JSON.stringify({ found: !!cmd, name: cmd?.name, description: cmd?.description, type: cmd?.type }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.found).toBe(true);
    expect(out.name).toBe("usage-credits");
    expect(out.description).toBe("Configure usage credits to keep working when you hit a limit");
  });

  test("E12 /extra-usage is a hidden stub with description 'Renamed to /usage-credits'", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const cmd = getBuiltInCommandByName("extra-usage");
console.log(JSON.stringify({ found: !!cmd, name: cmd?.name, description: cmd?.description, isHidden: cmd?.isHidden }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.found).toBe(true);
    expect(out.name).toBe("extra-usage");
    expect(out.description).toBe("Renamed to /usage-credits");
    expect(out.isHidden).toBe(true);
  });

  test("E12 /extra-usage stub delegates to /usage-credits (source: extra-usage.tsx imports usage-credits)", async () => {
    const script = `
const tsx = await Bun.file("${REPO_ROOT}/src/commands/extra-usage/extra-usage.tsx").text();
const ni = await Bun.file("${REPO_ROOT}/src/commands/extra-usage/extra-usage-noninteractive.ts").text();
console.log(JSON.stringify({
  interactiveDelegates: tsx.includes("../usage-credits/usage-credits.js") && tsx.includes("/extra-usage is now /usage-credits"),
  nonInteractiveDelegates: ni.includes("../usage-credits/usage-credits-noninteractive.js") && ni.includes("/extra-usage is now /usage-credits"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.interactiveDelegates).toBe(true);
    expect(out.nonInteractiveDelegates).toBe(true);
  });

  test("E16 /agents description starts with '(removed)' and is type local (not the wizard)", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const cmd = getBuiltInCommandByName("agents");
console.log(JSON.stringify({ found: !!cmd, name: cmd?.name, description: cmd?.description, type: cmd?.type, supportsNonInteractive: cmd?.supportsNonInteractive }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.found).toBe(true);
    expect(out.name).toBe("agents");
    expect(out.description).toBe("(removed) Ask Claude to create/manage subagents, or edit .claude/agents/");
    expect(out.type).toBe("local");
    expect(out.supportsNonInteractive).toBe(true);
  });

  test("E16 /agents stub returns the 'wizard has been removed' message", async () => {
    const script = `
const src = await Bun.file("${REPO_ROOT}/src/commands/agents/agents.ts").text();
console.log(JSON.stringify({
  hasRemovedMessage: src.includes("The /agents wizard has been removed."),
  hasDocsLink: src.includes("https://code.claude.com/docs/en/sub-agents"),
  wizardGone: !await Bun.file("${REPO_ROOT}/src/commands/agents/agents.tsx").exists(),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.hasRemovedMessage).toBe(true);
    expect(out.hasDocsLink).toBe(true);
    expect(out.wizardGone).toBe(true);
  });

  test("E17 /output-style command is NOT registered (import + command absent)", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const commandsSrc = await Bun.file("${REPO_ROOT}/src/commands.ts").text();
const dirExists = await Bun.file("${REPO_ROOT}/src/commands/output-style/index.ts").exists();
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const cmd = getBuiltInCommandByName("output-style");
console.log(JSON.stringify({
  importAbsent: !commandsSrc.includes("commands/output-style/index.js"),
  arrayEntryAbsent: !commandsSrc.includes("outputStyle"),
  dirGone: !dirExists,
  notRegistered: !cmd,
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.importAbsent).toBe(true);
    expect(out.arrayEntryAbsent).toBe(true);
    expect(out.dirGone).toBe(true);
    expect(out.notRegistered).toBe(true);
  });

  test("E13 /usage is registered with aliases [cost, stats] and official description", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
const cmd = getBuiltInCommandByName("usage");
console.log(JSON.stringify({ found: !!cmd, name: cmd?.name, aliases: cmd?.aliases, description: cmd?.description }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.found).toBe(true);
    expect(out.name).toBe("usage");
    expect(out.aliases).toEqual(["cost", "stats"]);
    // Interactive (local-jsx) variant has the official description.
    expect(out.description).toBe("Show session cost, plan usage, and activity stats");
  });

  test("E13 /cost and /stats are NOT registered as separate commands", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getBuiltInCommandByName } = await import("${REPO_ROOT}/src/commands.ts");
// A command named "cost" or "stats" should not exist (they are aliases of /usage).
const costCmd = getBuiltInCommandByName("cost");
const statsCmd = getBuiltInCommandByName("stats");
// getBuiltInCommandByName matches name OR alias, so "cost"/"stats" resolve to
// the /usage command (whose aliases include them) — confirming they are aliases,
// not standalone commands.
console.log(JSON.stringify({
  costResolvesToUsage: costCmd?.name === "usage",
  statsResolvesToUsage: statsCmd?.name === "usage",
  costDirGone: !await Bun.file("${REPO_ROOT}/src/commands/cost/index.ts").exists(),
  statsDirGone: !await Bun.file("${REPO_ROOT}/src/commands/stats/index.ts").exists(),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.costResolvesToUsage).toBe(true);
    expect(out.statsResolvesToUsage).toBe(true);
    expect(out.costDirGone).toBe(true);
    expect(out.statsDirGone).toBe(true);
  });
});
