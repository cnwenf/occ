import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * REPL image-paste e2e (tmux-based) — the "real REPL testing" for OCC-8.
 *
 * Drives the built dist/cli.js (or OCC_ENTRYPOINT) inside a tmux session,
 * sends the real Ctrl+V keybinding (chat:imagePaste) with
 * OCC_CLIPBOARD_IMAGE_SRC pointing at a fixture PNG, and asserts that occ
 * saves the clipboard image to a temp file AND inserts the path into the
 * input box. The clipboard-read step is stubbed via the env override (the
 * sandbox has no display/clipboard); every later step — save-to-temp-file,
 * path insertion, on-disk file — is exercised for real against the running
 * REPL.
 *
 * Gated out of CI (needs tmux + model creds + a TTY).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-imgpaste-test";

// 1x1 red PNG (well-known base64). Real PNG magic bytes.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKd0CgAAAABJRU5ErkJggg==",
  "base64",
);

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function freshSeededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "occ-imgpaste-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Pre-approve the env ANTHROPIC_API_KEY so the "Detected a custom API key"
  // startup dialog doesn't block the REPL from reaching the prompt. The
  // approval key is the last-20 chars of the key (normalizeApiKeyForConfig).
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const claudeJson: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ-imgpaste-seed-00000000000000000000000000000000000000000000",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.200",
    lastReleaseNotesSeen: "2.1.200",
    projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
  };
  if (apiKey) {
    claudeJson.customApiKeyResponses = {
      approved: [apiKey.slice(-20)],
      rejected: [],
    };
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableAllHooks: true,
    }),
  );
  return home;
}

function startRepl(home: string, occTmp: string, fixturePath: string) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  // Route occ's temp-image writes into occTmp (so we can assert on disk),
  // and stub the clipboard read to the fixture via OCC_CLIPBOARD_IMAGE_SRC.
  const envStr = Object.entries({
    ...process.env,
    HOME: home,
    CLAUDE_CODE_TMPDIR: occTmp,
    OCC_CLIPBOARD_IMAGE_SRC: fixturePath,
  })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN} --dangerously-skip-permissions"`,
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

async function waitForText(
  substr: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane();
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe.skipIf(!!process.env.CI)("REPL image paste (tmux e2e)", () => {
  test("Ctrl+V saves the clipboard image to a temp file and inserts the path", async () => {
    const home = freshSeededHome();
    const occTmp = mkdtempSync(join(tmpdir(), "occ-imgpaste-tmp-"));
    const fixturePath = join(occTmp, "screenshot.png");
    writeFileSync(fixturePath, PNG_1x1);
    startRepl(home, occTmp, fixturePath);
    try {
      // Wait for the REPL prompt to be ready (footer shows the shift+tab hint).
      await waitForText("shift+tab", 25_000);

      // Press Ctrl+V (chat:imagePaste). tmux sends Ctrl+V as "C-v".
      sendKeys("C-v");

      // The handler saves the clipboard image to a temp file and inserts the
      // file path into the input box. Assert the path appears in the pane.
      const inserted = await waitForText("occ-clipboard-", 10_000);
      expect(inserted).toBe(true);

      const pane = capturePane();
      expect(pane).toMatch(/occ-clipboard-.*\.png/);

      // And the temp file must actually exist on disk under occTmp.
      const files = readdirSync(occTmp).filter(
        (f) => f.startsWith("occ-clipboard-") && f.endsWith(".png"),
      );
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(occTmp, files[0]!))).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
      rmSync(occTmp, { recursive: true, force: true });
    }
  }, 60_000);
});
