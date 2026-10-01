/**
 * Policy Limits Service
 *
 * Fetches organization-level policy restrictions from the API and uses them
 * to disable CLI features. Follows the same patterns as remote managed settings
 * (fail open, ETag caching, background polling, retry logic).
 *
 * Eligibility:
 * - Console users (API key): All eligible
 * - OAuth users (Claude.ai): Only Team and Enterprise/C4E subscribers are eligible
 * - API fails open (non-blocking) - if fetch fails, continues without restrictions
 * - API returns empty restrictions for users without policy limits
 */

import axios from 'axios'
import { createHash } from 'crypto'
import { readFileSync as fsReadFileSync } from 'fs'
import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CLAUDE_AI_INFERENCE_SCOPE,
  getOauthConfig,
  OAUTH_BETA_HEADER,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  isAnthropicAuthEnabled,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  classifyAxiosError,
  isNonRetryableClientError,
} from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  getAPIProvider,
  isEndpointOnConfiguredAnthropicBase,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { getRetryDelay } from '../api/withRetry.js'
import {
  type PolicyLimitsFetchResult,
  type PolicyLimitsResponse,
  PolicyLimitsResponseSchema,
} from './types.js'

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error
}

// Constants
const CACHE_FILENAME = 'policy-limits.json'
const FETCH_TIMEOUT_MS = 10000 // 10 seconds
const DEFAULT_MAX_RETRIES = 5
const POLLING_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

// Background polling state
let pollingIntervalId: ReturnType<typeof setInterval> | null = null
let cleanupRegistered = false

// Promise that resolves when initial policy limits loading completes
let loadingCompletePromise: Promise<void> | null = null
let loadingCompleteResolve: (() => void) | null = null

// Timeout for the loading promise to prevent deadlocks
const LOADING_PROMISE_TIMEOUT_MS = 30000 // 30 seconds

// Session-level cache for policy restrictions
let sessionCache: PolicyLimitsResponse['restrictions'] | null = null

// 2.1.286 port (Remote Control policy disconnect): listeners notified when the
// effective policy cache actually changes — background-poll diff or a
// successful cache-changing load. Official equivalent is the policy store's
// verdictChanged stream: `D0(e){return f().verdictChanged.subscribe(e)}`
// @200064192 (v286). The poll interval itself is unchanged.
type PolicyLimitsChangeListener = () => void
const changeListeners = new Set<PolicyLimitsChangeListener>()

/**
 * Test-only sync reset. clearPolicyLimitsCache() does file I/O and is too
 * expensive for preload beforeEach; this only clears the module-level
 * singleton so downstream tests in the same shard see a clean slate.
 */
export function _resetPolicyLimitsForTesting(): void {
  stopBackgroundPolling()
  sessionCache = null
  loadingCompletePromise = null
  loadingCompleteResolve = null
  changeListeners.clear()
}

/** Serialized snapshot of the effective cache, for change detection. */
function sessionCacheSnapshot(): string | null {
  return sessionCache ? jsonStringify(sessionCache) : null
}

function notifyPolicyLimitsChange(): void {
  // Snapshot the listener set so unsubscribes during notification are safe.
  for (const listener of [...changeListeners]) {
    try {
      listener()
    } catch (e) {
      logForDebugging(
        `Policy limits: change listener threw - ${isNodeError(e) ? e.message : String(e)}`,
      )
    }
  }
}

/**
 * Subscribe to actual policy-cache changes. Returns an unsubscribe function.
 * Fires only when jsonStringify(sessionCache) differs before/after a
 * background poll or a successful cache-changing load — never on no-op
 * refreshes. 2.1.286 port; official D0/verdictChanged @200064192.
 */
export function onPolicyLimitsChange(
  listener: PolicyLimitsChangeListener,
): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/**
 * Initialize the loading promise for policy limits
 * This should be called early (e.g., in init.ts) to allow other systems
 * to await policy limits loading even if loadPolicyLimits() hasn't been called yet.
 *
 * Only creates the promise if the user is eligible for policy limits.
 * Includes a timeout to prevent deadlocks if loadPolicyLimits() is never called.
 */
export function initializePolicyLimitsLoadingPromise(): void {
  if (loadingCompletePromise) {
    return
  }

  if (isPolicyLimitsEligible()) {
    loadingCompletePromise = new Promise(resolve => {
      loadingCompleteResolve = resolve

      setTimeout(() => {
        if (loadingCompleteResolve) {
          logForDebugging(
            'Policy limits: Loading promise timed out, resolving anyway',
          )
          loadingCompleteResolve()
          loadingCompleteResolve = null
        }
      }, LOADING_PROMISE_TIMEOUT_MS)
    })
  }
}

/**
 * Get the path to the policy limits cache file
 */
function getCachePath(): string {
  return join(getClaudeConfigHomeDir(), CACHE_FILENAME)
}

/**
 * Get the policy limits API endpoint
 */
function getPolicyLimitsEndpoint(): string {
  return `${getOauthConfig().BASE_API_URL}/api/claude_code/policy_limits`
}

/**
 * Recursively sort all keys in an object for consistent hashing
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeysDeep)
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      sorted[key] = sortKeysDeep(value)
    }
    return sorted
  }
  return obj
}

/**
 * Compute a checksum from restrictions content for HTTP caching
 */
function computeChecksum(
  restrictions: PolicyLimitsResponse['restrictions'],
): string {
  const sorted = sortKeysDeep(restrictions)
  const normalized = jsonStringify(sorted)
  const hash = createHash('sha256').update(normalized).digest('hex')
  return `sha256:${hash}`
}

/**
 * Check if the current user is eligible for policy limits.
 *
 * IMPORTANT: This function must NOT call getSettings() or any function that calls
 * getSettings() to avoid circular dependencies during settings loading.
 */
export function isPolicyLimitsEligible(): boolean {
  // 3p provider users should not hit the policy limits endpoint
  if (getAPIProvider() !== 'firstParty') {
    return false
  }

  // Custom base URL users should not hit the policy limits endpoint
  if (!isFirstPartyAnthropicBaseUrl()) {
    return false
  }

  // Console users (API key) are eligible if we can get the actual key
  try {
    const { key: apiKey } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return true
    }
  } catch {
    // No API key available - continue to check OAuth
  }

  // For OAuth users, check if they have Claude.ai tokens
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    return false
  }

  // Must have Claude.ai inference scope
  if (!tokens.scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE)) {
    return false
  }

  // Only Team and Enterprise OAuth users are eligible — these orgs have
  // admin-configurable policy restrictions (e.g. allow_remote_sessions)
  if (
    tokens.subscriptionType !== 'enterprise' &&
    tokens.subscriptionType !== 'team'
  ) {
    return false
  }

  return true
}

/**
 * Wait for the initial policy limits loading to complete
 * Returns immediately if user is not eligible or loading has already completed
 */
export async function waitForPolicyLimitsToLoad(): Promise<void> {
  if (loadingCompletePromise) {
    await loadingCompletePromise
  }
}

/**
 * Get auth headers for policy limits without calling getSettings()
 * Supports both API key and OAuth authentication.
 *
 * 2.1.285 (ANTHROPIC_AUTH_TOKEN org-policy fix): port of the official `cRe`
 * header builder (auth chunk-f74xvn8g @198114510 region, byte-verified). The
 * v284 builder (`ARe` @200263118) had no `envBearerFallbackFor` arm, so a
 * session authenticating with ANTHROPIC_AUTH_TOKEN against the Anthropic API
 * never loaded the organization's policy: its stored team/enterprise OAuth
 * login kept the session ELIGIBLE (official `$Ce`, unchanged between v284 and
 * v285), but `nl()` returns false when ANTHROPIC_AUTH_TOKEN is set, so `ut()`
 * was false, the OAuth branch was skipped, no API key existed, and the build
 * failed with "No API key available" (auth_failed + skipRetry). v285 inserts
 * the env-bearer fallback below. Exported for testing.
 */
export function getAuthHeaders(
  options: { envBearerFallbackFor?: string } = {},
): {
  headers: Record<string, string>
  error?: string
} {
  // Try API key first (for Console users)
  try {
    const { key: apiKey } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return {
        headers: {
          'x-api-key': apiKey,
        },
      }
    }
  } catch {
    // No API key available - continue to check OAuth
  }

  // OAuth branch, gated by the official `ut()` predicate
  // (`ut(){if(!nl())return!1;return RF(ln()?.scopes)}` @198635759,
  // `RF(e)=vbn(e)`, `vbn(t)=Array.isArray(t)&&t.includes("user:inference")`
  // @195580177). OCC's isAnthropicAuthEnabled() is the existing `nl()` port.
  // Without this gate a session that authenticates with ANTHROPIC_AUTH_TOKEN
  // (or apiKeyHelper / FD) would send its STORED OAuth identity instead of
  // the env credential the session actually uses — the official skips the
  // OAuth branch for such sessions and lands on the fallback below.
  if (isAnthropicAuthEnabled()) {
    const oauthTokens = getClaudeAIOAuthTokens()
    if (
      oauthTokens &&
      Array.isArray(oauthTokens.scopes) &&
      oauthTokens.scopes.includes(CLAUDE_AI_INFERENCE_SCOPE)
    ) {
      if (!oauthTokens.accessToken) {
        // Official: {headers:{},error:"No OAuth token available",reasonCode:"no_oauth_token"}
        return { headers: {}, error: 'No OAuth token available' }
      }
      return {
        headers: {
          Authorization: `Bearer ${oauthTokens.accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
      }
    }
  }

  // 2.1.285 env-bearer fallback (official `cRe` arm, verbatim):
  //   let r=e.envBearerFallbackFor,s=r?ev():void 0;
  //   if(s&&r&&wh()&&ng(r)&&!a.ANTHROPIC_UNIX_SOCKET)
  //     return{headers:{Authorization:`Bearer ${s}`}};
  // `ev(){return Db()?void 0:a.ANTHROPIC_AUTH_TOKEN}` and this build's `Db()`
  // is `return!1` (@195483259) — i.e. the raw env var. `wh()` =
  // isFirstPartyAnthropicBaseUrl(); `ng(r)` =
  // isEndpointOnConfiguredAnthropicBase(r). NO anthropic-beta header on this
  // arm. The official caller passes the endpoint through a statsig
  // kill-switch (`kD(jFt()?{}:{envBearerFallbackFor:O})`,
  // `jFt(){return Xt.servedTrue("tengu_copper_kite")}`); the flag is unserved
  // by default so the fallback is ACTIVE by default — OCC passes the endpoint
  // unconditionally (tengu_copper_kite is deliberately NOT added to the
  // feature allowlist). The official `sentEnvBearerDigest` telemetry
  // (`w=D!==void 0&&I.headers.Authorization===\`Bearer ${D}\`?sne(D):null`)
  // is STAGED: OCC's fetch-result shape has no telemetry plumbing.
  const fallbackEndpoint = options.envBearerFallbackFor
  const envAuthToken = fallbackEndpoint
    ? process.env.ANTHROPIC_AUTH_TOKEN
    : undefined
  if (
    envAuthToken &&
    fallbackEndpoint &&
    isFirstPartyAnthropicBaseUrl() &&
    isEndpointOnConfiguredAnthropicBase(fallbackEndpoint) &&
    !process.env.ANTHROPIC_UNIX_SOCKET
  ) {
    return {
      headers: {
        Authorization: `Bearer ${envAuthToken}`,
      },
    }
  }

  return {
    headers: {},
    error: 'No authentication available',
  }
}

/**
 * Fetch policy limits with retry logic and exponential backoff
 */
async function fetchWithRetry(
  cachedChecksum?: string,
): Promise<PolicyLimitsFetchResult> {
  let lastResult: PolicyLimitsFetchResult | null = null

  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
    lastResult = await fetchPolicyLimits(cachedChecksum)

    if (lastResult.success) {
      return lastResult
    }

    if (lastResult.skipRetry) {
      return lastResult
    }

    if (attempt > DEFAULT_MAX_RETRIES) {
      return lastResult
    }

    const delayMs = getRetryDelay(attempt)
    logForDebugging(
      `Policy limits: Retry ${attempt}/${DEFAULT_MAX_RETRIES} after ${delayMs}ms`,
    )
    await sleep(delayMs)
  }

  return lastResult!
}

/**
 * Fetch policy limits (single attempt, no retries)
 */
async function fetchPolicyLimits(
  cachedChecksum?: string,
): Promise<PolicyLimitsFetchResult> {
  try {
    await checkAndRefreshOAuthTokenIfNeeded()

    // 2.1.285: the official `pt()` computes the endpoint first (`O=be()`) and
    // passes it as the env-bearer fallback target
    // (`I=await kD(jFt()?{}:{envBearerFallbackFor:O})` @209340651 region).
    const endpoint = getPolicyLimitsEndpoint()
    const authHeaders = getAuthHeaders({ envBearerFallbackFor: endpoint })
    if (authHeaders.error) {
      return {
        success: false,
        error: 'Authentication required for policy limits',
        skipRetry: true,
      }
    }

    const headers: Record<string, string> = {
      ...authHeaders.headers,
      'User-Agent': getClaudeCodeUserAgent(),
    }

    if (cachedChecksum) {
      headers['If-None-Match'] = `"${cachedChecksum}"`
    }

    const response = await axios.get(endpoint, {
      headers,
      timeout: FETCH_TIMEOUT_MS,
      validateStatus: status =>
        status === 200 || status === 304 || status === 404,
    })

    // Handle 304 Not Modified - cached version is still valid
    if (response.status === 304) {
      logForDebugging('Policy limits: Using cached restrictions (304)')
      return {
        success: true,
        restrictions: null, // Signal that cache is valid
        etag: cachedChecksum,
      }
    }

    // Handle 404 Not Found - no policy limits exist or feature not enabled
    if (response.status === 404) {
      logForDebugging('Policy limits: No restrictions found (404)')
      return {
        success: true,
        restrictions: {},
        etag: undefined,
      }
    }

    const parsed = PolicyLimitsResponseSchema().safeParse(response.data)
    if (!parsed.success) {
      logForDebugging(
        `Policy limits: Invalid response format - ${parsed.error.message}`,
      )
      return {
        success: false,
        error: 'Invalid policy limits format',
      }
    }

    logForDebugging('Policy limits: Fetched successfully')
    return {
      success: true,
      restrictions: parsed.data.restrictions,
    }
  } catch (error) {
    // 404 is handled above via validateStatus, so it won't reach here
    const { kind, status, message } = classifyAxiosError(error)
    switch (kind) {
      case 'auth':
        return {
          success: false,
          error: 'Not authorized for policy limits',
          skipRetry: true,
        }
      case 'timeout':
        return { success: false, error: 'Policy limits request timeout' }
      case 'network':
        return { success: false, error: 'Cannot connect to server' }
      default:
        // 2.1.281 (#103) @206240887: `skipRetry:c$e(I)` — a never-succeeding
        // 4xx (anything but 408/409/429) stops the backoff loop immediately
        // instead of burning all DEFAULT_MAX_RETRIES attempts.
        return {
          success: false,
          error: message,
          skipRetry: isNonRetryableClientError(status),
        }
    }
  }
}

/**
 * Load restrictions from cache file
 */
// sync IO: called from sync context (getRestrictionsFromCache -> isPolicyAllowed)
function loadCachedRestrictions(): PolicyLimitsResponse['restrictions'] | null {
  try {
    const content = fsReadFileSync(getCachePath(), 'utf-8')
    const data = safeParseJSON(content, false)
    const parsed = PolicyLimitsResponseSchema().safeParse(data)
    if (!parsed.success) {
      return null
    }

    return parsed.data.restrictions
  } catch {
    return null
  }
}

/**
 * Save restrictions to cache file
 */
async function saveCachedRestrictions(
  restrictions: PolicyLimitsResponse['restrictions'],
): Promise<void> {
  try {
    const path = getCachePath()
    const data: PolicyLimitsResponse = { restrictions }
    await writeFile(path, jsonStringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    logForDebugging(`Policy limits: Saved to ${path}`)
  } catch (error) {
    logForDebugging(
      `Policy limits: Failed to save - ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

/**
 * Fetch and load policy limits with file caching
 * Fails open - returns null if fetch fails and no cache exists
 */
async function fetchAndLoadPolicyLimits(): Promise<
  PolicyLimitsResponse['restrictions'] | null
> {
  if (!isPolicyLimitsEligible()) {
    return null
  }

  const cachedRestrictions = loadCachedRestrictions()

  const cachedChecksum = cachedRestrictions
    ? computeChecksum(cachedRestrictions)
    : undefined

  try {
    const result = await fetchWithRetry(cachedChecksum)

    if (!result.success) {
      if (cachedRestrictions) {
        logForDebugging('Policy limits: Using stale cache after fetch failure')
        sessionCache = cachedRestrictions
        return cachedRestrictions
      }
      return null
    }

    // Handle 304 Not Modified
    if (result.restrictions === null && cachedRestrictions) {
      logForDebugging('Policy limits: Cache still valid (304 Not Modified)')
      sessionCache = cachedRestrictions
      return cachedRestrictions
    }

    const newRestrictions = result.restrictions || {}
    const hasContent = Object.keys(newRestrictions).length > 0

    if (hasContent) {
      sessionCache = newRestrictions
      await saveCachedRestrictions(newRestrictions)
      logForDebugging('Policy limits: Applied new restrictions successfully')
      return newRestrictions
    }

    // Empty restrictions (404 response) - delete cached file if it exists
    sessionCache = newRestrictions
    try {
      await unlink(getCachePath())
      logForDebugging('Policy limits: Deleted cached file (404 response)')
    } catch (e) {
      if (isNodeError(e) && e.code !== 'ENOENT') {
        logForDebugging(
          `Policy limits: Failed to delete cached file - ${e.message}`,
        )
      }
    }
    return newRestrictions
  } catch {
    if (cachedRestrictions) {
      logForDebugging('Policy limits: Using stale cache after error')
      sessionCache = cachedRestrictions
      return cachedRestrictions
    }
    return null
  }
}

/**
 * Policies that default to denied when essential-traffic-only mode is active
 * and the policy cache is unavailable. Without this, a cache miss or network
 * timeout would silently re-enable these features for HIPAA orgs.
 */
const ESSENTIAL_TRAFFIC_DENY_ON_MISS = new Set(['allow_product_feedback'])

/**
 * Check if a specific policy is allowed
 * Returns true if the policy is unknown, unavailable, or explicitly allowed (fail open).
 * Exception: policies in ESSENTIAL_TRAFFIC_DENY_ON_MISS fail closed when
 * essential-traffic-only mode is active and the cache is unavailable.
 */
export function isPolicyAllowed(policy: string): boolean {
  const restrictions = getRestrictionsFromCache()
  if (!restrictions) {
    if (
      isEssentialTrafficOnly() &&
      ESSENTIAL_TRAFFIC_DENY_ON_MISS.has(policy)
    ) {
      return false
    }
    return true // fail open
  }
  const restriction = restrictions[policy]
  if (!restriction) {
    return true // unknown policy = allowed
  }
  return restriction.allowed
}

/**
 * Get restrictions synchronously from session cache or file
 */
function getRestrictionsFromCache():
  | PolicyLimitsResponse['restrictions']
  | null {
  if (!isPolicyLimitsEligible()) {
    return null
  }

  if (sessionCache) {
    return sessionCache
  }

  const cachedRestrictions = loadCachedRestrictions()
  if (cachedRestrictions) {
    sessionCache = cachedRestrictions
    return cachedRestrictions
  }

  return null
}

/**
 * Raw cache entry for one policy, for the 2.1.286 bridge policy watcher
 * (connectedBridgePolicyRefusal). Distinguishes the three states the official
 * per-policy verdict fn (Lb @200084227) collapses into cache_miss /
 * route_missing / org_denied:
 * - undefined: cache unavailable (ineligible / not loaded / no disk cache)
 *   → official 'cache_miss' — callers must NEVER disconnect on unknown.
 * - null: cache loaded but the policy key is absent → official 'route_missing'
 *   (absent = allowed; the API only includes blocked policies).
 * - { allowed }: explicit verdict; allowed === false ⇔ official 'org_denied'.
 */
export function getPolicyRestrictionFromCache(
  policy: string,
): { allowed: boolean } | null | undefined {
  const restrictions = getRestrictionsFromCache()
  if (!restrictions) {
    return undefined
  }
  return restrictions[policy] ?? null
}

/**
 * Load policy limits during CLI initialization
 * Fails open - if fetch fails, continues without restrictions
 * Also starts background polling to pick up changes mid-session
 */
export async function loadPolicyLimits(): Promise<void> {
  if (isPolicyLimitsEligible() && !loadingCompletePromise) {
    loadingCompletePromise = new Promise(resolve => {
      loadingCompleteResolve = resolve
    })
  }

  // 2.1.286: notify watchers after a successful cache-changing load.
  const previousCache = sessionCacheSnapshot()

  try {
    await fetchAndLoadPolicyLimits()

    if (sessionCacheSnapshot() !== previousCache) {
      notifyPolicyLimitsChange()
    }

    if (isPolicyLimitsEligible()) {
      startBackgroundPolling()
    }
  } finally {
    if (loadingCompleteResolve) {
      loadingCompleteResolve()
      loadingCompleteResolve = null
    }
  }
}

/**
 * Refresh policy limits asynchronously (for auth state changes)
 * Used when login occurs
 */
export async function refreshPolicyLimits(): Promise<void> {
  await clearPolicyLimitsCache()

  if (!isPolicyLimitsEligible()) {
    return
  }

  // 2.1.286: post-clear the snapshot is null; notify only if the refresh
  // actually loaded restrictions into the cache.
  await fetchAndLoadPolicyLimits()
  if (sessionCacheSnapshot() !== null) {
    notifyPolicyLimitsChange()
  }
  logForDebugging('Policy limits: Refreshed after auth change')
}

/**
 * Clear all policy limits (session, persistent, and stop polling)
 */
export async function clearPolicyLimitsCache(): Promise<void> {
  stopBackgroundPolling()

  sessionCache = null

  loadingCompletePromise = null
  loadingCompleteResolve = null

  try {
    await unlink(getCachePath())
  } catch {
    // Ignore errors (including ENOENT when file doesn't exist)
  }
}

/**
 * Background polling callback
 */
async function pollPolicyLimits(): Promise<void> {
  if (!isPolicyLimitsEligible()) {
    return
  }

  const previousCache = sessionCacheSnapshot()

  try {
    await fetchAndLoadPolicyLimits()

    const newCache = sessionCacheSnapshot()
    if (newCache !== previousCache) {
      logForDebugging('Policy limits: Changed during background poll')
      // 2.1.286: wake connected-bridge policy watchers (official verdictChanged).
      notifyPolicyLimitsChange()
    }
  } catch {
    // Don't fail closed for background polling
  }
}

/**
 * Start background polling for policy limits
 */
export function startBackgroundPolling(): void {
  if (pollingIntervalId !== null) {
    return
  }

  if (!isPolicyLimitsEligible()) {
    return
  }

  pollingIntervalId = setInterval(() => {
    void pollPolicyLimits()
  }, POLLING_INTERVAL_MS)
  pollingIntervalId.unref()

  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => stopBackgroundPolling())
  }
}

/**
 * Stop background polling for policy limits
 */
export function stopBackgroundPolling(): void {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId)
    pollingIntervalId = null
  }
}
