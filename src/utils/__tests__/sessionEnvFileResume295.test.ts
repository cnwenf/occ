import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import {
  getHookEnvFilePath,
  getSessionEnvDirPath,
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from '../sessionEnvironment.js'

// CC 2.1.295 (#071): "Fixed variables a SessionStart hook writes to
// CLAUDE_ENV_FILE not reaching the Bash tool after an in-app /resume or
// /branch." Root cause: the in-app resume runs processSessionStartHooks BEFORE
// switchSession(), so during the hook the ambient getSessionId() is still the
// OLD id — the hook's CLAUDE_ENV_FILE lands in the old session's env dir and the
// Bash tool (reading the resumed dir) never sees it. The fix threads an explicit
// envFileSessionId (= resumed id) down to getSessionEnvDirPath/getHookEnvFilePath
// and invalidates the session-env cache. These tests pin the core mechanism.
//
// Official evidence (v295 compiled bundle):
//   getSessionEnvDirPath  uIe(e=K())                       @215372474
//   getHookEnvFilePath    Uht(e,n,r)->join(uIe(r),...)     @215372992
//   hook env builder      CLAUDE_ENV_FILE=Uht(n,G,h.envFileSessionId) @217811376

const OLD_ID = 'old-session-aaaaaaaa'
const RESUMED_ID = 'resumed-session-bbbbbbbb'

let configDir: string
let savedConfigDir: string | undefined
let savedEnvFile: string | undefined

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'occ-sessionenv-295-'))
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedEnvFile = process.env.CLAUDE_ENV_FILE
  process.env.CLAUDE_CONFIG_DIR = configDir
  // getSessionEnvironmentScript() also folds in a parent-provided
  // CLAUDE_ENV_FILE; remove it so only the hook env dir is under test.
  delete process.env.CLAUDE_ENV_FILE
  invalidateSessionEnvCache()
})

afterEach(async () => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (savedEnvFile === undefined) {
    delete process.env.CLAUDE_ENV_FILE
  } else {
    process.env.CLAUDE_ENV_FILE = savedEnvFile
  }
  invalidateSessionEnvCache()
  await rm(configDir, { recursive: true, force: true })
})

describe('CC 2.1.295 #071 — getSessionEnvDirPath explicit session id', () => {
  test('uses the explicit session id when provided, ignoring the ambient id', async () => {
    switchSession(asSessionId(OLD_ID))
    const dir = await getSessionEnvDirPath(RESUMED_ID)
    expect(dir).toBe(join(configDir, 'session-env', RESUMED_ID))
    // ambient is still the OLD id — the explicit arg must win
    expect(getSessionId()).toBe(OLD_ID)
  })

  test('falls back to the ambient getSessionId() when omitted', async () => {
    switchSession(asSessionId(OLD_ID))
    const dir = await getSessionEnvDirPath()
    expect(dir).toBe(join(configDir, 'session-env', OLD_ID))
  })

  test('creates the directory on disk', async () => {
    switchSession(asSessionId(OLD_ID))
    const dir = await getSessionEnvDirPath(RESUMED_ID)
    // writeFile succeeds only if the dir was mkdir'd (recursive)
    await writeFile(join(dir, 'probe.txt'), 'ok')
    const probe = await readFile(join(dir, 'probe.txt'), 'utf8')
    expect(probe).toBe('ok')
  })
})

describe('CC 2.1.295 #071 — getHookEnvFilePath threads envFileSessionId', () => {
  test('resolves under the envFileSessionId dir when provided', async () => {
    switchSession(asSessionId(OLD_ID))
    const p = await getHookEnvFilePath('SessionStart', 0, RESUMED_ID)
    expect(p).toBe(
      join(configDir, 'session-env', RESUMED_ID, 'sessionstart-hook-0.sh'),
    )
  })

  test('resolves under the ambient dir when envFileSessionId is omitted', async () => {
    switchSession(asSessionId(OLD_ID))
    const p = await getHookEnvFilePath('SessionStart', 0)
    expect(p).toBe(
      join(configDir, 'session-env', OLD_ID, 'sessionstart-hook-0.sh'),
    )
  })

  test('preserves the per-event filename prefix and hook index', async () => {
    switchSession(asSessionId(RESUMED_ID))
    expect(await getHookEnvFilePath('Setup', 2, RESUMED_ID)).toBe(
      join(configDir, 'session-env', RESUMED_ID, 'setup-hook-2.sh'),
    )
    expect(await getHookEnvFilePath('CwdChanged', 1, RESUMED_ID)).toBe(
      join(configDir, 'session-env', RESUMED_ID, 'cwdchanged-hook-1.sh'),
    )
    expect(await getHookEnvFilePath('FileChanged', 3, RESUMED_ID)).toBe(
      join(configDir, 'session-env', RESUMED_ID, 'filechanged-hook-3.sh'),
    )
  })
})

describe('CC 2.1.295 #071 — CLAUDE_ENV_FILE reaches Bash after resume', () => {
  test('a SessionStart var written under envFileSessionId survives the post-hook switchSession', async () => {
    // Arrange: ambient session is the OLD (pre-resume) id — this is the state
    // while the in-app resume's SessionStart hooks are still running.
    switchSession(asSessionId(OLD_ID))

    // Act: the hook writes its export to CLAUDE_ENV_FILE. With the fix, the path
    // is computed with envFileSessionId = the RESUMED id, so the file lands in
    // the resumed session's dir even though ambient is still OLD.
    const envFile = await getHookEnvFilePath('SessionStart', 0, RESUMED_ID)
    await writeFile(envFile, 'export RESUMED_VAR=from_hook\n')

    // The resume then calls switchSession(RESUMED) and processSessionStartHooks
    // invalidates the session-env cache (envFileSessionId was set).
    switchSession(asSessionId(RESUMED_ID))
    invalidateSessionEnvCache()

    // Assert: the Bash-facing script now contains the hook's variable.
    const script = await getSessionEnvironmentScript()
    expect(script).toContain('export RESUMED_VAR=from_hook')
  })

  test('regression guard: writing under the ambient (old) id loses the var after switchSession', async () => {
    // This reproduces the PRE-fix bug: with no envFileSessionId the path uses the
    // ambient OLD id, so after switchSession(RESUMED) the Bash tool reads the
    // (empty) resumed dir and the variable never arrives.
    switchSession(asSessionId(OLD_ID))
    const envFile = await getHookEnvFilePath('SessionStart', 0) // no envFileSessionId
    expect(envFile).toContain(OLD_ID)
    await writeFile(envFile, 'export LOST_VAR=should_not_arrive\n')

    switchSession(asSessionId(RESUMED_ID))
    invalidateSessionEnvCache()

    const script = await getSessionEnvironmentScript()
    expect(script ?? '').not.toContain('LOST_VAR')
  })

  test('invalidateSessionEnvCache forces a re-read so a post-resume write is picked up', async () => {
    switchSession(asSessionId(RESUMED_ID))
    // Prime the cache while the resumed dir is empty.
    expect(await getSessionEnvironmentScript()).toBeNull()

    // A hook writes after the cache was primed.
    const envFile = await getHookEnvFilePath('SessionStart', 0, RESUMED_ID)
    await writeFile(envFile, 'export LATE_VAR=1\n')

    // Without invalidation the stale (null) cache would be served.
    expect(await getSessionEnvironmentScript()).toBeNull()

    // The fix's invalidation step unblocks the read.
    invalidateSessionEnvCache()
    const script = await getSessionEnvironmentScript()
    expect(script).toContain('export LATE_VAR=1')
  })
})
