/**
 * SEC-2 hardening — session-env path-segment sanitization.
 *
 * `getSessionEnvDirPath()` interpolates a session id into a path segment
 * under `<config>/session-env/` and creates it with `mkdir(recursive)`.
 * Before the fix a hostile or corrupt id (`../../evil`, `a/b`) escaped the
 * session-env root and created arbitrary directories. The fix whitelists
 * `[A-Za-z0-9_-]` (every other character becomes `_`), keeping the layout
 * for canonical uuid session ids unchanged.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'fs'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve, sep } from 'path'

// ---------------------------------------------------------------------------
// Arrange — same pattern as sessionEnvKeying295.test.ts: mock the global
// session id BEFORE importing the module under test and point
// CLAUDE_CONFIG_DIR at a throwaway dir (getClaudeConfigHomeDir is memoized
// keyed off that env var, so a fresh value needs no cache clearing).
// ---------------------------------------------------------------------------

const actualStateModule = await import('../../bootstrap/state.js')
mock.module('../../bootstrap/state.js', () => ({
  ...(actualStateModule as object),
  getSessionId: () => 'sec2-global-session-id',
}))

const { getSessionEnvDirPath, sanitizeSessionIdSegment } = await import(
  '../sessionEnvironment.js'
)

const configDir = await mkdtemp(join(tmpdir(), 'occ-sec2-path-safety-'))
process.env.CLAUDE_CONFIG_DIR = configDir
const sessionEnvRoot = join(configDir, 'session-env')
// Unique per-run escape marker: the traversal-target assertions look at the
// SHARED tmpdir (dirname(configDir)), so a fixed name like 'evil' could
// collide with residue from other runs and produce phantom failures.
const escapeMark = `evil-${process.pid}-${Date.now().toString(36)}`

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// sanitizeSessionIdSegment (unit)
// ---------------------------------------------------------------------------

describe('sanitizeSessionIdSegment (SEC-2)', () => {
  test('keeps canonical session ids (uuid charset) byte-identical', () => {
    const uuid = '9f8a7b6c-1d2e-4f30-a1b2-c3d4e5f60789'
    expect(sanitizeSessionIdSegment(uuid)).toBe(uuid)
    expect(sanitizeSessionIdSegment('abc-123_DEF')).toBe('abc-123_DEF')
  })

  test('neutralizes path traversal and separator characters', () => {
    for (const hostile of ['../../evil', 'a/b', '..', '../..', 'a\\b']) {
      const sanitized = sanitizeSessionIdSegment(hostile)
      expect(sanitized).not.toContain('/')
      expect(sanitized).not.toContain('\\')
      expect(sanitized).not.toContain('.')
      expect(sanitized.length).toBe(hostile.length)
    }
  })

  test('replaces every non-whitelisted character with "_"', () => {
    expect(sanitizeSessionIdSegment('a b:c')).toBe('a_b_c')
    expect(sanitizeSessionIdSegment('id\x00nul')).toBe('id_nul')
  })

  test('maps an id that sanitizes to empty onto the "_" fallback', () => {
    expect(sanitizeSessionIdSegment('')).toBe('_')
  })
})

// ---------------------------------------------------------------------------
// getSessionEnvDirPath (directory-creation behavior)
// ---------------------------------------------------------------------------

describe('getSessionEnvDirPath hostile ids cannot escape session-env (SEC-2)', () => {
  test('"../../<mark>" stays inside <config>/session-env and creates nothing outside', async () => {
    const dir = await getSessionEnvDirPath(`../../${escapeMark}`)

    // The returned path is a direct child of the session-env root…
    expect(resolve(dirname(dir))).toBe(resolve(sessionEnvRoot))
    expect(dir.startsWith(sessionEnvRoot + sep)).toBe(true)
    // …the directory was created there…
    expect(existsSync(dir)).toBe(true)
    // …and nothing was created at the traversal targets.
    expect(await pathExists(join(configDir, escapeMark))).toBe(false)
    expect(await pathExists(join(dirname(configDir), escapeMark))).toBe(false)
  })

  test('"a/b" becomes a single segment, not a nested directory', async () => {
    const dir = await getSessionEnvDirPath('a/b')

    expect(resolve(dirname(dir))).toBe(resolve(sessionEnvRoot))
    expect(dir).toBe(join(sessionEnvRoot, 'a_b'))
    expect(existsSync(dir)).toBe(true)
    // The unsanitized id would have created <root>/a/ — it must not exist.
    expect(existsSync(join(sessionEnvRoot, 'a'))).toBe(false)
  })

  test('".." alone cannot key the session-env root itself', async () => {
    const dir = await getSessionEnvDirPath('..')

    expect(dir).not.toBe(resolve(sessionEnvRoot))
    expect(dir).not.toBe(resolve(configDir))
    expect(resolve(dirname(dir))).toBe(resolve(sessionEnvRoot))
  })

  test('empty id falls back to the "_" segment instead of the root dir', async () => {
    const dir = await getSessionEnvDirPath('')

    expect(dir).toBe(join(sessionEnvRoot, '_'))
  })

  test('legitimate ids keep the pre-fix on-disk layout', async () => {
    const id = 'resume-295_session-id'
    const dir = await getSessionEnvDirPath(id)

    expect(dir).toBe(join(sessionEnvRoot, id))
    expect(existsSync(dir)).toBe(true)
  })
})
