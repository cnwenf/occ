import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 CLI subcommand alignment (vs official 2.1.200 binary).
 *
 *   E29 (2.1.126) — `claude project purge [path]` subcommand.
 *   E30 (2.1.120) — `claude ultrareview [target]` subcommand.
 *
 * Expected shapes verified against the official binary strings extraction:
 *   - project: "Manage Claude Code project state"
 *   - purge [path]: "Delete all Claude Code state for a project (transcripts,
 *     tasks, file history, config entry)" with --dry-run / --all / -i
 *   - ultrareview [target]: "Run a cloud-hosted multi-agent code review of the
 *     current branch (or a PR number / base branch) and print the findings"
 *     with --json / --timeout <minutes>
 *
 * Source-grep + handler-export checks.
 */

describe("2.1.200 CLI subcommands (e2e, vs official 2.1.200)", () => {
  test("E29 main.tsx registers `project` -> `purge [path]` with official description + options", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/main.tsx`).text();
    // Command tree
    expect(src).toContain(`program.command('project').description('Manage Claude Code project state')`);
    expect(src).toContain(`command('purge [path]')`);
    expect(src).toContain(
      `Delete all Claude Code state for a project (transcripts, tasks, file history, config entry)`,
    );
    // Options (exact wording from the binary)
    expect(src).toContain(`--dry-run`, );
    expect(src).toContain(`List what would be deleted without deleting`);
    expect(src).toContain(`--all`, );
    expect(src).toContain(`Purge state for every project (mutually exclusive with [path])`);
    expect(src).toContain(`-i, --interactive`);
    // Action wires to the handler
    expect(src).toContain(`purgeProjectHandler`);
    expect(src).toContain(`./cli/handlers/projectPurge.js`);
  });

  test("E29 purgeProjectHandler is exported and matches binary wording", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/cli/handlers/projectPurge.ts");
const src = await Bun.file("${REPO_ROOT}/src/cli/handlers/projectPurge.ts").text();
console.log(JSON.stringify({
  exported: typeof m.purgeProjectHandler === "function",
  hasNothingFound: src.includes("No Claude Code project state found"),
  hasPurgePlan: src.includes("Purge plan for"),
  hasDryRun: src.includes("Dry run:"),
  hasInteractiveAllGuard: src.includes("Cannot use -i/--interactive with --all."),
  hasConfigKey: src.includes('config: projects["'),
  hasNothingFoundTelemetry: src.includes("cli_purge_project_nothing_found"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.exported).toBe(true);
    expect(out.hasNothingFound).toBe(true);
    expect(out.hasPurgePlan).toBe(true);
    expect(out.hasDryRun).toBe(true);
    expect(out.hasInteractiveAllGuard).toBe(true);
    expect(out.hasConfigKey).toBe(true);
    expect(out.hasNothingFoundTelemetry).toBe(true);
  });

  test("E29 purgeProjectHandler --dry-run on empty state reports nothing found", async () => {
    // Use a temp config home so we don't touch real state.
    const script = `
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "occ-purge-"));
process.env.CLAUDE_CONFIG_DIR = home;
// Re-import config so it picks up the new dir
const mod = await import("${REPO_ROOT}/src/cli/handlers/projectPurge.ts");
const lines = [];
const orig = console.log;
console.log = (...a) => lines.push(a.join(" "));
await mod.purgeProjectHandler("/tmp/nonexistent-project-path", { dryRun: true });
console.log = orig;
console.log(lines.join("\\n"));
`;
    const stdout = (await $`bun -e ${script}`.quiet()).stdout.toString().trim();
    expect(stdout).toContain("No Claude Code project state found");
  });

  test("E30 main.tsx registers `ultrareview [target]` with official description + options", async () => {
    const src = await Bun.file(`${REPO_ROOT}/src/main.tsx`).text();
    expect(src).toContain(`command('ultrareview [target]')`);
    expect(src).toContain(
      `Run a cloud-hosted multi-agent code review of the current branch (or a PR number / base branch) and print the findings`,
    );
    expect(src).toContain(`--json`);
    expect(src).toContain(`Print the raw bugs.json payload instead of formatted findings`);
    expect(src).toContain(`--timeout <minutes>`);
    expect(src).toContain(`Maximum minutes to wait for the review to finish (default: 30)`);
    expect(src).toContain(`ultrareviewHandler`);
    expect(src).toContain(`./cli/handlers/ultrareview.js`);
  });

  test("E30 ultrareviewHandler is exported and matches binary wording", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/cli/handlers/ultrareview.ts");
const src = await Bun.file("${REPO_ROOT}/src/cli/handlers/ultrareview.ts").text();
console.log(JSON.stringify({
  exported: typeof m.ultrareviewHandler === "function",
  hasLaunchFailed: src.includes("Ultrareview could not launch"),
  hasCliTelemetry: src.includes("cli_ultrareview"),
  hasLaunchFailedTelemetry: src.includes("cli_ultrareview_launch_failed"),
  hasDefaultTimeout30: src.includes("30"),
  hasSigInt130: src.includes("130"),
}));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.exported).toBe(true);
    expect(out.hasLaunchFailed).toBe(true);
    expect(out.hasCliTelemetry).toBe(true);
    expect(out.hasLaunchFailedTelemetry).toBe(true);
    expect(out.hasDefaultTimeout30).toBe(true);
    expect(out.hasSigInt130).toBe(true);
  });
});
