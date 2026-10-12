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
 * - Shift+Tab permission mode cycling with official indicator chips
 *   (bypassPermissions → auto → default/manual → acceptEdits → plan)
 * - Auto-mode entry banner (official 2.1.296 — legacy opt-in dialog removed)
 * - /goal panel open + Escape dismiss
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
  // When ANTHROPIC_API_KEY is forwarded into the spawned REPL (the test's
  // startRepl passes the full parent env), OCC detects the custom key and
  // shows the "Detected a custom API key / Do you want to use this API key?"
  // approval dialog BEFORE the welcome screen — which makes waitForText(
  // "shift+tab") time out and every REPL test fail with an empty pane. Pre-
  // approve the key's truncated form (last 20 chars, matching
  // normalizeApiKeyForConfig in src/utils/authPortable.ts →
  // getCustomApiKeyStatus in src/utils/config.ts) so the dialog is suppressed
  // and the REPL goes straight to the welcome. This mirrors what a real user's
  // ~/.claude.json accumulates after answering the dialog once.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ-repl-seed-0000000000000000000000000000000000000000000000aa",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.200",
    lastReleaseNotesSeen: "2.1.200",
    projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
  };
  if (apiKey && apiKey.length >= 20) {
    config.customApiKeyResponses = {
      approved: [apiKey.slice(-20)],
      rejected: [],
    };
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify(config));
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
  /**
   * The footer permission-mode chip ("⏸ manual mode on · …", "⏵⏵ accept
   * edits on · …") is the authoritative mode indicator. capture-pane uses
   * -S - (scrollback included), so older frames still contain previous chip
   * text — scan from the BOTTOM and take the last chip-like line instead of
   * doing whole-pane substring checks.
   */
  function currentModeChip(): string {
    const lines = capturePane().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (/(mode on|edits on|permissions on)/.test(line)) return line
    }
    return ""
  }

  /** Poll until the footer chip contains `label` (official indicator text). */
  async function waitForChip(label: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (currentModeChip().includes(label)) return true
      await new Promise(r => setTimeout(r, 200))
    }
    return false
  }

  test("Shift+Tab cycles through permission modes", async () => {
    const home = freshSeededHome();
    startRepl(home)
    try {
      // Wait for REPL to render
      await waitForText("shift+tab", 20_000)

      // Booted with --dangerously-skip-permissions → bypassPermissions.
      // Official 2.1.296 carousel (getNextPermissionMode, live-verified
      // against the official binary's indicator table):
      //   bypassPermissions → auto → default(manual) → acceptEdits → plan → bypassPermissions
      expect(await waitForChip("bypass permissions on", 5_000)).toBe(true)

      const cycle = [
        "auto mode on",
        "manual mode on",
        "accept edits on",
        "plan mode on",
        "bypass permissions on",
      ]
      for (const chip of cycle) {
        sendKeys("S-Tab")
        expect(await waitForChip(chip, 5_000)).toBe(true)
      }
    } finally {
      killRepl()
      rmSync(home, { recursive: true, force: true })
    }
  }, 30_000)

  test("entering auto mode via carousel shows the auto-mode banner and no legacy opt-in dialog", async () => {
    // Official 2.1.296 contract (binary forensics): the old 4-option
    // "Enable auto mode?" opt-in dialog was REMOVED from the official binary
    // (0 string hits) and is dead in OCC (hasAutoModeOptIn() ≡ true since the
    // TRANSCRIPT_CLASSIFIER allowlist entry). Entering auto mode through the
    // Shift+Tab carousel instead emits the official auto-mode description
    // banner into the transcript (REPL.tsx createSystemMessage with
    // getAutoModeDescription()).
    const home = freshSeededHome();
    startRepl(home)
    try {
      await waitForText("shift+tab", 20_000)

      // Cycle with Shift+Tab until the footer chip reports auto mode.
      for (let i = 0; i < 8; i++) {
        sendKeys("S-Tab")
        if (await waitForChip("auto mode on", 2_000)) {
          // The official description banner appears in the transcript.
          expect(
            await waitForText(
              "Auto mode lets Claude handle permission prompts automatically",
              5_000,
            ),
          ).toBe(true)
          // The legacy opt-in dialog must NOT render.
          const pane = capturePane()
          expect(pane).not.toContain("Enable auto mode?")
          expect(pane).not.toContain("Yes, and make it my default mode")
          return
        }
      }
      // Auto mode never became the active chip — fail.
      expect(currentModeChip()).toContain("auto mode on")
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
