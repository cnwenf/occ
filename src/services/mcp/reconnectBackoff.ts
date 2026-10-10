/**
 * MCP reconnect backoff / young-close hold-off / retryability helpers.
 *
 * Byte-faithful port of the official Claude Code 2.1.295 reconnect machinery
 * (gap #018). Official evidence (v295 ELF offsets; v294 counterparts lack all
 * of the slow-phase/hold-off constants — they are new in 2.1.295):
 *
 * Constants @213397583:
 *   `cne=16777216,TJ=5,w=1000,h=30000,nns=1e4;
 *    function gnt(e){return Vv({attempt:e,baseMs:w,capMs:h})}
 *    var bRn=8,mZr=30000,rns=300000`
 *
 * Generic backoff `Vv` (identical in v294/v295):
 *   `function Vv({attempt:t,baseMs:r,capMs:e=1/0,factor:o=2,
 *                 jitter:n={kind:"none"},random:m=Math.random}){
 *      let i=Math.min(e,r*o**(t-1));
 *      switch(n.kind){case"none":return i;
 *        case"proportional":return i+m()*n.ratio*i;
 *        case"symmetric":return Math.max(0,i+i*n.ratio*(2*m()-1));
 *        case"full":{let a=Math.min(n.floorMs,i);return a+m()*(i-a)}}}`
 *
 * Full-jitter wrapper `AH` (v295):
 *   `function AH({baseMs:t,capMs:r=60000,attempt:e,floorMs:o=0,
 *                 random:n=Math.random}){
 *      return Math.floor(Vv({attempt:Math.max(0,e)+1,baseMs:t,capMs:r,
 *                            jitter:{kind:"full",floorMs:o},random:n}))}`
 *
 * Retryability gate `Wge` @217049252:
 *   `var Y5t=new Set(["http","sse","claudeai-proxy"]),
 *       cqt=new Set(["CLI_OWNED_BEARER_REJECTED","HEADERS_HELPER_AUTH_REJECTED"]),
 *       fGe=new Set(["500","502","503","504",...t6e,"23",...cqt,"CONNECT_TIMEOUT"]);
 *    function Wge(e){if(e.type!=="failed")return!1;
 *      let n=e.config.type??"";if(!Y5t.has(n))return!1;
 *      if(e.proxyConnectStatus===403)return!1;
 *      if(e.errorCode!==void 0)return fGe.has(e.errorCode);
 *      return n==="sse"}`
 *   with t6e @209603440:
 *   `new Set(["ECONNREFUSED","ETIMEDOUT","ECONNRESET","ECONNABORTED","ENOTFOUND",
 *             "ENETUNREACH","EAI_AGAIN","ConnectionRefused","ConnectionClosed",
 *             "FailedToOpenSocket","ERR_SOCKET_CLOSED","ERR_PROXY_TUNNEL"])`
 *
 * Young-close hold-off (watcher `yDo` @241120400): a connection that closes
 * before `nns` (10s) uptime increments a per-client young-close counter; when
 * the counter is >1 the next reconnect is held off for
 * `gnt(youngCloses-1) - uptimeMs` (clamped at 0) so a server that drops each
 * connection right after connect is not tight-looped.
 */

/** Official `TJ` — fast-phase reconnect attempts. */
export const FAST_RECONNECT_ATTEMPTS = 5
/** Official `bRn` — additional slow background reconnect attempts (new in v295). */
export const SLOW_RECONNECT_ATTEMPTS = 8
/** Official `W = TJ + bRn` — total attempts across both phases. */
export const TOTAL_RECONNECT_ATTEMPTS =
  FAST_RECONNECT_ATTEMPTS + SLOW_RECONNECT_ATTEMPTS

/** Official `w` — fast-phase backoff base (ms). */
export const FAST_BACKOFF_BASE_MS = 1000
/** Official `h` — fast-phase backoff cap (ms). */
export const FAST_BACKOFF_CAP_MS = 30000
/** Official `mZr` — slow-phase full-jitter base (ms) (new in v295). */
export const SLOW_BACKOFF_BASE_MS = 30000
/** Official `rns` — slow-phase full-jitter cap (ms) (new in v295). */
export const SLOW_BACKOFF_CAP_MS = 300000
/** Official `nns` — young-close uptime threshold (ms) (new in v295). */
export const YOUNG_CLOSE_THRESHOLD_MS = 10000

export type BackoffJitter =
  | { kind: 'none' }
  | { kind: 'proportional'; ratio: number }
  | { kind: 'symmetric'; ratio: number }
  | { kind: 'full'; floorMs: number }

/**
 * Generic exponential backoff — verbatim port of official `Vv`.
 */
export function computeBackoffMs(options: {
  attempt: number
  baseMs: number
  capMs?: number
  factor?: number
  jitter?: BackoffJitter
  random?: () => number
}): number {
  const {
    attempt,
    baseMs,
    capMs = Number.POSITIVE_INFINITY,
    factor = 2,
    jitter = { kind: 'none' },
    random = Math.random,
  } = options
  const capped = Math.min(capMs, baseMs * factor ** (attempt - 1))
  switch (jitter.kind) {
    case 'none':
      return capped
    case 'proportional':
      return capped + random() * jitter.ratio * capped
    case 'symmetric':
      return Math.max(0, capped + capped * jitter.ratio * (2 * random() - 1))
    case 'full': {
      const floor = Math.min(jitter.floorMs, capped)
      return floor + random() * (capped - floor)
    }
  }
}

/**
 * Fast-phase delay before attempt N+1 — official `gnt(e)` =
 * `Vv({attempt:e,baseMs:1000,capMs:30000})` → 1s, 2s, 4s, 8s, … capped at 30s.
 */
export function fastReconnectDelayMs(attempt: number): number {
  return computeBackoffMs({
    attempt,
    baseMs: FAST_BACKOFF_BASE_MS,
    capMs: FAST_BACKOFF_CAP_MS,
  })
}

/**
 * Slow-phase full-jitter delay — official `AH` as invoked by the loop `de`:
 * `AH({baseMs:mZr,capMs:rns,floorMs:mZr/2,attempt:H-1,random})` where H is the
 * 1-based slow attempt. Jittered within [15s, min(300s, 30s·2^attempt)].
 */
export function slowReconnectDelayMs(
  slowAttemptIndex: number,
  random: () => number = Math.random,
): number {
  return Math.floor(
    computeBackoffMs({
      attempt: Math.max(0, slowAttemptIndex) + 1,
      baseMs: SLOW_BACKOFF_BASE_MS,
      capMs: SLOW_BACKOFF_CAP_MS,
      jitter: { kind: 'full', floorMs: SLOW_BACKOFF_BASE_MS / 2 },
      random,
    }),
  )
}

/**
 * Young-close hold-off — official watcher closure `v(h,r,R)` @241120400:
 * `let T = r>1 ? gnt(r-1) - R : 0` where r = young-close count and
 * R = uptime of the just-closed connection. Returns 0 when the count is ≤1 or
 * the delay has already elapsed. (The official's extra gates — client still
 * shown connected in state, control-reconnect in flight — are enforced at the
 * call site, not here.)
 */
export function youngCloseHoldOffMs(
  youngCloses: number,
  uptimeMs: number,
): number {
  if (youngCloses <= 1) {
    return 0
  }
  return Math.max(0, fastReconnectDelayMs(youngCloses - 1) - uptimeMs)
}

/** True when a close after `uptimeMs` counts as a "young" close (official `d<nns`). */
export function isYoungClose(uptimeMs: number): boolean {
  return uptimeMs < YOUNG_CLOSE_THRESHOLD_MS
}

/** Official `Y5t` — transports eligible for background reconnect. */
const REMOTE_RETRY_TRANSPORT_TYPES = new Set(['http', 'sse', 'claudeai-proxy'])

/** Official `cqt` — auth-rejection codes excluded from the slow phase. */
export const AUTH_REJECTED_ERROR_CODES = new Set([
  'CLI_OWNED_BEARER_REJECTED',
  'HEADERS_HELPER_AUTH_REJECTED',
])

/** Official `t6e` — network error codes considered retryable. */
const NETWORK_RETRY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
  'ERR_SOCKET_CLOSED',
  'ERR_PROXY_TUNNEL',
])

/** Official `fGe` — retryable errorCode allowlist. */
const RETRYABLE_ERROR_CODES = new Set([
  '500',
  '502',
  '503',
  '504',
  ...NETWORK_RETRY_ERROR_CODES,
  '23',
  ...AUTH_REJECTED_ERROR_CODES,
  'CONNECT_TIMEOUT',
])

/** Minimal shape of the official failed-client record consulted by `Wge`. */
export interface RetryabilityInput {
  type: string
  config: { type?: string }
  errorCode?: string
  proxyConnectStatus?: number
}

/**
 * Retryability gate — verbatim port of official `Wge` @217049252.
 */
export function isRetryableMcpFailure(client: RetryabilityInput): boolean {
  if (client.type !== 'failed') {
    return false
  }
  const transportType = client.config.type ?? ''
  if (!REMOTE_RETRY_TRANSPORT_TYPES.has(transportType)) {
    return false
  }
  if (client.proxyConnectStatus === 403) {
    return false
  }
  if (client.errorCode !== undefined) {
    return RETRYABLE_ERROR_CODES.has(client.errorCode)
  }
  return transportType === 'sse'
}

/**
 * Slow-phase eligibility — official loop predicate
 * `O = Wge(a) && (a.errorCode===void 0 || !cqt.has(a.errorCode))`:
 * retryable AND not an auth rejection (auth failures never loop in the
 * background; they surface as needs-auth / gave-up instead).
 */
export function goesToSlowPhase(client: RetryabilityInput): boolean {
  return (
    isRetryableMcpFailure(client) &&
    (client.errorCode === undefined ||
      !AUTH_REJECTED_ERROR_CODES.has(client.errorCode))
  )
}
