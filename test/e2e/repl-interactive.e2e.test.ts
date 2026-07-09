import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * REPL interactive e2e (tmux-based). Drives the BUILT dist/cli.js inside a
 * tmux session, sending real keystrokes (Shift+Tab, Escape, Enter) and
 * reading the decoded pane output via `tmux capture-pane -p`.
 *
 * This tests REPL-only features that -p mode can't reach:
 * - Shift+Tab permission mode cycling (default → acceptEdits → plan → auto)
 * - /goal panel open + Escape dismiss
 * - /feedback dialog
 * - /context interactive panel
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-repl-test"

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 })
  } catch {
    return ""
  }
}

function startRepl(home: string) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
  // Pass the FULL parent env (so CLAUDE_CODE_BUBBLEWRAP / IS_SANDBOX that
  // allow --dangerously-skip-permissions under root are preserved — tmux does
  // NOT re-export the parent env by default) but override HOME to the temp dir
  // so the CLI reads the seeded .claude.json + .claude/settings.json instead
  // of the real user config (which may have defaultMode:"auto" /
  // skipAutoPermissionPrompt and falsely suppress the auto-mode opt-in dialog).
  const envStr = Object.entries({ ...process.env, HOME: home })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN} --dangerously-skip-permissions"`,
    { timeout: 5_000 },
  )
}

/**
 * Fresh temp HOME seeded to skip onboarding + bypass-acceptance + hooks, but
 * WITHOUT pre-enabling auto mode (no `skipAutoPermissionPrompt`, no
 * `autoModeOptInDismissed`, no `defaultMode: "auto"`) so the auto-mode opt-in
 * dialog CAN appear on Shift+Tab. Mirrors the isolation pattern in
 * trust-gate/goal-gate e2e tests.
 */
function freshSeededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "occ-repl-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-06T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-repl-seed-0000000000000000000000000000000000000000000000aa",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.200",
      lastReleaseNotesSeen: "2.1.200",
      projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
    }),
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableAllHooks: true,
    }),
  );
  return home;
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`)
}

function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")])
}

function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"])
}

/** Poll capture-pane until `substr` appears or timeout. */
async function waitForText(substr: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pane = capturePane()
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

describe.skipIf(!!process.env.CI)("REPL interactive (tmux e2e)", () => {
  test("Shift+Tab cycles through permission modes", async () => {
    const home = freshSeededHome();
    startRepl(home)
    try {
      // Wait for REPL to render
      await waitForText("shift+tab", 20_000)

      // Capture initial state
      const before = capturePane()

      // Send Shift+Tab (tmux: S-Tab)
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after1 = capturePane()

      // Send again
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after2 = capturePane()

      // Send again — should eventually reach auto or cycle back
      sendKeys("S-Tab")
      await new Promise(r => setTimeout(r, 500))
      const after3 = capturePane()

      // At least one of the mode strings should differ from initial
      const modes = ["default", "acceptEdits", "plan", "auto", "bypass"]
      const found = [after1, after2, after3].some(pane =>
        modes.some(m => pane.toLowerCase().includes(m.toLowerCase()) && !before.toLowerCase().includes(m.toLowerCase())),
      )
      expect(found).toBe(true)
    } finally {
      killRepl()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  test("Shift+Tab shows the auto-mode opt-in dialog", async () => {
    const home = freshSeededHome();
    startRepl(home)
    try {
      await waitForText("shift+tab", 20_000)

      // Cycle through modes with Shift+Tab until the auto-mode opt-in dialog
      // appears. Assert on the dialog TITLE ("Enable auto mode?") — not on the
      // bare substring "auto", which is also matched by the dialog body text
      // and would pass even when auto mode is NOT actually active (the dialog
      // explicitly does not activate the classifier until the user confirms).
      for (let i = 0; i < 8; i++) {
        sendKeys("S-Tab")
        if (await waitForText("enable auto mode?", 2_000)) {
          const pane = capturePane()
          // All four options render (the 4th is gated on !declineExits, which
          // is false in the REPL carousel, so "No, don't ask again" shows).
          expect(pane).toContain("Yes, and make it my default mode")
          expect(pane).toContain("Yes, enable auto mode")
          expect(pane).toMatch(/No, (go back|exit)/)
          expect(pane).toContain("No, don't ask again")
          return
        }
      }
      // If the dialog never appeared, fail.
      expect(false).toBe(true)
    } finally {
      killRepl()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  test("/goal panel opens and Escape dismisses it", async () => {
    const home = freshSeededHome();
    startRepl(home)
    try {
      await waitForText("shift+tab", 20_000)

      // Type /goal and Enter
      tmux(["send-keys", "-t", SESSION, "/goal", "Enter"])
      await waitForText("Goal", 5_000)

      // Panel should be visible
      const panel = capturePane()
      expect(panel.toLowerCase()).toMatch(/goal|no goal set/i)

      // Send Escape to dismiss
      sendKeys("Escape")
      await new Promise(r => setTimeout(r, 500))

      // After Escape, the prompt input should be back (shift+tab visible)
      const after = capturePane()
      expect(after.toLowerCase()).toContain("shift+tab")
    } finally {
      killRepl()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)
})
