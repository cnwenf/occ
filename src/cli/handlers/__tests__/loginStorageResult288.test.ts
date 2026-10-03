/**
 * claude-code 2.1.288 #35 — /login must NOT report success when saving the
 * credentials failed.
 *
 * Official v288 shape (byte-verified in /tmp/cc-diff-288/v288/package/claude):
 *
 *   vDe save fn @~223531700 now RETURNS (v287 LHe returned void):
 *     return {storage:{success:o.success, backendName:o.backendName,
 *                      transient:o.transient,
 *                      sessionAuth:o.success||P5r(e.accessToken)?"fresh"
 *                                            :Zp()?"previous":"none"}}
 *   where P5r(t) = t!=null && mn()?.accessToken===t  (the in-process token IS
 *   the new token) and Zp() = mn()?.accessToken!=null (any in-process token);
 *   mn() is the memoized credential getter (env → fd → secure storage) ≡ OCC's
 *   getClaudeAIOAuthTokens().
 *
 *   ConsoleOAuthFlow caller @223557800-223560400 branches on
 *   `let me=Y?.storage; if(me&&!me.success)` → storage_failed UI +
 *   `auth_storage_failure` notification (verbatim strings @223558664/223558737,
 *   type @223558787); else → success + `auth_success`.
 *
 * These tests cover:
 *  (a) the pure `resolveLoginSessionAuth` resolver (fresh/previous/none);
 *  (b) `installOAuthTokens` returning the {storage:{...}} result — driven with
 *      the REAL utils/auth.ts save path against a fake SecureStorage (same
 *      mock.module seam pattern as saveOAuthTokensTransient281.test.ts), so
 *      the storage result + sessionAuth classification are integration-real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'

// Capture real modules BEFORE mocking (spread snapshot — bare namespaces have
// live bindings that bun's mock.module patches; OCC-97 seam-heal discipline).
const realLogout = { ...(await import('../../../commands/logout/logout.js')) }
const realOauthClient = { ...(await import('../../../services/oauth/client.js')) }
const realFirstTokenDate = {
  ...(await import('../../../services/api/firstTokenDate.js')),
}
const realSecureStorageIndex = {
  ...(await import('../../../utils/secureStorage/index.js')),
}
const { TRANSIENT_READ_FAILURE } = await import(
  '../../../utils/secureStorage/transientRead.js'
)

// Per-test controllable fake; getSecureStorage() returns whatever this points at.
let fakeStorage: unknown

mock.module('../../../commands/logout/logout.js', () => ({
  ...realLogout,
  performLogout: async () => {},
  clearAuthRelatedCaches: async () => {},
}))
mock.module('../../../services/oauth/client.js', () => ({
  ...realOauthClient,
  storeOAuthAccountInfo: () => {},
  fetchAndStoreUserRoles: async () => ({}),
  createAndStoreApiKey: async () => 'sk-fake-key',
}))
mock.module('../../../services/api/firstTokenDate.js', () => ({
  ...realFirstTokenDate,
  fetchAndStoreClaudeCodeFirstTokenDate: async () => null,
}))
mock.module('../../../utils/secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))

// Import the target AFTER the mocks are registered so auth.ts binds the fakes.
const { installOAuthTokens, resolveLoginSessionAuth } = await import('../auth.js')

afterAll(() => {
  // Heal the seam first (OCC-97): point the storage seam at the REAL backend so
  // any leaked getSecureStorage() is behavior-neutral, then restore modules.
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  mock.module('../../../commands/logout/logout.js', () => realLogout)
  mock.module('../../../services/oauth/client.js', () => realOauthClient)
  mock.module('../../../services/api/firstTokenDate.js', () => realFirstTokenDate)
  mock.module('../../../utils/secureStorage/index.js', () => realSecureStorageIndex)
})

// ---------------------------------------------------------------------------
// Fixtures / fakes
// ---------------------------------------------------------------------------

/** A fake SecureStorage with controllable name/read/update behavior. */
function createFakeStorage(config: {
  name?: string
  stored?: Record<string, unknown> | null
  strictResult?: unknown
  updateResult?: { success: boolean; warning?: string }
}): Record<string, unknown> {
  return {
    name: config.name ?? 'plaintext',
    readStrict: (_options?: unknown) => config.strictResult ?? null,
    read: () => config.stored ?? null,
    update: (_data: Record<string, unknown>) => config.updateResult ?? { success: true },
    delete: () => true,
  }
}

/** Token set that passes shouldUseClaudeAIAuth + refreshToken/expiresAt gates. */
function loginTokens(overrides: Record<string, unknown> = {}): never {
  return {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    scopes: ['user:inference'],
    profile: {
      account: {
        uuid: 'acct-1',
        email: 'user@example.com',
        display_name: 'User',
        created_at: '2026-01-01T00:00:00Z',
      },
      organization: {
        uuid: 'org-1',
        has_extra_usage_enabled: false,
        billing_type: null,
        subscription_created_at: null,
      },
    },
    ...overrides,
  } as never
}

const savedEnvOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

beforeAll(() => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
})

afterEach(() => {
  if (savedEnvOAuthToken === undefined) {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  } else {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnvOAuthToken
  }
})

// ---------------------------------------------------------------------------
// (a) pure resolver — official `o.success||P5r(e.accessToken)?"fresh":Zp()?"previous":"none"`
// ---------------------------------------------------------------------------

describe('#35 resolveLoginSessionAuth — official vDe sessionAuth classification', () => {
  test('a successful save is always "fresh"', () => {
    expect(
      resolveLoginSessionAuth({
        storageSuccess: true,
        newAccessToken: 'new-access',
        sessionAccessToken: null,
      }),
    ).toBe('fresh')
  })

  test('failed save but the in-process token IS the new token (P5r) → "fresh"', () => {
    expect(
      resolveLoginSessionAuth({
        storageSuccess: false,
        newAccessToken: 'new-access',
        sessionAccessToken: 'new-access',
      }),
    ).toBe('fresh')
  })

  test('failed save with a DIFFERENT in-process token (Zp) → "previous"', () => {
    expect(
      resolveLoginSessionAuth({
        storageSuccess: false,
        newAccessToken: 'new-access',
        sessionAccessToken: 'old-access',
      }),
    ).toBe('previous')
  })

  test('failed save with no in-process token → "none"', () => {
    expect(
      resolveLoginSessionAuth({
        storageSuccess: false,
        newAccessToken: 'new-access',
        sessionAccessToken: null,
      }),
    ).toBe('none')
  })

  test('null new token never matches (P5r requires t != null)', () => {
    expect(
      resolveLoginSessionAuth({
        storageSuccess: false,
        newAccessToken: null,
        sessionAccessToken: 'old-access',
      }),
    ).toBe('previous')
    expect(
      resolveLoginSessionAuth({
        storageSuccess: false,
        newAccessToken: undefined,
        sessionAccessToken: null,
      }),
    ).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// (b) installOAuthTokens — {storage:{success, backendName, transient, sessionAuth}}
// ---------------------------------------------------------------------------

describe('#35 installOAuthTokens — v288 storage result contract', () => {
  test('a successful save returns {storage:{success:true, sessionAuth:"fresh"}} with the backend name', async () => {
    fakeStorage = createFakeStorage({ name: 'plaintext', stored: null })

    const result = await installOAuthTokens(loginTokens())

    expect(result.storage.success).toBe(true)
    expect(result.storage.backendName).toBe('plaintext')
    expect(result.storage.transient).toBeUndefined()
    expect(result.storage.sessionAuth).toBe('fresh')
  })

  test('a failed save returns success:false + sessionAuth "previous" when an old credential remains in storage', async () => {
    fakeStorage = createFakeStorage({
      name: 'keychain-with-plaintext-fallback',
      stored: { claudeAiOauth: { accessToken: 'old-access' } },
      updateResult: { success: false, warning: 'disk full' },
    })

    const result = await installOAuthTokens(loginTokens())

    expect(result.storage.success).toBe(false)
    expect(result.storage.backendName).toBe('keychain-with-plaintext-fallback')
    expect(result.storage.sessionAuth).toBe('previous')
  })

  test('a failed save with empty storage returns sessionAuth "none"', async () => {
    fakeStorage = createFakeStorage({
      name: 'plaintext',
      stored: null,
      updateResult: { success: false },
    })

    const result = await installOAuthTokens(loginTokens())

    expect(result.storage.success).toBe(false)
    expect(result.storage.sessionAuth).toBe('none')
  })

  test('a transient (locked-keychain) save with an env OAuth override does NOT throw and reports transient:true + sessionAuth "fresh" (env token === new token)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'new-access'
    fakeStorage = createFakeStorage({
      name: 'keychain-with-plaintext-fallback',
      strictResult: TRANSIENT_READ_FAILURE,
      stored: { claudeAiOauth: { accessToken: 'old-access' } },
    })

    const result = await installOAuthTokens(loginTokens())

    expect(result.storage.success).toBe(false)
    expect(result.storage.transient).toBe(true)
    // Official P5r: mn()?.accessToken === new token → "fresh" (the session WILL
    // authenticate with the new token — via the env override).
    expect(result.storage.sessionAuth).toBe('fresh')
  })

  test('v281 behavior preserved: transient save WITHOUT env/fd override still throws', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    fakeStorage = createFakeStorage({
      name: 'keychain-with-plaintext-fallback',
      strictResult: TRANSIENT_READ_FAILURE,
      stored: null,
    })

    expect(installOAuthTokens(loginTokens())).rejects.toThrow(
      "Couldn't save your login. Try logging in again.",
    )
  })
})
