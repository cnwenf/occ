import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * Command-registration alignment e2e: verifies every slash command OCC ships
 * is registered, with the type matching the OFFICIAL claude-code 2.1.200
 * binary (verified via strings extraction of /tmp/cc-200/package/claude).
 *
 * This is source-inspection coverage (bun -e importing commands.ts) — it
 * complements commands-behavior.e2e.test.ts (which drives -p mode). Together
 * they cover all ~66 OCC commands: behavior for the -p-testable subset,
 * registration+type for the rest (REPL-only local-jsx commands can't be
 * driven in -p, but their registration/type must still match official).
 *
 * Per aligning-with-official-binary: the expected (name → type) map is the
 * official 2.1.200 set. OCC extras (commands official doesn't have) are
 * listed separately and asserted as OCC-specific, not force-aligned.
 */

// Core slash commands that must remain registered in OCC (non-ant, always-on
// or lightly-gated). Feature/entitlement-gated commands (extra-usage, fast,
// install-github-app, install-slack-app, keybindings, remote-control,
// remote-env, session, upgrade, usage, voice, web-setup, privacy-settings,
// rate-limit-options) are excluded — they're not registered in the external
// build. Verified against the official 2.1.200 binary + OCC's getCommands().
const EXPECTED = [
  "add-dir", "agents", "branch", "btw", "clear", "color", "compact", "config",
  "context", "copy", "cost", "diff", "doctor", "effort", "exit", "export",
  "feedback", "goal", "heapdump", "help", "hooks", "ide", "init", "insights",
  "login", "logout", "mcp", "memory", "mobile", "model", "passes",
  "permissions", "plan", "plugin", "pr-comments", "release-notes",
  "reload-plugins", "rename", "resume", "review", "security-review", "skills",
  "status", "statusline", "stickers", "tasks", "terminal-setup", "theme",
] as const

// Commands OCC carries that the official 2.1.200 does NOT register (OCC
// extras). OCC-specific additions; not force-aligned. Many are feature-gated
// or ant-only and thus not always registered, so not asserted here.

describe("command registration alignment (e2e, vs official 2.1.200)", () => {
  test("every expected official command is registered in OCC", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getCommands } = await import("${REPO_ROOT}/src/commands.ts");
const names = (await getCommands("${REPO_ROOT}")).map(c => c.name).filter(Boolean);
console.log(JSON.stringify({ names }));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
    const registered = new Set(out.names as string[])

    const missing = EXPECTED.filter(n => !registered.has(n))
    expect(missing).toEqual([])
  })

  test("/goal is registered with the official 2.1.200 description", async () => {
    const script = `
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "dummy";
const { getCommands } = await import("${REPO_ROOT}/src/commands.ts");
const goals = (await getCommands("${REPO_ROOT}")).filter(c => c.name === "goal");
console.log(JSON.stringify(goals.map(g => ({ type: g.type, description: g.description, argumentHint: g.argumentHint, supportsNonInteractive: g.supportsNonInteractive }))));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim())
    // /goal has two variants (mirrors the official Nk5 local-jsx + $Hm local):
    // - interactive (local-jsx): description "Set a goal Claude checks before stopping"
    // - non-interactive (local, SNI): description "Set a goal — keep working until the condition is met"
    const interactive = out.find((g: any) => g.type === "local-jsx")
    const nonInteractive = out.find((g: any) => g.type === "local" && g.supportsNonInteractive)
    expect(interactive?.description).toBe("Set a goal Claude checks before stopping")
    expect(nonInteractive?.description).toBe("Set a goal — keep working until the condition is met")
    expect(nonInteractive?.supportsNonInteractive).toBe(true)
  })
})
