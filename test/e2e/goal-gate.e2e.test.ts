import { describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * /goal trusted/hooks gate e2e (tmux-based). Verifies the G1 gate (mirrors
 * official `z4o`): /goal must refuse to set a goal in an untrusted workspace
 * or when hooks are restricted, returning the official verbatim message and
 * NOT mutating goal state. Covers the REPL path (the gate is a command-level
 * check exercised via the interactive prompt).
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-goal-gate-test";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}
function startRepl(home: string) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  const envStr = Object.entries(process.env)
    .filter(([k]) => k.startsWith("ANTHROPIC"))
    .map(([k, v]) => `${k}='${v}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env HOME='${home}' ${envStr} ${BIN}"`,
    { timeout: 5_000 },
  );
}
function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}
function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")]);
}
/** Send a literal text string (with spaces) as a single tmux arg, then Enter. */
function sendLine(text: string) {
  tmux(["send-keys", "-t", SESSION, text, "Enter"]);
}
function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
}
async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capturePane().toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** onboarding-complete seed; trustForOcc controls whether /occ is pre-trusted. */
function freshSeededHome(opts: { trustForOcc?: boolean; disableAllHooks?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), "occ-goalgate-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const projects = opts.trustForOcc
    ? { "/occ": { hasTrustDialogAccepted: true } }
    : {};
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-06T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-goalgate-seed-00000000000000000000000000000000000000000aa",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.200",
      lastReleaseNotesSeen: "2.1.200",
      projects,
    }),
  );
  if (opts.disableAllHooks) {
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true }));
  }
  return home;
}

describe.skipIf(!!process.env.CI)("/goal trusted/hooks gate (tmux e2e)", () => {
  // NOTE on the trust branch: in the REPL, an untrusted workspace shows the
  // trust dialog BEFORE the prompt, so /goal cannot be reached untrusted; and
  // -p mode sets session trust (the trust dialog is skipped), so
  // checkHasTrustDialogAccepted() is true there too. The trust branch of
  // goalGate is therefore defense-in-depth (mirrors official z4o, not
  // practically reachable through normal flows). The hooks branch IS reachable
  // and is exercised below; both branches use the official verbatim messages.

  test("disableAllHooks: /goal <cond> is blocked, goal not set", async () => {
    const home = freshSeededHome({ trustForOcc: true, disableAllHooks: true });
    startRepl(home);
    try {
      expect(await waitForText("for shortcuts", 20_000)).toBe(true);
      sendLine("/goal make all tests pass");
      // Official verbatim hooks-gate message.
      expect(await waitForText("hooks are restricted", 8_000)).toBe(true);
      // Goal must NOT have been set — re-open /goal shows "No goal set".
      sendLine("/goal");
      expect(await waitForText("no goal set", 5_000)).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("trusted + hooks enabled: /goal <cond> is NOT blocked by the gate", async () => {
    const home = freshSeededHome({ trustForOcc: true });
    startRepl(home);
    try {
      expect(await waitForText("for shortcuts", 20_000)).toBe(true);
      sendLine("/goal make all tests pass");
      // The gate messages must NOT appear; "Goal set:" acks the set.
      // (This triggers a model query — the ack renders before the model replies.)
      expect(await waitForText("Goal set: make all tests pass", 15_000)).toBe(true);
      const pane = capturePane();
      expect(pane).not.toContain("only available in trusted workspaces");
      expect(pane).not.toContain("hooks are restricted");
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
