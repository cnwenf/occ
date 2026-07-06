import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.200 command-domain gaps (e2e):
 *   E19 (2.1.117): /model persists across restarts + startup pin header
 *   E23 (2.1.117+2.1.122): /resume offers to summarize stale large sessions +
 *                          pasting a PR URL finds the creating session
 *   E25 (2.1.92): /release-notes is an interactive "What's new" version picker
 *
 * Source-grep + behavior checks. Env (`NODE_ENV=test`, dummy API key,
 * `ANTHROPIC_MODEL` unset) is set inside each script so auth-gated
 * default-model resolution and the env-var > settings priority don't mask the
 * persisted settings.model read.
 */

const ENV = {
  NODE_ENV: "test",
  ANTHROPIC_API_KEY: "sk-test-e2e",
};

// ---------------------------------------------------------------------------
// E19 (2.1.117): /model persist across restarts + startup pin header
// ---------------------------------------------------------------------------
describe("E19 (2.1.117) /model persist + startup pin header", () => {
  test("source: picker pin header + inline session-scoped wording", () => {
    const src = readFileSync(join(REPO_ROOT, "src/commands/model/model.tsx"), "utf-8");
    // E19: the picker header explains the pick becomes the default (pinned) for
    // new sessions — i.e. it persists across restarts. Mirrors the 2.1.200
    // binary ModelPicker header text.
    expect(src).toContain("Your pick becomes the default for new sessions");
    expect(src).toContain("MODEL_PICKER_PIN_HEADER");
    expect(src).toContain("headerText={MODEL_PICKER_PIN_HEADER}");
    // E19: inline `/model <name>` is session-scoped (not persisted) — only the
    // picker "set as default" path persists. Mirrors the 2.1.200 binary:
    // `Model set to X (session-scoped, not persisted)`.
    expect(src).toContain("session-scoped, not persisted");
    // E19: `/model default` reset wording (binary: `Model reset to default for
    // this session`).
    expect(src).toContain("Model reset to default for this session");
    // E18 (kept): picker Enter persists to user settings.
    expect(src).toContain("updateSettingsForSource");
    expect(src).toContain("and saved as your default for new sessions");
  });

  test("behavior: saved settings.model is read at startup (persist roundtrip)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "occ-e19-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-opus-4-8" }));
    const script = `
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "sk-test-e2e";
delete process.env.ANTHROPIC_MODEL;           // env-var > settings: clear it
process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(dir)};
const { getUserSpecifiedModelSetting } = await import("${REPO_ROOT}/src/utils/model/model.ts");
const before = getUserSpecifiedModelSetting();
const { updateSettingsForSource } = await import("${REPO_ROOT}/src/utils/settings/settings.ts");
const r = updateSettingsForSource("userSettings", { model: "claude-sonnet-5" });
const after = getUserSpecifiedModelSetting();
console.log(JSON.stringify({ before, writeErr: r.error && r.error.message, after }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.before).toBe("claude-opus-4-8"); // settings.model read at startup
    expect(out.writeErr).toBeNull();
    expect(out.after).toBe("claude-sonnet-5"); // persist survives a re-read
  });
});

// ---------------------------------------------------------------------------
// E23 (2.1.117+2.1.122): /resume summarize stale + PR-URL search
// ---------------------------------------------------------------------------
describe("E23 (2.1.117+2.1.122) /resume summarize-stale + PR-URL search", () => {
  test("source: parsePrUrl + isStaleLargeSession + findSessionsByPrUrl + offer", () => {
    const src = readFileSync(join(REPO_ROOT, "src/commands/resume/resume.tsx"), "utf-8");
    // E23: PR URL parsing (binary regex `\/([^/]+)\/([^/]+)\/pull\/`).
    expect(src).toContain("parsePrUrl");
    expect(src).toContain("/pull/");
    expect(src).toContain("prRepository");
    expect(src).toContain("prNumber");
    expect(src).toContain("findSessionsByPrUrl");
    // E23: stale-large detection thresholds.
    expect(src).toContain("STALE_SESSION_AGE_DAYS");
    expect(src).toContain("LARGE_SESSION_MESSAGE_THRESHOLD");
    expect(src).toContain("isStaleLargeSession");
    // E23: the summarize offer + /compact queue on accept.
    expect(src).toContain("SummarizeStaleOffer");
    expect(src).toContain("Summarize it before resuming");
    expect(src).toContain("onResumeAndSummarize");
    expect(src).toContain("nextInput: '/compact'");
  });

  test("behavior: parsePrUrl extracts owner/repo/number; null for non-PR", async () => {
    const script = `
const { parsePrUrl } = await import("${REPO_ROOT}/src/commands/resume/resume.tsx");
const a = parsePrUrl("https://github.com/anthropics/claude-code/pull/123");
const b = parsePrUrl("not a url");
const c = parsePrUrl("https://reviews.example.test/acme/widget/pull/9");
console.log(JSON.stringify({ a, b, c }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.a).toEqual({ repository: "anthropics/claude-code", number: 123 });
    expect(out.b).toBeNull();
    expect(out.c).toEqual({ repository: "acme/widget", number: 9 });
  });

  test("behavior: isStaleLargeSession flags old+large only", async () => {
    const script = `
const { isStaleLargeSession } = await import("${REPO_ROOT}/src/commands/resume/resume.tsx");
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const oldLarge = { messageCount: 60, modified: new Date(now - 10 * day) };
const small = { messageCount: 5, modified: new Date(now - 10 * day) };
const recentLarge = { messageCount: 60, modified: new Date(now - 1 * day) };
console.log(JSON.stringify({
  oldLarge: isStaleLargeSession(oldLarge, now),
  small: isStaleLargeSession(small, now),
  recentLarge: isStaleLargeSession(recentLarge, now),
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.oldLarge).toBe(true);
    expect(out.small).toBe(false);
    expect(out.recentLarge).toBe(false);
  });

  test("behavior: findSessionsByPrUrl matches prNumber + prRepository", async () => {
    const script = `
const { findSessionsByPrUrl } = await import("${REPO_ROOT}/src/commands/resume/resume.tsx");
const logs = [
  { prNumber: 123, prRepository: "anthropics/claude-code", messageCount: 1, modified: new Date() },
  { prNumber: 999, prRepository: "other/repo", messageCount: 1, modified: new Date() },
  { prNumber: 123, prRepository: "wrong/repo", messageCount: 1, modified: new Date() },
];
const hits = findSessionsByPrUrl(logs, { repository: "anthropics/claude-code", number: 123 });
console.log(JSON.stringify({ count: hits.length, repo: hits[0]?.prRepository, num: hits[0]?.prNumber }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.count).toBe(1);
    expect(out.repo).toBe("anthropics/claude-code");
    expect(out.num).toBe(123);
  });
});

// ---------------------------------------------------------------------------
// E25 (2.1.92): /release-notes interactive "What's new" version picker
// ---------------------------------------------------------------------------
describe("E25 (2.1.92) /release-notes interactive picker", () => {
  test("source: local-jsx + requires ink + 'View release notes'", () => {
    const src = readFileSync(join(REPO_ROOT, "src/commands/release-notes/index.ts"), "utf-8");
    expect(src).toContain("type: 'local-jsx'");
    expect(src).toContain("requires: { ink: true }");
    expect(src).toContain("View release notes");
  });

  test("source: What's new panel — title / footer / emptyMessage", () => {
    const src = readFileSync(
      join(REPO_ROOT, "src/commands/release-notes/release-notes.tsx"),
      "utf-8",
    );
    expect(src).toContain("What's new");
    expect(src).toContain("/release-notes for more");
    expect(src).toContain("Check the Claude Code changelog for updates");
    expect(src).toContain("ReleaseNotesPanel");
    expect(src).toContain("LocalJSXCommandCall");
  });

  test("behavior: load() returns a local-jsx module with call()", async () => {
    const script = `
const mod = await import("${REPO_ROOT}/src/commands/release-notes/index.ts");
const cmd = mod.default;
const loaded = await cmd.load();
console.log(JSON.stringify({ type: cmd.type, requires: cmd.requires, hasCall: typeof loaded.call === "function" }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet().env(ENV)).stdout.toString().trim(),
    );
    expect(out.type).toBe("local-jsx");
    expect(out.requires).toEqual({ ink: true });
    expect(out.hasCall).toBe(true);
  });
});
