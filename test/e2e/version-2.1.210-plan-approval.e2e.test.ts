import { describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.210 #12 — plan-approval label + no-clobber (tmux behavioral e2e).
 *
 * Bugs ported:
 *  - Bug 1: an unedited plan approval was mislabeled "Approved Plan (edited
 *    by user)" because normalizeToolInput injects `plan` from disk
 *    pre-permission, so the tool saw `inputPlan` as set even without a user
 *    edit.
 *  - Bug 2: that injected snapshot was written back to the plan file at
 *    approval time.
 *
 * Flow: start the REPL in plan mode, drive a real model turn that calls
 * ExitPlanMode, then approve via Shift+Tab (the deterministic "auto-accept
 * edits / keep context" shortcut in ExitPlanModePermissionRequest). The
 * keep-context path calls `onAllow(updatedInput)`:
 *   - no edit  -> updatedInput = {}            -> "Approved Plan", no clobber
 *   - Ctrl+G   -> updatedInput = { plan }      -> "Approved Plan (edited by user)"
 *
 * Gated out of CI (needs tmux + model creds + a built dist/cli.js).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-plan-approval-test";

const hasCreds = !!(
  process.env.ANTHROPIC_API_KEY ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.CLAUDE_CODE_USE_BEDROCK ||
  process.env.CLAUDE_CODE_USE_VERTEX
);
const tmuxOk = (() => {
  try { execSync("tmux -V", { stdio: "ignore", timeout: 2_000 }); return true; } catch { return false; }
})();
const distOk = existsSync(BIN);
const SKIP = !!process.env.CI || !hasCreds || !tmuxOk || !distOk;

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 15_000 });
  } catch {
    return "";
  }
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

/**
 * Start the REPL in plan mode inside a temp project. `extraEnv` carries
 * per-test env (e.g. EDITOR for the Ctrl+G case).
 */
function startRepl(home: string, projectDir: string, extraEnv: Record<string, string> = {}) {
  killRepl();
  const envStr = Object.entries({ ...process.env, HOME: home, ...extraEnv })
    .filter(([k]) =>
      // Keep ANTHROPIC_* + the per-test extras; drop nothing critical.
      k.startsWith("ANTHROPIC") || k === "HOME" || k in extraEnv ||
      k === "CLAUDE_CODE_USE_BEDROCK" || k === "CLAUDE_CODE_USE_VERTEX" ||
      k === "CLAUDE_CONFIG_DIR" || k === "PATH",
    )
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 -c ${projectDir} ` +
      `"env ${envStr} bun ${BIN} --append-system-prompt 'You are in plan mode. After reading any files, you MUST immediately call the ExitPlanMode tool to present a short plan. Do not write any files.' "`,
    { timeout: 5_000 },
  );
}

function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")]);
}
function sendLine(text: string) {
  tmux(["send-keys", "-t", SESSION, text, "Enter"]);
}
function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
}

/** Poll capture-pane until `substr` appears or timeout. */
async function waitForText(substr: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane();
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Seed a temp HOME that has completed onboarding + trusts the temp project. */
function freshSeededHome(projectDir: string): string {
  const home = mkdtempSync(join(tmpdir(), "occ-plan-app-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-06T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-plan-app-seed-000000000000000000000000000000000000000000a",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.200",
      lastReleaseNotesSeen: "2.1.200",
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    }),
  );
  // Start in plan mode so the model calls ExitPlanMode; disable hooks so the
  // e2e isn't perturbed by user hooks.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ disableAllHooks: true, defaultMode: "plan" }),
  );
  return home;
}

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "occ-plan-proj-"));
  writeFileSync(join(dir, "target.txt"), "existing content\n");
  return dir;
}

describe.skipIf(SKIP)("2.1.210 plan-approval label (tmux e2e)", () => {
  test("approve WITHOUT edit -> 'Approved Plan' (no edited-by-user suffix)", async () => {
    const project = freshProject();
    const home = freshSeededHome(project);
    startRepl(home, project);
    try {
      await waitForText("shift+tab", 25_000);
      // Drive a plan-eliciting turn.
      sendLine("Read target.txt, then present a one-step plan to add a greeting comment at the top of target.txt.");
      // Wait for the ExitPlanMode approval dialog.
      await waitForText("exit plan mode", 60_000);
      // Approve with no edit via Shift+Tab (auto-accept-edits keep-context).
      sendKeys("S-Tab");
      // The tool_result renders the label.
      const ok = await waitForText("approved plan", 60_000);
      expect(ok).toBe(true);
      const pane = capturePane();
      // Bug 1: an unedited approval must NOT carry the edited-by-user suffix.
      expect(pane).not.toContain("(edited by user)");
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 180_000);

  test("approve WITH edit (Ctrl+G) -> 'Approved Plan (edited by user)'", async () => {
    const project = freshProject();
    const home = freshSeededHome(project);
    // Non-interactive EDITOR: append a marker line to the plan file, then exit.
    const editorScript = join(home, "edit-plan.sh");
    writeFileSync(editorScript, "#!/bin/sh\nprintf '\\n[plan edited by user via Ctrl-G]\\n' >> \"$1\"\n");
    execSync(`chmod +x ${editorScript}`);
    startRepl(home, project, { EDITOR: editorScript });
    try {
      await waitForText("shift+tab", 25_000);
      sendLine("Read target.txt, then present a one-step plan to add a greeting comment at the top of target.txt.");
      await waitForText("exit plan mode", 60_000);
      // Edit the plan in the external editor via Ctrl+G, then approve.
      sendKeys("C-g");
      await new Promise((r) => setTimeout(r, 1500));
      sendKeys("S-Tab");
      const ok = await waitForText("approved plan (edited by user)", 60_000);
      expect(ok).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 180_000);
});
