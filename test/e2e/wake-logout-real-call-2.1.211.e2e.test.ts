import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { REPO_ROOT } from './helpers'

/**
 * E2E test for CC 2.1.211 wake-logout scoping — drives the REAL call()
 * from src/commands/logout/logout.tsx, NOT an inline rewrite.
 *
 * Mocks only leaf I/O side-effects (gracefulShutdownSync, removeApiKey,
 * secureStorage.delete, saveGlobalConfig) to assert non-invocation.
 * The REAL call() logic — isBgSession() guard, warning message, shutdown
 * skip — is exercised end-to-end.
 *
 * Binary recon: see wake-logout-scoped-2.1.211.e2e.test.ts for decompiled
 * fQe() / Di() evidence.
 */

// ── Leaf I/O mock state ──────────────────────────────────────────────
const mockState = {
  gracefulShutdownCalled: false,
  removeApiKeyCalled: false,
  secureStorageDeleted: false,
  saveGlobalConfigCalled: false,
}

function resetMockState(): void {
  mockState.gracefulShutdownCalled = false
  mockState.removeApiKeyCalled = false
  mockState.secureStorageDeleted = false
  mockState.saveGlobalConfigCalled = false
}

// ── Mock leaf modules BEFORE importing call() ────────────────────────
// These must match the resolved paths that logout.tsx imports.
const R = REPO_ROOT

mock.module(`${R}/src/utils/gracefulShutdown.ts`, () => ({
  gracefulShutdownSync: () => {
    mockState.gracefulShutdownCalled = true
  },
}))

// Helper: create a comprehensive mock module from a list of export names.
// Functions become no-ops (or return null/false), consts become null.
function stubModule(exports: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const name of exports) {
    if (name in overrides) {
      obj[name] = overrides[name]
    } else {
      obj[name] = () => null
    }
  }
  return obj
}

// All exported names from auth.ts (extracted from source)
const authExports = [
  'calculateApiKeyHelperTTL', 'checkAndRefreshOAuthTokenIfNeeded',
  'checkGcpCredentialsValid', 'clearApiKeyHelperCache',
  'clearAwsCredentialsCache', 'clearAwsHelperCredentialsCache',
  'clearGcpCredentialsCache', 'clearOAuthTokenCache',
  'getAccountInformation', 'getAnthropicApiKey',
  'getAnthropicApiKeyWithSource', 'getApiKeyFromApiKeyHelper',
  'getApiKeyFromApiKeyHelperCached', 'getApiKeyFromConfigOrMacOSKeychain',
  'getApiKeyHelperElapsedMs', 'getApiKeyHelperError',
  'getAuthTokenSource', 'getClaudeAIOAuthTokens',
  'getClaudeAIOAuthTokensAsync', 'getConfiguredApiKeyHelper',
  'getDefaultAwsCredentialProvider', 'getOauthAccountInfo',
  'getOtelHeadersFromHelper', 'getRateLimitTier',
  'getSubscriptionName', 'getSubscriptionType',
  'handleOAuth401Error', 'hasAnthropicApiKeyAuth',
  'hasOpusAccess', 'hasProfileScope',
  'invalidateAwsCredentialProvider', 'is1PApiCustomer',
  'isAnthropicAuthEnabled', 'isApiKeyHelperAuthSource',
  'isAwsAuthRefreshFromProjectSettings', 'isAwsCredentialExportFromProjectSettings',
  'isClaudeAISubscriber', 'isConsumerSubscriber',
  'isCustomApiKeyApproved', 'isEnterpriseSubscriber',
  'isGcpAuthRefreshFromProjectSettings', 'isMaxSubscriber',
  'isOtelHeadersHelperFromProjectOrLocalSettings', 'isOverageProvisioningAllowed',
  'isProSubscriber', 'isTeamPremiumSubscriber',
  'isTeamSubscriber', 'isUsing3PServices',
  'prefetchApiKeyFromApiKeyHelperIfSafe', 'prefetchAwsCredentialsAndBedRockInfoIfSafe',
  'prefetchGcpCredentialsIfSafe', 'refreshAndGetAwsCredentials',
  'refreshAwsAuth', 'refreshGcpAuth',
  'refreshGcpCredentialsIfNeeded', 'removeApiKey',
  'saveApiKey', 'saveOAuthTokensIfNeeded',
  'validateForceLoginOrg',
  // memoized functions with .cache property
  'getApiKeyFromConfigOrMacOSKeychain',
]

mock.module(`${R}/src/utils/auth.ts`, () =>
  stubModule(authExports, {
    removeApiKey: async () => {
      mockState.removeApiKeyCalled = true
    },
    clearOAuthTokenCache: () => {},
    isClaudeAISubscriber: () => false,
    isAnthropicAuthEnabled: () => false,
    handleOAuth401Error: async () => false,
    checkAndRefreshOAuthTokenIfNeeded: async () => false,
    getAuthTokenSource: () => ({ source: 'none', hasToken: false }),
    getAnthropicApiKeyWithSource: () => ({ key: null, source: 'none' }),
    getAnthropicApiKey: () => null,
    getSubscriptionType: () => null,
    getApiKeyFromConfigOrMacOSKeychain: (() => {
      const fn = () => null
      fn.cache = { clear: () => {} }
      return fn
    })(),
    getClaudeAIOAuthTokens: (() => {
      const fn = () => null
      fn.cache = { clear: () => {} }
      return fn
    })(),
  }),
)

mock.module(`${R}/src/utils/secureStorage/index.ts`, () => ({
  getSecureStorage: () => ({
    name: 'mock',
    read: () => null,
    readAsync: async () => null,
    update: () => ({ success: true }),
    delete: () => {
      mockState.secureStorageDeleted = true
    },
  }),
}))

mock.module(`${R}/src/utils/config.ts`, () => ({
  getGlobalConfig: () => ({}),
  saveGlobalConfig: (fn: (c: Record<string, unknown>) => Record<string, unknown>) => {
    mockState.saveGlobalConfigCalled = true
    fn({})
    return Promise.resolve()
  },
}))

mock.module(`${R}/src/bridge/trustedDevice.ts`, () => ({
  clearTrustedDeviceTokenCache: () => {},
}))

mock.module(`${R}/src/services/analytics/growthbook.ts`, () => ({
  refreshGrowthBookAfterAuthChange: () => {},
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(_key: string, def: T): T => def,
  getFeatureValue_CACHED_WITH_REFRESH: <T>(_key: string, def: T): T => def,
  getFeatureValue_DEPRECATED: async <T>(_key: string, def: T): Promise<T> => def,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  checkSecurityRestrictionGate: async () => false,
  checkGate_CACHED_OR_BLOCKING: async () => false,
  getDynamicConfig_BLOCKS_ON_INIT: async <T>(_k: string, def: T): Promise<T> => def,
  getDynamicConfig_CACHED_MAY_BE_STALE: <T>(_k: string, def: T): T => def,
  onGrowthBookRefresh: () => {},
  hasGrowthBookEnvOverride: () => false,
  getAllGrowthBookFeatures: () => ({}),
  getGrowthBookConfigOverrides: () => ({}),
  setGrowthBookConfigOverride: () => {},
  clearGrowthBookConfigOverrides: () => {},
  getApiBaseUrlHost: () => undefined,
  initializeGrowthBook: () => {},
  resetGrowthBook: () => {},
  refreshGrowthBookFeatures: async () => {},
  setupPeriodicGrowthBookRefresh: () => {},
  stopPeriodicGrowthBookRefresh: () => {},
}))

mock.module(`${R}/src/services/api/grove.ts`, () => ({
  getGroveNoticeConfig: { cache: { clear: () => {} } },
  getGroveSettings: { cache: { clear: () => {} } },
}))

mock.module(`${R}/src/services/policyLimits/index.ts`, () => ({
  clearPolicyLimitsCache: async () => {},
}))

mock.module(`${R}/src/services/remoteManagedSettings/index.ts`, () => ({
  clearRemoteManagedSettingsCache: async () => {},
}))

mock.module(`${R}/src/utils/betas.ts`, () => ({
  clearBetasCaches: () => {},
  getModelBetas: (() => {
    const fn = () => []
    fn.cache = { clear: () => {} }
    return fn
  })(),
  getAllModelBetas: (() => {
    const fn = () => []
    fn.cache = { clear: () => {} }
    return fn
  })(),
  getBedrockExtraBodyParamsBetas: (() => {
    const fn = () => []
    fn.cache = { clear: () => {} }
    return fn
  })(),
  filterAllowedSdkBetas: () => [],
  modelSupportsISP: () => false,
  modelSupportsContextManagement: () => false,
  modelSupportsStructuredOutputs: () => false,
  modelSupportsAutoMode: () => false,
  getToolSearchBetaHeader: () => '',
  shouldIncludeFirstPartyOnlyBetas: () => false,
  shouldUseGlobalCacheScope: () => false,
  getMergedBetas: () => [],
}))

// Mock telemetry/instrumentation to prevent flushTelemetry from pulling
// in the entire OpenTelemetry + betas chain via lazy import
mock.module(`${R}/src/utils/telemetry/instrumentation.ts`, () => ({
  flushTelemetry: async () => {},
}))

mock.module(`${R}/src/utils/toolSchemaCache.ts`, () => ({
  clearToolSchemaCache: () => {},
}))

mock.module(`${R}/src/utils/user.ts`, () => ({
  resetUserCache: () => {},
}))

// Mock ink.ts to avoid pulling in the full React/ink render tree
mock.module(`${R}/src/ink.ts`, () => {
  const { createElement } = require('react')
  return {
    Text: ({ children }: { children: unknown }) =>
      createElement('text', null, children),
  }
})

describe('CC 2.1.211 real call() — background session guard (Stage 3, path 1)', () => {
  const origSessionKind = process.env.CLAUDE_CODE_SESSION_KIND

  beforeEach(() => {
    resetMockState()
  })

  afterEach(() => {
    if (origSessionKind === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_KIND
    } else {
      process.env.CLAUDE_CODE_SESSION_KIND = origSessionKind
    }
  })

  test('background session: call() warns "shares credentials", no shutdown, no credential wipe', async () => {
    // Set background session via real env var
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'

    // Import the REAL call() — module mocks above intercept leaf I/O
    const mod = await import(`${R}/src/commands/logout/logout.tsx`)
    const result = await mod.call()

    // (a) Warning message contains "shares credentials"
    // call() returns a React element: { type: 'text', props: { children: "..." } }
    const text =
      typeof result === 'object' && result !== null && 'props' in result
        ? String((result as { props: { children: unknown } }).props.children)
        : String(result)
    expect(text).toContain('shares credentials')

    // (b) gracefulShutdownSync is NOT called
    expect(mockState.gracefulShutdownCalled).toBe(false)

    // (c) performLogout (the shared-credential wipe) is NOT called —
    // verified by its leaf side-effects not firing
    expect(mockState.removeApiKeyCalled).toBe(false)
    expect(mockState.secureStorageDeleted).toBe(false)
    expect(mockState.saveGlobalConfigCalled).toBe(false)
  })

  test('interactive session: call() proceeds with logout (shuts down, wipes credentials)', async () => {
    // Interactive session — no env var
    delete process.env.CLAUDE_CODE_SESSION_KIND

    const mod = await import(`${R}/src/commands/logout/logout.tsx`)
    const result = await mod.call()

    // Returns success message
    const text =
      typeof result === 'object' && result !== null && 'props' in result
        ? String((result as { props: { children: unknown } }).props.children)
        : String(result)
    expect(text).toContain('Successfully logged out')

    // performLogout IS called — credential wipe side-effects fire
    expect(mockState.removeApiKeyCalled).toBe(true)
    expect(mockState.secureStorageDeleted).toBe(true)
    expect(mockState.saveGlobalConfigCalled).toBe(true)

    // gracefulShutdownSync IS called (via setTimeout, but mock fires synchronously)
    // Note: setTimeout fires async, so we wait a tick
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(mockState.gracefulShutdownCalled).toBe(true)
  })
})
