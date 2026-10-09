/**
 * CC 2.1.295 (Item 4) — session env-file keying unit tests.
 *
 * Regression: in-app /resume and /branch fire SessionStart hooks BEFORE
 * switchSession(), so the global getSessionId() still returns the OLD session
 * id at hook time. CLAUDE_ENV_FILE writes keyed on the global id landed in the
 * old session's dir and never reached Bash after the switch. The fix keys the
 * env dir on an EXPLICIT sessionId (the hook input's session_id — the session
 * being resumed INTO) with the global id only as fallback.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Arrange — mock the global session id BEFORE importing the module under test,
// and point CLAUDE_CONFIG_DIR at a throwaway dir (getClaudeConfigHomeDir is
// memoized keyed off that env var, so a fresh value needs no cache clearing).
// ---------------------------------------------------------------------------

const GLOBAL_SESSION_ID = 'global-old-session-id'

const actualStateModule = await import('../../bootstrap/state.js')
mock.module('../../bootstrap/state.js', () => ({
  ...(actualStateModule as object),
  getSessionId: () => GLOBAL_SESSION_ID,
}))

const { getSessionEnvDirPath, getHookEnvFilePath } = await import(
  '../sessionEnvironment.js'
)

const configDir = await mkdtemp(join(tmpdir(), 'occ-session-env-keying-'))
process.env.CLAUDE_CONFIG_DIR = configDir

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(configDir, { recursive: true, force: true })
})

async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// getSessionEnvDirPath
// ---------------------------------------------------------------------------

describe('getSessionEnvDirPath keying (CC 2.1.295 Item 4)', () => {
  test('keys the env dir on the explicit session id, not the global one', async () => {
    // Arrange — the resume-INTO session differs from the still-active global id.
    const resumedSessionId = 'resumed-into-session-id'

    // Act
    const dir = await getSessionEnvDirPath(resumedSessionId)

    // Assert — path keys on the explicit id and the directory is created
    expect(dir).toBe(join(configDir, 'session-env', resumedSessionId))
    expect(await dirExists(dir)).toBe(true)
    expect(dir).not.toBe(join(configDir, 'session-env', GLOBAL_SESSION_ID))
  })

  test('falls back to the global session id when no explicit id is passed', async () => {
    // Act
    const dir = await getSessionEnvDirPath()

    // Assert
    expect(dir).toBe(join(configDir, 'session-env', GLOBAL_SESSION_ID))
    expect(await dirExists(dir)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getHookEnvFilePath
// ---------------------------------------------------------------------------

describe('getHookEnvFilePath keying (CC 2.1.295 Item 4)', () => {
  test('builds the CLAUDE_ENV_FILE path under the explicit session dir', async () => {
    // Arrange
    const resumedSessionId = 'hook-env-session-id'

    // Act
    const filePath = await getHookEnvFilePath('SessionStart', 0, resumedSessionId)

    // Assert — this is exactly what execCommandHook exports as CLAUDE_ENV_FILE
    expect(filePath).toBe(
      join(configDir, 'session-env', resumedSessionId, 'sessionstart-hook-0.sh'),
    )
    expect(
      await dirExists(join(configDir, 'session-env', resumedSessionId)),
    ).toBe(true)
  })

  test('lowercases the hook event and appends the hook index to the filename', async () => {
    // Act
    const cwdChanged = await getHookEnvFilePath('CwdChanged', 2, 'fmt-session')
    const fileChanged = await getHookEnvFilePath('FileChanged', 11, 'fmt-session')

    // Assert
    expect(cwdChanged).toBe(
      join(configDir, 'session-env', 'fmt-session', 'cwdchanged-hook-2.sh'),
    )
    expect(fileChanged).toBe(
      join(configDir, 'session-env', 'fmt-session', 'filechanged-hook-11.sh'),
    )
  })

  test('falls back to the global session id when no explicit id is passed', async () => {
    // Act
    const filePath = await getHookEnvFilePath('SessionStart', 3)

    // Assert
    expect(filePath).toBe(
      join(
        configDir,
        'session-env',
        GLOBAL_SESSION_ID,
        'sessionstart-hook-3.sh',
      ),
    )
  })

  test('keeps distinct sessions in distinct dirs (old writes cannot leak into the resumed session)', async () => {
    // Arrange
    const oldDir = await getSessionEnvDirPath()
    const newDir = await getSessionEnvDirPath('brand-new-session-id')

    // Act
    const oldPath = await getHookEnvFilePath('SessionStart', 0)
    const newPath = await getHookEnvFilePath(
      'SessionStart',
      0,
      'brand-new-session-id',
    )

    // Assert — same hook event + index, different session keys → different files
    expect(oldDir).not.toBe(newDir)
    expect(oldPath).not.toBe(newPath)
    expect(oldPath.startsWith(oldDir)).toBe(true)
    expect(newPath.startsWith(newDir)).toBe(true)
  })
})
