// CC 2.1.301 PORT #9 — P2 acceptance fix (call-site guard).
//
// The 301 alignment changed checkAndRefreshOAuthTokenIfNeeded's disk-full
// contract from `resolve(false)` to THROW OAuthRefreshDiskFullError (auth.ts
// throw sites: config-dir mkdir, lock acquisition, token refresh). Four raw
// call sites had no catch — on ENOSPC/EDQUOT they would surface an unhandled
// rejection (fire-and-forget voice stream), mass-reject every claudeai-proxy
// connector request, or abort a tool call / bridge resume:
//   - src/services/voiceStreamSTT.ts (connectVoiceStream)
//   - src/services/mcp/client.ts (createClaudeAiProxyFetch doRequest)
//   - src/tools/RemoteTriggerTool/RemoteTriggerTool.ts (call)
//   - src/bridge/bridgeMain.ts (session-resume path)
//
// Fix: those sites now call checkAndRefreshOAuthTokenIfNeededBestEffort,
// which degrades ONLY OAuthRefreshDiskFullError to the pre-301 `false`
// semantics; every other error keeps its original propagation. The throw
// body itself is untouched — the API path (services/api/claude.ts mapper)
// still receives and unwraps the actionable error.
//
// This file pins:
//   1. the name-based instance predicate (no auth↔errors import cycle),
//   2. best-effort degradation at BOTH disk-full throw paths reachable
//      without heavy fs mocking (lock + refresh) AND the mkdir path,
//   3. non-disk-full error propagation (pre-301 contract unchanged),
//   4. call-site wiring (scoped source assertions — the behavioral surface
//      of the four sites needs the full WS/MCP/tool/bridge stacks, so the
//      wiring is pinned structurally per the claudeaiProxyNoRedirect299
//      precedent).
//
// Fixture pattern: oauthRefreshDiskFullAuth301.test.ts (temp config dir with
// an expired claude.ai credential; mutable lockfile/oauth/fs mocks installed
// BEFORE requiring auth.js; passthrough flags flip off in afterAll).

import {
  afterAll,
  beforeAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- mocks: install BEFORE requiring auth.js ----------------------------------

// lockfile: mutable lock impl so we can simulate ENOSPC on lock acquisition.
const actualLockfile = { ...require('../lockfile.js') } as typeof import('../lockfile.js')
let lockfileMockActive = true
let lockImpl: (target: string, opts?: unknown) => Promise<() => Promise<void>>
let releaseCalls = 0
mock.module('../lockfile.js', () => ({
  ...actualLockfile,
  lock: (target: string, opts?: unknown) => {
    if (!lockfileMockActive) {
      return (actualLockfile.lock as Function)(target, opts)
    }
    return lockImpl(target, opts)
  },
}))

// oauth client: mutable refreshOAuthToken impl.
const actualOAuthClient = { ...require('../../services/oauth/client.js') } as typeof import('../../services/oauth/client.js')
let oauthClientMockActive = true
let refreshImpl: (refreshToken: string, opts?: unknown) => Promise<unknown>
mock.module('../../services/oauth/client.js', () => ({
  ...actualOAuthClient,
  refreshOAuthToken: (refreshToken: string, opts?: unknown) => {
    if (!oauthClientMockActive) {
      return (actualOAuthClient.refreshOAuthToken as Function)(refreshToken, opts)
    }
    return refreshImpl(refreshToken, opts)
  },
}))

// fs/promises: mutable mkdir impl so we can simulate disk-full / permission
// failures at the config-dir mkdir throw site. Everything else (readFile,
// stat, ...) passes through untouched.
const actualFsPromises = { ...require('fs/promises') } as typeof import('fs/promises')
let mkdirMockActive = false
let mkdirImpl: (target: string, opts?: unknown) => Promise<unknown>
mock.module('fs/promises', () => ({
  ...actualFsPromises,
  mkdir: (target: string, opts?: unknown) => {
    if (!mkdirMockActive) {
      return (actualFsPromises.mkdir as Function)(target, opts)
    }
    return mkdirImpl(target, opts)
  },
}))

// analytics: record events so the pre-throw disk-full telemetry stays
// assertable through the degrade path.
const actualAnalytics = { ...require('../../services/analytics/index.js') } as typeof import('../../services/analytics/index.js')
let analyticsMockActive = true
type RecordedEvent = { name: string; metadata: Record<string, unknown> }
const events: RecordedEvent[] = []
mock.module('../../services/analytics/index.js', () => ({
  ...actualAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (!analyticsMockActive) return actualAnalytics.logEvent(name, metadata)
    events.push({ name, metadata })
  },
}))

// Require targets AFTER mock registration.
const {
  checkAndRefreshOAuthTokenIfNeededBestEffort,
  isOAuthRefreshDiskFullErrorInstance,
  clearOAuthTokenCache,
} = require('../auth.js') as typeof import('../auth.js')
const { OAuthRefreshDiskFullError } =
  require('../../services/api/errors.js') as typeof import('../../services/api/errors.js')
const { getClaudeConfigHomeDir } =
  require('../envUtils.js') as typeof import('../envUtils.js')

// --- fixture: temp config dir with an EXPIRED claude.ai credential -------------

const ENV_TO_CLEAR = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
]

let tmpConfigDir: string
let credPath: string
const savedEnv: Record<string, string | undefined> = {}
let savedConfigDir: string | undefined

function writeExpiredCred(): void {
  writeFileSync(
    credPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at-expired',
        refreshToken: 'rt-test',
        expiresAt: Date.now() - 60_000,
        scopes: ['user:inference'],
      },
    }),
  )
}

function codedError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-301-besteffort-'))
  credPath = join(tmpConfigDir, '.credentials.json')
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
})

beforeEach(() => {
  for (const k of ENV_TO_CLEAR) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  writeExpiredCred()
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  events.length = 0
  releaseCalls = 0
  lockfileMockActive = true
  oauthClientMockActive = true
  analyticsMockActive = true
  mkdirMockActive = false
  // Default impls: a lock that succeeds with a counting release; a refresh
  // that should never be reached unless a test asks for it.
  lockImpl = async () => {
    return async () => {
      releaseCalls++
    }
  }
  refreshImpl = async () => {
    throw new Error('unexpected refresh call')
  }
  mkdirImpl = async (target: string, opts?: unknown) =>
    (actualFsPromises.mkdir as Function)(target, opts)
})

afterEach(() => {
  for (const k of ENV_TO_CLEAR) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
})

afterAll(() => {
  lockfileMockActive = false
  oauthClientMockActive = false
  analyticsMockActive = false
  mkdirMockActive = false
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the tmp fixture
  }
})

// --- unit: isOAuthRefreshDiskFullErrorInstance (name-based, cycle-free) --------

describe('CC 2.1.301 #9 P2 — isOAuthRefreshDiskFullErrorInstance predicate', () => {
  test('matches the real OAuthRefreshDiskFullError class instance', () => {
    expect(
      isOAuthRefreshDiskFullErrorInstance(new OAuthRefreshDiskFullError()),
    ).toBe(true)
  })

  test('matches by name across module identities (deferred-import safety)', () => {
    // The throw sites construct the class via a deferred dynamic import
    // (auth↔errors cycle guard). A structurally identical error carrying the
    // pinned `name` must still be recognized.
    const crossRealmLike = Object.assign(new Error('some other message'), {
      name: 'OAuthRefreshDiskFullError',
    })
    expect(isOAuthRefreshDiskFullErrorInstance(crossRealmLike)).toBe(true)
  })

  test('other errors and non-errors → false', () => {
    expect(isOAuthRefreshDiskFullErrorInstance(new Error('ENOSPC'))).toBe(false)
    expect(
      isOAuthRefreshDiskFullErrorInstance(codedError('ENOSPC', 'disk full')),
    ).toBe(false) // raw fs error — that is isDiskFullOAuthRefreshError's job
    expect(isOAuthRefreshDiskFullErrorInstance(null)).toBe(false)
    expect(isOAuthRefreshDiskFullErrorInstance(undefined)).toBe(false)
    expect(isOAuthRefreshDiskFullErrorInstance('OAuthRefreshDiskFullError')).toBe(false)
    expect(
      isOAuthRefreshDiskFullErrorInstance({ name: 'OAuthRefreshDiskFullError' }),
    ).toBe(false) // plain object, not an Error instance
  })
})

// --- integration: best-effort degradation at every disk-full throw path -------

describe('CC 2.1.301 #9 P2 — checkAndRefreshOAuthTokenIfNeededBestEffort', () => {
  test(
    'lock-acquisition ENOSPC degrades to false (was: unhandled rejection at raw call sites)',
    async () => {
      lockImpl = async () => {
        throw codedError('ENOSPC', 'ENOSPC: no space left on device, mkdir \'/x\'')
      }

      await expect(
        checkAndRefreshOAuthTokenIfNeededBestEffort('[test]'),
      ).resolves.toBe(false)

      // The impl's pre-throw telemetry still fired (degrade happens AFTER
      // the official api_request producer, at the call-site wrapper).
      expect(
        events.find(
          e =>
            e.name === 'api_request' &&
            e.metadata.reason === 'api_request_oauth_refresh_disk_full',
        ),
      ).toBeDefined()
    },
    15000,
  )

  test(
    'refresh-path EDQUOT degrades to false and still releases the lock',
    async () => {
      refreshImpl = async () => {
        throw codedError('EDQUOT', 'EDQUOT: disk quota exceeded')
      }

      await expect(
        checkAndRefreshOAuthTokenIfNeededBestEffort('[test]'),
      ).resolves.toBe(false)
      expect(releaseCalls).toBe(1)
    },
    15000,
  )

  test(
    'config-dir mkdir ENOSPC degrades to false',
    async () => {
      mkdirMockActive = true
      mkdirImpl = async () => {
        throw codedError('ENOSPC', 'ENOSPC: no space left on device')
      }

      await expect(
        checkAndRefreshOAuthTokenIfNeededBestEffort('[test]'),
      ).resolves.toBe(false)
    },
    15000,
  )

  test(
    'non-disk-full mkdir error keeps its pre-301 raw propagation (rethrow gate)',
    async () => {
      mkdirMockActive = true
      mkdirImpl = async () => {
        throw codedError('EACCES', 'EACCES: permission denied')
      }

      // The best-effort wrapper degrades ONLY OAuthRefreshDiskFullError —
      // every other error must propagate unchanged (pre-301 contract).
      await expect(
        checkAndRefreshOAuthTokenIfNeededBestEffort('[test]'),
      ).rejects.toThrow('EACCES')
    },
    15000,
  )

  test(
    'non-disk-full refresh error still resolves false (pre-301 behavior unchanged)',
    async () => {
      refreshImpl = async () => {
        throw new Error('invalid_grant')
      }

      await expect(
        checkAndRefreshOAuthTokenIfNeededBestEffort('[test]'),
      ).resolves.toBe(false)
      expect(releaseCalls).toBe(1)
      expect(
        events.find(
          e =>
            e.name === 'api_request' &&
            e.metadata.reason === 'api_request_oauth_refresh_disk_full',
        ),
      ).toBeUndefined()
    },
    15000,
  )
})

// --- wiring: the four raw call sites now use the best-effort variant ----------

describe('CC 2.1.301 #9 P2 — raw call sites are guarded (wiring)', () => {
  const srcRoot = join(import.meta.dir, '..', '..')

  function read(rel: string): string {
    return readFileSync(join(srcRoot, rel), 'utf8')
  }

  test('voiceStreamSTT connectVoiceStream uses the best-effort variant', () => {
    const source = read('services/voiceStreamSTT.ts')
    expect(source).toContain(
      "checkAndRefreshOAuthTokenIfNeededBestEffort('[voice_stream]')",
    )
    // No unguarded raw call remains in this file (the BestEffort name never
    // contains the bare `checkAndRefreshOAuthTokenIfNeeded(` substring).
    expect(source).not.toContain('checkAndRefreshOAuthTokenIfNeeded(')
  })

  test('mcp/client createClaudeAiProxyFetch uses the best-effort variant', () => {
    const source = read('services/mcp/client.ts')
    expect(source).toContain(
      "checkAndRefreshOAuthTokenIfNeededBestEffort('[mcp claudeai-proxy]')",
    )
    expect(source).not.toContain('checkAndRefreshOAuthTokenIfNeeded(')
  })

  test('RemoteTriggerTool call() uses the best-effort variant', () => {
    const source = read('tools/RemoteTriggerTool/RemoteTriggerTool.ts')
    expect(source).toContain(
      "checkAndRefreshOAuthTokenIfNeededBestEffort('[remote_trigger]')",
    )
    expect(source).not.toContain('checkAndRefreshOAuthTokenIfNeeded(')
  })

  test('bridgeMain session-resume uses the best-effort variant', () => {
    const source = read('bridge/bridgeMain.ts')
    expect(source).toContain(
      "checkAndRefreshOAuthTokenIfNeededBestEffort('[bridge session-resume]')",
    )
    // bridgeMain keeps ONE raw call (the runBridgeLoop token-getter callback
    // at ~:2896) — that rejection path is awaited by the bridge main's error
    // handling, so the actionable disk-full error still surfaces there.
    const rawCalls = source.match(/await checkAndRefreshOAuthTokenIfNeeded\(\)/g)
    expect(rawCalls?.length).toBe(1)
  })
})
