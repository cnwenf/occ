import { feature } from 'src/utils/featureFlags.js'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProvider, getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getApiKeyHelperError,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isApiKeyHelperAuthSource,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { parseEnvInt } from '../../utils/envValidation.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import {
  extractConnectionErrorDetails,
  isAdvisorEntryRefusedError,
  isImageUnprocessableError,
  isOutputContentFilteredError,
} from './errorUtils.js'
// CC 2.1.286 (items A/B/D): fast-rejection store, ladder gate, allowlist and
// the shared per-model-call retry ledger.
import {
  hasEverOrFallbackFastRejected,
  isFastRejectedFallback,
  isSpeedParamRejection,
  markFastRejected,
} from '../../utils/model/fastRejection.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { isModelFallbackDisabled } from '../../utils/model/modelLadder.js'
import { type ModelCallRetries, NoApiAttemptsLeftError } from './modelCallRetries.js'

const abortError = () => new APIUserAbortError()

const DEFAULT_MAX_RETRIES = 10
const FLOOR_OUTPUT_TOKENS = 3000
const MAX_529_RETRIES = 3
export const BASE_DELAY_MS = 500

// 2.1.186 (A13): CLAUDE_CODE_MAX_RETRIES is capped at 15 when the retry
// watchdog is OFF (binary `uZo = 15`). With the watchdog ON
// (CLAUDE_CODE_RETRY_WATCHDOG), the default is 300 (binary `zCm = 300`) and
// the cap is not applied — overload/429 errors retry well past the normal
// budget. Binary references (claude.strings):
//   - `function vge(){return it(process.env.CLAUDE_CODE_RETRY_WATCHDOG)}`
//   - `uZo=15` ... `zCm=300` ... `VCm=10`
//   - `if(t>uZo&&!e){...v(\`CLAUDE_CODE_MAX_RETRIES=${t} clamped to ${uZo}\`...);return uZo}`
const MAX_RETRIES_CLAMP = 15
const WATCHDOG_DEFAULT_MAX_RETRIES = 300
let maxRetriesClampWarned = false

/**
 * 2.1.186 (A13): whether the retry watchdog is enabled
 * (CLAUDE_CODE_RETRY_WATCHDOG). When enabled, overload/429 errors are retried
 * past the normal budget (up to WATCHDOG_DEFAULT_MAX_RETRIES by default), the
 * MAX_RETRIES cap-at-15 is not applied, mid-stream 529s are retried, and the
 * "background drop" / "custom 529 overload" / "retry-after too long" throws
 * are suppressed. Mirrors the binary's `vge()`.
 */
export function isRetryWatchdogEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_RETRY_WATCHDOG)
}

/**
 * 2.1.186 (A13): default max retries, honoring CLAUDE_CODE_MAX_RETRIES with a
 * cap-at-15 when the watchdog is OFF. When the watchdog is ON, the cap is not
 * applied and the default rises to 300. Mirrors the binary's `T3o()`.
 *
 * @param watchdog - whether the retry watchdog is enabled (default: current
 *   value of isRetryWatchdogEnabled()).
 */
export function getDefaultMaxRetries(
  watchdog: boolean = isRetryWatchdogEnabled(),
): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    const t = parseEnvInt(process.env.CLAUDE_CODE_MAX_RETRIES)
    if (t !== undefined && t >= 0) {
      // Only clamp when the watchdog is OFF — the watchdog opts into
      // unbounded overload/429 retry, so capping would defeat it.
      if (t > MAX_RETRIES_CLAMP && !watchdog) {
        if (!maxRetriesClampWarned) {
          maxRetriesClampWarned = true
          logForDebugging(
            `CLAUDE_CODE_MAX_RETRIES=${t} clamped to ${MAX_RETRIES_CLAMP}`,
            { level: 'warn' },
          )
        }
        return MAX_RETRIES_CLAMP
      }
      return t
    }
  }
  return watchdog ? WATCHDOG_DEFAULT_MAX_RETRIES : DEFAULT_MAX_RETRIES
}

// CC 2.1.285 (item-B2): official `bIo=0.9`. A non-streaming fallback attempt
// only counts toward the timeout-retry budget once it has run at least 90% of
// `nonStreamingTimeoutMs` — i.e. it genuinely hit the timeout rather than
// failing fast for an unrelated reason. Mirrors the binary's
//   `Date.now()-Et >= r.nonStreamingTimeoutMs*bIo`.
const NONSTREAMING_TIMEOUT_ELAPSED_RATIO = 0.9

/**
 * CC 2.1.285 (item-B2): parse CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES.
 * Official registry descriptor is `$I=M.int({min:0,digitsOnly:!0})` → a
 * non-negative integer, or undefined when unset/invalid. `undefined` means the
 * cap is disabled (the retry loop falls back to its normal maxRetries budget).
 */
function getNonstreamingTimeoutRetryCap(): number | undefined {
  const parsed = parseEnvInt(
    process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES,
  )
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

// Foreground query sources where the user IS blocking on the result — these
// retry on 529. Everything else (summaries, titles, suggestions, classifiers)
// bails immediately: during a capacity cascade each retry is 3-10× gateway
// amplification, and the user never sees those fail anyway. New sources
// default to no-retry — add here only if the user is waiting on the result.
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // Security classifiers — must complete for auto-mode correctness.
  // yoloClassifier.ts uses 'auto_mode' (not 'yolo_classifier' — that's
  // type-only). bash_classifier is ant-only; feature-gate so the string
  // tree-shakes out of external builds (excluded-strings.txt).
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

function shouldRetry529(querySource: QuerySource | undefined): boolean {
  // undefined → retry (conservative for untagged call paths)
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// CLAUDE_CODE_UNATTENDED_RETRY: for unattended sessions (ant-only). Retries 429/529
// indefinitely with higher backoff and periodic keep-alive yields so the host
// environment does not mark the session idle mid-wait.
// TODO(ANT-344): the keep-alive via SystemAPIErrorMessage yields is a stopgap
// until there's a dedicated keep-alive channel.
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 30_000

// 2.1.281 (#022): binary constants block @202407030 —
// `Ipo=1,Opo=60000,Dpo=300000,TRe=21600000,Nlr=30000` (Dpo/TRe/Nlr are the
// PERSISTENT_MAX_BACKOFF_MS/PERSISTENT_RESET_CAP_MS/HEARTBEAT_INTERVAL_MS
// above). Opo: a NON-watchdog retry delay above this THROWS
// (tengu_api_retry_after_too_long) instead of sleeping silently past a
// minute — `else if(Kn>Opo)throw ...` @202416849. Byte-verified Opo=60000
// (v280 `ufr=60000` @199569644 is unchanged); the finalized §P4 triage note
// claiming 600000 contradicts the ELF — the bytes win.
const RETRY_AFTER_TOO_LONG_THRESHOLD_MS = 60_000
// Binary long-wait telemetry literal @202417418-region:
// `if(yn&&Kn>60000)i("tengu_api_persistent_retry_wait",...)`.
const PERSISTENT_RETRY_WAIT_LOG_THRESHOLD_MS = 60_000

function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

export interface RetryContext {
  maxTokensOverride?: number
  model: string
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
}

interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string[]
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * Pre-seed the consecutive 529 counter. Used when this retry loop is a
   * non-streaming fallback after a streaming 529 — the streaming 529 should
   * count toward MAX_529_RETRIES so total 529s-before-fallback is consistent
   * regardless of which request mode hit the overload.
   */
  initialConsecutive529Errors?: number
  /**
   * 2.1.157 (J9): when an API 400 indicates an image content block is
   * unprocessable (corrupt/zero-byte), the retry loop calls this to strip the
   * offending block from the request messages and retry immediately, rather
   * than failing the whole turn. Returns the location of the stripped block
   * (for telemetry), or null when no image block remains (stop stripping).
   */
  stripMediaBlock?: () => {
    kind: string
    messageIdx: number
    contentIdx: number
  } | null
  /**
   * 2.1.276 advisor hotfix, extended by 2.1.280 (#032): when the API/gateway
   * rejects the advisor tool entry — a 400, or a 422 carrying the
   * `Input tag 'advisor_\d+'` rejection (official v280 `ake` classifier;
   * e.g. a proxy that does not recognize the `advisor_20260301` tool tag) —
   * the retry loop calls this to strip the advisor schema/header/message-
   * blocks from the request and retry once, immediately. Returns true when
   * the request was stripped and must be retried; the handler is one-shot per
   * request (official `QHe`, v276 `Wvt`). Mirrors the official v280 `Ece`,
   * wired FIRST in both fatal chains:
   * `return Ece(hs)??Tce(hs,"stream")??mK(hs)??gK(hs)??Tae(hs)`.
   */
  retryAdvisorEntryRefused?: (error: APIError) => boolean
  /**
   * CC 2.1.285 (item-B2): per-attempt timeout (ms) of a NON-STREAMING fallback
   * request, set by executeNonStreamingRequest (official `I0t` passes
   * `nonStreamingTimeoutMs:S`, S = IOo()). When present — together with the
   * CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES env cap — the retry loop stops
   * re-sending a fallback that keeps timing out after that many attempts,
   * instead of looping to maxRetries × the full timeout (minutes of silent
   * retries). Undefined on the streaming path, so the cap never fires there.
   */
  nonStreamingTimeoutMs?: number
  /**
   * CC 2.1.286 (item-A): this model was reached via a refusal fallback (the
   * binary's `r.modelIsRefusalFallbackTarget`). Together with the
   * fast-rejection store (`SYn`) it gates the new speed-param-rejection retry
   * branch: a fallback target that rejects the `speed` parameter is recorded
   * and retried at standard speed instead of failing the turn.
   *
   * STAGED in OCC production: no caller sets this flag yet — the official
   * setter is the refusal/queued retry dispatch in the query engine (outside
   * this round's retry-module scope; gap doc §4 backlog item 3). The branch
   * it gates is therefore dormant until wired; the fast-rejection STORE is
   * still live in production via the withRetry loop-head coercion.
   */
  modelIsRefusalFallbackTarget?: boolean
  /**
   * CC 2.1.286 (item-B): the previous model of the same tier computed by the
   * ladder (`src/utils/model/modelLadder.ts` ≡ binary `oPr`/`GBn`). Used as
   * the fallback when the API REFUSES the resolved model (404/403) on
   * firstParty and no `--fallback-model` was given (binary
   * `Pn=r.fallbackModel??(Kn&&Fl(r.model)==="firstParty"?iOe(r):void 0)`).
   *
   * STAGED in OCC production: nothing sets this option yet. The official
   * producer is the query-engine dispatch (`let A=GBn(Ze,st,ce)` @212168274
   * threaded as `accessFallbackModel:A` @212172692) — outside this round's
   * retry-module scope (see the modelLadder.ts header STAGED block and
   * docs/upstream-version-gap-occ104-2026-10.md §4 backlog item 3). Until
   * wired, the option stays `undefined` and the ladder arm of the
   * refusal-fallback branch is dormant.
   */
  accessFallbackModel?: string
  /**
   * CC 2.1.286 (item-D): shared per-model-call retry ledger (binary `FFt`,
   * `src/services/api/modelCallRetries.ts`). One limit covers a whole model
   * call — with default retry settings a failing call sends at most 14
   * requests (11 withRetry + 1 chain hop + 2 credential renewals).
   *
   * STAGED in OCC production: `createModelCallRetries` has no production
   * caller yet — the official producer is the QueryModel construction site
   * (@206191201, recovered in the modelCallRetries.ts header STAGED block;
   * gap doc §4 backlog item 3). The four `options.modelCallRetries?.x()`
   * hooks below are therefore no-ops until the query engine wires the ledger.
   */
  modelCallRetries?: ModelCallRetries
}

export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // Preserve the original stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
    /**
     * 2.1.152/2.1.166 (A16): why fallback was triggered. Mirrors the binary's
     * trigger enum: "model_not_found" (model retired/unknown, 404),
     * "permission_denied" (org lacks model access, 403), "overloaded" (529),
     * "server_error" (5xx non-529, only when the watchdog is OFF).
     */
    public readonly trigger:
      | 'model_not_found'
      | 'permission_denied'
      | 'overloaded'
      | 'server_error' = 'overloaded',
    /**
     * CC 2.1.286 (item-B): the binary's `Tx` constructor gained a 4th arg —
     * the original error (`new Tx(r.model,Pn,Qo,qt)`) — so the caller can
     * inspect the refusal that triggered the hop.
     */
    public readonly originalError?: unknown,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0
  // 2.1.208 (#15): count 401s caused by a failed apiKeyHelper so the real
  // error surfaces within 3 attempts instead of silently retrying up to
  // DEFAULT_MAX_RETRIES (10) and showing a generic 401. Mirrors the binary's
  //   `if(b instanceof ui && b.status===401 && Pu() && K8t() && d1r()!==null)
  //      { if(f>=$jy) throw he("api_request","api_request_api_key_helper_failed"),
  //        new s2(b,o); f++ }` ($jy = 2 → throws on the 3rd occurrence).
  let apiKeyHelperAuthRetries = 0
  const API_KEY_HELPER_AUTH_RETRY_CAP = 2
  // CC 2.1.267 (#9): AWS/GCP credential errors previously suppressed the
  // throw path entirely (handleAwsCredentialError/handleGcpCredentialError
  // clear caches and return true), so a permanently broken credential
  // looped to DEFAULT_MAX_RETRIES (10). Official caps cloud-auth retries at
  // 2 (binary ZDn/eNn) and then throws CannotRetryError with an
  // api_request_aws_auth_exhausted / api_request_gcp_auth_exhausted
  // telemetry event.
  let awsAuthRetries = 0
  let gcpAuthRetries = 0
  const CLOUD_AUTH_RETRY_CAP = 2
  // 2.1.157 (J9): bound on media-block strips per request to guard against a
  // misbehaving stripMediaBlock callback that never returns null.
  let mediaStrips = 0
  const MAX_MEDIA_STRIPS = 20
  // CC 2.1.285 (item-B2): official `K` (timeout-retry counter) and the env cap
  // `vn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES`. The cap is read once per
  // request (it is a stable env value); undefined disables the cap.
  let nonstreamingTimeoutRetries = 0
  const nonstreamingTimeoutRetryCap = getNonstreamingTimeoutRetryCap()
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    // CC 2.1.285 (item-B2): official `Et=g.now()` — per-attempt start time, used
    // by the non-streaming-timeout budget check to confirm the attempt actually
    // ran ~the full timeout (a genuine timeout, not a fast unrelated failure).
    const attemptStartTime = Date.now()
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }
    // CC 2.1.286 (item-D): binary loop head
    //   `if(r.modelCallRetries?.takeApiAttempt()===!1)throw new Fd(new pZ,h)`
    // — the whole-call attempt gate. When the shared ledger is dry (e.g. the
    // idle-compact path's `{count:1}` budget), no request is sent at all.
    if (options.modelCallRetries?.takeApiAttempt() === false) {
      throw new CannotRetryError(new NoApiAttemptsLeftError(), retryContext)
    }

    // CC 2.1.286 (item-A): binary loop-head coercion
    //   `if(Ke=!1,h.fastMode&&rBt(h.model))h.fastMode=!1`
    // — a model family already forced to standard speed this session runs at
    // standard speed from the FIRST attempt (no re-failing 400).
    if (retryContext.fastMode && isFastRejectedFallback(retryContext.model)) {
      retryContext.fastMode = false
    }

    // Capture whether fast mode is active before this attempt
    // (fallback may change the state mid-loop)
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Check for mock rate limits (used by /mock-limits command for Ant employees)
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // Get a fresh client instance on first attempt or after authentication errors
      // - 401 for first-party API authentication failures
      // - 403 "OAuth token has been revoked" (another process refreshed the token)
      // - Bedrock-specific auth errors (403 or CredentialsProviderError)
      // - Vertex-specific auth errors (credential refresh failures, 401)
      // - ECONNRESET/EPIPE: stale keep-alive socket; disable pooling and reconnect
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive()
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // On 401 "token expired" or 403 "token revoked", force a token refresh
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient()
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      // CC 2.1.285 (item-B3): the official retry loop added a fatal branch for
      // the API's output content filter near the top of the catch (before the
      // lastError assignment), g0 predicate @203962444:
      //   `if(g0(Ft))throw m("api_request","api_request_output_content_filtered"),
      //      new ic(Ft,h)`
      // A response blocked by the output content filter is a permanent rejection
      // — re-sending the same content just gets filtered again — so surface it
      // immediately instead of retrying for minutes. Placed first (before
      // lastError/log) to mirror the official fatal-branch precedence.
      if (isOutputContentFilteredError(error)) {
        logEvent('api_request', {
          reason: 'api_request_output_content_filtered',
        })
        throw new CannotRetryError(error, retryContext)
      }

      // CC 2.1.286 (item-D): binary catch top
      //   `if(r.modelCallRetries?.outOfApiAttempts())throw m("api_request",
      //     "api_request_attempts_exhausted"),new Fd(qt,h)`
      // — once the whole-call ledger is dry, any further failure is fatal
      // (no retry paths below may consume more requests).
      if (options.modelCallRetries?.outOfApiAttempts()) {
        logEvent('api_request', {
          reason: 'api_request_attempts_exhausted',
        })
        throw new CannotRetryError(error, retryContext)
      }

      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast mode fallback: on 429/529, either wait and retry (short delays)
      // or fall back to standard speed (long delays) to avoid cache thrashing.
      // Skip in persistent mode: the short-retry path below loops with fast
      // mode still active, so its `continue` never reaches the attempt clamp
      // and the for-loop terminates. Persistent sessions want the chunked
      // keep-alive path instead of fast-mode cache-preservation anyway.
      //
      // CC 2.1.272 (fast mode fixes): port of the official retry-watchdog
      // interaction. 2.1.270 gated the whole fast block on `!VM()`
      // (CLAUDE_CODE_RETRY_WATCHDOG off), so under the watchdog a
      // usage-credits/overage 429 fell through to shouldRetry →
      // CannotRetryError (turn failed instead of falling back to standard
      // speed) and overload retried forever at fast speed. 2.1.272 drops
      // that gate, captures `let Yn=sM()` (watchdog enabled) before the
      // block, and then:
      //   - the silent short-retry sleep runs only when NOT under the
      //     watchdog (`if(Jn&&!Yn){await Q(ar,...);continue}`); under the
      //     watchdog a short retry-after falls through to the normal visible
      //     retry path instead of looping at fast speed in the background;
      //   - cooldown (fallback to standard speed) is entered only for
      //     non-short retries (`if(!Jn){...}`);
      //   - every fast-path `continue` gives the attempt back (2.1.281
      //     `if(Sn)gt--`; 2.1.272 had clamped `if(Yn&&pt>=s)pt=s`) so a
      //     fallback at/near budget exhaustion still gets its standard-speed
      //     retry instead of ending the loop — the for-loop's `attempt++`
      //     cancels the decrement, freezing the counter for that fallback.
      // OCC keeps its pre-existing `!isPersistentRetryEnabled()` gate (dead
      // in production — the UNATTENDED_RETRY flag is not enabled — but it
      // preserves the documented persistent-mode behavior above).
      const watchdogRetryEnabled = isRetryWatchdogEnabled()
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // If the 429 is specifically because extra usage (overage) is not
        // available, permanently disable fast mode with a specific message.
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          // Official 2.1.281 `if(Sn)gt--` — give the attempt back so the
          // standard-speed retry still runs at budget exhaustion.
          if (watchdogRetryEnabled) attempt--
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        const isShortRetry =
          retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS
        // Official `if(Jn&&!Yn)`: the silent wait-and-retry at fast speed is
        // for non-watchdog sessions only. Under the watchdog, fall through
        // to the normal (visible) retry path below — fast mode stays active,
        // but the user sees the retry message instead of a hidden fast-speed
        // loop.
        if (isShortRetry && !watchdogRetryEnabled) {
          // 2.1.281 (#023): official
          // `if(gt<=s){let Do=Math.min(uU(gt,xRe(It),vRe),vRe),kr=wRe(It,g.model);
          //   if(kr)...yield r$(kr,Do,gt,s,"request_retry");await qPt(Do,r)}continue`
          // v280 slept the RAW header ms — `Retry-After: 0` meant an instant
          // back-to-back re-request. The delay is now FLOORED through the
          // exponential backoff (uU), CAPPED at the 20s short-retry threshold,
          // budget-gated (`gt<=s` — no sleep once the budget is spent), and
          // VISIBLE via a yielded retry message.
          if (attempt <= maxRetries) {
            const shortRetryDelayMs = Math.min(
              getRetryDelay(
                attempt,
                getRetryAfter(error),
                SHORT_RETRY_THRESHOLD_MS,
              ),
              SHORT_RETRY_THRESHOLD_MS,
            )
            yield createSystemAPIErrorMessage(
              error,
              shortRetryDelayMs,
              attempt,
              maxRetries,
            )
            // Short retry-after: wait and retry with fast mode still active
            // to preserve prompt cache (same model name on retry).
            await sleep(shortRetryDelayMs, options.signal, { abortError })
          }
          continue
        }
        // Official `if(!Jn){...}`: cooldown (switch to standard speed) only
        // for long/unknown retry-after. A short retry-after under the
        // watchdog must NOT trigger cooldown — it falls through instead.
        if (!isShortRetry) {
          const cooldownMs = Math.max(
            retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
            MIN_COOLDOWN_MS,
          )
          const cooldownReason: CooldownReason = is529Error(error)
            ? 'overloaded'
            : 'rate_limit'
          triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
          if (isFastModeEnabled()) {
            retryContext.fastMode = false
          }
          // Official 2.1.281 `if(Sn)gt--`.
          if (watchdogRetryEnabled) attempt--
          continue
        }
      }

      // CC 2.1.286 (item-A): binary branch1 — placed BEFORE branch2 (the
      // 400 fast-not-enabled path below), matching the official order:
      //   `if(en&&lOe(qt,h.model)&&(r.modelIsRefusalFallbackTarget||SYn(h.model)))
      //      {if(aBo(h.model),h.fastMode=!1,Ln)$t--;continue}`
      // The API rejected the `speed` parameter for a refusal/fallback target
      // model (400 `'…' does not support the \`speed\` parameter`): record the
      // family in the fast-rejection store, drop to standard speed and retry
      // — the turn no longer fails when the fallback model can't run fast.
      // `Ln` ≡ watchdogRetryEnabled attempt give-back (2.1.281 `if(Sn)gt--`).
      if (
        wasFastModeActive &&
        isSpeedParamRejection(error, retryContext.model) &&
        (options.modelIsRefusalFallbackTarget ||
          hasEverOrFallbackFastRejected(retryContext.model))
      ) {
        markFastRejected(retryContext.model)
        retryContext.fastMode = false
        if (watchdogRetryEnabled) attempt--
        continue
      }

      // Fast mode fallback: if the API rejects the fast mode parameter
      // (e.g., org doesn't have fast mode enabled), permanently disable fast
      // mode and retry at standard speed.
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        // Official 2.1.281 `if(Sn)gt--` in the 400-not-enabled path.
        if (watchdogRetryEnabled) attempt--
        continue
      }

      // Non-foreground sources bail immediately on 529 — no retry amplification
      // during capacity cascades. User never sees these fail.
      // 2.1.186 (A13): suppressed when the retry watchdog is ON (binary
      // `!vge()` guard) — the watchdog keeps retrying overload instead of
      // dropping background requests.
      if (
        is529Error(error) &&
        !shouldRetry529(options.querySource) &&
        !isRetryWatchdogEnabled()
      ) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // Track consecutive 529 errors
      if (
        is529Error(error) &&
        // If FALLBACK_FOR_ALL_PRIMARY_MODELS is not set, fall through only if the primary model is a non-custom Opus model.
        // TODO: Revisit if the isNonCustomOpusModel check should still exist, or if isNonCustomOpusModel is a stale artifact of when Claude Code was hardcoded on Opus.
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          // Check if fallback model is specified
          if (options.fallbackModel && options.fallbackModel.length > 0) {
            const primaryFallback = options.fallbackModel[0]
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                primaryFallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })

            // Throw special error to indicate fallback was triggered
            throw new FallbackTriggeredError(
              options.model,
              primaryFallback,
            )
          }

          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled() &&
            !isRetryWatchdogEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // CC 2.1.286 (item-B): binary trigger rewrite (byte-verified v286):
      //   let Kn=NJe(qt)||LJe(qt),
      //       Pn=r.fallbackModel??(Kn&&Fl(r.model)==="firstParty"?iOe(r):void 0);
      //   if((Kn||!g3()&&dOe(qt))&&Pn&&Pn!==r.model){
      //     let Qo=NJe(qt)?"model_not_found":LJe(qt)?"permission_denied":"server_error";
      //     throw i("tengu_api_model_not_found_fallback_triggered",
      //       {original_model:St(r.model),fallback_model:St(Pn),provider:CT(),reason:c(Qo)}),
      //       new Tx(r.model,Pn,Qo,qt)}
      // v285→v286 deltas: (a) when the API REFUSES the resolved model
      // (404 model_not_found / 403 permission_denied) on firstParty, the
      // ladder's accessFallbackModel — the previous model of the same tier
      // (gated by tengu_nifty_finch, computed in src/utils/model/modelLadder.ts)
      // — is used even without --fallback-model. NOTE: this arm is DORMANT in
      // OCC production — no caller populates `options.accessFallbackModel`
      // (the query-engine producer @212172692 is STAGED; see the
      // accessFallbackModel JSDoc + gap doc §4 item 3), so resolveAccess-
      // FallbackModel always returns undefined and only --fallback-model hops.
      // (b) the telemetry event now
      // logs UNCONDITIONALLY with a `reason` field (v285 logged only for
      // model_not_found, without reason); (c) the thrown error carries the
      // original error. Mappings: NJe/LJe ≡ isModelNotFoundError/
      // isModelPermissionDeniedError; g3 ≡ isRetryWatchdogEnabled; dOe ≡
      // is5xxServerError; Fl(model) ≡ getAPIProvider() (OCC has no per-model
      // provider resolution — the global provider is the established mapping);
      // iOe ≡ resolveAccessFallbackModel below.
      const isRefusalTrigger =
        isModelNotFoundError(error) || isModelPermissionDeniedError(error)
      const effectiveFallback =
        options.fallbackModel?.[0] ??
        (isRefusalTrigger && getAPIProvider() === 'firstParty'
          ? resolveAccessFallbackModel(options)
          : undefined)
      if (
        (isRefusalTrigger ||
          (is5xxServerError(error) && !isRetryWatchdogEnabled())) &&
        effectiveFallback !== undefined &&
        effectiveFallback !== options.model
      ) {
        const trigger = isModelNotFoundError(error)
          ? 'model_not_found'
          : isModelPermissionDeniedError(error)
            ? 'permission_denied'
            : 'server_error'
        logEvent('tengu_api_model_not_found_fallback_triggered', {
          original_model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_model:
            effectiveFallback as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          provider: getAPIProviderForStatsig(),
          reason:
            trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new FallbackTriggeredError(
          options.model,
          effectiveFallback,
          trigger,
          error,
        )
      }

      // 2.1.157 (J9): unprocessable images — the API rejects the whole request
      // when any image content block is corrupt/zero-byte. Strip the offending
      // block and retry immediately instead of failing the turn. Bounded by the
      // number of image blocks (stripMediaBlock returns null when none remain)
      // and the MAX_MEDIA_STRIPS guard.
      if (
        error instanceof APIError &&
        isImageUnprocessableError(error) &&
        options.stripMediaBlock &&
        mediaStrips < MAX_MEDIA_STRIPS
      ) {
        const stripped = options.stripMediaBlock()
        if (stripped) {
          mediaStrips++
          logForDebugging(
            `Removed unprocessable ${stripped.kind} at messages.${stripped.messageIdx}.content.${stripped.contentIdx}; retrying.`,
          )
          logEvent('tengu_media_block_strip_retry', {
            kind:
              stripped.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            message_idx: stripped.messageIdx,
            content_idx: stripped.contentIdx,
          })
          // Don't count the strip against the retry budget.
          attempt--
          continue
        }
      }

      // 2.1.276 advisor hotfix + 2.1.280 #032: advisor-entry-refused error
      // (official v280 `ake` classifier — 400 shapes plus the 422 Input-tag
      // shape) — strip the advisor tool from the request and retry once
      // (official v280 `Ece`). The official wires Ece FIRST in its fatal
      // chains (`Ece(hs)??Tce(hs,"stream")??…`), i.e. exactly when the error
      // is about to become non-retryable — both 400 and 422 fail
      // `shouldRetry` below, so this hook sits immediately before that gate
      // and the v280 422 arm flows through it without further changes. Like
      // the media strip above, the retry does not count against the retry
      // budget; the handler's one-shot latch (official `QHe`, v276 `Wvt`)
      // bounds it to a single extra attempt.
      if (
        error instanceof APIError &&
        isAdvisorEntryRefusedError(error) &&
        options.retryAdvisorEntryRefused?.(error)
      ) {
        attempt--
        continue
      }

      // Only retry if the error indicates we should
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      // 2.1.186 (A17): with the retry watchdog ON, overload (529) / 429 errors
      // retry past the normal budget instead of throwing on exhaustion — the
      // watchdog keeps headless/unattended sessions alive through capacity
      // cascades. Mirrors the binary's
      //   `let T=vge()&&WTc(b); if(h>r&&!T) throw Ie("api_request","api_request_retry_exhausted")`
      // (T = watchdog-enabled && (overloaded || 429); without T, exhaustion throws).
      const watchdogRetryable =
        isRetryWatchdogEnabled() && isWatchdogRetryable(error)
      if (attempt > maxRetries && !persistent && !watchdogRetryable) {
        // CC 2.1.286 (item-D): binary exhausted block (byte-verified v286):
        //   if($t>s&&!dn){let Qo=!(qt instanceof It&&qt.status===401)||Fe!==
        //     void 0||Lke()||bse(qt)||!y7()&&Wc();
        //     if(!SFt(qt,h.model)||!Qo||r.modelCallRetries?.
        //       takeCredentialRenewal()!==!0)throw m("api_request",
        //       "api_request_retry_exhausted"),new Fd(qt,h);$t--}
        // A credential-renewal error (401/403 auth family, `SFt` ≡
        // isCredentialRenewalError below) gets up to VMo (2) attempt rewinds
        // per model call — shared via the ledger — before the retry is
        // exhausted. Qo mirrors: !(401) || Fe (claude.ai OAuth access token
        // present) || Lke (firstParty) || bse (revoked-token 401/403) ||
        // !y7()&&Wc(). Documented simplifications: bse's auth-mode internals
        // (Bn/mv/lre) have no clean OCC surface → mapped to
        // isOAuthTokenRevokedError; the profile-implicit term !y7()&&Wc() ≡
        // false (no OCC surface); Lke ≡ firstParty provider.
        const credentialRenewalEligible =
          !(error instanceof APIError && error.status === 401) ||
          getClaudeAIOAuthTokens()?.accessToken !== undefined ||
          getAPIProvider() === 'firstParty' ||
          isOAuthTokenRevokedError(error)
        if (
          !isCredentialRenewalError(error) ||
          !credentialRenewalEligible ||
          options.modelCallRetries?.takeCredentialRenewal() !== true
        ) {
          logEvent('api_request', {
            reason: 'api_request_retry_exhausted',
          })
          throw new CannotRetryError(error, retryContext)
        }
        attempt--
      }

      // 2.1.208 (#15): a 401 caused by a failed apiKeyHelper must surface the
      // real error within 3 attempts instead of silently retrying up to
      // DEFAULT_MAX_RETRIES (10) and showing a generic 401. Mirrors the
      // binary's
      //   `if(b instanceof ui && b.status===401 && Pu() && K8t() && d1r()!==null)
      //      { if(f>=$jy) throw he("api_request","api_request_api_key_helper_failed"),
      //        new s2(b,o); f++ }`
      // ($jy = 2 → throws on the 3rd 401; Pu = Cn()==="firstParty" via
      //  getAPIProvider; K8t = isApiKeyHelperAuthSource; d1r = getApiKeyHelperError;
      //  s2 = CannotRetryError).
      if (
        error instanceof APIError &&
        error.status === 401 &&
        getAPIProvider() === 'firstParty' &&
        isApiKeyHelperAuthSource() &&
        getApiKeyHelperError() !== null
      ) {
        if (apiKeyHelperAuthRetries >= API_KEY_HELPER_AUTH_RETRY_CAP) {
          logEvent('api_request', {
            reason: 'api_request_api_key_helper_failed',
          })
          throw new CannotRetryError(error, retryContext)
        }
        apiKeyHelperAuthRetries++
      }

      // CC 2.1.267 (#9): cap cloud credential error retries at 2 (official
      // ZDn/eNn). Mirrors the binary's
      //   `let kt=eJ(Je);
      //    if(kt==="AWS"||!iW()&&udt(Je,d.model)){if(O>=ZDn)throw f("api_request",
      //      "api_request_aws_auth_exhausted"),new Ob(Je,d);O++,Ln=ZDn-O}
      //    if(kt==="Google Cloud"||!iW()&&JQ(Je)){if(L>=eNn)throw f("api_request",
      //      "api_request_gcp_auth_exhausted"),new Ob(Je,d);L++,Ln=eNn-L}`
      // (eJ = classifyCloudCredentialError below; iW = first-party provider;
      //  udt/JQ = the Bedrock/Vertex auth-error predicates; Ob =
      //  CannotRetryError. Official also clamps the backoff exponent via
      //  Ln = cap - retries; OCC's delay computation is unchanged — the cap
      //  itself is the observable behavior.)
      const cloudCredentialKind = classifyCloudCredentialError(error)
      if (
        cloudCredentialKind === 'AWS' ||
        (getAPIProvider() !== 'firstParty' && isBedrockAuthError(error))
      ) {
        if (awsAuthRetries >= CLOUD_AUTH_RETRY_CAP) {
          logEvent('api_request', {
            reason: 'api_request_aws_auth_exhausted',
          })
          throw new CannotRetryError(error, retryContext)
        }
        awsAuthRetries++
      }
      if (
        cloudCredentialKind === 'Google Cloud' ||
        (getAPIProvider() !== 'firstParty' && isVertexAuthError(error))
      ) {
        if (gcpAuthRetries >= CLOUD_AUTH_RETRY_CAP) {
          logEvent('api_request', {
            reason: 'api_request_gcp_auth_exhausted',
          })
          throw new CannotRetryError(error, retryContext)
        }
        gcpAuthRetries++
      }

      // CC 2.1.285 (item-B2): CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES cap.
      // Mirrors the official v285 retry-loop catch (evidence
      // /tmp/cc-diff-285/evidence/nonstreaming_retries.txt):
      //   `let Xn,vn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES;
      //    if(vn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&Ft instanceof gI&&
      //       Date.now()-Et>=r.nonStreamingTimeoutMs*bIo&&!XW()){
      //      if(K>=vn)throw m("api_request","api_request_nonstreaming_timeout_exhausted"),
      //        new ic(Ft,h);
      //      K++,Xn=vn-K}`
      // gI ≡ APIConnectionTimeoutError (SDK "Request timed out."), Et ≡
      // attemptStartTime, bIo ≡ NONSTREAMING_TIMEOUT_ELAPSED_RATIO (0.9),
      // XW() ≡ isRetryWatchdogEnabled(), ic ≡ CannotRetryError. Without the cap
      // a fallback that keeps timing out re-sends up to maxRetries times, each
      // burning the full nonStreamingTimeoutMs — minutes of silent retries
      // (changelog: "retried up to 21 times when streaming kept failing").
      // The official's `Xn=vn-K` remaining-budget value feeds its `a0t` retry-
      // status display; OCC has no `a0t` display-budget surface, so only the
      // cap (the observable behavior) is ported.
      if (
        nonstreamingTimeoutRetryCap !== undefined &&
        options.nonStreamingTimeoutMs !== undefined &&
        error instanceof APIConnectionTimeoutError &&
        Date.now() - attemptStartTime >=
          options.nonStreamingTimeoutMs * NONSTREAMING_TIMEOUT_ELAPSED_RATIO &&
        !isRetryWatchdogEnabled()
      ) {
        if (nonstreamingTimeoutRetries >= nonstreamingTimeoutRetryCap) {
          logEvent('api_request', {
            reason: 'api_request_nonstreaming_timeout_exhausted',
          })
          throw new CannotRetryError(error, retryContext)
        }
        nonstreamingTimeoutRetries++
      }

      // AWS/GCP errors aren't always APIError, but can be retried
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // Handle max tokens context overflow errors by adjusting max_tokens for the next attempt
      // NOTE: With extended-context-window beta, this 400 error should not occur.
      // The API now returns 'model_context_window_exceeded' stop_reason instead.
      // Keeping for backward compatibility.
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error
          }
          // Ensure we have enough tokens for thinking + at least 1 output token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          // 2.1.218 (#22): when the thinking budget alone exceeds the available
          // context, the adjusted max_tokens would still overflow on retry —
          // the loop would re-send an identical doomed request forever. Fail
          // fast instead of looping. Mirrors the binary's guard that compares
          // the thinking budget against the remaining context window.
          if (minRequired > availableContext) {
            logError(
              new Error(
                `thinking budget (${minRequired - 1}) exceeds available context (${availableContext}); cannot retry context-overflow`,
              ),
            )
            throw error
          }
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue
        }
      }

      // For other errors, proceed with normal retry logic
      // Get retry-after header if available
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      // Official `yn` — heartbeat long-wait mode. In the binary it is
      // initialized to Kt (persistent); OCC's `persistent` covers that role,
      // so this flag tracks the OTHER way yn gets set: a watchdog-capped wait.
      let watchdogLongWait = false
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // Window-based limits (e.g. 5hr Max/Pro) include a reset timestamp.
        // Wait until reset rather than polling every 5 min uselessly.
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After is a server directive and bypasses maxDelayMs inside
        // getRetryDelay (intentional — honoring it is correct). Cap at the
        // 6hr reset-cap here so a pathological header can't wait unbounded.
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        // 2.1.281 (#022): official
        // `else if(Kn=uU(gt+M,zn),S6())Kn=Math.min(Kn,TRe),yn=!0;
        //  else if(Kn>Opo)throw i("tengu_api_retry_after_too_long",{...}),
        //    m("api_request","api_request_retry_after_too_long"),new Fc(It,g)`.
        // (a) gt+M: accumulated persistent waits feed the exponent, so a 5xx
        //     after long 429/529 waits does not restart backoff at attempt 1.
        delayMs = getRetryDelay(attempt + persistentAttempt, retryAfter)
        if (watchdogRetryEnabled) {
          // (b) S6(): cap at TRe=6h and enter heartbeat long-wait mode (yn).
          delayMs = Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
          watchdogLongWait = true
        } else if (delayMs > RETRY_AFTER_TOO_LONG_THRESHOLD_MS) {
          // (c) Kn>Opo: fail loudly instead of sleeping uncapped past a minute.
          logEvent('tengu_api_retry_after_too_long', {
            delayMs,
            status: (error as APIError).status,
            provider: getAPIProviderForStatsig(),
          })
          logEvent('api_request', {
            reason:
              'api_request_retry_after_too_long' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new CannotRetryError(error, retryContext)
        }
      }

      // In persistent mode the for-loop `attempt` is clamped at maxRetries+1;
      // use persistentAttempt for telemetry/yields so they show the true count.
      const reportedAttempt = persistent ? persistentAttempt : attempt
      // CC 2.1.286 (item-D): binary `r.modelCallRetries?.reportHttpFailure(qt,"retry")`
      // immediately before the tengu_api_retry telemetry — feeds the shared
      // ledger (classifiable errors run through the decision engine; others
      // take the plain retries+1 increment) so its counts stay authoritative
      // across withRetry invocations within one model call.
      options.modelCallRetries?.reportHttpFailure(error, 'retry')
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      // Official `yn` — long waits (persistent or watchdog-capped) log
      // persistent_retry_wait above a minute and sleep in 30s heartbeat
      // chunks (2.1.281 #022 extends the v280 persistent-only condition
      // `Qt&&on>60000` to `yn&&Kn>60000`).
      const heartbeatWait = persistent || watchdogLongWait
      if (heartbeatWait && delayMs > PERSISTENT_RETRY_WAIT_LOG_THRESHOLD_MS) {
        logEvent('tengu_api_persistent_retry_wait', {
          status: (error as APIError).status,
          delayMs,
          attempt: reportedAttempt,
          provider: getAPIProviderForStatsig(),
        })
      }

      if (heartbeatWait) {
        // Chunk long sleeps so the host sees periodic stdout activity and
        // does not mark the session idle. Each yield surfaces as
        // {type:'system', subtype:'api_retry'} on stdout via QueryEngine.
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 2.1.281 (#022): official tail `if(Kt)gt--` replaces the v280 clamp
        // `if(_t>=s)_t=s` — persistent waits no longer consume retry budget.
        // The clamp left attempt pinned at maxRetries+1, so the first
        // non-transient error (5xx) after long 429/529 waits tripped the
        // retry-exhausted gate. The for-loop's attempt++ cancels this
        // decrement, freezing the counter across persistent waits; backoff
        // still uses the separate persistentAttempt counter which keeps
        // growing to the 5-min cap (and feeds gt+M for later non-persistent
        // backoff, see the delay computation above).
        if (persistent) attempt--
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

// 2.1.281 (#023): aligned byte-for-byte with the official uU (@200159276,
// identical in v280 as k1 @197288416):
//   `function uU(o,t,s=32000){let n=Math.min(500*Math.pow(2,o-1),s),
//     e=Math.round(n+Math.random()*0.25*n);
//     if(t){let i=parseInt(t,10);if(!isNaN(i))return Math.max(i*1000,e)}
//     return e}`
// The retry-after header no longer bypasses the backoff — it FLOORS it
// (Math.max), so `Retry-After: 0` waits the exponential-backoff amount
// instead of re-requesting instantly, and the result is rounded to an
// integer like the binary.
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const backoffMs = Math.round(baseDelay + Math.random() * 0.25 * baseDelay)

  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return Math.max(seconds * 1000, backoffMs)
    }
  }

  return backoffMs
}

export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // Example format: "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: Replace with a response header check once the API adds a dedicated
// header for fast-mode rejection (e.g., x-fast-mode-rejected). String-matching
// the error message is fragile and will break if the API wording changes.
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  // Check for 529 status code or overloaded error in message
  return (
    error.status === 529 ||
    // See below: the SDK sometimes fails to properly pass the 529 status code during streaming
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

/**
 * 2.1.152 (A16): a 404 `not_found_error` whose message references a model —
 * i.e. the API rejected the requested model id (retired/unknown). Mirrors the
 * binary's `FTc`. Triggers model fallback immediately (no 529-counting).
 */
export function isModelNotFoundError(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 404) return false
  const message = error.message ?? ''
  // `type` is on the JSON body, not the SDK's APIError typings.
  const errorType = (error as { type?: string }).type
  return (
    (errorType === 'not_found_error' ||
      message.includes('"type":"not_found_error"')) &&
    message.includes('model:')
  )
}

/**
 * 2.1.166 (A16): a 403 `permission_error` whose message references a model —
 * i.e. the org is not permitted to use the requested model. Mirrors the
 * binary's `UTc`. Triggers model fallback immediately.
 */
export function isModelPermissionDeniedError(error: unknown): boolean {
  if (!(error instanceof APIError) || error.status !== 403) return false
  const message = error.message ?? ''
  // `type` is on the JSON body, not the SDK's APIError typings.
  const errorType = (error as { type?: string }).type
  return (
    (errorType === 'permission_error' ||
      message.includes('"type":"permission_error"')) &&
    message.includes('model:')
  )
}

/**
 * A 5xx server error that is NOT a 529 overload (e.g. 500/502/503/504).
 * Mirrors the binary's `v3o`. Used as a fallback trigger (when the watchdog
 * is OFF) and distinguished from overload, which has its own retry path.
 */
function is5xxServerError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status !== undefined &&
    error.status >= 500 &&
    error.status < 600 &&
    error.status !== 529
  )
}

/**
 * 2.1.186 (A13/A17): whether an error is "watchdog retryable" — an overload
 * (529) or a 429 rate limit. When the retry watchdog is ON, these errors
 * retry past the normal budget instead of throwing on exhaustion. Mirrors
 * the binary's `WTc(b) = Hge(b) || (b instanceof Wo && b.status===429)`.
 */
export function isWatchdogRetryable(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

/**
 * The fallback trigger reason for an error. Mirrors the binary's
 * `R = FTc(b) ? "model_not_found" : UTc(b) ? "permission_denied" : "server_error"`.
 */
export function getFallbackTriggerReason(
  error: unknown,
): 'model_not_found' | 'permission_denied' | 'server_error' | null {
  if (isModelNotFoundError(error)) return 'model_not_found'
  if (isModelPermissionDeniedError(error)) return 'permission_denied'
  if (is5xxServerError(error)) return 'server_error'
  return null
}

/**
 * CC 2.1.286 (item-B): binary `iOe({accessFallbackModel:e,toolFreeHelper:n})`:
 *   return e!==void 0&&!d9e()&&Hr(e)&&(n===!0||OTe(e))?e:void 0
 * The ladder candidate is honored when fallbacks are not env-disabled and the
 * model passes the allowlist. Documented simplifications: `OTe(e)` (the
 * auto-model-mode check) ≡ true — OCC has no auto-model mode — so the
 * toolFreeHelper arm collapses; `d9e` ≡ isModelFallbackDisabled; `Hr` ≡
 * isModelAllowed.
 */
function resolveAccessFallbackModel(
  options: RetryOptions,
): string | undefined {
  const candidate = options.accessFallbackModel
  return candidate !== undefined &&
    !isModelFallbackDisabled() &&
    isModelAllowed(candidate)
    ? candidate
    : undefined
}

/**
 * CC 2.1.286 (item-D): binary `SFt(e,n)` (byte-verified):
 *   e instanceof It&&e.status===401||bse(e)||aOe(e)!==void 0&&Boolean(IIe())||
 *   X7(e)||cOe(e,n)||_F(e)
 * Credential-renewal classifier for the exhausted-block rewind. Documented
 * simplifications: the proxy-auth term (`aOe`/`IIe`) is skipped (no OCC
 * proxy-auth surface); `bse`'s auth-mode internals (Bn/mv/lre) have no clean
 * OCC surface → mapped to isOAuthTokenRevokedError; `X7` ≡
 * isOAuthTokenRevokedError; `cOe(e,n)` = the AWS arms (below); `_F(e)` = the
 * Vertex/Google arms → isVertexAuthError || classifyCloudCredentialError
 * 'Google Cloud' (OCC's established env-gated GCP classifier).
 */
function isCredentialRenewalError(error: unknown): boolean {
  // Binary SFt arm 1: plain 401.
  if (error instanceof APIError && error.status === 401) {
    return true
  }
  // Binary bse/X7 arms: revoked OAuth token (403 message match).
  if (isOAuthTokenRevokedError(error)) {
    return true
  }
  // Binary cOe(e,n) arm: under any AWS-family env (bedrock / anthropic_aws /
  // mantle), a CredentialsProviderError (B9e) or a 403 renews credentials;
  // plus uOe: a 401 while the model resolves to anthropicAws/mantle.
  const provider = getAPIProvider()
  if (
    provider === 'bedrock' ||
    provider === 'anthropic_aws' ||
    provider === 'mantle'
  ) {
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403) ||
      (error instanceof APIError &&
        error.status === 401 &&
        (provider === 'anthropic_aws' || provider === 'mantle'))
    ) {
      return true
    }
  }
  // Binary _F(e) arm: Vertex/Google credential errors.
  return (
    isVertexAuthError(error) ||
    classifyCloudCredentialError(error) === 'Google Cloud'
  )
}

function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

/**
 * CC 2.1.267 (#9): official `lq` — walk the error's .cause chain (starting
 * at the error itself, up to depth 5) and return the first Error matching
 * the predicate.
 */
function findInErrorCauseChain(
  error: unknown,
  predicate: (e: Error) => boolean,
  maxDepth = 5,
): Error | undefined {
  let current: unknown = error
  for (let depth = 0; depth < maxDepth; depth++) {
    if (!(current instanceof Error)) return undefined
    if (predicate(current)) return current
    current = current.cause
  }
  return undefined
}

/**
 * CC 2.1.267 (#9): official `JOn` — true when any error in the cause chain
 * carries a message containing one of the needles.
 */
function errorChainMessageIncludes(
  error: unknown,
  needles: string[],
): boolean {
  return (
    findInErrorCauseChain(error, e =>
      needles.some(needle => e.message.includes(needle)),
    ) !== undefined
  )
}

/**
 * CC 2.1.267 (#9): official `ZOn()` — Google Cloud credential machinery is
 * in play when either Vertex or the Anthropic-on-Google-Cloud env flag is
 * set. Byte-faithful to the binary's bare `!!(a.X||a.Y)` truthiness (the
 * pre-existing isVertexAuthError gate uses isEnvTruthy — documented
 * divergence, unchanged here).
 */
function isGoogleCloudEnv(): boolean {
  return !!(
    process.env.CLAUDE_CODE_USE_VERTEX ||
    process.env.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD
  )
}

/** Official `QOn`: classifier message list for Google Cloud credential errors. */
const GOOGLE_CREDENTIAL_CLASSIFIER_MESSAGES = [
  'Could not load the default credentials',
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]

/** Official `$8t` (first entry of `z$o`). */
const GOOGLE_OAUTH_FAILURE_MESSAGE =
  'Failed to acquire Google OAuth credentials.'

/** Official second entry of `z$o`. */
const GOOGLE_TOKEN_REFRESH_FAILURE_MESSAGE = 'Could not refresh access token'

/**
 * CC 2.1.267 (#9): official `eJ` — classify a non-HTTP error as a cloud
 * credential failure. An APIError with a status is an HTTP response, not a
 * credential error (null). A CredentialsProviderError anywhere in the cause
 * chain (depth ≤5) is AWS (official `zxt`); in a Google Cloud env, the
 * official QOn message list anywhere in the chain is Google Cloud.
 */
function classifyCloudCredentialError(
  error: unknown,
): 'AWS' | 'Google Cloud' | null {
  if (error instanceof APIError && error.status !== undefined) return null
  if (
    findInErrorCauseChain(
      error,
      e => e.name === 'CredentialsProviderError',
    ) !== undefined
  ) {
    return 'AWS'
  }
  if (
    isGoogleCloudEnv() &&
    errorChainMessageIncludes(error, GOOGLE_CREDENTIAL_CLASSIFIER_MESSAGES)
  ) {
    return 'Google Cloud'
  }
  return null
}

function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    // AWS libs reject without an API call if .aws holds a past Expiration value
    // otherwise, API calls that receive expired tokens give generic 403
    // "The security token included in the request is invalid"
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * Clear AWS auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library throws plain Error (no typed name like AWS's
// CredentialsProviderError). CC 2.1.267 (#9): official `JQ` matches the
// combined QOn+z$o message list via the cause-chain walker (`JOn`) — the
// message may live on a wrapped cause, not just the top-level error — and
// adds invalid_client, unauthorized_client, and the Google OAuth
// acquisition failure to the previous three messages.
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  return errorChainMessageIncludes(error, [
    ...GOOGLE_CREDENTIAL_CLASSIFIER_MESSAGES,
    GOOGLE_OAUTH_FAILURE_MESSAGE,
    GOOGLE_TOKEN_REFRESH_FAILURE_MESSAGE,
  ])
}

function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // SDK-level: google-auth-library fails in prepareOptions() before the HTTP call
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    // Server-side: Vertex returns 401 for expired/invalid tokens
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * Clear GCP auth caches if appropriate.
 * @returns true if action was taken.
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

function shouldRetry(error: APIError): boolean {
  // Never retry mock errors - they're from /mock-limits command for testing
  if (isMockRateLimitError(error)) {
    return false
  }

  // Persistent mode: 429/529 always retryable, bypass subscriber gates and
  // x-should-retry header.
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR mode: auth is via infrastructure-provided JWTs, so a 401/403 is a
  // transient blip (auth service flap, network hiccup) rather than bad
  // credentials. Bypass x-should-retry:false — the server assumes we'd retry
  // the same bad key, but our key is fine.
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // 2.1.198 (A12): Claude Platform on AWS failover — for anthropicAws (and
  // mantle), a 403 or an AWS CredentialsProviderError is a transient auth
  // blip (credential refresh flap), not bad credentials. Retry instead of
  // failing the turn. Mirrors the binary's
  //   `if(it(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)||it(process.env.CLAUDE_CODE_USE_MANTLE))
  //      {if(Uhi(e)||e instanceof Wo&&e.status===403)return!0}` (Uhi = CredentialsProviderError).
  if (
    (isEnvTruthy(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)) &&
    (isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403))
  ) {
    return true
  }

  // Check for overloaded errors first by examining the message content
  // The SDK sometimes fails to properly pass the 529 status code during streaming,
  // so we need to check the error message directly
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // Check for max tokens context overflow errors that we can handle
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // Note this is not a standard header.
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // If the server explicitly says whether or not to retry, obey.
  // For Max and Pro users, should-retry is true, but in several hours, so we shouldn't.
  // Enterprise users can retry because they typically use PAYG instead of rate limits.
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // Ants can ignore x-should-retry: false for 5xx server errors only.
  // For other status codes (401, 403, 400, 429, etc.), respect the header.
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    // 2.1.199 (J2): SSL/TLS certificate errors are never retryable — the
    // certificate won't fix itself, and retrying burns the retry budget
    // while surfacing the same opaque error. Fail immediately; the
    // user-facing fix hint ("SSL certificate error (CODE). If you are
    // behind a corporate proxy or TLS-intercepting firewall, set
    // NODE_EXTRA_CA_CERTS …") is produced by formatAPIError /
    // getSSLErrorHint from errorUtils.ts.
    if (extractConnectionErrorDetails(error)?.isSSLError) {
      return false
    }
    return true
  }

  if (!error.status) return false

  // Retry on request timeouts.
  if (error.status === 408) return true

  // Retry on lock timeouts.
  if (error.status === 409) return true

  // Retry on rate limits, but not for ClaudeAI Subscription users
  // Enterprise users can retry because they typically use PAYG instead of rate limits
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // Clear API key cache on 401 and allow retry.
  // OAuth token handling is done in the main retry loop via handleOAuth401Error.
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // Retry on 403 "token revoked" (same refresh logic as 401, see above)
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // Retry internal errors.
  if (error.status && error.status >= 500) return true

  return false
}

function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 30 minutes
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000 // 20 seconds
const MIN_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes

function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS)
}
