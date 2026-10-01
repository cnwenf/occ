/**
 * CC 2.1.286 (item-D): shared per-model-call retry ledger.
 *
 * Official changelog: "Changed how failed API requests are retried: one limit
 * now covers a whole model call, so with the default retry settings a failing
 * call sends at most 14 requests."
 *
 * The ledger (`FFt` in the v286 binary, byte-verified dump
 * /tmp/cc-diff-286/w286_ledger.txt) owns ONE retry budget for a whole model
 * call — across withRetry invocations (streaming attempt → non-streaming
 * fallback → fallback-model hop) and across credential renewals:
 *   14 = 11 withRetry requests (1 initial + 10 retries)
 *      + 1 chain hop that starts with `retriesLeft()` = 0
 *      + 2 credential renewals (`VMo = 2`, each rewinds one attempt).
 *
 * withRetry integration points (v286 loop @206105122-206131122):
 *   - loop head: `if(r.modelCallRetries?.takeApiAttempt()===!1)
 *       throw new Fd(new pZ,h)`
 *   - catch top: `if(r.modelCallRetries?.outOfApiAttempts())
 *       throw m("api_request","api_request_attempts_exhausted"),new Fd(qt,h)`
 *   - exhausted block: `…||r.modelCallRetries?.takeCredentialRenewal()!==!0)
 *       throw …;$t--`
 *   - pre-telemetry: `r.modelCallRetries?.reportHttpFailure(qt,"retry")`
 *
 * STAGED (recovered, not wired — call sites live in the query engine /
 * stream path / compaction, outside the retry modules):
 *   - QueryModel construction @206191201:
 *     `l_=FFt({maxRetries:pOe(),maxOverloaded:LK,hasFallbackModel:Boolean(
 *      B.fallbackModel),persistent:g3(),background:!Ade(B.querySource)},
 *      B.apiAttemptsLeft)`; dispatch `maxRetries:l_.retriesLeft(),
 *      modelCallRetries:l_,initialConsecutive529Errors:l_.counts().overloaded`;
 *     idle-compact `apiAttemptsLeft:{count:1}`.
 *   - The stream-state → failure classifier `$Ft`/`XMo` (feeds
 *     onStreamFailed from claude.ts).
 *   - The retry-status classifier kind `no_api_attempts_left` (`vae`) — OCC
 *     has no retry-status classifier surface.
 */
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { logError } from 'src/utils/log.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

/** Binary `LFt` — the initial per-call counts. */
export interface ModelCallAttemptCounts {
  retries: number
  overloaded: number
  stalls: number
  truncations: number
  afterThinkingOnly: number
  triedWithoutStreaming: boolean
}

/** Binary `LFt` value (never mutated — every update spreads a new object). */
export function initialAttemptCounts(): ModelCallAttemptCounts {
  return {
    retries: 0,
    overloaded: 0,
    stalls: 0,
    truncations: 0,
    afterThinkingOnly: 0,
    triedWithoutStreaming: false,
  }
}

/** Binary `VMo = 2` — credential renewals allowed per model call. */
export const CREDENTIAL_RENEWALS_PER_MODEL_CALL = 2

/** Binary `LK = 3` — max consecutive 529 overloads per model call. */
export const MAX_OVERLOADED_PER_MODEL_CALL = 3

/** Binary `gOe = 1` — max stall retries (KMo passes the literal 1). */
export const MAX_STALL_RETRIES = 1

/** Binary `NFt = 2` — max after-thinking-only retries (literal 2 in KMo). */
export const MAX_AFTER_THINKING_ONLY_RETRIES = 2

export type AttemptDecision =
  | 'retry'
  | 'fail'
  | 'useFallbackModel'
  | 'retryWithoutStreaming'
  | 'keepPartial'

export interface AttemptOutcome {
  decision: AttemptDecision
  counts: ModelCallAttemptCounts
}

/** Binary stream-failure cause values (produced by the staged `XMo`). */
export type StreamFailCause =
  | 'denied'
  | 'overloaded'
  | 'serverError'
  | 'stalled'
  | 'truncated'
  | 'connectionLost'
  | 'malformed'
  | 'badRequest'
  | 'unknown'

/** Binary stream-progress values (produced by the staged `$Ft`). */
export type StreamProgress =
  | 'output'
  | 'thinkingOnly'
  | 'partialOutput'
  | 'started'
  | 'nothing'

/** Binary `YMo`/`$Ft` classifier output — the decision-engine input. */
export type ClassifiedFailure =
  | { kind: 'noResponse' }
  | { kind: 'httpError'; status: number; fallbackModelCouldHelp: boolean }
  | {
      kind: 'streamFailed'
      cause: StreamFailCause
      progress: StreamProgress
      stopReasonReceived: boolean
    }

/** Binary `FFt(e,…)` config — built once per model call (staged @206191201). */
export interface ModelCallRetriesConfig {
  maxRetries: number
  maxOverloaded: number
  hasFallbackModel: boolean
  persistent: boolean
  background: boolean
}

/** Binary `n` (apiAttemptsLeft) — `{count:1}` on the idle-compact path. */
export interface ApiAttemptsLeft {
  count: number
}

/**
 * Binary `Y0(e,n,r)` (byte-verified): retry while the budget lasts, else the
 * given fallthrough outcome (default fail).
 */
function retryOrFail(
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  exhausted: AttemptOutcome = { decision: 'fail', counts },
): AttemptOutcome {
  return counts.retries < config.maxRetries
    ? {
        decision: 'retry',
        counts: { ...counts, retries: counts.retries + 1 },
      }
    : exhausted
}

/**
 * Binary `FK(e,n,r,s,g)` (byte-verified): bump a named sub-budget counter and
 * retry while under its cap, else the fallthrough outcome.
 */
function bumpCounterOrFail(
  counter: 'stalls' | 'truncations' | 'afterThinkingOnly',
  cap: number,
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  exhausted: AttemptOutcome,
): AttemptOutcome {
  return counts[counter] < cap
    ? retryOrFail({ ...counts, [counter]: counts[counter] + 1 }, config, exhausted)
    : exhausted
}

/**
 * Binary `Tse(e,n,r)` (byte-verified): switch to a non-streaming retry unless
 * already tried or the budget is spent.
 */
function retryWithoutStreamingOutcome(
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  allow: boolean,
): AttemptOutcome {
  if (!allow) {
    return { decision: 'fail', counts }
  }
  if (counts.triedWithoutStreaming && counts.retries >= config.maxRetries) {
    return { decision: 'fail', counts }
  }
  return {
    decision: 'retryWithoutStreaming',
    counts: {
      ...counts,
      retries: Math.min(counts.retries + 1, config.maxRetries),
      triedWithoutStreaming: true,
    },
  }
}

/**
 * Binary `mOe(e,n,r)` (byte-verified): overload (529) decision — counts the
 * overload, prefers the fallback model in background/exhausted cases, retries
 * while under maxOverloaded.
 */
function decideOverloaded(
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  allowNonStreamingRetry: boolean | undefined,
): AttemptOutcome {
  const bumped: ModelCallAttemptCounts = {
    ...counts,
    overloaded: counts.overloaded + 1,
  }
  const canGoNonStreaming = allowNonStreamingRetry !== undefined
  const nonStreamingOutcome = canGoNonStreaming
    ? retryWithoutStreamingOutcome(bumped, config, allowNonStreamingRetry as boolean)
    : { decision: 'fail' as const, counts: bumped }
  const retryOutcome: AttemptOutcome = { decision: 'retry', counts: bumped }
  if (config.background && !config.persistent) {
    return canGoNonStreaming && config.hasFallbackModel
      ? { decision: 'useFallbackModel', counts: bumped }
      : nonStreamingOutcome
  }
  if (bumped.overloaded < config.maxOverloaded) {
    return config.persistent
      ? retryOutcome
      : retryOrFail(bumped, config, nonStreamingOutcome)
  }
  if (config.hasFallbackModel) {
    return { decision: 'useFallbackModel', counts: bumped }
  }
  if (canGoNonStreaming) {
    return nonStreamingOutcome
  }
  return config.persistent ? retryOutcome : retryOrFail(bumped, config)
}

/**
 * Binary `qMo({status,fallbackModelCouldHelp},r,s)` (byte-verified): the
 * HTTP-status decision table.
 */
function decideHttpError(
  failure: { status: number; fallbackModelCouldHelp: boolean },
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
): AttemptOutcome {
  const { status, fallbackModelCouldHelp } = failure
  if (status === 529) {
    return decideOverloaded(counts, config, undefined)
  }
  if (status === 429 && config.persistent) {
    return { decision: 'retry', counts }
  }
  if (fallbackModelCouldHelp && config.hasFallbackModel) {
    return { decision: 'useFallbackModel', counts }
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return retryOrFail(counts, config)
  }
  if (status === 404 && !counts.triedWithoutStreaming) {
    return retryWithoutStreamingOutcome(counts, config, true)
  }
  return { decision: 'fail', counts }
}

/** Binary `KMo({cause,progress,stopReasonReceived},s,g,h)` (byte-verified). */
function decideStreamFailed(
  failure: {
    cause: StreamFailCause
    progress: StreamProgress
    stopReasonReceived: boolean
  },
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  allowNonStreamingRetry: boolean,
): AttemptOutcome {
  const { cause, progress, stopReasonReceived } = failure
  const fail: AttemptOutcome = { decision: 'fail', counts }
  const keepPartial: AttemptOutcome = { decision: 'keepPartial', counts }
  const nonStreaming = retryWithoutStreamingOutcome(counts, config, allowNonStreamingRetry)
  if (cause === 'denied') {
    return fail
  }
  if (progress === 'output') {
    return cause === 'badRequest' || cause === 'unknown' ? fail : keepPartial
  }
  if (progress === 'thinkingOnly') {
    switch (cause) {
      case 'stalled':
        return stopReasonReceived
          ? keepPartial
          : bumpCounterOrFail('stalls', MAX_STALL_RETRIES, counts, config, keepPartial)
      case 'connectionLost':
      case 'truncated':
      case 'malformed':
        return stopReasonReceived
          ? keepPartial
          : bumpCounterOrFail(
              'afterThinkingOnly',
              MAX_AFTER_THINKING_ONLY_RETRIES,
              counts,
              config,
              keepPartial,
            )
      case 'serverError':
        if (stopReasonReceived) {
          return fail
        }
        if (config.hasFallbackModel && !config.persistent) {
          return { decision: 'useFallbackModel', counts }
        }
        return bumpCounterOrFail(
          'afterThinkingOnly',
          MAX_AFTER_THINKING_ONLY_RETRIES,
          counts,
          config,
          fail,
        )
      case 'overloaded':
        return stopReasonReceived ? fail : decideOverloaded(counts, config, allowNonStreamingRetry)
      case 'badRequest':
      case 'unknown':
        return fail
    }
  }
  switch (cause) {
    case 'overloaded':
      return progress === 'partialOutput'
        ? retryWithoutStreamingOutcome(
            { ...counts, overloaded: counts.overloaded + 1 },
            config,
            allowNonStreamingRetry,
          )
        : decideOverloaded(counts, config, allowNonStreamingRetry)
    case 'stalled':
      return progress === 'nothing'
        ? bumpCounterOrFail('stalls', MAX_STALL_RETRIES, counts, config, nonStreaming)
        : nonStreaming
    case 'truncated':
      return stopReasonReceived
        ? nonStreaming
        : bumpCounterOrFail('truncations', 1, counts, config, nonStreaming)
    case 'connectionLost':
      return stopReasonReceived ? nonStreaming : retryOrFail(counts, config, nonStreaming)
    case 'serverError':
    case 'malformed':
    case 'badRequest':
    case 'unknown':
      return nonStreaming
  }
}

/** Binary `hOe(e,n,r,s)` (byte-verified): the decision-engine entry. */
export function decideAttempt(
  failure: ClassifiedFailure,
  counts: ModelCallAttemptCounts,
  config: ModelCallRetriesConfig,
  allowNonStreamingRetry: boolean,
): AttemptOutcome {
  switch (failure.kind) {
    case 'noResponse':
      return retryOrFail(counts, config)
    case 'httpError':
      return decideHttpError(failure, counts, config)
    case 'streamFailed':
      return decideStreamFailed(failure, counts, config, allowNonStreamingRetry)
  }
}

/**
 * Binary `YMo(e,n)` (byte-verified): classify a thrown error for the ledger.
 * Connection errors → noResponse; APIError (direct or as `cause`) with a
 * status other than 401/403 → httpError; anything else → undefined (the
 * ledger falls back to its plain retry increment).
 */
export function classifyFailureForLedger(
  error: unknown,
  fallbackModelCouldHelp: boolean,
): ClassifiedFailure | undefined {
  if (error instanceof APIConnectionError) {
    return { kind: 'noResponse' }
  }
  const apiError =
    error instanceof APIError
      ? error
      : error instanceof Error && error.cause instanceof APIError
        ? error.cause
        : undefined
  if (
    apiError?.status === undefined ||
    apiError.status === 401 ||
    apiError.status === 403
  ) {
    return undefined
  }
  return {
    kind: 'httpError',
    status: apiError.status,
    fallbackModelCouldHelp,
  }
}

/** Binary `pZ` — thrown by the withRetry loop head when the ledger is dry. */
export class NoApiAttemptsLeftError extends Error {
  constructor() {
    super('Not sent: no API attempts left')
    this.name = 'NoApiAttemptsLeftError'
  }
}

/** The ledger surface consumed by withRetry (binary `FFt` return object). */
export interface ModelCallRetries {
  /** Binary `onStreamFailed(he,_e)` — stream-path decision + counts update. */
  onStreamFailed(
    failure: Extract<ClassifiedFailure, { kind: 'streamFailed' }>,
    allowNonStreamingRetry: boolean,
  ): AttemptDecision
  /** Binary `undoLastCount(){s=g,w=!1}` — rewind after a discarded attempt. */
  undoLastCount(): void
  /** Binary `counts:()=>s`. */
  counts(): ModelCallAttemptCounts
  /** Binary `retriesLeft:()=>Math.max(0,e.maxRetries-s.retries)`. */
  retriesLeft(): number
  /** Binary `takeCredentialRenewal()` — at most VMo (2) per model call. */
  takeCredentialRenewal(): boolean
  /** Binary `takeApiAttempt()` — the whole-call request gate. */
  takeApiAttempt(): boolean
  /** Binary `outOfApiAttempts` (B). */
  outOfApiAttempts(): boolean
  /** Binary `onWithRetryGaveUp(he)`. */
  onWithRetryGaveUp(error: unknown): AttemptDecision
  /** Binary `reportHttpFailure(he,_e,Se)` — `did` is e.g. `"retry"`. */
  reportHttpFailure(
    error: unknown,
    did: 'retry' | string,
    info?: { fallbackModelCouldHelp?: boolean },
  ): void
}

/**
 * Binary `FFt(e,n)` (byte-verified, w286_ledger.txt). Creates the shared
 * per-model-call ledger. `apiAttemptsLeft` is undefined on the normal path
 * (unlimited whole-call attempts — the per-call cap comes from maxRetries)
 * and `{count:1}` on the idle-compact path.
 *
 * The `tengu_attempt_decision_shadow` flag (default false) only gates the
 * extra `tengu_attempt_decision_mismatch` telemetry (binary `K`); the counts
 * mutation in `W` is live either way, exactly as in the binary.
 */
export function createModelCallRetries(
  config: ModelCallRetriesConfig,
  apiAttemptsLeft?: ApiAttemptsLeft,
): ModelCallRetries {
  const shadowDecisions = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_attempt_decision_shadow',
    false,
  )
  let counts = initialAttemptCounts()
  let previousCounts = counts
  let credentialRenewalsLeft = CREDENTIAL_RENEWALS_PER_MODEL_CALL
  let mismatchReported = false
  let gaveUp = false

  const outOfApiAttempts = (): boolean =>
    apiAttemptsLeft !== undefined && apiAttemptsLeft.count <= 0

  /** Binary `H(he)`: keepPartial passes through; everything else fails when dry. */
  function clampWhenOutOfAttempts(decision: AttemptDecision): AttemptDecision {
    return decision === 'keepPartial' || !outOfApiAttempts() ? decision : 'fail'
  }

  /**
   * Binary `W(he,_e)`: shadow/live classification + decision; mutates counts
   * through the engine. Returns undefined when the error is not classifiable
   * (caller falls back to the plain retry increment) or after give-up.
   */
  function decideFromError(
    error: unknown,
    fallbackModelCouldHelp: boolean,
  ): { failure: ClassifiedFailure; decision: AttemptDecision } | undefined {
    if (gaveUp) {
      return undefined
    }
    try {
      const failure = classifyFailureForLedger(error, fallbackModelCouldHelp)
      if (failure === undefined) {
        return undefined
      }
      const outcome = decideAttempt(failure, counts, config, true)
      counts = outcome.counts
      return { failure, decision: outcome.decision }
    } catch (innerError) {
      logError(innerError)
      return undefined
    }
  }

  /** Binary `K(he,_e)`: one-shot mismatch telemetry under the shadow flag. */
  function reportDecisionMismatch(
    decided: { failure: ClassifiedFailure; decision: AttemptDecision } | undefined,
    did: AttemptDecision | string,
  ): void {
    if (
      decided === undefined ||
      decided.decision === did ||
      mismatchReported ||
      !shadowDecisions
    ) {
      return
    }
    mismatchReported = true
    logEvent('tengu_attempt_decision_mismatch', {
      end: decided.failure.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      status:
        decided.failure.kind === 'httpError' ? decided.failure.status : undefined,
      decided: decided.decision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      did: did as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      spent: counts.retries,
      limit: config.maxRetries,
    })
  }

  return {
    onStreamFailed(failure, allowNonStreamingRetry) {
      previousCounts = counts
      let decision: AttemptDecision
      try {
        const outcome = decideAttempt(failure, counts, config, allowNonStreamingRetry)
        counts = outcome.counts
        decision = outcome.decision
      } catch (error) {
        logError(error)
        decision =
          failure.progress === 'thinkingOnly' || failure.progress === 'output'
            ? 'keepPartial'
            : allowNonStreamingRetry
              ? 'retryWithoutStreaming'
              : 'fail'
      }
      decision = clampWhenOutOfAttempts(decision)
      gaveUp = decision === 'fail' || decision === 'useFallbackModel'
      return decision
    },
    undoLastCount() {
      counts = previousCounts
      gaveUp = false
    },
    counts: () => counts,
    retriesLeft: () => Math.max(0, config.maxRetries - counts.retries),
    takeCredentialRenewal() {
      if (credentialRenewalsLeft <= 0) {
        return false
      }
      credentialRenewalsLeft--
      return true
    },
    takeApiAttempt() {
      if (apiAttemptsLeft === undefined) {
        return true
      }
      if (apiAttemptsLeft.count <= 0) {
        return false
      }
      apiAttemptsLeft.count--
      return true
    },
    outOfApiAttempts,
    onWithRetryGaveUp(error) {
      if (outOfApiAttempts()) {
        return 'fail'
      }
      const decided = decideFromError(error, false)
      const did: AttemptDecision =
        decided?.decision === 'retryWithoutStreaming' ? 'retryWithoutStreaming' : 'fail'
      reportDecisionMismatch(decided, did)
      return did
    },
    reportHttpFailure(error, did, info) {
      const { triedWithoutStreaming } = counts
      const decided = decideFromError(error, info?.fallbackModelCouldHelp ?? false)
      counts = { ...counts, triedWithoutStreaming }
      if (decided === undefined && did === 'retry') {
        counts = {
          ...counts,
          retries: Math.min(counts.retries + 1, config.maxRetries),
        }
      }
      reportDecisionMismatch(decided, did)
    },
  }
}
