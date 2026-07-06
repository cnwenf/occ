import { describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * Trust gate e2e (tmux-based). Exercises the first-run workspace trust dialog
 * and the Bypass Permissions mode acceptance dialog — the security-critical
 * gates that the rest of the e2e suite deliberately pre-seeds/skips.
 *
 * Each test boots the BUILT dist/cli.js inside tmux against a FRESH temp HOME
 * seeded with `hasCompletedOnboarding:true` (so the theme picker / security
 * notes are skipped) but with NO trust and NO skipDangerousModePermissionPrompt
 * for the project — so the trust dialog (and, with --dangerously-skip-permissions,
 * the bypass dialog) MUST appear.
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-trust-test";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function sessionAlive(): boolean {
  try {
    return execSync("tmux list-sessions 2>/dev/null", { encoding: "utf8" }).includes(SESSION);
  } catch {
    return false;
  }
}

/** A fresh temp HOME seeded to skip onboarding but NOT trust / bypass acceptance. */
function freshSeededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "occ-trust-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-06T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-trust-seed-0000000000000000000000000000000000000000000000aa",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.200",
      lastReleaseNotesSeen: "2.1.200",
      projects: {},
    }),
  );
  return home;
}

function startRepl(home: string, extraArgs: string[] = []) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  const envStr = Object.entries(process.env)
    .filter(([k]) => k.startsWith("ANTHROPIC"))
    .map(([k, v]) => `${k}='${v}'`)
    .join(" ");
  const args = extraArgs.join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env HOME='${home}' ${envStr} ${BIN} ${args}"`,
    { timeout: 5_000 },
  );
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")]);
}

function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
}

/** Poll capture-pane until `substr` appears or timeout. */
async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capturePane().toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Poll until the tmux session is gone (the CLI exited). */
async function waitForExit(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sessionAlive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function readSettingsTrust(home: string): { trust?: boolean; bypass?: boolean } {
  const cfgPath = join(home, ".claude.json");
  const settingsPath = join(home, ".claude", "settings.json");
  const out: { trust?: boolean; bypass?: boolean } = {};
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const projects = cfg.projects ?? {};
      // trust is stored per-project; find any project with the flag.
      for (const k of Object.keys(projects)) {
        if (projects[k]?.hasTrustDialogAccepted) out.trust = true;
      }
    } catch {}
  }
  if (existsSync(settingsPath)) {
    try {
      out.bypass = !!JSON.parse(readFileSync(settingsPath, "utf8")).skipDangerousModePermissionPrompt;
    } catch {}
  }
  return out;
}

describe.skipIf(!!process.env.CI)("Trust gate (tmux e2e, fresh HOME)", () => {
  test("fresh project shows trust dialog; default Enter accepts → prompt", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      const pane = capturePane();
      expect(pane).toContain("Yes, I trust this folder");
      expect(pane).toContain("No, exit");

      // Default cursor is on "Yes" (first option) → Enter accepts.
      sendKeys("Enter");
      expect(await waitForText("for shortcuts", 15_000)).toBe(true);

      // Trust persisted to .claude.json
      expect(readSettingsTrust(home).trust).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("second boot in same HOME skips the trust dialog", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      sendKeys("Enter"); // accept
      expect(await waitForText("for shortcuts", 15_000)).toBe(true);
      killRepl();

      // Reboot in the same HOME — trust already persisted.
      startRepl(home);
      expect(await waitForText("for shortcuts", 15_000)).toBe(true);
      expect(capturePane().toLowerCase()).not.toContain("quick safety check");
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("'No, exit' exits the session", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      sendKeys("Down"); // move to "No, exit"
      sendKeys("Enter");
      expect(await waitForExit(10_000)).toBe(true);
      // Decline must NOT persist trust.
      expect(readSettingsTrust(home).trust).not.toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);

  test("bypass dialog: default cursor = 'No, exit'; Enter exits, no persist", async () => {
    const home = freshSeededHome();
    startRepl(home, ["--dangerously-skip-permissions"]);
    try {
      // Trust dialog first (always shown).
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      sendKeys("Enter"); // accept trust
      // Bypass dialog next.
      expect(await waitForText("Bypass Permissions mode", 15_000)).toBe(true);
      const pane = capturePane();
      expect(pane).toContain("No, exit");
      expect(pane).toContain("Yes, I accept");
      // Default cursor is "No, exit" → Enter declines → exit.
      sendKeys("Enter");
      expect(await waitForExit(10_000)).toBe(true);
      expect(readSettingsTrust(home).bypass).not.toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("bypass accept persists (one-time); second boot skips bypass dialog", async () => {
    const home = freshSeededHome();
    startRepl(home, ["--dangerously-skip-permissions"]);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      sendKeys("Enter"); // accept trust
      expect(await waitForText("Bypass Permissions mode", 15_000)).toBe(true);
      sendKeys("Down"); // move to "Yes, I accept"
      sendKeys("Enter");
      // Bypass-mode prompt footer contains "shift+tab".
      expect(await waitForText("shift+tab", 15_000)).toBe(true);
      expect(readSettingsTrust(home).bypass).toBe(true);
      killRepl();

      // Reboot: trust + bypass acceptance persisted → straight to bypass prompt.
      startRepl(home, ["--dangerously-skip-permissions"]);
      expect(await waitForText("shift+tab", 15_000)).toBe(true);
      expect(capturePane().toLowerCase()).not.toContain("bypass permissions mode");
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
