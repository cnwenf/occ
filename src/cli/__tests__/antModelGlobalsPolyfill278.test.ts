import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Gap-133a (OCC-133) — LIVE-PATH regression test for the USER_TYPE=ant
 * ambient-globals provider install in src/entrypoints/cli.tsx.
 *
 * src/types/global.d.ts declares `resolveAntModel`/`getAntModels`/
 * `getAntModelOverrideConfig` as AMBIENT globals. Every bare call site sits
 * behind a RUNTIME `process.env.USER_TYPE === 'ant'` guard the bundler cannot
 * eliminate, but nothing provided the identifiers at runtime (since 2.1.307).
 * With USER_TYPE=ant, parseUserSpecifiedModel threw
 * `ReferenceError: resolveAntModel is not defined` inside
 * initializeToolPermissionContext — an unhandled rejection that silently
 * drained the event loop (exit 0, NO output) before runHeadless was reached.
 * Official 2.1.278 serves the ant path fine (live-verified side-by-side:
 * `[claude-code:unrecognized_model]` line + PONG + exit 0 under USER_TYPE=ant).
 *
 * The fix: cli.tsx installs the real antModels.ts providers via a
 * USER_TYPE-gated dynamic import (zero cost for normal runs; antModels.ts
 * self-gates on USER_TYPE). This test spawns dist/cli.js DIRECTLY — no
 * wrapper pre-installing the globals — and drives the vestigial ant fast-exit
 * in runHeadless (USER_TYPE=ant + CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER=1):
 * reaching 'Startup time:' on stderr proves the provider install ran and
 * parseUserSpecifiedModel survived the ant guard. Pre-fix, this run died
 * silently and every assertion below the ReferenceError check failed
 * (mutation-verified RED).
 *
 * The fast exit fires before loadInitialMessages/auth/API calls, so the
 * unroutable ANTHROPIC_BASE_URL guarantees a network-free child. In-process
 * process.exit() would kill the test runner, hence the subprocess shape.
 * The cost-save assertions document mainline P3-4 semantics (last-session-wins
 * zero overwrite is by-design per docs/upstream-version-gap-occ133.md §P3-4):
 * this test only requires that the exit listener ran and persisted a session.
 */

const REPO_ROOT = realpathSync(join(import.meta.dirname, '..', '..', '..'))
const DIST_CLI = process.env.OCC_ENTRYPOINT ?? join(REPO_ROOT, 'dist', 'cli.js')
// ci.yml runs `bun run build` BEFORE scripts/ci-test.sh, and the Docker e2e
// image ships a built dist — so in CI this skip never triggers. It is a
// visible, reported skip (writeToDirectory278 discipline), not a silent one.
const HAS_DIST = existsSync(DIST_CLI)
const VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
).version

interface FastExitRun {
  code: number
  stdout: string
  stderr: string
}

interface SeededEnv {
  root: string
  home: string
  projDir: string
  cleanup: () => void
}

function seedEnv(): SeededEnv {
  const root = mkdtempSync(join(tmpdir(), 'occ-ant-gap133a-'))
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(join(root, 'proj'), { recursive: true })
  // realpath AFTER creation — the child's project-config key is derived from
  // its resolved cwd, so the seeded key must match byte-for-byte.
  const projDir = realpathSync(join(root, 'proj'))

  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-09-01T00:00:00.000Z',
      migrationVersion: 11,
      hasCompletedOnboarding: true,
      lastOnboardingVersion: VERSION,
      lastReleaseNotesSeen: VERSION,
      projects: { [projDir]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true }),
  )

  return {
    root,
    home,
    projDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function readProjectConfig(
  seeded: SeededEnv,
): Record<string, unknown> | undefined {
  const config = JSON.parse(
    readFileSync(join(seeded.home, '.claude.json'), 'utf8'),
  ) as { projects?: Record<string, Record<string, unknown>> }
  return config.projects?.[seeded.projDir]
}

function runAntFastExitDirect(seeded: SeededEnv): Promise<FastExitRun> {
  return new Promise(resolve => {
    // Deterministic child env: NODE_ENV must NOT be 'test' (that
    // short-circuits saveCurrentProjectConfig to an in-memory object — the
    // point is the real disk write), and no CLAUDE_CONFIG_DIR / ANTHROPIC_*
    // parent state may leak in.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: seeded.home,
      USER_TYPE: 'ant',
      CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER: '1',
      // Presence-only credential (the CI dummy): the auth-presence guard
      // passes, and the ant exit fires before any request is built. The
      // unroutable base URL is a belt-and-braces network-free guarantee.
      ANTHROPIC_API_KEY: 'sk-ant-test-dummy',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_UNATTENDED_RETRY: '0',
    }
    const child = spawn('bun', [DIST_CLI, '-p', 'hi'], {
      cwd: seeded.projDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    const timer = setTimeout(killGroup, 45_000)
    // Without an 'error' listener a missing/unspawnable `bun` surfaces as an
    // uncaught ENOENT that crashes the whole test runner instead of failing
    // this test legibly. Resolve with a harness-tagged marker so the guard
    // assertion below reports the spawn failure explicitly.
    child.on('error', err => {
      clearTimeout(timer)
      stderr += `\n[test-harness] spawn('bun') failed: ${err.message}`
      resolve({ code: -1, stdout, stderr })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

describe.skipIf(!HAS_DIST)(
  'Gap-133a: USER_TYPE=ant live path (real child process, dist/cli.js, no wrapper)',
  () => {
    test(
      'cli.tsx ambient-globals install lets ant runs reach runHeadless and fast-exit cleanly',
      async () => {
        const seeded = seedEnv()
        try {
          const run = await runAntFastExitDirect(seeded)

          // Pre-fix signature: silent exit 0, empty stdout/stderr — the
          // ReferenceError unhandled rejection drained the loop before
          // runHeadless. Post-fix: the ant fast-exit banner prints and the
          // cost-save exit listener persists this run's session id.
          expect(run.stderr).not.toContain("[test-harness] spawn('bun') failed")
          expect(run.stderr).not.toContain('resolveAntModel is not defined')
          expect(run.code).toBe(0)
          expect(run.stderr).toContain('Startup time:')

          const saved = readProjectConfig(seeded)
          expect(saved).toBeDefined()
          expect(typeof saved?.lastSessionId).toBe('string')
          expect((saved?.lastSessionId as string).length).toBeGreaterThan(0)
        } finally {
          seeded.cleanup()
        }
      },
      60_000,
    )
  },
)
