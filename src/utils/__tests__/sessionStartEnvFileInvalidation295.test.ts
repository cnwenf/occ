import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Some transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { switchSession } from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import {
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from '../sessionEnvironment.js'
import { processSessionStartHooks } from '../sessionStart.js'

// CC 2.1.295 (#071): the in-app /resume + /branch path threads an explicit
// envFileSessionId into processSessionStartHooks. When it is set, the session-env
// cache MUST be invalidated after the hooks run so the Bash tool re-reads the
// resumed session's env dir instead of serving a stale pre-resume value.
//
// Official evidence (v295 compiled bundle):
//   mJ(e,n,{...,envFileSessionId:ke}={})                 @217319721
//   `... _e||ke!==void 0)kte()`  (kte = invalidate)      @217322255
//   v294 G9 fired only on `_e` (newPluginsOnly)          @214856490
// OCC has no newPluginsOnly, so the trigger reduces to envFileSessionId!=undefined.

const RESUMED_ID = 'resumed-integration-cccc'

let configDir: string
let savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'occ-sessionstart-295-'))
  savedEnv = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CLAUDE_ENV_FILE: process.env.CLAUDE_ENV_FILE,
    // processSessionStartHooks early-returns under bare/safe mode (before the
    // invalidation), so make sure neither is active.
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
    CLAUDE_CODE_SAFE_MODE: process.env.CLAUDE_CODE_SAFE_MODE,
  }
  process.env.CLAUDE_CONFIG_DIR = configDir
  delete process.env.CLAUDE_ENV_FILE
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_SAFE_MODE
  invalidateSessionEnvCache()
})

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  invalidateSessionEnvCache()
  await rm(configDir, { recursive: true, force: true })
})

// Simulate a SessionStart hook that already wrote its CLAUDE_ENV_FILE export
// under the resumed session's env dir (what getHookEnvFilePath(...,RESUMED_ID)
// points the hook at — covered by sessionEnvFileResume295.test.ts).
async function writeResumedHookFile(content: string): Promise<void> {
  const dir = join(configDir, 'session-env', RESUMED_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'sessionstart-hook-0.sh'), content)
}

describe('CC 2.1.295 #071 — processSessionStartHooks cache invalidation', () => {
  test('resume WITH envFileSessionId invalidates the stale session-env cache', async () => {
    switchSession(asSessionId(RESUMED_ID))
    // Prime the cache while the resumed dir is empty → caches null.
    expect(await getSessionEnvironmentScript()).toBeNull()
    // The hook writes its export after the cache was primed.
    await writeResumedHookFile('export RESUMED_VAR=1\n')
    // Cache is stale: still null without invalidation.
    expect(await getSessionEnvironmentScript()).toBeNull()

    // The in-app resume path passes envFileSessionId → the cache must be
    // invalidated so the next read picks up the hook's write.
    await processSessionStartHooks('resume', { envFileSessionId: RESUMED_ID })

    const script = await getSessionEnvironmentScript()
    expect(script).toContain('export RESUMED_VAR=1')
  })

  test('resume WITHOUT envFileSessionId does NOT invalidate (startup/compact/clear unchanged)', async () => {
    switchSession(asSessionId(RESUMED_ID))
    expect(await getSessionEnvironmentScript()).toBeNull()
    await writeResumedHookFile('export RESUMED_VAR=1\n')
    expect(await getSessionEnvironmentScript()).toBeNull()

    // The startup-resume path (conversationRecovery.loadConversationForResume)
    // passes only {sessionId} — no envFileSessionId — matching official, which
    // threads envFileSessionId on the in-app caller only. So the cache is
    // intentionally left untouched here.
    await processSessionStartHooks('resume', { sessionId: RESUMED_ID })

    expect(await getSessionEnvironmentScript()).toBeNull()
  })
})
