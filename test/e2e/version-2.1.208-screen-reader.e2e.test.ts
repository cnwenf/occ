import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * Screen-reader mode e2e (tmux-based). Drives the BUILT dist/cli.js inside a
 * tmux session with `--ax-screen-reader` and asserts on the decoded pane output.
 *
 * Done-gate #4 (behavioral e2e, NOT source-grep) for the 2.1.208 screen-reader
 * port. Asserts:
 *  (a) Startup announce `[Screen Reader Mode: on via flag]` is routed through
 *      the SR announce queue and observable in the pane. REAL mechanism (2.1.217
 *      #8(a), NOT stdout): main.tsx → emitStartupSrAnnouncement →
 *      pushScreenReaderAnnouncement → per-frame drain appends it as a held
 *      announcement (announceInsert forces a diff replay from the insertion
 *      point so screen readers speak it). With the rewrite switch default-off,
 *      screen-reader-render.ts invalidation (verbatim binary port @213430744)
 *      WIPES the held line within ~1 frame (<200ms) at the loading→prompt
 *      transition — so pane polling can never observe it. Official 2.1.296
 *      behaves identically (forensics on the official ELF:
 *      `eAs(){return a.CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT??!1}` — default
 *      false — plus requestInputPriorityFrame clearing srHeldAnnouncements), so
 *      this is a test-contract matter, not a product gap. This test injects the
 *      official switch `CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT=1` (binary `Z8o`) to
 *      make the held announce survive the transition and become assertable.
 *  (b) Classic-renderer box-drawing border chars are absent — the SR flat-render
 *      path (onRenderScreenReader → serializeNode) emits plain text, no borders.
 *
 * Gated out of CI (needs tmux + model creds).
 *
 * UPDATED (OCC-114 acceptance, round 2): BOTH boot-time Divider sources are now
 * seeded away. The SR serializer faithfully keeps text nodes (official R0c/oHh
 * sanitize controls/bidi only), so any literal U+2500 Divider TEXT legitimately
 * survives flat-render and trips assertion (b). Two independent boot sources:
 *  1. the custom-API-key approval dialog (ApproveApiKey → design-system Pane →
 *     Divider) — suppressed by pre-approving the parent env's ANTHROPIC_API_KEY
 *     (customApiKeyResponses, key truncated to its last 20 chars per the
 *     official normalizeApiKeyForConfig scheme);
 *  2. the WhatsNew welcome splash (LogoV2 full-logo path → createWhatsNewFeed →
 *     Divider, ~147 U+2500 chars) — rendered whenever
 *     `lastReleaseNotesSeen` < current version (getRecentReleaseNotes returns
 *     notes only on gt()). Suppressed at the source by seeding
 *     `lastReleaseNotesSeen` = the CURRENT package version, read dynamically
 *     from package.json so the seed never goes stale on a version bump
 *     (hasReleaseNotes=false + showOnboarding=false → CondensedLogo path).
 * The earlier round attributed the Divider only to source 1 — incomplete.
 * This test makes no API call; both dialogs/splashes are pure environment
 * noise, not screen-reader regressions.
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ-sr-test";
/** Current OCC version — read dynamically so config seeds never go stale. */
const PKG_VERSION: string = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).version;

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
  // Pre-approve the inherited env API key (official truncation: last 20
  // chars) so the interactive approval dialog never renders — its Pane
  // Divider emits literal U+2500 TEXT (kept by the faithful SR text
  // serializer), which would trip the no-box-drawing assertion below.
  const envApiKey = process.env.ANTHROPIC_API_KEY;
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: "2026-07-15T00:00:00.000Z",
      migrationVersion: 11,
      userID: "occ-sr-seed-0000000000000000000000000000000000000000000000aa",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.200",
      // Current version (dynamic, never stale) → getRecentReleaseNotes sees
      // lastSeen == current → hasReleaseNotes=false → no WhatsNew splash and
      // no full-logo Divider (see header, splash source 2).
      lastReleaseNotesSeen: PKG_VERSION,
      projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
      ...(envApiKey
        ? {
            customApiKeyResponses: {
              approved: [envApiKey.slice(-20)],
              rejected: [],
            },
          }
        : {}),
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
  // CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT=1 is the OFFICIAL held-announce
  // rewrite switch (binary `Z8o`/`eAs`, default false): it lets held SR
  // announcements survive content changes above them. Without it the startup
  // announce is invalidated within ~1 frame at the loading→prompt transition
  // (official 2.1.296 does the same) and 200ms pane polling can never catch
  // it — see header (a). Test-only injection; product behavior is untouched.
  const envStr = Object.entries({
    ...process.env,
    HOME: home,
    CLAUDE_AX_REWRITE_HELD_ANNOUNCEMENT: "1",
  })
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
 * Poll until the pane settles: two consecutive captures (300ms apart) are
 * identical — i.e. boot finished and the prompt is stable. Replaces the old
 * `waitForText("shift+tab", …)` non-asserting wait, which always burned its
 * full 20s timeout (OCC-108 removed the shift+tab hint from the SR footer).
 */
async function waitForPaneStable(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let prev = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const pane = capturePane();
    if (pane && pane === prev) return true;
    prev = pane;
  }
  return false;
}

/**
 * Classic-renderer decorative border chars (Box Drawing block U+2500–257F +
 * Rounded corners U+256D–2570). The non-SR Ink renderer uses these for prompt
 * borders; the SR flat-render path emits plain text only.
 */
const BOX_DRAWING = /[\u2500-\u257f]/;

// No API call is made by this test — the startup announce is emitted locally
// through the SR announce queue (no network), and the REPL prompt renders
// locally. Skip only when CI is set OR tmux is unavailable.
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
          // (a) Startup announce observable via the SR announce queue. The
          // rewrite switch (startRepl env) keeps the held announce alive across
          // the loading→prompt transition so polling can observe it.
          const announced = await waitForText(
            "[Screen Reader Mode: on via flag]",
            25_000,
          );
          expect(announced).toBe(true);

          // Wait for boot to finish and the prompt to settle (pane stable
          // across two captures) before the border assertion — any late splash
          // / dialog frame must have rendered (or been suppressed) by now.
          const stable = await waitForPaneStable(20_000);
          expect(stable).toBe(true);

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
