/**
 * claude-code 2.1.281 #049 (🔒) — saveOAuthTokensIfNeeded transient skip.
 *
 * v281 `Et()` (@195273552) changed the credential-save merge so a STRICT read
 * that classifies the store as transiently inaccessible (locked macOS keychain)
 * short-circuits BEFORE any write:
 *   strict-read transient -> sentinel
 *     -> logEvent("secure_storage_credentials_write","read_failed_skip_write")
 *     -> {success:false, transient:true}   (update() NEVER called)
 * The point is the shared keychain blob holds BOTH claudeAiOauth and mcpOAuth;
 * writing from an "empty" base (what a locked keychain looks like to a plain
 * read) would drop every mcpOAuth token, and the fallback storage's recovery
 * branch would then delete the keychain entry. #049 makes the save a no-op so
 * the existing blob survives untouched.
 *
 * These tests drive the REAL `saveOAuthTokensIfNeeded` with a controllable fake
 * SecureStorage swapped in via mock.module (getSecureStorage is the only export
 * of secureStorage/index.ts). The real module is captured + restored in afterAll
 * so the mock never leaks into other files sharing this worker (OCC-97).
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'

// Capture the real index module BEFORE mocking so afterAll can restore it.
// Spread snapshot — a bare import namespace has LIVE bindings that bun's
// mock.module patches; the afterAll heal below must read the REAL backend.
const realSecureStorageIndex = { ...(await import('../secureStorage/index.js')) }
import { TRANSIENT_READ_FAILURE } from '../secureStorage/transientRead.js'

// Per-test controllable fake; getSecureStorage() returns whatever this points at.
let fakeStorage: unknown

mock.module('../secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))

// Import the target AFTER the mock is registered so auth.ts binds the fake.
const { saveOAuthTokensIfNeeded } = await import('../auth.js')

afterAll(() => {
  // Heal the seam first: modules whose bindings already resolved to the mock
  // namespace keep this closure for the rest of the shared process, and no
  // beforeEach/afterEach runs after this file — pointing the seam at the REAL
  // backend keeps any leaked getSecureStorage() behavior-neutral.
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  // Restore the real module for any other test file in this worker (OCC-97).
  mock.module('../secureStorage/index.js', () => realSecureStorageIndex)
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

/** A token set that passes the shouldUseClaudeAIAuth + refreshToken/expiresAt gates. */
function validTokens(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    scopes: ['user:inference'],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// (a) transient read -> write skipped
// ---------------------------------------------------------------------------

describe('#049 saveOAuthTokensIfNeeded — transient (locked keychain) skip', () => {
  test('a transient strict read returns {success:false,transient:true} and never writes', () => {
    // The live keychain blob: an existing login PLUS an mcpOAuth token.
    const seeded = {
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        subscriptionType: 'max',
      },
      mcpOAuth: {
        'srv-a': { accessToken: 'mcp-token-a', refreshToken: 'mcp-refresh-a' },
      },
    }
    const fake = createFakeStorage({
      strictResult: TRANSIENT_READ_FAILURE,
      stored: seeded,
    })
    fakeStorage = fake.storage

    const result = saveOAuthTokensIfNeeded(validTokens() as never)

    // Exact transient contract — no warning key.
    expect(result).toEqual({ success: false, transient: true })
    expect(result.warning).toBeUndefined()

    // The whole point of #049: update() is NEVER called on a transient read.
    expect(fake.updateCalls.length).toBe(0)

    // The existing blob is byte-identical — mcpOAuth survives, nothing dropped.
    expect(fake.getStored()).toEqual(seeded)
    expect(
      (fake.getStored() as { mcpOAuth: { 'srv-a': { accessToken: string } } })
        .mcpOAuth['srv-a'].accessToken,
    ).toBe('mcp-token-a')
  })

  test('the sentinel is identity-matched (a plain empty read is NOT transient)', () => {
    // readStrict returns null (empty, not locked) -> must take the write path.
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage

    const result = saveOAuthTokensIfNeeded(validTokens() as never)

    expect(result.transient).toBeUndefined()
    expect(result.success).toBe(true)
    expect(fake.updateCalls.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (b) non-transient read -> normal update path (+ immutable merge)
// ---------------------------------------------------------------------------

describe('#049 saveOAuthTokensIfNeeded — non-transient write path', () => {
  test('an empty (null) strict read writes a fresh claudeAiOauth blob', () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage

    const result = saveOAuthTokensIfNeeded(validTokens() as never)

    expect(result.success).toBe(true)
    expect(fake.updateCalls.length).toBe(1)
    const written = fake.updateCalls[0]!.data as {
      claudeAiOauth: Record<string, unknown>
    }
    expect(written.claudeAiOauth.accessToken).toBe('new-access')
    expect(written.claudeAiOauth.refreshToken).toBe('new-refresh')
    expect(written.claudeAiOauth.scopes).toEqual(['user:inference'])
  })

  test('a non-empty strict read merges immutably — mcpOAuth + unrelated keys preserved', () => {
    const seeded = {
      claudeAiOauth: {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        subscriptionType: 'max',
        rateLimitTier: 'tier-x',
      },
      mcpOAuth: { 'srv-a': { accessToken: 'mcp-token-a' } },
      someOtherKey: 42,
    }
    const fake = createFakeStorage({ strictResult: seeded, stored: seeded })
    fakeStorage = fake.storage

    // tokens carry no subscriptionType/rateLimitTier -> must fall back to existing.
    const result = saveOAuthTokensIfNeeded(validTokens() as never)

    expect(result.success).toBe(true)
    const written = fake.updateCalls[0]!.data as Record<string, unknown>

    // mcpOAuth + unrelated keys survive the merge (the #049 invariant, on the
    // non-transient path too).
    expect(written.mcpOAuth).toEqual({ 'srv-a': { accessToken: 'mcp-token-a' } })
    expect(written.someOtherKey).toBe(42)

    // New tokens replaced the old claudeAiOauth...
    const oauth = written.claudeAiOauth as Record<string, unknown>
    expect(oauth.accessToken).toBe('new-access')
    // ...but subscription/rateLimit fall back to the existing stored values.
    expect(oauth.subscriptionType).toBe('max')
    expect(oauth.rateLimitTier).toBe('tier-x')

    // The seeded blob was NOT mutated in place (immutable spread).
    expect(seeded.claudeAiOauth.accessToken).toBe('old-access')
  })

  test('a backend without readStrict falls back to read() and still writes', () => {
    // Emulates plainTextStorage (Linux): no readStrict, no transient state.
    const fake = createFakeStorage({
      strictResult: null,
      stored: null,
      hasReadStrict: false,
    })
    fakeStorage = fake.storage

    const result = saveOAuthTokensIfNeeded(validTokens() as never)

    expect(result.success).toBe(true)
    expect(result.transient).toBeUndefined()
    expect(fake.updateCalls.length).toBe(1)
  })
})
