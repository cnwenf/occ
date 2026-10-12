import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * CC 2.1.296 — auto-default nudge e2e (Gap B port, tmux-based).
 *
 * Official contract (byte-verified in the official linux-x64 binary —
 * gate `aMr`, dialog `qhe`, resolver `Ckt`/`Tkt`):
 * - When onboarding is complete, `hasSeenAutoDefaultNudge` is unset, and the
 *   USER settings layer explicitly pins a non-auto permissions.defaultMode
 *   (no other layer pinning it), startup offers "Make auto mode your default
 *   permission mode?" with verbatim options.
 * - Accept → userSettings permissions.defaultMode becomes "auto", the REPL
 *   boots in auto mode (footer chip "auto mode on"), and the one-shot config
 *   flag is set so the dialog never reappears.
 * - Decline (incl. Esc) → settings untouched, one-shot flag set, no dialog on
 *   the next launch.
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-nudge-test";

const NUDGE_TITLE = "Make auto mode your default permission mode?";
// Short unique fragments — the full body sentence (~215 chars) wraps inside
// the dialog box at 200 cols, so whole-phrase substring checks would flake.
const NUDGE_BODY_HEAD = "Auto mode lets Claude handle permission prompts";
const NUDGE_BODY_TAIL = "lower-risk";
const ACCEPT_LABEL = "Yes, set auto mode as my default permission mode";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function startRepl(home: string, options: { bypass?: boolean } = {}) {
  const { bypass = true } = options;
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  // Full parent env (keeps sandbox/bypass vars) with HOME overridden so the
  // seeded .claude.json + .claude/settings.json drive the nudge gate.
  const envStr = Object.entries({ ...process.env, HOME: home })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  const bypassFlag = bypass ? " --dangerously-skip-permissions" : "";
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN}${bypassFlag}"`,
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

async function waitForText(substr: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capturePane().toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Seeded HOME: onboarding complete, trust accepted, custom API key approved,
 * hooks disabled, and userSettings EXPLICITLY pinning permissions.defaultMode
 * to "default" — the exact gate state that must trigger the official nudge.
 */
function freshNudgeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "occ-nudge-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ-nudge-seed-0000000000000000000000000000000000000000000aa",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.296",
    lastReleaseNotesSeen: "2.1.296",
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
      permissions: { defaultMode: "default" },
    }),
  );
  return home;
}

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

function currentModeChip(): string {
  const lines = capturePane().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/(mode on|edits on|permissions on)/.test(line)) return line;
  }
  return "";
}

async function waitForChip(label: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentModeChip().includes(label)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

describe.skipIf(!!process.env.CI)("CC 2.1.296 auto-default nudge (tmux e2e)", () => {
  test("dialog appears with official verbatim strings; Esc declines, persists the one-shot flag, and never reappears", async () => {
    const home = freshNudgeHome();
    try {
      // --- Launch 1: nudge must appear ---
      startRepl(home);
      expect(await waitForText(NUDGE_TITLE, 25_000)).toBe(true);

      // Official qhe body + options, verbatim.
      const pane = capturePane();
      expect(pane).toContain(NUDGE_BODY_HEAD);
      expect(pane).toContain(NUDGE_BODY_TAIL);
      expect(pane).toContain(ACCEPT_LABEL);
      // "No, keep <current mode indicator>" — booted with
      // --dangerously-skip-permissions, so the current mode is bypass.
      expect(pane.toLowerCase()).toMatch(/no, keep\b/);

      // Esc = decline (official onCancel -> at("decline")).
      sendKeys("Escape");

      // REPL mounts after the decline resolves.
      expect(await waitForText("shift+tab", 25_000)).toBe(true);
      killRepl();

      // Official Ckt decline path: flag set, settings NOT modified.
      const configAfter = readJSON(join(home, ".claude.json"));
      expect(configAfter.hasSeenAutoDefaultNudge).toBe(true);
      const settingsAfter = readJSON(join(home, ".claude", "settings.json"));
      expect(settingsAfter.permissions).toEqual({ defaultMode: "default" });

      // --- Launch 2: one-shot flag suppresses the dialog ---
      startRepl(home);
      expect(await waitForText("shift+tab", 25_000)).toBe(true);
      expect(capturePane()).not.toContain(NUDGE_TITLE);
      killRepl();
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("accept persists defaultMode auto, boots the REPL in auto mode, and sets the flag", async () => {
    const home = freshNudgeHome();
    try {
      startRepl(home);
      expect(await waitForText(NUDGE_TITLE, 25_000)).toBe(true);

      // First option (accept) is focused by default — Enter selects it.
      sendKeys("Enter");

      // REPL mounts in auto mode: official footer chip.
      expect(await waitForText("shift+tab", 25_000)).toBe(true);
      expect(await waitForChip("auto mode on", 10_000)).toBe(true);
      killRepl();

      // Official Tkt accept path: userSettings defaultMode persisted as auto.
      const settingsAfter = readJSON(join(home, ".claude", "settings.json"));
      expect(settingsAfter.permissions).toEqual({ defaultMode: "auto" });
      const configAfter = readJSON(join(home, ".claude.json"));
      expect(configAfter.hasSeenAutoDefaultNudge).toBe(true);

      // --- Launch 2: no dialog (flag set). Boots WITHOUT the bypass flag so
      // the persisted userSettings defaultMode:"auto" drives the startup mode
      // (the bypass flag would override it to bypassPermissions). ---
      startRepl(home, { bypass: false });
      expect(await waitForText("shift+tab", 25_000)).toBe(true);
      expect(capturePane()).not.toContain(NUDGE_TITLE);
      expect(await waitForChip("auto mode on", 10_000)).toBe(true);
      killRepl();
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test("no nudge when userSettings does not pin defaultMode (official gate requires an explicit non-auto pin)", async () => {
    const home = freshNudgeHome();
    try {
      // Remove the explicit pin — gate `aMr` requires `e && e !== "auto"`.
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          skipDangerousModePermissionPrompt: true,
          disableAllHooks: true,
        }),
      );
      startRepl(home);
      expect(await waitForText("shift+tab", 25_000)).toBe(true);
      expect(capturePane()).not.toContain(NUDGE_TITLE);
      // No dialog → no flag write (official only writes on resolution).
      const configAfter = readJSON(join(home, ".claude.json"));
      expect(configAfter.hasSeenAutoDefaultNudge).toBeUndefined();
      killRepl();
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);
});
