import { describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
 * UPDATED (OCC-114 acceptance): since the 2.1.218-alignment V2 dialog, the
 * pane renders the summary chrome "User approved Claude's plan" for BOTH
 * cases; the "Approved Plan[(edited by user)]" label survives only in the
 * tool_result content (ExitPlanModeV2Tool planLabel) that is sent to the
 * model and persisted in the session transcript — so the label assertions
 * read ~/.claude/projects/**\/*.jsonl under the seeded home.
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

/**
 * Wait for the V2 "Ready to code?" dialog, approving any incidental file
 * permission prompt ("Do you want to proceed?" — e.g. a Read outside the
 * trusted set) that renders on the way. The plan dialog itself asks
 * "Would you like to proceed?" so the watcher can never confuse the two.
 */
async function waitForPlanDialog(timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane().toLowerCase();
    if (pane.includes("ready to code?")) return true;
    if (pane.includes("do you want to proceed?")) {
      sendKeys("Enter"); // "1. Yes" is the focused default
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * Concatenate every session transcript JSONL under the seeded home. The
 * ExitPlanMode tool_result (with the "Approved Plan" label) is persisted
 * there; the V2 pane renders only the summary chrome ("User approved
 * Claude's plan"), so the label assertion reads the transcript.
 */
function readTranscripts(home: string): string {
  const projRoot = join(home, ".claude", "projects");
  if (!existsSync(projRoot)) return "";
  let out = "";
  for (const entry of readdirSync(projRoot, { recursive: true }) as string[]) {
    const p = join(projRoot, entry);
    if (p.endsWith(".jsonl") && existsSync(p)) {
      try { out += readFileSync(p, "utf8"); } catch { /* being written */ }
    }
  }
  return out;
}

/** Poll the transcripts until `needle` appears (label flush lags the pane). */
async function waitForTranscriptText(home: string, needle: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readTranscripts(home).includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Seed a temp HOME that has completed onboarding + trusts the temp project. */
function freshSeededHome(projectDir: string): string {
  const home = mkdtempSync(join(tmpdir(), "occ-plan-app-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  // UPDATED (OCC-114 acceptance): pre-approve an inherited ANTHROPIC_API_KEY
  // (official truncation: last 20 chars). Without this seed, environments
  // that export a real key boot into the "Detected a custom API key"
  // approval dialog and the REPL never reaches plan mode — both tests then
  // time out on waitForText. Same harness fix as the screen-reader e2e.
  const envApiKey = process.env.ANTHROPIC_API_KEY;
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
      // UPDATED (OCC-115 acceptance F-fix): seed the auto-default-nudge
      // one-shot flag. This home completes onboarding AND pins a non-auto
      // userSettings permissions.defaultMode ("plan", below) — exactly the
      // 2.1.296 nudge gate (`aMr`) — so without the flag the nudge modal
      // blocks the REPL at startup and swallows the first prompt (both tests
      // timed out in waitForPlanDialog). This test verifies plan-approval
      // labels and no-clobber, not the nudge (which has its own e2e:
      // version-2.1.296-auto-default-nudge.e2e.test.ts).
      hasSeenAutoDefaultNudge: true,
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
      ...(envApiKey && envApiKey.length >= 20
        ? {
            customApiKeyResponses: {
              approved: [envApiKey.slice(-20)],
              rejected: [],
            },
          }
        : {}),
    }),
  );
  // Start in plan mode so the model calls ExitPlanMode; disable hooks so the
  // e2e isn't perturbed by user hooks.
  // UPDATED (OCC-114 acceptance): the seed previously set a TOP-LEVEL
  // `defaultMode: "plan"` — but permissionSetup only reads the schema-valid
  // `permissions.defaultMode` (true since before this test was written), so
  // plan mode NEVER activated and the flow depended on the live model
  // honoring the appended system prompt alone (qwen3.8-max presents a text
  // plan instead of calling ExitPlanMode → both tests timed out). Seed the
  // canonical location so the REPL genuinely boots into plan mode.
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      disableAllHooks: true,
      permissions: { defaultMode: "plan" },
    }),
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
      // OCC-108: the footer no longer shows "shift+tab" (official Gn=!CQo
      // gate) — wait on the always-present mode chip instead. With
      // permissions.defaultMode=plan now genuinely active (OCC-114 fix),
      // the chip reads "plan mode on".
      await waitForText("plan mode on", 25_000);
      // Drive a plan-eliciting turn.
      sendLine("Read target.txt, then present a one-step plan to add a greeting comment at the top of target.txt.");
      // Wait for the ExitPlanMode approval dialog. UPDATED (OCC-114
      // acceptance): the 2.1.218-alignment V2 dialog (official v296 ELF
      // byte-verified: "Ready to code?" @93855112, "Yes, and use auto mode"
      // @94190972) replaced the V1 surface whose title contained
      // "exit plan mode". 120s budget: the live model (qwen3.8-max) can take
      // >60s to read the file, compose the plan and call ExitPlanMode.
      // Shift+Tab (auto-accept-edits keep-context) and Ctrl+G ($EDITOR)
      // bindings are unchanged in V2.
      const dialogShown = await waitForPlanDialog();
      expect(dialogShown).toBe(true);
      // Approve with no edit via Shift+Tab (auto-accept-edits keep-context).
      sendKeys("S-Tab");
      // UPDATED (OCC-114 acceptance): assert on the PERSISTED transcript, not
      // the pane header. The V2 pane chrome ("User approved Claude's plan")
      // is transient: approving enters auto mode and the model immediately
      // executes the plan, whose output can flood tmux scrollback past the
      // history-limit and evict the header before any poll observes it
      // (observed in the wild). The tool_result label "## Approved Plan:"
      // (ExitPlanModeV2Tool planLabel — the exact string CC 2.1.210 #12 Bug 1
      // mislabeled) is durable in ~/.claude/projects/**/*.jsonl.
      const labeled = await waitForTranscriptText(home, "## Approved Plan:", 60_000);
      expect(labeled).toBe(true);
      const pane = capturePane();
      // Bug 1: an unedited approval must NOT carry the edited-by-user suffix.
      expect(pane).not.toContain("(edited by user)");
      const mislabeled = await waitForTranscriptText(home, "Approved Plan (edited by user)", 3_000);
      expect(mislabeled).toBe(false);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 300_000);

  test("approve WITH edit (Ctrl+G) -> 'Approved Plan (edited by user)'", async () => {
    const project = freshProject();
    const home = freshSeededHome(project);
    // Non-interactive EDITOR: append a marker line to the plan file, then exit.
    const editorScript = join(home, "edit-plan.sh");
    writeFileSync(editorScript, "#!/bin/sh\nprintf '\\n[plan edited by user via Ctrl-G]\\n' >> \"$1\"\n");
    execSync(`chmod +x ${editorScript}`);
    startRepl(home, project, { EDITOR: editorScript });
    try {
      // OCC-108: the footer no longer shows "shift+tab" (official Gn=!CQo
      // gate) — wait on the mode chip instead (plan mode genuinely active
      // since the OCC-114 permissions.defaultMode seed fix).
      await waitForText("plan mode on", 25_000);
      sendLine("Read target.txt, then present a one-step plan to add a greeting comment at the top of target.txt.");
      // V2 dialog header (see the sibling test's OCC-114 note; same 120s
      // live-model budget + incidental-prompt tolerance).
      const dialogShown = await waitForPlanDialog();
      expect(dialogShown).toBe(true);
      // Edit the plan in the external editor via Ctrl+G. UPDATED (OCC-114
      // acceptance): wait for the editor round-trip to complete — the dialog
      // re-renders with the "✔Plan saved!" toast — instead of a fixed sleep.
      // Under load (test 1's REPL just tore down) the alt-screen handoff back
      // from $EDITOR can exceed 1.5s and an early Shift+Tab gets swallowed.
      sendKeys("C-g");
      const editorDone = await waitForText("plan saved!", 15_000);
      expect(editorDone).toBe(true);
      // Approve via Shift+Tab, retrying while the dialog is still up (the
      // first key can be lost to the screen handoff).
      sendKeys("S-Tab");
      // Poll the PERSISTED transcript for the edited label — the pane header
      // is transient (see the sibling test: auto-mode execution can evict it
      // from tmux scrollback). Re-send Shift+Tab while the dialog is still up
      // (the first key can be lost to the $EDITOR alt-screen handoff).
      let editedLabel = false;
      for (let attempt = 0; attempt < 8 && !editedLabel; attempt++) {
        editedLabel = await waitForTranscriptText(home, "Approved Plan (edited by user)", 8_000);
        if (!editedLabel) {
          const paneNow = capturePane().toLowerCase();
          if (paneNow.includes("would you like to proceed?") || paneNow.includes("ready to code?")) {
            sendKeys("S-Tab");
          }
        }
      }
      if (!editedLabel) {
        // Surface the pane for diagnosis (dead session → empty capture).
        throw new Error(
          "edited-plan approval never reached the transcript; pane tail:\n" +
            capturePane().split("\n").slice(-30).join("\n"),
        );
      }
      expect(editedLabel).toBe(true);
      // The Ctrl+G edit itself (marker line appended by the EDITOR script)
      // must reach the model in the echoed plan.
      const markerEchoed = await waitForTranscriptText(home, "[plan edited by user via Ctrl-G]", 5_000);
      expect(markerEchoed).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 300_000);
});
