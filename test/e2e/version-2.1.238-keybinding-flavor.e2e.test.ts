import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * 2.1.238 `keybindingFlavor` REPL e2e (tmux-based). Drives the BUILT
 * dist/cli.js inside a tmux session, types a WORD run into the prompt input,
 * presses Ctrl+W, and reads back the surviving input via `tmux capture-pane`.
 *
 * The feature under test (binary `["w", Y ? _e : ge]` in useTextInput +
 * `case "w": h ? deleteWORDBefore : deleteWordBefore` in useSearchInput):
 *   - "classic" (default): Ctrl+W kills the previous word — for "foo-bar" the
 *     Intl.Segmenter boundary at "-" means only "bar" is killed, leaving "foo-".
 *   - "readline": Ctrl+W kills back to the previous whitespace — the whole
 *     "foo-bar" run is killed, leaving the input empty.
 *
 * Gated out of CI (needs tmux + a built dist/cli.js).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-keybinding-flavor-test";

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
 * test can opt into `keybindingFlavor: "readline"`.
 */
function freshSeededHome(extraSettings: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "occ-kbf-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ-kbf-seed-000000000000000000000000000000000000000000000aa",
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

function sendKeys(keys: string) {
  tmux(["send-keys", "-t", SESSION, ...keys.split(" ")]);
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

describe.skipIf(!!process.env.CI)("2.1.238 keybindingFlavor Ctrl+W (tmux REPL e2e)", () => {
  test("classic (default): Ctrl+W kills only the previous word", async () => {
    const home = freshSeededHome();
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      sendKeys("foo-bar");
      expect(await waitForText("foo-bar")).toBe(true);
      sendKeys("C-w");
      await settle();
      // Classic word-boundary kill stops at "-": "bar" is killed, "foo-" stays.
      expect(captureVisible()).toContain("foo-");
    } finally {
      killRepl();
    }
  }, 60_000);

  test("readline: Ctrl+W kills back to the previous whitespace", async () => {
    const home = freshSeededHome({ keybindingFlavor: "readline" });
    startRepl(home);
    try {
      expect(await waitForText("shift+tab")).toBe(true);
      sendKeys("foo-bar");
      expect(await waitForText("foo-bar")).toBe(true);
      sendKeys("C-w");
      await settle();
      const pane = captureVisible();
      // Readline whitespace kill removes the whole "foo-bar" run.
      expect(pane).not.toContain("foo-bar");
      expect(pane).not.toContain("foo-");
    } finally {
      killRepl();
    }
  }, 60_000);
});
