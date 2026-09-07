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

/**
 * Dismiss the ApproveApiKey dialog when a custom ANTHROPIC_API_KEY is present in
 * the environment. Boot order is trust → api-key → bypass → REPL; the dialog's
 * default focus is "No (recommended)", so a bare Enter declines and proceeds.
 * The rejection is persisted to config, so it does not reappear on a second boot.
 * No-op when the dialog is absent (clean env / reboot).
 */
async function dismissApiKeyDialogIfPresent(): Promise<void> {
  if (await waitForText("use this api key", 4_000)) {
    await new Promise((r) => setTimeout(r, 300));
    sendKeys("Enter");
  }
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
  test("fresh project shows trust dialog; safe 'No, exit' is default, Down+Enter accepts → prompt", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      const pane = capturePane();
      expect(pane).toContain("Yes, I trust this folder");
      expect(pane).toContain("No, exit");

      // Official 2.1.263 parity (OCC-118): the trust dialog is cancel-first —
      // "No, exit" is the FIRST option and the safe default the cursor lands on
      // (binary En: cancelFirst:!0, focus:"cancel"). Accepting trust now needs
      // Down → "Yes, I trust this folder" → Enter.
      sendKeys("Down");
      await new Promise((r) => setTimeout(r, 300));
      sendKeys("Enter");
      await dismissApiKeyDialogIfPresent();
      // Ready marker: OCC's manual-mode footer renders "manual mode on
      // (shift+tab to cycle)". (Official 2.1.263 renders "· ? for shortcuts ·
      // ← for agents" on the same line — footer-composition divergence tracked
      // in docs/upstream-version-gap-occ118.md, not a trust-gate concern.)
      expect(await waitForText("shift+tab", 15_000)).toBe(true);

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
      sendKeys("Down"); // OCC-118: cancel-first — move to "Yes, I trust this folder"
      await new Promise((r) => setTimeout(r, 300));
      sendKeys("Enter"); // accept
      await dismissApiKeyDialogIfPresent();
      expect(await waitForText("shift+tab", 15_000)).toBe(true);
      killRepl();

      // Reboot in the same HOME — trust already persisted, API-key rejection
      // persisted, so no dialogs: straight to the manual-mode REPL footer.
      startRepl(home);
      expect(await waitForText("shift+tab", 15_000)).toBe(true);
      expect(capturePane().toLowerCase()).not.toContain("quick safety check");
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("default 'No, exit' (safe default) exits the session without Down", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("Quick safety check", 20_000)).toBe(true);
      // Official 2.1.263 parity (OCC-118): "No, exit" is the first/default
      // option, so a bare Enter declines and exits — no Down needed. This is the
      // safe-default behavior (binary En: cancelFirst:!0, focus:"cancel").
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
      sendKeys("Down"); // OCC-118: cancel-first — move to "Yes, I trust this folder"
      await new Promise((r) => setTimeout(r, 300));
      sendKeys("Enter"); // accept trust
      await dismissApiKeyDialogIfPresent();
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
      sendKeys("Down"); // OCC-118: cancel-first — move to "Yes, I trust this folder"
      await new Promise((r) => setTimeout(r, 300));
      sendKeys("Enter"); // accept trust
      await dismissApiKeyDialogIfPresent();
      expect(await waitForText("Bypass Permissions mode", 15_000)).toBe(true);
      sendKeys("Down"); // move to "Yes, I accept"
      await new Promise((r) => setTimeout(r, 300));
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
