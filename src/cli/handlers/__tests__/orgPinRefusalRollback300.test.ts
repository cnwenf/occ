/**
 * CC 2.1.300 (#19, P1-2) — a login refused by `forceLoginOrgUUID` must leave
 * NO trace in the install path: the refused org's account record must not stay
 * in globalConfig.oauthAccount, prior credentials must survive untouched, and
 * the cached-account fallback in `checkOrgPinForTokenSave` must not be poisoned
 * for later saves.
 *
 * Bug on HEAD: `installOAuthTokens` runs performLogout FIRST, then
 * `storeOAuthAccountInfo` (refused org's record written), then
 * `saveOAuthTokensIfNeeded` (where the org-pin refusal happens). On refusal
 * nothing rolls back, so:
 *   (A) globalConfig.oauthAccount keeps organizationUuid 'org-refused', and a
 *       LATER correct-org save whose tokens lack org metadata is wrongly
 *       refused via the `getOauthAccountInfo()?.organizationUuid` fallback;
 *   (B) the claim "the prior credentials survive untouched" is false —
 *       performLogout already wiped them.
 *
 * Official v300 byte-verified order (ELF forensics, /tmp/cc-fix-300/package/claude):
 *   - login flow @242589186: `let a=Ju(),p=await bee(E,{…}),h=await O1e(p);
 *     if(h.outcome==="refused"){if(a)await ECo(a,m);await R(…)}` — the org-pin
 *     validator `O1e` runs BEFORE the persist fn `FGe`; on refusal `FGe` never
 *     executes (browser path), and the refresh path additionally restores the
 *     account snapshot (`Ju` @219110002 = `ce().oauthAccount`; `ECo` @218862306
 *     = saveGlobalConfig restore guarded on same accountUuid + not-deep-equal).
 *   - `FGe` @242172197 → `yWr`: logout `mre({clearOnboarding:!1,…})` → profile
 *     fetch `d9e` → account store `lsn` → token save `WIr`. So officially the
 *     mutation window (logout + account store + token save) is INSIDE the
 *     persist fn that only runs after validation passed.
 *   - `WIr` @219087585 has NO pin check — official validates before persist,
 *     not inside the save.
 *   - `O1e` @219129901 resolves the token org from the network profile fetch
 *     only — it never consults the cached oauthAccount record.
 *
 * Fix design (matches official validate-before-persist inside OCC's adjudicated
 * sync-latch architecture): `installOAuthTokens` hoists the profile resolution
 * and calls the new sync `checkOrgPinForLoginInstall(tokens, profile)` BEFORE
 * performLogout; on refusal it records the `pendingOrgPinRefusal` latch and
 * returns early — the mutation window never runs.
 *
 * Cases:
 *   (i)   refused install → globalConfig.oauthAccount equals the pre-login
 *         snapshot (refused-org uuid absent);
 *   (ii)  after a refused install, correct-org tokens WITHOUT org metadata save
 *         successfully (no cached-account fallback poisoning);
 *   (iii) prior credentials survive untouched — performLogout NOT called,
 *         storage unchanged, sessionAuth reports "previous";
 *   (iii-b) a refused install skips the post-save side effects (roles);
 *   (iv)  the latch is still consumed by validateForceLoginOrg exactly once
 *         (preservation guard — green on HEAD and after the fix);
 *   (v)/(vi) permitted / not_checked installs still run the full persist flow
 *         (over-blocking guards — green on HEAD and after the fix).
 *
 * Rig: loginStorageResult288.test.ts (installOAuthTokens against the REAL
 * utils/auth save path + fake SecureStorage) extended with an in-memory
 * globalConfig fake so the REAL `storeOAuthAccountInfo` poisoning is
 * observable, and a fake-effect performLogout spy (counts calls AND emulates
 * the credential/account wipe). OCC-97: snapshot real exports, override
 * narrowly, seam-heal + restore in afterAll.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// Sandbox any real config reads/writes BEFORE the snapshot imports run.
const tempConfigDir = mkdtempSync(join(tmpdir(), 'occ-orgpin-rollback-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = tempConfigDir

// Env hygiene: isAnthropicAuthEnabled() must be TRUE so getOauthAccountInfo()
// (the cached-account fallback under test) is live; credential resolution must
// come from the fake storage, not env/fd overrides.
const CONTROLLED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE',
] as const
const savedEnv: Record<string, string | undefined> = {}
// bun test sets NODE_ENV=test, which arms the CI guard in
// getAnthropicApiKeyWithSource ("ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
// env var is required" — it THROWS instead of returning source:'none'). That
// guard would break isAnthropicAuthEnabled() for this suite; run as
// 'development' (logEvent is unaffected — the analytics sink is null in tests,
// events just queue) and restore in afterAll.
const savedNodeEnv = process.env.NODE_ENV
const savedCi = process.env.CI
process.env.NODE_ENV = 'development'
delete process.env.CI

// Capture real modules BEFORE mocking (spread snapshot — OCC-97 discipline).
const realConfigModule = { ...(await import('../../../utils/config.js')) }
const realSecureStorageIndex = {
  ...(await import('../../../utils/secureStorage/index.js')),
}
const realSettingsModule = {
  ...(await import('../../../utils/settings/settings.js')),
}
const realAllowedProvidersModule = {
  ...(await import('../../../utils/settings/allowedProvidersEnforcement.js')),
}
const realOauthProfileModule = {
  ...(await import('../../../services/oauth/getOauthProfile.js')),
}
const realLogoutModule = {
  ...(await import('../../../commands/logout/logout.js')),
}
const realOauthClientModule = {
  ...(await import('../../../services/oauth/client.js')),
}
const realFirstTokenDateModule = {
  ...(await import('../../../services/api/firstTokenDate.js')),
}

// ---------------------------------------------------------------------------
// Fakes (module-scope — the mock factories close over these)
// ---------------------------------------------------------------------------

type FakeGlobalConfig = {
  oauthAccount?: Record<string, unknown> | undefined
  [key: string]: unknown
}

/** In-memory globalConfig — the REAL storeOAuthAccountInfo writes land here. */
let fakeConfig: FakeGlobalConfig = {}

/** Per-test fake SecureStorage rig; getSecureStorage() returns `.storage`. */
let fakeStorage: unknown
let fakeStorageRig: FakeStorageRig

/** Mutable org pin returned by the mocked policySettings source. */
let policyPin: string | undefined

/** Controllable profile-fetch result (getOauthProfileFromOauthToken). */
let profileFetchResult: unknown = null

/** performLogout spy — counts calls AND emulates the real credential wipe. */
const performLogoutCalls: Array<Record<string, unknown>> = []
const fetchAndStoreUserRolesCalls: string[] = []
const createAndStoreApiKeyCalls: string[] = []

interface FakeStorageRig {
  storage: Record<string, unknown>
  updateCalls: Array<{ data: Record<string, unknown> }>
  deleteCalls: number
  getStored(): Record<string, unknown> | null
}

function createFakeStorage(config: {
  stored?: Record<string, unknown> | null
  name?: string
}): FakeStorageRig {
  const updateCalls: Array<{ data: Record<string, unknown> }> = []
  let stored = config.stored ?? null
  let deleteCalls = 0
  const storage: Record<string, unknown> = {
    name: config.name ?? 'fake-keychain',
    update(data: Record<string, unknown>) {
      updateCalls.push({ data })
      stored = data
      return { success: true }
    },
    read() {
      return stored
    },
    readStrict(_options?: unknown) {
      return null
    },
    delete() {
      deleteCalls += 1
      stored = null
      return true
    },
  }
  return {
    storage,
    updateCalls,
    get deleteCalls() {
      return deleteCalls
    },
    getStored: () => stored,
  } as FakeStorageRig
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

mock.module('../../../utils/config.js', () => ({
  ...realConfigModule,
  getGlobalConfig: () => fakeConfig,
  saveGlobalConfig: (
    updater: (current: FakeGlobalConfig) => FakeGlobalConfig,
  ): void => {
    fakeConfig = updater(fakeConfig)
  },
}))
mock.module('../../../utils/secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))
mock.module('../../../utils/settings/settings.js', () => ({
  ...realSettingsModule,
  getSettingsForSource: (source: string) =>
    source === 'policySettings' && policyPin
      ? { forceLoginOrgUUID: policyPin }
      : null,
  getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
  hasNonOsDeniedAdminPolicyLoadFailures: () => false,
  getBlockingAdminPolicyLoadErrors: () => [],
  getSettings_DEPRECATED: () => ({}),
  getInitialSettings: () => ({}),
}))
mock.module('../../../utils/settings/allowedProvidersEnforcement.js', () => ({
  ...realAllowedProvidersModule,
  validateProviderAllowed: () => Promise.resolve(null),
}))
mock.module('../../../services/oauth/getOauthProfile.js', () => ({
  ...realOauthProfileModule,
  getOauthProfileFromOauthToken: () => Promise.resolve(profileFetchResult),
}))
mock.module('../../../commands/logout/logout.js', () => ({
  ...realLogoutModule,
  // Fake-effect spy: mirror performLogout's observable state changes (wipe
  // secure storage + clear the cached account record) so assertions on
  // prior-credential survival and oauthAccount poisoning are meaningful.
  performLogout: async (opts: Record<string, unknown>) => {
    performLogoutCalls.push(opts)
    fakeStorageRig?.storage.delete()
    fakeConfig = { ...fakeConfig, oauthAccount: undefined }
  },
  clearAuthRelatedCaches: async () => {},
}))
mock.module('../../../services/oauth/client.js', () => ({
  ...realOauthClientModule,
  // KEEP the real storeOAuthAccountInfo + shouldUseClaudeAIAuth — the account
  // poisoning under test flows through the real writer into fakeConfig.
  fetchAndStoreUserRoles: async (accessToken: string) => {
    fetchAndStoreUserRolesCalls.push(accessToken)
    return {}
  },
  createAndStoreApiKey: async (accessToken: string) => {
    createAndStoreApiKeyCalls.push(accessToken)
    return 'sk-fake-key'
  },
}))
mock.module('../../../services/api/firstTokenDate.js', () => ({
  ...realFirstTokenDateModule,
  fetchAndStoreClaudeCodeFirstTokenDate: async () => null,
}))

// Import the targets AFTER the mocks so they bind the fakes.
const { installOAuthTokens } = await import('../auth.js')
const {
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
  getOauthAccountInfo,
  clearOAuthTokenCache,
  _peekPendingOrgPinRefusalForTesting,
  _resetPendingOrgPinRefusalForTesting,
} = await import('../../../utils/auth.js')

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(() => {
  for (const key of CONTROLLED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  // Heal the storage seam (OCC-97), then restore the real modules + env.
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  mock.module('../../../utils/config.js', () => realConfigModule)
  mock.module(
    '../../../utils/secureStorage/index.js',
    () => realSecureStorageIndex,
  )
  mock.module('../../../utils/settings/settings.js', () => realSettingsModule)
  mock.module(
    '../../../utils/settings/allowedProvidersEnforcement.js',
    () => realAllowedProvidersModule,
  )
  mock.module(
    '../../../services/oauth/getOauthProfile.js',
    () => realOauthProfileModule,
  )
  mock.module('../../../commands/logout/logout.js', () => realLogoutModule)
  mock.module('../../../services/oauth/client.js', () => realOauthClientModule)
  mock.module(
    '../../../services/api/firstTokenDate.js',
    () => realFirstTokenDateModule,
  )
  for (const key of CONTROLLED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (savedNodeEnv === undefined) {
    delete process.env.NODE_ENV
  } else {
    process.env.NODE_ENV = savedNodeEnv
  }
  if (savedCi === undefined) {
    delete process.env.CI
  } else {
    process.env.CI = savedCi
  }
  rmSync(tempConfigDir, { recursive: true, force: true })
})

beforeEach(() => {
  policyPin = undefined
  profileFetchResult = null
  performLogoutCalls.length = 0
  fetchAndStoreUserRolesCalls.length = 0
  createAndStoreApiKeyCalls.length = 0
  fakeConfig = { oauthAccount: priorAccount() }
  fakeStorageRig = createFakeStorage({ stored: seededPriorCreds() })
  fakeStorage = fakeStorageRig.storage
  _resetPendingOrgPinRefusalForTesting()
  clearOAuthTokenCache()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The pre-login cached account record (the org-pin-permitted prior login). */
function priorAccount(): Record<string, unknown> {
  return {
    accountUuid: 'acct-prior',
    emailAddress: 'prior@example.com',
    organizationUuid: 'org-required',
    displayName: 'Prior User',
  }
}

/** A pre-existing stored login (the "prior creds" that must survive refusal). */
function seededPriorCreds(): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      subscriptionType: 'max',
    },
    mcpOAuth: { 'srv-a': { accessToken: 'mcp-token-a' } },
  }
}

/** Tokens that pass the shouldUseClaudeAIAuth + refreshToken/expiresAt gates. */
function validTokens(overrides: Record<string, unknown> = {}): never {
  return {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 86_400_000,
    scopes: ['user:inference'],
    ...overrides,
  } as never
}

/** Login tokens whose pre-fetched profile belongs to the REFUSED org. */
function refusedTokens(): never {
  return validTokens({
    profile: {
      account: {
        uuid: 'acct-refused',
        email: 'refused@example.com',
        display_name: 'Refused User',
        created_at: '2026-01-01T00:00:00Z',
      },
      organization: {
        uuid: 'org-refused',
        has_extra_usage_enabled: false,
        billing_type: null,
        subscription_created_at: null,
      },
    },
  })
}

/** Login tokens whose pre-fetched profile belongs to the PINNED org. */
function permittedTokens(): never {
  return validTokens({
    profile: {
      account: {
        uuid: 'acct-ok',
        email: 'ok@example.com',
        display_name: 'OK User',
        created_at: '2026-01-01T00:00:00Z',
      },
      organization: {
        uuid: 'org-required',
        has_extra_usage_enabled: false,
        billing_type: null,
        subscription_created_at: null,
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Rig sanity — if this fails, case (ii) can silently pass on HEAD
// ---------------------------------------------------------------------------

describe('#19 P1-2 rig sanity', () => {
  test('isAnthropicAuthEnabled is on: the cached account record is readable', () => {
    expect(getOauthAccountInfo()?.organizationUuid).toBe('org-required')
  })
})

// ---------------------------------------------------------------------------
// (i)-(iii) refused installOAuthTokens leaves no trace
// ---------------------------------------------------------------------------

describe('#19 P1-2 refused installOAuthTokens — no trace', () => {
  test('(i) globalConfig.oauthAccount equals the pre-login snapshot (refused-org uuid absent)', async () => {
    policyPin = 'org-required'
    const preLoginSnapshot = structuredClone(fakeConfig.oauthAccount)

    const result = await installOAuthTokens(refusedTokens())

    expect(result.storage.success).toBe(false)
    // HEAD bug A: storeOAuthAccountInfo already wrote the refused org's record
    // and nothing rolls it back → snapshot equality fails.
    expect(fakeConfig.oauthAccount).toEqual(preLoginSnapshot)
    expect(fakeConfig.oauthAccount?.organizationUuid).not.toBe('org-refused')
  })

  test('(ii) after a refused install, correct-org tokens WITHOUT org metadata save successfully (no fallback poisoning)', async () => {
    policyPin = 'org-required'
    await installOAuthTokens(refusedTokens())
    _resetPendingOrgPinRefusalForTesting()

    // Tokens with NO profile / tokenAccount org metadata: the sync check's
    // only org source is the cached account record. HEAD reads the poisoned
    // 'org-refused' record and wrongly refuses; the fix leaves the prior
    // 'org-required' record in place → permitted.
    const saveResult = saveOAuthTokensIfNeeded(validTokens())

    expect(saveResult.success).toBe(true)
    expect(fakeStorageRig.updateCalls.length).toBe(1)
  })

  test('(iii) prior credentials survive untouched: performLogout NOT called, storage unchanged, sessionAuth "previous"', async () => {
    policyPin = 'org-required'
    const seeded = seededPriorCreds()

    const result = await installOAuthTokens(refusedTokens())

    expect(result.storage.success).toBe(false)
    // HEAD bug B: performLogout ran BEFORE the refusal → prior creds wiped,
    // storage deleted, and the session has no credential left ("none").
    expect(performLogoutCalls.length).toBe(0)
    expect(fakeStorageRig.deleteCalls).toBe(0)
    expect(fakeStorageRig.getStored()).toEqual(seeded)
    expect(result.storage.sessionAuth).toBe('previous')
  })

  test('(iii-b) a refused install skips the post-save side effects (no roles fetch, no API-key creation)', async () => {
    policyPin = 'org-required'

    await installOAuthTokens(refusedTokens())

    // Official refusal paths exit before FGe — the roles/API-key tail never
    // runs with a refused token. HEAD runs fetchAndStoreUserRoles regardless.
    expect(fetchAndStoreUserRolesCalls.length).toBe(0)
    expect(createAndStoreApiKeyCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (iv) latch preservation — green on HEAD and after the fix (must STAY green)
// ---------------------------------------------------------------------------

describe('#19 P1-2 latch preservation', () => {
  test('(iv) the refused install records the latch; validateForceLoginOrg consumes it exactly once', async () => {
    policyPin = 'org-required'

    await installOAuthTokens(refusedTokens())

    const orgResult = await validateForceLoginOrg()
    expect(orgResult.valid).toBe(false)
    if (!orgResult.valid) {
      expect(orgResult.reason).toBe('org_pin_mismatch')
      expect(orgResult.message).toContain('org-refused')
      expect(orgResult.message).toContain('org-required')
    }
    expect(_peekPendingOrgPinRefusalForTesting()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (v)/(vi) over-blocking guards — permitted / not_checked installs are intact
// ---------------------------------------------------------------------------

describe('#19 P1-2 permitted / not_checked installs unaffected', () => {
  test('(v) a matching-org install runs the full persist flow (logout → account store → token save)', async () => {
    policyPin = 'org-required'

    const result = await installOAuthTokens(permittedTokens())

    expect(result.storage.success).toBe(true)
    expect(result.storage.sessionAuth).toBe('fresh')
    expect(performLogoutCalls.length).toBe(1)
    expect(fakeConfig.oauthAccount?.accountUuid).toBe('acct-ok')
    expect(fakeConfig.oauthAccount?.organizationUuid).toBe('org-required')
    expect(fakeStorageRig.updateCalls.length).toBe(1)
    expect(_peekPendingOrgPinRefusalForTesting()).toBeNull()
  })

  test('(vi) an install with NO org metadata and a failed profile fetch defers (not_checked) and persists', async () => {
    policyPin = 'org-required'
    profileFetchResult = null

    const result = await installOAuthTokens(validTokens())

    // No synchronous org evidence anywhere → the async network validator stays
    // authoritative; the install must NOT be blocked by the pre-check.
    expect(result.storage.success).toBe(true)
    expect(performLogoutCalls.length).toBe(1)
    expect(fakeStorageRig.updateCalls.length).toBe(1)
    expect(_peekPendingOrgPinRefusalForTesting()).toBeNull()
  })
})
