/**
 * CC 2.1.300 (#19) — "Fixed a login refused by `forceLoginOrgUUID` leaving the
 * refused organization's token stored, or live after `/login`."
 *
 * Official v300 (@242589299 region) reorders the login credential save so the
 * org pin is validated FIRST (outcome-typed validator `O1e` @219127148:
 * `refused` / `permitted{verified}` / `not_checked`): credentials are
 * snapshotted (`Ju`), the token is obtained, and persistence (`FGe`) happens
 * ONLY on `permitted` — on `refused` the snapshot is restored (`ECo`) so a
 * token rejected by `forceLoginOrgUUID` is never left stored. v299
 * (@241266854) persisted-then-validated — the bug.
 *
 * OCC constraint: `saveOAuthTokensIfNeeded` is SYNC (its return value is
 * consumed synchronously by the CLI login handler at
 * src/cli/handlers/auth.ts:184 — out of cluster), while the session-start
 * validator `validateForceLoginOrg` is ASYNC (network profile fetch). So OCC
 * runs a SYNC outcome-typed org-pin check inside `saveOAuthTokensIfNeeded`
 * that REFUSES the write on mismatch, and records the refusal in a module-level
 * `pendingOrgPinRefusal` latch that `validateForceLoginOrg` consumes (before its
 * `!tokens` fall-through) — otherwise the pre-save `performLogout` wipe would
 * make `validateForceLoginOrg` see empty storage and return a false
 * `{valid:true}` ("Login successful"). See docs/gap-research-300/triage-T3.md
 * ## 19 for the full deviation note.
 *
 * Test seam follows saveOAuthTokensTransient281.test.ts (fake SecureStorage via
 * mock.module) + settings/provider/profile mocks (OCC-97: snapshot real exports,
 * override narrowly, restore in afterAll).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const realSecureStorageIndex = { ...(await import('../secureStorage/index.js')) }
const realSettingsModule = { ...(await import('../settings/settings.js')) }
const realAllowedProvidersModule = {
  ...(await import('../settings/allowedProvidersEnforcement.js')),
}
const realOauthProfileModule = {
  ...(await import('../../services/oauth/getOauthProfile.js')),
}

// Per-test controllable fake storage; getSecureStorage() returns this.
let fakeStorage: unknown
// Mutable org pin returned by the mocked getSettingsForSource('policySettings').
let policyPin: string | undefined

mock.module('../secureStorage/index.js', () => ({
  ...realSecureStorageIndex,
  getSecureStorage: () => fakeStorage,
}))
mock.module('../settings/settings.js', () => ({
  ...realSettingsModule,
  getSettingsForSource: (source: string) =>
    source === 'policySettings' && policyPin
      ? { forceLoginOrgUUID: policyPin }
      : null,
  getSettingsWithErrors: () => ({ settings: {}, errors: [] }),
  hasNonOsDeniedAdminPolicyLoadFailures: () => false,
  getBlockingAdminPolicyLoadErrors: () => [],
}))
mock.module('../settings/allowedProvidersEnforcement.js', () => ({
  ...realAllowedProvidersModule,
  validateProviderAllowed: () => Promise.resolve(null),
}))
mock.module('../../services/oauth/getOauthProfile.js', () => ({
  ...realOauthProfileModule,
  getOauthProfileFromOauthToken: () => Promise.resolve(null),
}))

// Import the targets AFTER the mocks so auth.ts binds the fakes.
const {
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
  _peekPendingOrgPinRefusalForTesting,
  _resetPendingOrgPinRefusalForTesting,
} = await import('../auth.js')

afterAll(() => {
  // Heal the storage seam, then restore the real modules (OCC-97).
  fakeStorage = (
    realSecureStorageIndex as { getSecureStorage: () => unknown }
  ).getSecureStorage()
  mock.module('../secureStorage/index.js', () => realSecureStorageIndex)
  mock.module('../settings/settings.js', () => realSettingsModule)
  mock.module(
    '../settings/allowedProvidersEnforcement.js',
    () => realAllowedProvidersModule,
  )
  mock.module(
    '../../services/oauth/getOauthProfile.js',
    () => realOauthProfileModule,
  )
})

beforeEach(() => {
  policyPin = undefined
  _resetPendingOrgPinRefusalForTesting?.()
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

function createFakeStorage(config: {
  strictResult?: unknown
  stored?: Record<string, unknown> | null
  name?: string
}): FakeStorage {
  const updateCalls: UpdateCall[] = []
  let stored = config.stored ?? null
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
      return config.strictResult ?? null
    },
    delete() {
      stored = null
      return true
    },
  }
  return { storage, updateCalls, getStored: () => stored }
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

/** A pre-existing stored login (the "prior creds" that must survive a refusal). */
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

// ---------------------------------------------------------------------------
// (a) refused — org pin mismatch → NO persist, prior creds intact, latch set
// ---------------------------------------------------------------------------

describe('#19 saveOAuthTokensIfNeeded — org-pin refusal', () => {
  test('mismatched forceLoginOrgUUID refuses the write and leaves prior creds intact', () => {
    const seeded = seededPriorCreds()
    const fake = createFakeStorage({ strictResult: seeded, stored: seeded })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    const result = saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-other' } } }),
    )

    // The bug fix: a refused token is NOT persisted.
    expect(result.success).toBe(false)
    expect(fake.updateCalls.length).toBe(0)
    // Prior credentials survive untouched (the official `ECo` restore intent).
    expect(fake.getStored()).toEqual(seeded)
    // The refusal is recorded for validateForceLoginOrg to surface.
    const latch = _peekPendingOrgPinRefusalForTesting?.()
    expect(latch).not.toBeNull()
    expect(latch?.valid).toBe(false)
    expect(latch?.reason).toBe('org_pin_mismatch')
  })

  test('the refusal is also detected via tokenAccount.organizationUuid', () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    const result = saveOAuthTokensIfNeeded(
      validTokens({ tokenAccount: { organizationUuid: 'org-other' } }),
    )

    expect(result.success).toBe(false)
    expect(fake.updateCalls.length).toBe(0)
    expect(_peekPendingOrgPinRefusalForTesting?.()?.reason).toBe(
      'org_pin_mismatch',
    )
  })
})

// ---------------------------------------------------------------------------
// (b) permitted / not_checked — persist normally, no latch
// ---------------------------------------------------------------------------

describe('#19 saveOAuthTokensIfNeeded — permitted / not_checked', () => {
  test('matching org pin persists the token and sets no latch', () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    const result = saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-required' } } }),
    )

    expect(result.success).toBe(true)
    expect(fake.updateCalls.length).toBe(1)
    expect(_peekPendingOrgPinRefusalForTesting?.()).toBeNull()
  })

  test('no forceLoginOrgUUID pin → not_checked → persists normally', () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage
    policyPin = undefined

    const result = saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-whatever' } } }),
    )

    expect(result.success).toBe(true)
    expect(fake.updateCalls.length).toBe(1)
    expect(_peekPendingOrgPinRefusalForTesting?.()).toBeNull()
  })

  test('a permitted save clears a stale latch from a prior refusal (reset-on-entry)', () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    // First: refused → latch set.
    saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-other' } } }),
    )
    expect(_peekPendingOrgPinRefusalForTesting?.()).not.toBeNull()

    // Then: permitted → latch reset at entry, not re-set.
    const result = saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-required' } } }),
    )
    expect(result.success).toBe(true)
    expect(_peekPendingOrgPinRefusalForTesting?.()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (c) the bridge — validateForceLoginOrg consumes the latch (regression guard)
// ---------------------------------------------------------------------------

describe('#19 validateForceLoginOrg — latch consumption', () => {
  test('a pending refusal is surfaced as {valid:false, reason:org_pin_mismatch} without a network fetch', async () => {
    const seeded = seededPriorCreds()
    const fake = createFakeStorage({ strictResult: seeded, stored: seeded })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    // The login save refused (storage wiped by performLogout upstream, then the
    // refused token NOT written → storage holds only the prior creds here).
    saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-other' } } }),
    )

    // validateForceLoginOrg must surface the refusal (not fall through to a
    // false {valid:true} on the empty/stale-storage `!tokens` path).
    const orgResult = await validateForceLoginOrg()
    expect(orgResult.valid).toBe(false)
    if (!orgResult.valid) {
      expect(orgResult.reason).toBe('org_pin_mismatch')
      expect(orgResult.message).toContain('org-other')
      expect(orgResult.message).toContain('org-required')
    }
    // Consumed exactly once.
    expect(_peekPendingOrgPinRefusalForTesting?.()).toBeNull()
  })

  test('with no pending latch, validateForceLoginOrg does not invent a refusal', async () => {
    const fake = createFakeStorage({ strictResult: null, stored: null })
    fakeStorage = fake.storage
    policyPin = 'org-required'

    // A permitted save (no latch).
    saveOAuthTokensIfNeeded(
      validTokens({ profile: { organization: { uuid: 'org-required' } } }),
    )
    expect(_peekPendingOrgPinRefusalForTesting?.()).toBeNull()

    // validateForceLoginOrg falls through to its normal (mocked-profile) path —
    // crucially it does NOT return the org_pin_mismatch latch refusal.
    const orgResult = await validateForceLoginOrg()
    if (!orgResult.valid) {
      expect(orgResult.reason).not.toBe('org_pin_mismatch')
    }
  })
})
