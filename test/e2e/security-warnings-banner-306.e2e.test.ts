import { describe, expect, test } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers";

/**
 * OCC-126 (CC 2.1.305/306) — startup securityWarnings banner rows are
 * rendered by the banner-notice registry (official `security-warnings`
 * entry), NOT seeded into the messages list. Behavioral gate (real built
 * dist/cli.js inside tmux, real model round-trip):
 *
 *   1. fresh start with a deny rule that restricts nothing → the official
 *      row "Deny rule Glob(path:src/**) never matches · use Read(…)" renders
 *      under the logo banner;
 *   2. the persisted transcript JSONL contains NO banner row (pre-fix, the
 *      seeded createSystemMessage rows were loggable and landed on disk);
 *   3. `--resume <id>` with the rule still broken → the banner renders
 *      EXACTLY ONCE (pre-fix: persisted row + re-seeded row = duplicate);
 *   4. rule FIXED → `--resume <id>` shows NO stale row (pre-fix: the
 *      persisted row came back via initialMessages even though the current
 *      warning set was empty).
 *
 * Gated out of CI (needs tmux + model creds). Do NOT pass
 * --dangerously-skip-permissions here: bypass mode skips permission-rule
 * evaluation, so no securityWarnings rows are produced at all.
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = "occ126-banner";
const DENY_ROW_NEEDLE = "Deny rule Glob(path:src/**) never matches";
const PONG = "OCC126PONG";

function tmux(args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf8", timeout: 10_000 });
  } catch {
    return "";
  }
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

/**
 * Fresh temp HOME + project dir. HOME is seeded to skip onboarding/trust and
 * carries the broken deny rule `Glob(path:src/**)` (targets Glob's path as a
 * raw string → the official FIRST-loop "never matches · use Read(…)" row).
 * The API key is pre-approved (last-20 form) so no approval dialog blocks
 * the banner. ANTHROPIC_AUTH_TOKEN in the ambient tmux server env may add
 * the both-auth-methods notice — harmless: every assertion here is
 * needle-specific to the Deny row.
 */
function seedEnv(denyRule: string): { home: string; proj: string } {
  const home = mkdtempSync(join(tmpdir(), "occ126-home-"));
  const proj = mkdtempSync(join(tmpdir(), "occ126-proj-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const config: Record<string, unknown> = {
    numStartups: 1,
    firstStartTime: "2026-07-06T00:00:00.000Z",
    migrationVersion: 11,
    userID: "occ126-seed-0000000000000000000000000000000000000000000000aa",
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.200",
    lastReleaseNotesSeen: "2.1.300",
    projects: { [proj]: { hasTrustDialogAccepted: true } },
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
      permissions: { deny: [denyRule] },
    }),
  );
  return { home, proj };
}

function startRepl(home: string, proj: string, extraArgs: string[] = []) {
  killRepl();
  // Forward only what the CLI needs; HOME points at the seeded dir. No
  // --dangerously-skip-permissions (bypass skips rule evaluation).
  const fwd: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
  };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_BUBBLEWRAP", "IS_SANDBOX"]) {
    if (process.env[k] !== undefined) fwd[k] = process.env[k]!;
  }
  const envStr = Object.entries(fwd)
    .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
    .join(" ");
  const args = extraArgs.join(" ");
  execSync(
    `cd '${proj}' && tmux new-session -d -s ${SESSION} -x 200 -y 50 "env ${envStr} '${BIN}' ${args}"`,
    { timeout: 10_000 },
  );
}

function captureViewport(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p"]);
}

function captureAll(): string {
  return tmux(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
}

async function waitForText(substr: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captureAll().includes(substr)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/** Newest session JSONL under the seeded HOME's projects dir. */
function latestTranscript(home: string): string | null {
  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;
  let newest: { path: string; mtime: number } | null = null;
  for (const projDir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projDir.isDirectory()) continue;
    const dir = join(projectsDir, projDir.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  }
  return newest?.path ?? null;
}

function sessionIdOf(transcriptPath: string): string {
  const base = transcriptPath.split("/").pop()!;
  return base.replace(/\.jsonl$/, "");
}

describe.skipIf(!!process.env.CI)("OCC-126 securityWarnings banner (tmux e2e)", () => {
  test("fresh start renders the banner row; transcript stays clean; resume shows it exactly once; fixed rule leaves no stale row", async () => {
    const { home, proj } = seedEnv("Glob(path:src/**)");
    try {
      // --- 1. Fresh start: banner row renders under the logo ---
      startRepl(home, proj);
      expect(await waitForText(DENY_ROW_NEEDLE, 30_000)).toBe(true);
      // Exactly once in the viewport (banner, not a message row).
      const freshCount = captureViewport()
        .split("\n")
        .filter(l => l.includes(DENY_ROW_NEEDLE)).length;
      expect(freshCount).toBe(1);

      // --- Drive one real round-trip so the transcript is persisted.
      // NOTE: the pane echo of the typed prompt already contains PONG, so
      // gate on the ASSISTANT row landing in the JSONL (a line that is both
      // type:"assistant" and mentions PONG) — that proves a real model
      // round-trip, not just the input echo.
      tmux(["send-keys", "-t", SESSION, `reply with exactly: ${PONG}`, "Enter"]);
      let transcript: string | null = null;
      let transcriptText = "";
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        transcript = latestTranscript(home);
        if (transcript) {
          transcriptText = readFileSync(transcript, "utf8");
          const hasAssistantPong = transcriptText
            .split("\n")
            .some(line => line.includes(PONG) && line.includes('"type":"assistant"'));
          if (hasAssistantPong) break;
        }
        await new Promise(r => setTimeout(r, 300));
      }
      expect(transcript).not.toBeNull();
      expect(
        transcriptText
          .split("\n")
          .some(line => line.includes(PONG) && line.includes('"type":"assistant"')),
      ).toBe(true);

      // --- 2. Transcript carries NO banner row (registry rows are transient
      // JSX — never messages, never recordTranscript'd) ---
      expect(transcriptText).not.toContain("Deny rule");
      expect(transcriptText).not.toContain("never matches");
      const sessionId = sessionIdOf(transcript!);

      // --- 3. Resume with the rule still broken: banner exactly once ---
      startRepl(home, proj, ["--resume", sessionId]);
      expect(await waitForText(PONG, 30_000)).toBe(true);
      expect(await waitForText(DENY_ROW_NEEDLE, 30_000)).toBe(true);
      const resumeCount = captureViewport()
        .split("\n")
        .filter(l => l.includes(DENY_ROW_NEEDLE)).length;
      expect(resumeCount).toBe(1);

      // --- 4. Fix the rule, resume again: NO stale row anywhere ---
      writeFileSync(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          skipDangerousModePermissionPrompt: true,
          disableAllHooks: true,
          permissions: { deny: ["Read(.env)"] },
        }),
      );
      startRepl(home, proj, ["--resume", sessionId]);
      expect(await waitForText(PONG, 30_000)).toBe(true);
      // Give the banner area a beat to render, then assert absence across
      // viewport AND scrollback (a pre-fix persisted row would resurface via
      // initialMessages regardless of the current rule state).
      await new Promise(r => setTimeout(r, 2_000));
      expect(captureViewport()).not.toContain(DENY_ROW_NEEDLE);
      expect(captureAll()).not.toContain(DENY_ROW_NEEDLE);
    } finally {
      killRepl();
    }
  }, 180_000);
});
