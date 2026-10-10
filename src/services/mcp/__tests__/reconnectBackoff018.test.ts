import { describe, expect, test } from 'bun:test'
import {
  AUTH_REJECTED_ERROR_CODES,
  FAST_BACKOFF_BASE_MS,
  FAST_BACKOFF_CAP_MS,
  FAST_RECONNECT_ATTEMPTS,
  SLOW_BACKOFF_BASE_MS,
  SLOW_BACKOFF_CAP_MS,
  SLOW_RECONNECT_ATTEMPTS,
  TOTAL_RECONNECT_ATTEMPTS,
  YOUNG_CLOSE_THRESHOLD_MS,
  computeBackoffMs,
  fastReconnectDelayMs,
  goesToSlowPhase,
  isRetryableMcpFailure,
  isYoungClose,
  slowReconnectDelayMs,
  youngCloseHoldOffMs,
  type RetryabilityInput,
} from '../reconnectBackoff.js'

/**
 * Gap #018 (official 2.1.295): remote MCP reconnect gains a two-phase loop —
 * fast phase (TJ=5 attempts, delays 1s/2s/4s/8s capped at 30s) then slow
 * background phase (bRn=8 more attempts, W=13 total, full jitter base 30s cap
 * 300s floor 15s) — plus young-close detection (uptime < nns=10s) with a
 * hold-off of `gnt(youngCloses-1) - uptime` so a server that drops each
 * connection right after connect is not tight-looped.
 *
 * Official evidence (v295 ELF; ALL slow-phase constants absent from v294):
 * - Constants @213397583: `TJ=5,w=1000,h=30000,nns=1e4;
 *   function gnt(e){return Vv({attempt:e,baseMs:w,capMs:h})}
 *   var bRn=8,mZr=30000,rns=300000`
 * - Loop `de` @241124366: `W=TJ+bRn`; slow delay
 *   `AH({baseMs:mZr,capMs:rns,floorMs:mZr/2,attempt:H-1,random})`;
 *   success presets young-close counter to `S+u-1`.
 * - Watcher `yDo` @241120400: `A=d<nns?(E.get(r.client)??0)+1:0`;
 *   hold-off `T=r>1?gnt(r-1)-R:0`.
 * - Retryability `Wge` @217049252 (see reconnectBackoff.ts header for the
 *   verbatim body).
 */

describe('official v295 reconnect constants (#018)', () => {
  test('two-phase attempt counts: 5 fast + 8 slow = 13 total', () => {
    // Act & Assert — TJ=5, bRn=8, W=TJ+bRn
    expect(FAST_RECONNECT_ATTEMPTS).toBe(5)
    expect(SLOW_RECONNECT_ATTEMPTS).toBe(8)
    expect(TOTAL_RECONNECT_ATTEMPTS).toBe(13)
  })

  test('backoff constants match the binary (w/h/mZr/rns/nns)', () => {
    // Act & Assert
    expect(FAST_BACKOFF_BASE_MS).toBe(1000)
    expect(FAST_BACKOFF_CAP_MS).toBe(30000)
    expect(SLOW_BACKOFF_BASE_MS).toBe(30000)
    expect(SLOW_BACKOFF_CAP_MS).toBe(300000)
    expect(YOUNG_CLOSE_THRESHOLD_MS).toBe(10000)
  })
})

describe('computeBackoffMs — verbatim official Vv', () => {
  test('none jitter: exponential with cap, default factor 2', () => {
    // Act & Assert
    expect(computeBackoffMs({ attempt: 1, baseMs: 1000, capMs: 30000 })).toBe(1000)
    expect(computeBackoffMs({ attempt: 4, baseMs: 1000, capMs: 30000 })).toBe(8000)
    expect(computeBackoffMs({ attempt: 9, baseMs: 1000, capMs: 30000 })).toBe(30000)
  })

  test('full jitter: floor + random()*(capped-floor)', () => {
    // Arrange
    const random = () => 0.5

    // Act
    const result = computeBackoffMs({
      attempt: 1,
      baseMs: 30000,
      capMs: 300000,
      jitter: { kind: 'full', floorMs: 15000 },
      random,
    })

    // Assert — floor=min(15000,30000)=15000; 15000+0.5*15000
    expect(result).toBe(22500)
  })

  test('proportional jitter: capped + random()*ratio*capped', () => {
    // Act & Assert
    expect(
      computeBackoffMs({
        attempt: 2,
        baseMs: 1000,
        jitter: { kind: 'proportional', ratio: 0.5 },
        random: () => 0.5,
      }),
    ).toBe(2500)
  })

  test('symmetric jitter never goes below zero', () => {
    // Act & Assert — ratio 1 with random()=0 → capped-capped = 0
    expect(
      computeBackoffMs({
        attempt: 1,
        baseMs: 1000,
        jitter: { kind: 'symmetric', ratio: 1 },
        random: () => 0,
      }),
    ).toBe(0)
  })
})

describe('fastReconnectDelayMs — official gnt schedule', () => {
  test('delays are 1s/2s/4s/8s/16s then capped at 30s', () => {
    // Act & Assert
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(fastReconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
  })
})

describe('slowReconnectDelayMs — official AH full jitter (seeded)', () => {
  test('attempt idx 0 jitters within [15s floor, 30s cap]', () => {
    // Act & Assert — capped=30000, floor=15000
    expect(slowReconnectDelayMs(0, () => 0)).toBe(15000)
    expect(slowReconnectDelayMs(0, () => 0.5)).toBe(22500)
    expect(slowReconnectDelayMs(0, () => 1)).toBe(30000)
  })

  test('capped growth: idx 4 saturates the 300s cap', () => {
    // Act & Assert — 30000*2^4=480000 → capped at 300000; floor 15000
    expect(slowReconnectDelayMs(4, () => 0.5)).toBe(157500)
    expect(slowReconnectDelayMs(7, () => 0)).toBe(15000)
  })

  test('negative index is clamped to attempt 1 (official Math.max(0,e)+1)', () => {
    // Act & Assert
    expect(slowReconnectDelayMs(-3, () => 0.5)).toBe(22500)
  })

  test('result is always an integer (official Math.floor)', () => {
    // Act
    const result = slowReconnectDelayMs(2, () => 0.123456789)

    // Assert
    expect(Number.isInteger(result)).toBe(true)
  })
})

describe('youngCloseHoldOffMs — official watcher v(h,r,R) (#018 anti-tight-loop)', () => {
  test('count <= 1 means no hold-off (first young close reconnects immediately)', () => {
    // Act & Assert
    expect(youngCloseHoldOffMs(0, 0)).toBe(0)
    expect(youngCloseHoldOffMs(1, 500)).toBe(0)
  })

  test('hold-off is gnt(count-1) minus uptime, clamped at zero', () => {
    // Act & Assert
    expect(youngCloseHoldOffMs(2, 3000)).toBe(0) // gnt(1)=1000 already elapsed
    expect(youngCloseHoldOffMs(3, 500)).toBe(1500) // gnt(2)=2000-500
    expect(youngCloseHoldOffMs(6, 0)).toBe(16000) // gnt(5)
    expect(youngCloseHoldOffMs(7, 0)).toBe(30000) // gnt(6) capped
  })
})

describe('isYoungClose — official d < nns threshold', () => {
  test('closes under 10s uptime are young; at/over 10s are not', () => {
    // Act & Assert — strict less-than
    expect(isYoungClose(0)).toBe(true)
    expect(isYoungClose(9999)).toBe(true)
    expect(isYoungClose(10000)).toBe(false)
    expect(isYoungClose(60000)).toBe(false)
  })
})

function failedClient(
  transportType: string,
  errorCode?: string,
  extra?: Partial<RetryabilityInput>,
): RetryabilityInput {
  return {
    type: 'failed',
    config: { type: transportType },
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...extra,
  }
}

describe('isRetryableMcpFailure — verbatim official Wge @217049252', () => {
  test('non-failed clients are never retryable', () => {
    // Act & Assert
    expect(
      isRetryableMcpFailure({
        type: 'pending',
        config: { type: 'http' },
        errorCode: 'ECONNRESET',
      }),
    ).toBe(false)
  })

  test('local transports are never retryable (Y5t = http/sse/claudeai-proxy only)', () => {
    // Act & Assert — stdio/ws/sdk stay out of the background loop
    expect(isRetryableMcpFailure(failedClient('stdio', 'ECONNRESET'))).toBe(false)
    expect(isRetryableMcpFailure(failedClient('ws', 'ECONNRESET'))).toBe(false)
    expect(isRetryableMcpFailure(failedClient('sdk'))).toBe(false)
  })

  test('http with a retryable network error code IS retryable', () => {
    // Act & Assert — fGe includes t6e network codes
    expect(isRetryableMcpFailure(failedClient('http', 'ECONNRESET'))).toBe(true)
    expect(isRetryableMcpFailure(failedClient('http', 'ECONNREFUSED'))).toBe(true)
    expect(isRetryableMcpFailure(failedClient('claudeai-proxy', 'EAI_AGAIN'))).toBe(
      true,
    )
    expect(isRetryableMcpFailure(failedClient('http', 'CONNECT_TIMEOUT'))).toBe(true)
    expect(isRetryableMcpFailure(failedClient('http', '500'))).toBe(true)
    expect(isRetryableMcpFailure(failedClient('http', '23'))).toBe(true)
  })

  test('http with NO error code is NOT retryable (only sse defaults to retryable)', () => {
    // Act & Assert — `return n==="sse"` fallback
    expect(isRetryableMcpFailure(failedClient('http'))).toBe(false)
    expect(isRetryableMcpFailure(failedClient('sse'))).toBe(true)
    expect(isRetryableMcpFailure(failedClient('claudeai-proxy'))).toBe(false)
  })

  test('non-allowlisted error code is NOT retryable', () => {
    // Act & Assert
    expect(isRetryableMcpFailure(failedClient('sse', '401'))).toBe(false)
    expect(isRetryableMcpFailure(failedClient('http', 'ENOENT'))).toBe(false)
  })

  test('proxyConnectStatus 403 short-circuits to NOT retryable', () => {
    // Act & Assert
    expect(
      isRetryableMcpFailure(
        failedClient('http', 'ECONNRESET', { proxyConnectStatus: 403 }),
      ),
    ).toBe(false)
  })
})

describe('goesToSlowPhase — official loop predicate O (retryable AND not auth-rejected)', () => {
  test('auth-rejected codes are retryable but never enter the slow background loop', () => {
    // Arrange — cqt exclusions
    expect(AUTH_REJECTED_ERROR_CODES.has('CLI_OWNED_BEARER_REJECTED')).toBe(true)
    expect(AUTH_REJECTED_ERROR_CODES.has('HEADERS_HELPER_AUTH_REJECTED')).toBe(true)

    // Act & Assert
    expect(isRetryableMcpFailure(failedClient('http', 'CLI_OWNED_BEARER_REJECTED'))).toBe(
      true,
    )
    expect(goesToSlowPhase(failedClient('http', 'CLI_OWNED_BEARER_REJECTED'))).toBe(false)
    expect(goesToSlowPhase(failedClient('http', 'HEADERS_HELPER_AUTH_REJECTED'))).toBe(
      false,
    )
  })

  test('plain network failures DO go to the slow phase', () => {
    // Act & Assert
    expect(goesToSlowPhase(failedClient('http', 'ECONNRESET'))).toBe(true)
    expect(goesToSlowPhase(failedClient('http', 'CONNECT_TIMEOUT'))).toBe(true)
  })

  test('sse with no error code goes to the slow phase (errorCode undefined branch)', () => {
    // Act & Assert
    expect(goesToSlowPhase(failedClient('sse'))).toBe(true)
  })

  test('non-retryable failures never reach the slow phase', () => {
    // Act & Assert
    expect(goesToSlowPhase(failedClient('stdio', 'ECONNRESET'))).toBe(false)
    expect(goesToSlowPhase(failedClient('http'))).toBe(false)
  })
})
