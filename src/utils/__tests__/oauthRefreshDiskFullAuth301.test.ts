// CC 2.1.301 PORT #9 (auth side) — disk-full detection at the OAuth refresh
// catch sites in src/utils/auth.ts.
//
// Official v301 (linux-x64 ELF, byte-verified via grep+dd — binary NEVER
// executed):
//   classifier @216477455: `function TGo(n){let e=E(n);return e==="ENOSPC"||
//     e==="EDQUOT"}` — error-CODE based;
//   producer @219775178 (lock-acquisition catch): logs
//     tengu_oauth_token_refresh_lock_error + oauth_token_refresh/
//     oauth_refresh_lock_error, then yields `TGo(te)?"lock_disk_full":
//     "lock_error"`;
//   throw site @228690043: `if(yo==="lock_disk_full"&&Bqr(H))throw
//     m("api_request","api_request_oauth_refresh_disk_full"),
//     new Rc(new wG,y)` (Rc ≡ CannotRetryError, wG ≡
//     OAuthRefreshDiskFullError).
//
// OCC adaptation (per task directive): OCC has no client-retry-level
// `yo`-kind plumbing, so the disk-full classification + throw happen directly
// at the refresh catch sites in auth.ts (config-dir mkdir, lock acquisition,
// token refresh). The plain (non-APIError) throw is AUTOMATICALLY wrapped in
// CannotRetryError by withRetry's non-retryable guard (withRetry.ts
// :1176-1181), exactly replicating the official `new Rc(new wG,y)` — no
// wrapping needed here. The classifier follows official TGo (code-based) plus
// the message-includes fallback from OCC's ENOSPC precedent
// (NativeAutoUpdater.tsx:33-34) for errors that lost their code.
//
// Regression contract: NON-disk-full lock/refresh errors keep the pre-301
// behavior (logEvent + resolve false) — the throw is disk-full only.

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
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// --- mocks: install BEFORE requiring auth.js ----------------------------------
// Passthrough-flag pattern: spread snapshots of the real namespaces; flags
// flip off in afterAll so later files in the shared bun process see genuine
// behavior.

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

// oauth client: mutable refreshOAuthToken impl (isOAuthTokenExpired /
// shouldUseClaudeAIAuth stay real — the test fixtures rely on them).
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

// analytics: record events so the api_request_oauth_refresh_disk_full reason
// is assertable (auth.ts imports logEvent via the 'src/services/analytics'
// alias — same resolved module as this relative specifier).
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
  checkAndRefreshOAuthTokenIfNeeded,
  isDiskFullOAuthRefreshError,
  clearOAuthTokenCache,
} = require('../auth.js') as typeof import('../auth.js')
const { OAuthRefreshDiskFullError } =
  require('../../services/api/errors.js') as typeof import('../../services/api/errors.js')
const { getClaudeConfigHomeDir } =
  require('../envUtils.js') as typeof import('../envUtils.js')

// --- fixture: temp config dir with an EXPIRED claude.ai credential -------------
// Same drive pattern as oauthUnusableTokenRecheck286.test.ts.

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
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-301-diskfull-'))
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
  // Default impls: a lock that succeeds with a counting release.
  lockImpl = async () => {
    return async () => {
      releaseCalls++
    }
  }
  refreshImpl = async () => {
    throw new Error('unexpected refresh call')
  }
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

// --- unit: isDiskFullOAuthRefreshError (official TGo + OCC message fallback) ----

describe('CC 2.1.301 #9 — isDiskFullOAuthRefreshError classifier', () => {
  test('ENOSPC / EDQUOT error codes → true (official TGo, code-based)', () => {
    expect(isDiskFullOAuthRefreshError({ code: 'ENOSPC' })).toBe(true)
    expect(isDiskFullOAuthRefreshError({ code: 'EDQUOT' })).toBe(true)
    expect(
      isDiskFullOAuthRefreshError(codedError('ENOSPC', 'no space left on device')),
    ).toBe(true)
    expect(
      isDiskFullOAuthRefreshError(codedError('EDQUOT', 'disk quota exceeded')),
    ).toBe(true)
  })

  test('message-only ENOSPC/EDQUOT (code lost) → true (NativeAutoUpdater precedent)', () => {
    expect(
      isDiskFullOAuthRefreshError(
        new Error('ENOSPC: no space left on device, open \'/x/.credentials.json\''),
      ),
    ).toBe(true)
    expect(
      isDiskFullOAuthRefreshError(new Error('write EDQUOT: disk quota exceeded')),
    ).toBe(true)
  })

  test('other errors → false', () => {
    expect(
      isDiskFullOAuthRefreshError(codedError('EACCES', 'permission denied')),
    ).toBe(false)
    expect(isDiskFullOAuthRefreshError(new Error('EACCES: permission denied'))).toBe(
      false,
    )
    expect(isDiskFullOAuthRefreshError(new Error('ELOCKED'))).toBe(false)
    expect(isDiskFullOAuthRefreshError(new Error('invalid_grant'))).toBe(false)
  })

  test('non-error inputs → false, never throws', () => {
    expect(isDiskFullOAuthRefreshError(null)).toBe(false)
    expect(isDiskFullOAuthRefreshError(undefined)).toBe(false)
    expect(isDiskFullOAuthRefreshError('ENOSPC')).toBe(false)
    expect(isDiskFullOAuthRefreshError(42)).toBe(false)
    expect(isDiskFullOAuthRefreshError({})).toBe(false)
  })
})

// --- integration: refresh-path wiring -------------------------------------------

describe('CC 2.1.301 #9 — checkAndRefreshOAuthTokenIfNeeded disk-full wiring', () => {
  test(
    'ENOSPC during lock acquisition rejects with OAuthRefreshDiskFullError + api_request event',
    async () => {
      // Arrange — official producer path: lock-acquisition catch classifies
      // ENOSPC as "lock_disk_full" → throw site raises wG.
      lockImpl = async () => {
        throw codedError('ENOSPC', 'ENOSPC: no space left on device, mkdir \'/x\'')
      }

      // Act/Assert
      await expect(checkAndRefreshOAuthTokenIfNeeded()).rejects.toBeInstanceOf(
        OAuthRefreshDiskFullError,
      )
      const apiRequest = events.find(
        e =>
          e.name === 'api_request' &&
          e.metadata.reason === 'api_request_oauth_refresh_disk_full',
      )
      expect(apiRequest).toBeDefined()
      // The pre-existing lock-error telemetry still fires (official producer
      // logs tengu_oauth_token_refresh_lock_error BEFORE classifying).
      expect(
        events.find(e => e.name === 'tengu_oauth_token_refresh_lock_error'),
      ).toBeDefined()
    },
    15000,
  )

  test(
    'non-disk-full lock acquisition error still resolves false (regression guard)',
    async () => {
      // Arrange
      lockImpl = async () => {
        throw codedError('EACCES', 'EACCES: permission denied')
      }

      // Act/Assert — pre-301 behavior unchanged: log + false, no throw.
      await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(false)
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

  test(
    'EDQUOT during the token refresh rejects with OAuthRefreshDiskFullError and releases the lock',
    async () => {
      // Arrange — lock OK; the refresh itself hits a full quota (e.g. saving
      // through a filesystem layer that surfaces EDQUOT).
      refreshImpl = async () => {
        throw codedError('EDQUOT', 'EDQUOT: disk quota exceeded')
      }

      // Act/Assert
      await expect(checkAndRefreshOAuthTokenIfNeeded()).rejects.toBeInstanceOf(
        OAuthRefreshDiskFullError,
      )
      expect(releaseCalls).toBe(1) // finally still released the lock
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
    'non-disk-full refresh error still resolves false (regression guard)',
    async () => {
      // Arrange
      refreshImpl = async () => {
        throw new Error('invalid_grant')
      }

      // Act/Assert — pre-301 catch behavior: cache clear, race check, false.
      await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(false)
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
