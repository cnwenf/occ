import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * Screen-reader mode e2e (tmux-based). Drives the BUILT dist/cli.js inside a
 * tmux session with `--ax-screen-reader` and asserts on the decoded pane output.
 *
 * Done-gate #4 (behavioral e2e, NOT source-grep) for the 2.1.208 screen-reader
 * port. Asserts:
 *  (a) Startup announce `[Screen Reader Mode: on via flag]` appears on stdout
 *      (written by main.tsx before Ink mounts).
 *  (b) Classic-renderer box-drawing border chars are absent — the SR flat-render
 *      path (onRenderScreenReader → serializeNode) emits plain text, no borders.
 *
 * Gated out of CI (needs tmux + model creds).
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-sr-test";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

/**
 * Fresh temp HOME seeded to skip onboarding + bypass-acceptance + hooks. Same
 * isolation pattern as repl-interactive.e2e.test.ts.
 */
function freshSeededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "occ-sr-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-15T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-sr-seed-0000000000000000000000000000000000000000000000aa",
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

function startRepl(home: string, extraArgs: string[] = []) {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
  // Pass the FULL parent env (so CLAUDE_CODE_BUBBLEWRAP / IS_SANDBOX that
  // allow --dangerously-skip-permissions under root are preserved) but override
  // HOME to the temp dir so the CLI reads the seeded config.
  const envStr = Object.entries({ ...process.env, HOME: home })
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(" ");
  execSync(
    `tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} ${BIN} --ax-screen-reader --dangerously-skip-permissions ${extraArgs.join(" ")}"`,
    { timeout: 5_000 },
  );
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

function capturePane(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
}

/** Poll capture-pane until `substr` appears (case-insensitive) or timeout. */
async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane();
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Classic-renderer decorative border chars (Box Drawing block U+2500–257F +
 * Rounded corners U+256D–2570). The non-SR Ink renderer uses these for prompt
 * borders; the SR flat-render path emits plain text only.
 */
const BOX_DRAWING = /[\u2500-\u257f]/;

// No API call is made by this test — the startup announce is written by
// main.tsx before any API interaction, and the REPL prompt renders locally.
// Skip only when CI is set OR tmux is unavailable.
const HAS_TMUX = (() => {
  try {
    execSync("tmux -V", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(!!process.env.CI || !HAS_TMUX)(
  "screen-reader mode (tmux e2e)",
  () => {
    test(
      "--ax-screen-reader announces mode + flat-render (no box borders)",
      async () => {
        const home = freshSeededHome();
        startRepl(home);
        try {
          // (a) Startup announce appears on stdout.
          const announced = await waitForText(
            "[Screen Reader Mode: on via flag]",
            25_000,
          );
          expect(announced).toBe(true);

          // Wait for the REPL prompt to render (flat text — "shift+tab" hint
          // appears in the classic prompt footer, serialized to flat text).
          await waitForText("shift+tab", 20_000);

          const pane = capturePane();

          // (b) Flat-render: no classic box-drawing border chars anywhere in
          // the visible pane + scrollback. The SR path serializes the whole
          // React tree to plain text via serializeNode — borders are gone.
          expect(BOX_DRAWING.test(pane)).toBe(false);

          // Sanity: the announce line is still present in the full capture.
          expect(pane).toContain("[Screen Reader Mode: on via flag]");
        } finally {
          killRepl();
          rmSync(home, { recursive: true, force: true });
        }
      },
      60_000,
    );
  },
);
