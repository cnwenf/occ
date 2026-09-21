import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * OCC-132 P2-2 (docs/upstream-version-gap-occ132.md §7): the print.ts:519
 * cost-save ordering was guarded only by static/unit tests. This drives the
 * REAL live path in a child `bun` process: the actual `runHeadless()` ant
 * branch registers `registerHeadlessCostSaveOnExit()` first, then
 * `USER_TYPE==='ant'` + `CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER` calls
 * `process.exit(0)`, which synchronously fires the 'exit' listener →
 * `saveCurrentSessionCosts()` → project-config write.
 *
 * The child (antFastExitDriver.ts) runs the real runHeadless; it does NOT run
 * main.tsx's full setup, which in dev/source ant mode throws on the ant-only
 * `getAntModelOverrideConfig` global and hangs on a growthbook fetch — both
 * unrelated to this finding. We assert on a REAL OS process exit(0), a REAL
 * 'exit' listener, and a REAL file write into an isolated CLAUDE_CONFIG_DIR.
 * No network: the ant branch exits before any model call and no API key/base
 * URL is provided.
 */

const DRIVER = join(import.meta.dir, 'antFastExitDriver.ts')
const KNOWN_COST = 1.75
const SPAWN_TIMEOUT_MS = 60_000

describe('OCC-132 P2-2: ant fast-exit live path saves cost totals on process.exit(0)', () => {
  test('runHeadless ant hard-exit fires the cost-save exit listener and writes project config', () => {
    const home = mkdtempSync(join(tmpdir(), 'occ-ant-home-'))
    const cfgDir = mkdtempSync(join(tmpdir(), 'occ-ant-cfg-'))
    const workDir = mkdtempSync(join(tmpdir(), 'occ-ant-work-'))
    try {
      // Minimal, isolated env. Deliberately omit ANTHROPIC_BASE_URL (so the
      // live gateway can't be reached) and NODE_ENV (so the real config-file
      // write path is used, not the in-memory 'test' config). The dummy key is
      // never used — the ant branch exits before any model call.
      const child = spawnSync(process.execPath, [DRIVER], {
        cwd: workDir,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          CLAUDE_CONFIG_DIR: cfgDir,
          USER_TYPE: 'ant',
          CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER: '1',
          ANTHROPIC_API_KEY: 'sk-ant-dummy-not-real',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      })

      expect(child.error).toBeUndefined()
      expect(child.status).toBe(0)
      expect(child.stderr).toContain('Startup time:')

      // The cost-save side effect landed in the isolated config dir.
      const configFile = join(cfgDir, '.claude.json')
      expect(existsSync(configFile)).toBe(true)

      const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as {
        projects?: Record<
          string,
          { lastCost?: number; lastSessionId?: string }
        >
      }
      const projects = parsed.projects ?? {}
      // The child's cwd is the project key (workDir is not a git repo, so
      // getProjectPathForConfig() resolves to the cwd itself).
      const projectKey = realpathSync(workDir)
      const saved = projects[projectKey]
      expect(saved).toBeDefined()
      expect(saved?.lastCost).toBe(KNOWN_COST)
      expect(typeof saved?.lastSessionId).toBe('string')
      expect((saved?.lastSessionId ?? '').length).toBeGreaterThan(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(cfgDir, { recursive: true, force: true })
      rmSync(workDir, { recursive: true, force: true })
    }
  }, SPAWN_TIMEOUT_MS)
})
