import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * 2.1.239 catch-up REPL e2e (tmux-based), updated for the 2.1.261
 * keybindingFlavor deprecation. Drives the BUILT dist/cli.js inside a tmux
 * session and exercises the landed 2.1.239 clusters end to end:
 *
 *  1. Alt+D word kill — 2.1.261 deleted the classic Segmenter-word variant;
 *     Alt+D now ALWAYS kills exactly one READLINE word (punctuation delimits:
 *     "foo-bar" → kills "foo", leaves "-bar baz"), even with an explicit
 *     `keybindingFlavor: "classic"` setting (useTextInput `['d', killWordAfter]`).
 *  2. Placeholder family — a multi-line bracketed paste collapses to a
 *     `[Pasted text #1 +N lines]` chip and Ctrl+W deletes the WHOLE chip
 *     atomically (killRange placeholder snapping).
 *  3. killRange rework + kill ring — Ctrl+U kill then Ctrl+Y yank round-trip
 *     survives the killRange refactor.
 *
 * Meta delivery: tmux `M-d` sends ESC d, which parse-keypress maps to
 * `meta: true` + input 'd' (META_KEY_CODE_RE). Ctrl+A = start of line.
 *
 * Gated out of CI (needs tmux + a built dist/cli.js).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-kbf-239-test";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function startRepl(home: string) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  const envStr = Object.entries({ ...process.env, HOME: home })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN} --dangerously-skip-permissions"`,
    { timeout: 5_000 },
  );
}

/**
 * Fresh temp HOME seeded to skip onboarding + suppress the custom-API-key
 * approval dialog. `extraSettings` is merged into .claude/settings.json so a
 * test can seed a (now-ignored) `keybindingFlavor` value.
 */
function freshSeededHome(extraSettings: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "occ-kbf239-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ-kbf239-seed-00000000000000000000000000000000000000aa",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.200",
    lastReleaseNotesSeen: "2.1.200",
    projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
  };
  if (apiKey && apiKey.length >= 20) {
    config.customApiKeyResponses = { approved: [apiKey.slice(-20)], rejected: [] };
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify(config));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableAllHooks: true,
      ...extraSettings,
    }),
  );
  return home;
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

/** Type literal text (spaces included) — `send-keys -l` bypasses key-name
 *  interpretation so nothing is dropped or translated. */
function typeText(text: string) {
  tmux(["send-keys", "-t", SESSION, "-l", text]);
}

/** Press named keys (C-a, M-d, C-w, ...). */
function pressKey(...keys: string[]) {
  tmux(["send-keys", "-t", SESSION, ...keys]);
}

/** Capture only the visible pane (no scrollback) so we read the live input. */
function captureVisible(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p"]);
}

async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captureVisible().toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const settle = () => new Promise((r) => setTimeout(r, 600));

describe.skipIf(!!process.env.CI)("2.1.239 keybinding catch-up (tmux REPL e2e)", () => {
  test("Alt+D kills exactly one readline word (punctuation delimits)", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      typeText("foo-bar baz");
      expect(await waitForText("foo-bar baz")).toBe(true);
      pressKey("C-a"); // start of line
      await settle();
      pressKey("M-d"); // readline killWord: kills "foo" only
      await settle();
      const pane = captureVisible();
      expect(pane).toContain("-bar baz");
    } finally {
      killRepl();
    }
  }, 60_000);

  test("explicit keybindingFlavor: classic is ignored (2.1.261 deprecation)", async () => {
    const home = freshSeededHome({ keybindingFlavor: "classic" });
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      typeText("foo-bar baz");
      expect(await waitForText("foo-bar baz")).toBe(true);
      pressKey("C-a"); // start of line
      await settle();
      pressKey("M-d"); // still readline killWord: kills "foo" only
      await settle();
      const pane = captureVisible();
      expect(pane).toContain("-bar baz");
    } finally {
      killRepl();
    }
  }, 60_000);

  test("multi-line paste becomes a chip; Ctrl+W deletes the whole chip atomically", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      // 4 lines → numLines 3 > maxLines 2 (rows 50) → chip path in onTextPaste.
      execSync("tmux load-buffer -", {
        input: "alpha\nbravo\ncharlie\ndelta",
        timeout: 5_000,
      });
      tmux(["paste-buffer", "-p", "-t", SESSION]); // -p = bracketed paste
      expect(await waitForText("[Pasted text #1")).toBe(true);
      pressKey("C-w"); // readline deleteWORDBefore → killRange snaps over the chip
      await settle();
      expect(captureVisible()).not.toContain("[Pasted text");
    } finally {
      killRepl();
    }
  }, 60_000);

  test("Ctrl+U kill then Ctrl+Y yank round-trip (killRange rework keeps the kill ring intact)", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      typeText("hello world");
      expect(await waitForText("hello world")).toBe(true);
      pressKey("C-u"); // kill to line start → input empty, kill ring holds the text
      await settle();
      expect(captureVisible()).not.toContain("hello world");
      pressKey("C-y"); // yank last kill
      expect(await waitForText("hello world")).toBe(true);
    } finally {
      killRepl();
    }
  }, 60_000);
});
