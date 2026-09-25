/**
 * claude-code 2.1.281 #049 (🔒), acceptance round RT-2 — mcpOAuth write paths.
 *
 * The v281 `Et()` strict-read guard (@195273515) protects the SHARED keychain
 * blob: one entry holds `claudeAiOauth` AND every server's `mcpOAuth` /
 * `mcpOAuthClientConfig`. `src/utils/auth.ts` `saveOAuthTokensIfNeeded` was
 * already guarded (see saveOAuthTokensTransient281.test.ts); this file pins
 * the SAME contract for the mcpOAuth merge-and-write flows in
 * `src/services/mcp/auth.ts`, which now all route through the common
 * `mergeWriteSecureStorage` helper:
 *
 *   strict-read transient (locked macOS keychain) -> sentinel
 *     -> logEvent("secure_storage_credentials_write","read_failed_skip_write")
 *     -> update() NEVER called — the pre-existing blob survives untouched.
 *
 * Without the guard, `read() || {}` on a locked keychain merges from an empty
 * base and `update()` clobbers every other credential in the blob (data loss).
 *
 * Previously-unguarded paths driven here:
 *   - saveMcpClientSecret()            (exported, synchronous)
 *   - ClaudeAuthProvider.saveTokens()
 *   - ClaudeAuthProvider.saveClientInformation()
 *   - ClaudeAuthProvider.saveDiscoveryState()
 *
 * Repo mock.module template (saveOAuthTokensTransient281.test.ts /
 * dangerousRmAutoDenyWindow281.test.ts): snapshot actuals BEFORE mocking,
 * dynamic-import the module under test AFTER registration, heal the seam +
 * restore in afterAll — bun's mock.module is process-global and
 * mock.restore() does NOT heal already-resolved bindings (OCC-97).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// Capture the real modules BEFORE mocking (spread snapshots — bare import
// namespaces have LIVE bindings that mock.module patches).
const realSecureStorageIndex = {
  ...(await import('../../../utils/secureStorage/index.js')),
}
const realAnalytics = { ...(await import('../../analytics/index.js')) }
import { TRANSIENT_READ_FAILURE } from '../../../utils/secureStorage/transientRead.js'

// Per-test controllable seams.
let fakeStorage: unknown
let loggedEvents: Array<{ name: string; metadata: Record<string, unknown> }> =
  []
// Passthrough flags: with these off (afterAll) both seams delegate to the REAL
// implementations, so leaked closures stay behavior-neutral for later files
// in the shared test process.
let mcpTransientMocksActive = true
const actualLogEvent = realAnalytics.logEvent as (
  name: string,
  metadata: Record<string, unknown>,
) => void

mock.module('../../../utils/secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))

mock.module('../../analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (name: string, metadata: Record<string, unknown>) => {
    if (mcpTransientMocksActive) {
      loggedEvents.push({ name, metadata })
    } else {
      actualLogEvent(name, metadata)
    }
  },
}))

// Import the targets AFTER the mocks are registered so mcp/auth.ts binds the
// fakes. Cache-busting specifier: an isolated instance bound to THIS file's
// mocks (the module is also imported un-mocked by other test files).
const ISOLATED_SPECIFIER = '../auth.js?occ-mcp-oauth-transient-281'
const { saveMcpClientSecret, ClaudeAuthProvider, getServerKey } = (await import(
  ISOLATED_SPECIFIER
)) as typeof import('../auth.js')

afterAll(() => {
  mcpTransientMocksActive = false
  // Heal the storage seam: point it at the REAL backend so any leaked
  // getSecureStorage() closure stays behavior-neutral.
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  // Restore the real modules for any other test file in this worker (OCC-97).
  mock.module(
    '../../../utils/secureStorage/index.js',
    () => realSecureStorageIndex,
  )
  mock.module('../../analytics/index.js', () => realAnalytics)
})

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type UpdateCall = { data: Record<string, unknown> }

interface FakeStorage {
  storage: Record<string, unknown>
  updateCalls: UpdateCall[]
  getStored(): Record<string, unknown> | null
}

/**
 * Build a fake SecureStorage. `strictResult` is what readStrict() returns
 * (the sentinel, null, or a blob). `stored` is the backing blob, mutated ONLY
 * by update() — so an untouched `stored` proves the write was skipped.
 * Set `hasReadStrict:false` to emulate a backend without strict support
 * (plainTextStorage on Linux), exercising the `?? read()` fallback.
 */
function createFakeStorage(config: {
  strictResult?: unknown
  stored?: Record<string, unknown> | null
  hasReadStrict?: boolean
  name?: string
}): FakeStorage {
  const updateCalls: UpdateCall[] = []
  let stored = config.stored ?? null
  const storage: Record<string, unknown> = {
    name: config.name ?? 'fake-keychain-with-plaintext-fallback',
    update(data: Record<string, unknown>) {
      updateCalls.push({ data })
      stored = data
      return { success: true }
    },
    read() {
      return stored
    },
    delete() {
      stored = null
      return true
    },
  }
  if (config.hasReadStrict !== false) {
    storage.readStrict = (_options?: unknown) => config.strictResult ?? null
  }
  return { storage, updateCalls, getStored: () => stored }
}

const SERVER_NAME = 'srv-a'
const SERVER_CONFIG = {
  type: 'http' as const,
  url: 'https://srv-a.example.com/mcp',
}
// The key the flows compute for SERVER_CONFIG (sha256 prefix — stable within
// a run; asserted via getServerKey rather than hardcoded).
const SERVER_KEY = getServerKey(SERVER_NAME, SERVER_CONFIG)

/** The live keychain blob: a login PLUS another server's mcpOAuth token. */
function seededBlob(): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      subscriptionType: 'max',
    },
    mcpOAuth: {
      'srv-other|abc123': {
        accessToken: 'mcp-token-other',
        refreshToken: 'mcp-refresh-other',
      },
    },
    mcpOAuthClientConfig: {
      'srv-other|abc123': { clientSecret: 'other-secret' },
    },
  }
}

function makeProvider(): InstanceType<typeof ClaudeAuthProvider> {
  return new ClaudeAuthProvider(
    SERVER_NAME,
    SERVER_CONFIG,
    'http://localhost:33418/callback',
  )
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return loggedEvents.filter((e) => e.name === name).map((e) => e.metadata)
}

function resetEvents(): void {
  loggedEvents = []
}

// ---------------------------------------------------------------------------
// (a) saveMcpClientSecret — previously-unguarded exported write path
// ---------------------------------------------------------------------------

describe('#049 RT-2 saveMcpClientSecret — transient (locked keychain) skip', () => {
  test('a transient strict read skips the write and the seeded blob survives untouched', () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({
      strictResult: TRANSIENT_READ_FAILURE,
      stored: seeded,
    })
    fakeStorage = fake.storage

    saveMcpClientSecret(SERVER_NAME, SERVER_CONFIG, 'new-client-secret')

    // The whole point of #049: update() is NEVER called on a transient read.
    expect(fake.updateCalls.length).toBe(0)
    // The existing blob is byte-identical — claudeAiOauth + other servers survive.
    expect(fake.getStored()).toEqual(seeded)

    // Official telemetry contract: read_failed_skip_write + backend name.
    const telemetry = eventsNamed('secure_storage_credentials_write')
    expect(telemetry).toHaveLength(1)
    expect(telemetry[0]).toMatchObject({
      reason: 'read_failed_skip_write',
      storageBackend: 'fake-keychain-with-plaintext-fallback',
    })
  })

  test('a non-transient read merges the secret in, preserving every pre-existing entry', () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({ strictResult: seeded, stored: seeded })
    fakeStorage = fake.storage

    saveMcpClientSecret(SERVER_NAME, SERVER_CONFIG, 'new-client-secret')

    expect(fake.updateCalls.length).toBe(1)
    const written = fake.updateCalls[0]!.data as Record<string, unknown>
    expect(written.mcpOAuthClientConfig).toEqual({
      'srv-other|abc123': { clientSecret: 'other-secret' },
      [SERVER_KEY]: { clientSecret: 'new-client-secret' },
    })
    // Sibling sections survive the merge (the #049 invariant, write path).
    expect(written.claudeAiOauth).toEqual(seeded.claudeAiOauth)
    expect(written.mcpOAuth).toEqual(seeded.mcpOAuth)
    expect(eventsNamed('secure_storage_credentials_write')).toHaveLength(0)
  })

  test('a backend without readStrict falls back to read() and still writes', () => {
    resetEvents()
    // Emulates plainTextStorage (Linux): no readStrict, no transient state.
    const seeded = seededBlob()
    const fake = createFakeStorage({
      stored: seeded,
      hasReadStrict: false,
    })
    fakeStorage = fake.storage

    saveMcpClientSecret(SERVER_NAME, SERVER_CONFIG, 'linux-secret')

    expect(fake.updateCalls.length).toBe(1)
    const written = fake.updateCalls[0]!.data as Record<string, unknown>
    const clientConfig = written.mcpOAuthClientConfig as Record<string, unknown>
    expect(clientConfig[SERVER_KEY]).toEqual({ clientSecret: 'linux-secret' })
    expect(written.mcpOAuth).toEqual(seeded.mcpOAuth)
  })
})

// ---------------------------------------------------------------------------
// (b) ClaudeAuthProvider write paths — previously-unguarded instance methods
// ---------------------------------------------------------------------------

describe('#049 RT-2 ClaudeAuthProvider — transient (locked keychain) skip', () => {
  test('saveTokens skips the write on a transient read; seeded blob untouched', async () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({
      strictResult: TRANSIENT_READ_FAILURE,
      stored: seeded,
    })
    fakeStorage = fake.storage

    await makeProvider().saveTokens({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
    })

    expect(fake.updateCalls.length).toBe(0)
    expect(fake.getStored()).toEqual(seeded)
    expect(eventsNamed('secure_storage_credentials_write')).toHaveLength(1)
  })

  test('saveClientInformation skips the write on a transient read', async () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({
      strictResult: TRANSIENT_READ_FAILURE,
      stored: seeded,
    })
    fakeStorage = fake.storage

    await makeProvider().saveClientInformation({
      client_id: 'new-client-id',
      client_secret: 'new-client-secret',
    })

    expect(fake.updateCalls.length).toBe(0)
    expect(fake.getStored()).toEqual(seeded)
    expect(eventsNamed('secure_storage_credentials_write')).toHaveLength(1)
  })

  test('saveDiscoveryState skips the write on a transient read', async () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({
      strictResult: TRANSIENT_READ_FAILURE,
      stored: seeded,
    })
    fakeStorage = fake.storage

    await makeProvider().saveDiscoveryState({
      authorizationServerUrl: 'https://idp.example.com',
      resourceMetadataUrl: 'https://srv-a.example.com/.well-known/oauth-protected-resource',
    } as never)

    expect(fake.updateCalls.length).toBe(0)
    expect(fake.getStored()).toEqual(seeded)
    expect(eventsNamed('secure_storage_credentials_write')).toHaveLength(1)
  })

  test('the sentinel is identity-matched — a plain empty read is NOT transient', async () => {
    resetEvents()
    // readStrict returns null (empty store, not locked) -> must take the
    // write path (a fresh blob is created, nothing to clobber).
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage

    await makeProvider().saveTokens({
      access_token: 'new-access',
      token_type: 'Bearer',
      expires_in: 3600,
    })

    expect(fake.updateCalls.length).toBe(1)
    expect(eventsNamed('secure_storage_credentials_write')).toHaveLength(0)
    const written = fake.updateCalls[0]!.data as Record<string, unknown>
    const entry = (written.mcpOAuth as Record<string, Record<string, unknown>>)[
      SERVER_KEY
    ]!
    expect(entry.accessToken).toBe('new-access')
    expect(entry.serverName).toBe(SERVER_NAME)
    expect(entry.serverUrl).toBe(SERVER_CONFIG.url)
  })

  test('a non-transient saveTokens merges immutably — sibling credentials preserved', async () => {
    resetEvents()
    const seeded = seededBlob()
    const fake = createFakeStorage({ strictResult: seeded, stored: seeded })
    fakeStorage = fake.storage

    await makeProvider().saveTokens({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'read write',
    })

    expect(fake.updateCalls.length).toBe(1)
    const written = fake.updateCalls[0]!.data as Record<string, unknown>
    // The other server's token + the login survive (the #049 invariant).
    expect(written.mcpOAuth).toMatchObject(seeded.mcpOAuth as object)
    expect(written.claudeAiOauth).toEqual(seeded.claudeAiOauth)
    expect(written.mcpOAuthClientConfig).toEqual(seeded.mcpOAuthClientConfig)
    // The new entry landed under this server's key.
    const entry = (written.mcpOAuth as Record<string, Record<string, unknown>>)[
      SERVER_KEY
    ]!
    expect(entry.accessToken).toBe('new-access')
    expect(entry.refreshToken).toBe('new-refresh')
    expect(entry.scope).toBe('read write')
    // The seeded blob was NOT mutated in place (immutable spread).
    const seededMcp = seeded.mcpOAuth as Record<string, unknown>
    expect(seededMcp[SERVER_KEY]).toBeUndefined()
  })
})
