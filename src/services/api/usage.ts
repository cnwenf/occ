import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { formatNumber, formatResetTime } from '../../utils/format.js'
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
  /**
   * CC 2.1.304 (#43 — official rate-limit memory store `heldUntilMs`): the
   * wall-clock ms at which the rate-limit hold is expected to end, honored
   * from the response's `Retry-After` (capped). Present only on 429/403 so
   * `/usage` can render "rate limited until <HH:MM>" instead of the vague
   * "try again in a moment". undefined → keep the vague text.
   */
  heldUntilMs?: number
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
 * CC 2.1.304 (#43): default rate-limit hold when the response carries no
 * usable `Retry-After`. Official `Ft` in
 * `untilMs = Date.now() + Math.min(retryAfterMs>0 ? retryAfterMs : Ft, Ke)`.
 * 60s mirrors the "a moment" framing without over-promising.
 */
const RATE_LIMIT_DEFAULT_HOLD_MS = 60_000

/**
 * CC 2.1.304 (#43): upper bound on the recorded hold. Official `Ke` in the
 * `Math.min(...)` above — a huge/absurd `Retry-After` never inflates the
 * displayed "rate limited until" clock beyond this. 24h is a safe ceiling for
 * a usage-endpoint hold.
 */
const RATE_LIMIT_MAX_HOLD_MS = 86_400_000

/**
 * CC 2.1.304 (#43): parse a `Retry-After` header into ms. Supports both the
 * delta-seconds form (`120`) and the HTTP-date form. Returns null when the
 * header is absent/unparseable or resolves to a non-positive delay (mirrors
 * the official `retryAfterMs>0 ? …` guard — non-positive falls back to the
 * default hold).
 */
function parseRetryAfterMs(rawRetryAfter: string | undefined): number | null {
  if (!rawRetryAfter) return null
  const trimmed = rawRetryAfter.trim()
  if (trimmed === '') return null
  const asSeconds = Number(trimmed)
  if (Number.isFinite(asSeconds)) {
    return asSeconds > 0 ? asSeconds * 1000 : null
  }
  const asDateMs = Date.parse(trimmed)
  if (Number.isNaN(asDateMs)) return null
  const deltaMs = asDateMs - Date.now()
  return deltaMs > 0 ? deltaMs : null
}

/**
 * CC 2.1.304 (#43): pull the `Retry-After` header off an axios-style error.
 * Handles both a plain lowercased-headers object and an `AxiosHeaders`
 * instance exposing `.get()`. Returns undefined when absent.
 */
function extractRetryAfterHeader(err: unknown): string | undefined {
  const headers = (
    err as {
      response?: {
        headers?:
          | Record<string, unknown>
          | { get?: (name: string) => unknown }
      }
    }
  ).response?.headers
  if (!headers) return undefined
  const getter = (headers as { get?: (name: string) => unknown }).get
  const raw =
    typeof getter === 'function'
      ? getter.call(headers, 'retry-after')
      : (headers as Record<string, unknown>)['retry-after']
  return raw === undefined || raw === null ? undefined : String(raw)
}

/**
 * CC 2.1.304 (#43): compute the rate-limit hold deadline from an errored
 * response. Official shape:
 *   `untilMs = Date.now() + Math.min(retryAfterMs>0 ? retryAfterMs : Ft, Ke)`
 * `retryAfterMs` is honored from the `Retry-After` header; `Ft` is the default
 * hold; `Ke` is the cap. Returns the absolute wall-clock ms.
 */
export function computeRateLimitHeldUntilMs(
  retryAfterHeader: string | undefined,
): number {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
  const holdMs = Math.min(
    retryAfterMs !== null ? retryAfterMs : RATE_LIMIT_DEFAULT_HOLD_MS,
    RATE_LIMIT_MAX_HOLD_MS,
  )
  return Date.now() + holdMs
}

/**
 * CC 2.1.304 (#43 — official `fo`): render the rate-limit line for `/usage`.
 *   `o===void 0 ? "rate limited — try again in a moment"
 *               : \`rate limited until ${vA(Math.ceil(o/60000)*60)}\``
 * `vA` is the clock-time formatter over epoch SECONDS; OCC's `formatResetTime`
 * takes exactly that. `Math.ceil(o/60000)*60` rounds the ms deadline UP to the
 * minute then converts to seconds. When `heldUntilMs` is undefined the vague
 * 303-era text is preserved verbatim.
 */
export function formatRateLimitedText(heldUntilMs: number | undefined): string {
  if (heldUntilMs === undefined) {
    return 'rate limited — try again in a moment'
  }
  const epochSeconds = Math.ceil(heldUntilMs / 60_000) * 60
  return `rate limited until ${formatResetTime(epochSeconds)}`
}

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
 * unavailable (rate limited until <clock> / — try again in a moment)" when
 * rate-limited (CC 2.1.304 #43: `heldUntilMs` drives the "until" form).
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
    const errorStatus = (err as { response?: { status?: number } }).response
      ?.status
    const isRateLimited = errorStatus === 429
    const rateLimitedVia = isRateLimited ? ('http_429' as const) : null
    // CC 2.1.304 (#43 — official rate-limit memory store): record WHEN the
    // hold ends on 429/403 responses, honored from Retry-After (capped), so
    // /usage can print "rate limited until <clock>" instead of the vague
    // "try again in a moment". isRateLimited/rateLimitedVia keep their
    // 429-only semantics (existing consumers gate on them).
    const heldUntilMs =
      errorStatus === 429 || errorStatus === 403
        ? computeRateLimitHeldUntilMs(extractRetryAfterHeader(err))
        : undefined
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
        heldUntilMs,
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
        heldUntilMs,
      }
    }
    const responseBody = (err as { response?: { data?: unknown } }).response?.data
    return {
      status: 'unavailable',
      isRateLimited,
      rateLimitedVia,
      heldUntilMs,
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
