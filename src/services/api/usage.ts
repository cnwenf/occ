import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { formatNumber } from '../../utils/format.js'
import { getAuthHeaders } from '../../utils/http.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

export type RateLimit = {
  utilization: number | null // a percentage from 0 to 100
  resets_at: string | null // ISO 8601 timestamp
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

/**
 * Per-model token usage returned by /api/oauth/usage for subscription users.
 * Mirrors the official 2.1.200 `model_usage` field. cache_read_input_tokens
 * is the cache-hit breakdown.
 */
export type ApiModelUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  web_search_requests?: number
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
  // 2.1.92: per-model + cache-hit breakdown for subscription users.
  model_usage?: Record<string, ApiModelUsage> | null
  rate_limits_available?: boolean | null
  seeded?: boolean | null
}

/**
 * Result of fetchUtilizationWithStatus — mirrors the official 2.1.210 `sur()`
 * return shape. `status` is one of: ok | empty_response | seeded | unavailable.
 * `seeded` means the API was rate-limited / errored and we fell back to the
 * last successful utilization; the per-model breakdown is unavailable.
 *
 * CC 2.1.208 #23/#44: `seedSource` distinguishes "persisted" (disk cache,
 * has `seedFetchedAtMs`) from "headers" (fresh-ish rate-limit data from
 * response headers). `rateLimitedVia` is non-null when the seed was triggered
 * by a 429. These drive the "Showing last-known usage as of <time>" message.
 */
export type FetchUtilizationResult = {
  status: 'ok' | 'empty_response' | 'seeded' | 'unavailable'
  utilization?: Utilization | null
  isRateLimited?: boolean
  responseBody?: string
  /** 2.1.208 #23/#44: where the seed came from — "persisted" or "headers". */
  seedSource?: 'persisted' | 'headers'
  /** 2.1.208 #44: timestamp (ms) when the persisted seed was originally fetched. */
  seedFetchedAtMs?: number
  /** 2.1.208 #44: non-null when the seed was triggered by a rate-limit (429). */
  rateLimitedVia?: 'http_429' | null
}

// Module-level cache of the last successful utilization, used as the seeded
// fallback when /api/oauth/usage is rate-limited or errors (mirrors `Etn()`).
let seededUtilization: Utilization | null = null

/**
 * Max age of the persisted usage seed. Mirrors the binary's `ngg=3600000`
 * (1 hour). Seeds older than this are not shown as "last-known" — the data
 * is too stale to be useful.
 */
const PERSISTED_SEED_MAX_AGE_MS = 3_600_000

/**
 * Min interval between writes to the persisted usage seed. Mirrors the
 * binary's `ogg=300000` (5 minutes). Prevents excessive config writes on
 * every successful fetch.
 */
const PERSISTED_SEED_MIN_WRITE_INTERVAL_MS = 300_000

/**
 * CC 2.1.208 #44: read the persisted usage seed from the global config.
 * Mirrors the binary's `tlu()`. Returns null if the seed is missing, fails
 * validation, belongs to a different account, or is older than the max age.
 */
export function readPersistedUsageSeed(): {
  utilization: Utilization
  fetchedAtMs: number
} | null {
  const cached = getGlobalConfig().cachedUsageUtilization
  if (!cached) return null
  if (!cached.utilization || typeof cached.fetchedAtMs !== 'number') return null

  // Don't show seeds from a different account (prevents cross-account staleness)
  const currentAccountUuid = getOauthAccountInfo()?.accountUuid
  if (cached.accountUuid && currentAccountUuid && cached.accountUuid !== currentAccountUuid) {
    // Clear stale cross-account seed
    saveGlobalConfig(prev => ({ ...prev, cachedUsageUtilization: undefined }))
    return null
  }

  const age = Date.now() - cached.fetchedAtMs
  if (age < 0 || age > PERSISTED_SEED_MAX_AGE_MS) return null

  return {
    utilization: cached.utilization as Utilization,
    fetchedAtMs: cached.fetchedAtMs,
  }
}

/**
 * CC 2.1.208 #44: write the persisted usage seed to the global config.
 * Mirrors the binary's `elu()`. Only writes if the new data is fresher than
 * the existing cache (debounced by PERSISTED_SEED_MIN_WRITE_INTERVAL_MS).
 */
export function writePersistedUsageSeed(
  utilization: Utilization,
  accountUuid?: string,
): void {
  const existing = getGlobalConfig().cachedUsageUtilization
  const existingAge =
    existing && existing.accountUuid === accountUuid
      ? Date.now() - existing.fetchedAtMs
      : Number.POSITIVE_INFINITY
  // Don't write more often than every 5 minutes (mirrors `ogg`)
  if (existingAge >= 0 && existingAge < PERSISTED_SEED_MIN_WRITE_INTERVAL_MS) return

  saveGlobalConfig(prev => ({
    ...prev,
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      ...(accountUuid !== undefined && { accountUuid }),
      utilization,
    },
  }))
}

export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // Skip API call if OAuth token is expired to avoid 401 errors
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 second timeout
  })

  return response.data
}

/**
 * Rich fetch with status + seeded fallback (mirrors the official `sur()`).
 * Used by the interactive /usage panel to surface "Per-model breakdown
 * unavailable (rate limited — try again in a moment)" when rate-limited.
 */
export async function fetchUtilizationWithStatus(): Promise<FetchUtilizationResult> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return { status: 'ok', utilization: {} }
  }

  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    // Fall back to persisted seed first, then in-memory seed
    const persisted = readPersistedUsageSeed()
    if (persisted) {
      return {
        status: 'seeded',
        utilization: persisted.utilization,
        isRateLimited: false,
        seedSource: 'persisted',
        seedFetchedAtMs: persisted.fetchedAtMs,
        rateLimitedVia: null,
      }
    }
    if (seededUtilization) {
      return { status: 'seeded', utilization: seededUtilization, isRateLimited: false }
    }
    return { status: 'unavailable', isRateLimited: false }
  }

  const authResult = getAuthHeaders()
  if (authResult.error) {
    const persisted = readPersistedUsageSeed()
    if (persisted) {
      return {
        status: 'seeded',
        utilization: persisted.utilization,
        isRateLimited: false,
        seedSource: 'persisted',
        seedFetchedAtMs: persisted.fetchedAtMs,
        rateLimitedVia: null,
      }
    }
    if (seededUtilization) {
      return { status: 'seeded', utilization: seededUtilization, isRateLimited: false }
    }
    return { status: 'unavailable', isRateLimited: false, responseBody: authResult.error }
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  try {
    const response = await axios.get<Utilization>(url, {
      headers,
      timeout: 5000,
    })
    if (response.data && Object.keys(response.data).length === 0) {
      // Fieldless body (in-band error envelope)
      const persisted = readPersistedUsageSeed()
      if (persisted) {
        return {
          status: 'seeded',
          utilization: persisted.utilization,
          isRateLimited: false,
          seedSource: 'persisted',
          seedFetchedAtMs: persisted.fetchedAtMs,
          rateLimitedVia: null,
        }
      }
      if (seededUtilization) {
        return { status: 'seeded', utilization: seededUtilization, isRateLimited: false }
      }
      return { status: 'empty_response' }
    }
    // Cache for seeded fallback on future rate-limited requests
    seededUtilization = response.data
    // CC 2.1.208 #44: persist to disk so the "as of" note survives restarts
    writePersistedUsageSeed(response.data, getOauthAccountInfo()?.accountUuid)
    return { status: 'ok', utilization: response.data }
  } catch (err) {
    const isRateLimited =
      (err as { response?: { status?: number } }).response?.status === 429
    const rateLimitedVia = isRateLimited ? ('http_429' as const) : null
    // CC 2.1.208 #44: prefer the persisted seed (has fetchedAtMs for "as of")
    const persisted = readPersistedUsageSeed()
    if (persisted) {
      return {
        status: 'seeded',
        utilization: persisted.utilization,
        isRateLimited,
        seedSource: 'persisted',
        seedFetchedAtMs: persisted.fetchedAtMs,
        rateLimitedVia,
      }
    }
    // Fall back to in-memory seed (no fetchedAtMs → treated as "headers" source)
    if (seededUtilization) {
      return {
        status: 'seeded',
        utilization: seededUtilization,
        isRateLimited,
        seedSource: 'headers',
        rateLimitedVia,
      }
    }
    const responseBody = (err as { response?: { data?: unknown } }).response?.data
    return {
      status: 'unavailable',
      isRateLimited,
      rateLimitedVia,
      responseBody: responseBody ? jsonStringify(responseBody) : undefined,
    }
  }
}

/**
 * Format the API-returned model_usage map into the "Usage by model:" display
 * (mirrors the local formatModelUsage, but without per-model cost since
 * subscription users don't pay per-token). cache_read = cache-hit breakdown.
 */
export function formatApiModelUsage(
  modelUsage: Record<string, ApiModelUsage> | null | undefined,
): string {
  if (!modelUsage || Object.keys(modelUsage).length === 0) {
    return ''
  }
  let result = 'Usage by model:'
  for (const [model, usage] of Object.entries(modelUsage)) {
    const parts: string[] = []
    if (usage.input_tokens) parts.push(`${formatNumber(usage.input_tokens)} input`)
    if (usage.output_tokens) parts.push(`${formatNumber(usage.output_tokens)} output`)
    if (usage.cache_read_input_tokens)
      parts.push(`${formatNumber(usage.cache_read_input_tokens)} cache read`)
    if (usage.cache_creation_input_tokens)
      parts.push(`${formatNumber(usage.cache_creation_input_tokens)} cache write`)
    if (usage.web_search_requests)
      parts.push(`${formatNumber(usage.web_search_requests)} web search`)
    result += `\n` + `${model}:`.padStart(21) + `  ${parts.join(', ')}`
  }
  return result
}
