import { describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers';

/**
 * Real REPL acceptance (tmux e2e) for the startup welcome page (OCC-20).
 *
 * Boots the BUILT dist/cli.js inside a tmux pane with a seeded HOME (onboarding
 * + trust already accepted) and reads the decoded pane via `tmux capture-pane
 * -p`. Verifies the responsive condensed welcome (wide / compact / plain) and
 * the forced full logo. The condensed path renders OCC's open-orbit mark,
 * context, and a session-stable tip; the full path keeps the two-tone doge
 * mascot.
 *
 * Gated out of CI because it requires tmux; no model call is made.
 */

const BIN = process.env.OCC_ENTRYPOINT ?? `${REPO_ROOT}/dist/cli.js`;
const SESSION = 'occ-welcome-test';
const VERSION = (
  JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { version: string }
).version;

function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', args, { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return '';
  }
}

function killRepl() {
  execSync(`tmux kill-session -t ${SESSION} 2>/dev/null; true`);
}

function capturePane(): string {
  return tmux(['capture-pane', '-t', SESSION, '-p', '-S', '-']);
}

async function waitForText(
  substr: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = capturePane();
    if (pane.toLowerCase().includes(substr.toLowerCase())) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Seed onboarding + trust as done, and "last release notes seen" = current
// version so the CONDENSED logo is what renders by default.
function freshSeededHome(lastReleaseNotesSeen: string): string {
  const home = mkdtempSync(join(tmpdir(), 'occ-welcome-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 7,
      firstStartTime: '2026-07-06T00:00:00.000Z',
      migrationVersion: 11,
      userID:
        'occ-welcome-seed-0000000000000000000000000000000000000000000aa',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.200',
      lastReleaseNotesSeen,
      projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
    }),
  );
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      disableAllHooks: true,
    }),
  );
  return home;
}

function startRepl(
  home: string,
  extraEnv: Record<string, string> = {},
  width = 200,
) {
  killRepl();
  // Strip ANTHROPIC_API_KEY so the "Detected a custom API key" approval dialog
  // (src/interactiveHelpers.tsx) does not block the welcome render — auth uses
  // ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL instead, same as the e2e runner.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    TERM: 'xterm-256color',
    ...extraEnv,
  };
  delete env.ANTHROPIC_API_KEY;
  const envStr = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join(' ');
  execSync(
    `tmux new-session -d -s ${SESSION} -x ${width} -y 50 "env ${envStr} ${BIN} --dangerously-skip-permissions"`,
    { timeout: 5_000 },
  );
  tmux(['resize-window', '-t', SESSION, '-x', String(width), '-y', '50']);
}

const LARGE_LOGO_GLYPH = '⢀⣾⠟⠉⠉⠻⣷⣄';
const MEDIUM_LOGO_GLYPH = '⣰⡿⠋⠙⢿⣆';
const SMALL_LOGO_GLYPH = '⢸⡇⣿⡇⢠';
const OLD_WORDMARK = '___   ___   ___';

// Doge art glyphs that must remain in the forced full-logo pane.
const DOGE_GLYPHS = ['/\\___/\\', '=w=', '~~'];

describe.skipIf(!!process.env.CI)('REPL welcome page (tmux e2e, OCC-20)', () => {
  test('wide welcome renders brand, version, context, tip, and large mark', async () => {
    const home = freshSeededHome(VERSION);
    startRepl(home, {}, 100);
    try {
      // Wait for the REPL prompt / welcome to paint.
      await waitForText('occ', 20_000);
      await new Promise((r) => setTimeout(r, 800));
      const pane = capturePane();

      // Brand + version.
      expect(pane.toLowerCase()).toContain('occ');
      expect(pane).toContain(`v${VERSION}`);
      expect(pane).toContain(LARGE_LOGO_GLYPH);
      expect(pane).not.toContain(OLD_WORDMARK);
      expect(pane).toContain('Open C Code');
      // One of the welcome tips is shown.
      const tipShown = [
        'press / for commands',
        'type @ to reference',
        'use # to pin',
        'press ! to run',
        'ctrl+o expands',
        'run /help',
        'use the tab key',
        'press esc twice',
      ].some((t) => pane.toLowerCase().includes(t));
      expect(tipShown).toBe(true);
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('forced full logo renders the bordered welcome box with doge', async () => {
    const home = freshSeededHome(VERSION);
    startRepl(home, { CLAUDE_CODE_FORCE_FULL_LOGO: '1' });
    try {
      await waitForText('occ', 20_000);
      await new Promise((r) => setTimeout(r, 800));
      const pane = capturePane();

      expect(pane).toContain(`v${VERSION}`);
      // The full logo is a rounded border titled "OCC v…".
      expect(pane).toContain('OCC');
      // Doge glyphs still render inside the full box.
      for (const glyph of DOGE_GLYPHS) {
        expect(pane).toContain(glyph);
      }
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('compact terminal uses the medium mark without overflowing', async () => {
    const home = freshSeededHome(VERSION);
    startRepl(home, {}, 60);
    try {
      await waitForText('occ', 20_000);
      await new Promise((r) => setTimeout(r, 800));
      const pane = capturePane();
      // Still renders the brand and stacked medium mark without crashing.
      expect(pane.toLowerCase()).toContain('occ');
      expect(pane).toContain(MEDIUM_LOGO_GLYPH);
      expect(pane).not.toContain(LARGE_LOGO_GLYPH);
      expect(pane).not.toContain(OLD_WORDMARK);
      expect(pane).toContain('Open C Code');
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('very narrow terminal uses the small borderless mark', async () => {
    const home = freshSeededHome(VERSION);
    startRepl(home, {}, 36);
    try {
      await waitForText('occ', 20_000);
      await new Promise((r) => setTimeout(r, 800));
      const pane = capturePane();

      expect(pane).toContain(`OCC v${VERSION}`);
      expect(pane).toContain('Open C Code');
      expect(pane).toContain(SMALL_LOGO_GLYPH);
      expect(pane).not.toContain(MEDIUM_LOGO_GLYPH);
      expect(pane).not.toContain(OLD_WORDMARK);
      expect(pane).not.toContain('╭');
    } finally {
      killRepl();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
