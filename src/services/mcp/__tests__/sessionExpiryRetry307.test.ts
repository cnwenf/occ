/**
 * claude-code 2.1.307 PORT B3 — HTTP MCP idempotent-only retry.
 * Official sources (linux ELF + new307.txt, byte-verified, never executed):
 *  - `SO` error class @241629553: `expiryKind` (default `"session_expired_404"`),
 *    three verbatim messages, telemetryMessage `"MCP session expired"`,
 *    `get mayHaveRun()` → true ONLY for `"connection_closed_http"`.
 *  - Throw-site classification @279157850:
 *    `ee?"session_expired_404":mZn(ue?.closeReason)||ue?.closeReason==="session expired"&&te?
 *     "connection_closed_call_refused":!K&&te?"connection_closed_call_not_run":"connection_closed_http"`
 *    where `mZn(e){return e==="malformed message after an auth challenge"}`,
 *    `te`=allSendsRanNothing, `K`=sessionId-was-undefined at call entry.
 *  - Retry gate @279114404:
 *    `ze instanceof SO&&Et<1&&(!ze.mayHaveRun||ee.isConcurrencySafe(te)||x.annotations?.idempotentHint===!0)`
 *  - `Amo` rejection-code set + `rNn` send tracking + `oNn` allSendsRanNothing
 *    @278908635.
 *  - `z_` result-text renderer @276388380 (em-dash U+2014, " mcp_call" suffix)
 *    and the `Jt` sanitizer @239037125 (lone surrogates + invisibles stripped
 *    to EMPTY, 64-pass fixpoint, 4096 pre-slice, 1024 display truncation).
 */
import { describe, expect, test } from 'bun:test'
import {
  McpSessionExpiredError,
  classifySessionExpiryKind,
  shouldRetryAfterSessionRecovery,
} from '../client.js'
import {
  SEND_REJECTION_CODES,
  allSendsRanNothing,
  trackToolCallSends,
} from '../sendTracking.js'
import type { ToolCallWatchdog } from '../sendTracking.js'
import {
  renderSessionRecoveryResultText,
  sanitizeSessionRecoveryText,
} from '../sessionRecoveryText.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../../utils/errors.js'

// ---------------------------------------------------------------------------
// McpSessionExpiredError — verbatim per-kind messages + mayHaveRun truth table
// ---------------------------------------------------------------------------

describe('2.1.307 B3 McpSessionExpiredError', () => {
  test('defaults to session_expired_404 with the verbatim session-expired message', () => {
    // Act
    const error = new McpSessionExpiredError('srv')

    // Assert
    expect(error.expiryKind).toBe('session_expired_404')
    expect(error.message).toBe('MCP server "srv" session expired')
    expect(error.name).toBe('McpSessionExpiredError')
    expect(error.mayHaveRun).toBe(false)
  })

  test('connection_closed_http carries the may-have-run message and mayHaveRun=true', () => {
    // Act
    const error = new McpSessionExpiredError('srv', 'connection_closed_http')

    // Assert — verbatim official message.
    expect(error.message).toBe(
      'MCP server "srv" connection closed before the tool call was answered. The tool may have run: check whether it did before running it again.',
    )
    expect(error.mayHaveRun).toBe(true)
  })

  test('connection_closed_call_not_run carries the call-not-run message and mayHaveRun=false', () => {
    // Act
    const error = new McpSessionExpiredError(
      'srv',
      'connection_closed_call_not_run',
    )

    // Assert
    expect(error.message).toBe(
      'MCP server "srv" connection closed before the tool call ran',
    )
    expect(error.mayHaveRun).toBe(false)
  })

  test('connection_closed_call_refused reuses the session-expired message and mayHaveRun=false', () => {
    // Act
    const error = new McpSessionExpiredError(
      'srv',
      'connection_closed_call_refused',
    )

    // Assert — the official ternary's else branch serves BOTH
    // session_expired_404 and connection_closed_call_refused.
    expect(error.message).toBe('MCP server "srv" session expired')
    expect(error.mayHaveRun).toBe(false)
  })

  test('is a TelemetrySafeError with the official telemetry message', () => {
    // Arrange / Act
    const error = new McpSessionExpiredError('srv')

    // Assert — official `SO extends R` (R = TelemetrySafeError base),
    // telemetryMessage "MCP session expired".
    expect(error).toBeInstanceOf(
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    )
    expect(error.telemetryMessage).toBe('MCP session expired')
  })
})

// ---------------------------------------------------------------------------
// classifySessionExpiryKind — the official throw-site kind chain
// ---------------------------------------------------------------------------

describe('2.1.307 B3 classifySessionExpiryKind', () => {
  test('stale session always classifies as session_expired_404', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: true,
        closeReason: 'malformed message after an auth challenge',
        ranNothing: true,
        sessionIdWasUndefined: false,
      }),
    ).toBe('session_expired_404')
  })

  test('malformed-after-auth-challenge close reason classifies as connection_closed_call_refused', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: 'malformed message after an auth challenge',
        ranNothing: false,
        sessionIdWasUndefined: false,
      }),
    ).toBe('connection_closed_call_refused')
  })

  test('session-expired close reason + all sends ran nothing classifies as connection_closed_call_refused', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: 'session expired',
        ranNothing: true,
        sessionIdWasUndefined: false,
      }),
    ).toBe('connection_closed_call_refused')
  })

  test('session-expired close reason WITH a send that may have run falls through to connection_closed_http', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: 'session expired',
        ranNothing: false,
        sessionIdWasUndefined: false,
      }),
    ).toBe('connection_closed_http')
  })

  test('had a session id + all sends ran nothing classifies as connection_closed_call_not_run', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: undefined,
        ranNothing: true,
        sessionIdWasUndefined: false,
      }),
    ).toBe('connection_closed_call_not_run')
  })

  test('no session id at entry never classifies as call_not_run even when sends ran nothing', () => {
    // Official `!K&&te` — K (sessionIdWasUndefined) blocks the not_run kind.
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: undefined,
        ranNothing: true,
        sessionIdWasUndefined: true,
      }),
    ).toBe('connection_closed_http')
  })

  test('defaults to connection_closed_http', () => {
    expect(
      classifySessionExpiryKind({
        isStaleSession: false,
        closeReason: 'max consecutive terminal errors',
        ranNothing: false,
        sessionIdWasUndefined: true,
      }),
    ).toBe('connection_closed_http')
  })
})

// ---------------------------------------------------------------------------
// shouldRetryAfterSessionRecovery — the official retry gate fragment
// ---------------------------------------------------------------------------

describe('2.1.307 B3 shouldRetryAfterSessionRecovery', () => {
  test('retries when the call definitely did not run', () => {
    expect(shouldRetryAfterSessionRecovery(undefined, false)).toBe(true)
  })

  test('refuses a may-have-run retry with no annotations', () => {
    expect(shouldRetryAfterSessionRecovery(undefined, true)).toBe(false)
  })

  test('retries a may-have-run call when the tool is concurrency-safe (readOnlyHint)', () => {
    expect(
      shouldRetryAfterSessionRecovery({ readOnlyHint: true }, true),
    ).toBe(true)
  })

  test('retries a may-have-run call when idempotentHint is strictly true', () => {
    expect(
      shouldRetryAfterSessionRecovery({ idempotentHint: true }, true),
    ).toBe(true)
  })

  test('refuses when readOnlyHint and idempotentHint are false', () => {
    expect(
      shouldRetryAfterSessionRecovery(
        { readOnlyHint: false, idempotentHint: false },
        true,
      ),
    ).toBe(false)
  })

  test('refuses when idempotentHint is not strictly boolean true', () => {
    // Official uses `===!0` — a truthy non-boolean must NOT enable the retry.
    expect(
      shouldRetryAfterSessionRecovery(
        { idempotentHint: 'true' as unknown as boolean },
        true,
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Send tracking (official Amo / rNn / oNn)
// ---------------------------------------------------------------------------

interface SentRecord {
  message: unknown
  options: unknown
}

function makeFakeTransport(failures: Array<unknown | undefined> = []) {
  const sent: SentRecord[] = []
  let sendIndex = 0
  const transport = {
    send: async (message: unknown, options?: unknown) => {
      sent.push({ message, options })
      const failure = failures[sendIndex++]
      if (failure !== undefined) {
        throw failure
      }
    },
  }
  return { transport, sent }
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code })
}

function watchdog(toolUseId?: string): ToolCallWatchdog {
  return {
    armedAt: 0,
    offCriticalPath: false,
    toolUseId,
    ownSends: { started: 0, ranNothing: 0 },
  }
}

function toolsCall(toolUseId?: string) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'echo',
      arguments: {},
      ...(toolUseId !== undefined && {
        _meta: { 'claudecode/toolUseId': toolUseId },
      }),
    },
  }
}

describe('2.1.307 B3 send tracking', () => {
  test('exports the official rejection-code set verbatim', () => {
    expect([...SEND_REJECTION_CODES].sort()).toEqual(
      [
        'ECONNREFUSED',
        'ConnectionRefused',
        'ENOTFOUND',
        'EAI_AGAIN',
        'FailedToOpenSocket',
        'ERR_PROXY_TUNNEL',
      ].sort(),
    )
  })

  test('passes non-tools/call messages through without counting', async () => {
    // Arrange
    const { transport, sent } = makeFakeTransport()
    const counts = trackToolCallSends(transport, () => false, new Set())

    // Act
    await transport.send({ method: 'notifications/initialized' })
    await transport.send('not-an-object' as never)
    await transport.send(null as never)

    // Assert
    expect(sent).toHaveLength(3)
    expect(counts.started).toBe(0)
    expect(counts.ranNothing).toEqual([])
  })

  test('counts tools/call sends and leaves ranNothing empty on success', async () => {
    // Arrange
    const { transport } = makeFakeTransport()
    const counts = trackToolCallSends(transport, () => false, new Set())

    // Act
    await transport.send(toolsCall())
    await transport.send(toolsCall())

    // Assert
    expect(counts.started).toBe(2)
    expect(counts.ranNothing).toEqual([])
  })

  test('records ranNothing with the send sequence when a rejection-code error fires, and rethrows', async () => {
    // Arrange — first send succeeds, second fails with ECONNREFUSED.
    const failure = errnoError('ECONNREFUSED')
    const { transport } = makeFakeTransport([undefined, failure])
    const counts = trackToolCallSends(transport, () => false, new Set())

    // Act
    await transport.send(toolsCall())
    const rejected = transport.send(toolsCall()).catch((e: unknown) => e)

    // Assert
    expect(await rejected).toBe(failure)
    expect(counts.started).toBe(2)
    expect(counts.ranNothing).toEqual([2])
  })

  test('records ranNothing when the session-expired predicate matches', async () => {
    // Arrange
    const failure = new Error('404 {"code":-32001}')
    const { transport } = makeFakeTransport([failure])
    const counts = trackToolCallSends(
      transport,
      (error: Error) => error.message.includes('-32001'),
      new Set(),
    )

    // Act
    await expect(transport.send(toolsCall())).rejects.toBe(failure)

    // Assert
    expect(counts.ranNothing).toEqual([1])
  })

  test('does NOT record ranNothing for an unrelated send failure', async () => {
    // Arrange — ETIMEDOUT is not in the official set and the predicate is false.
    const { transport } = makeFakeTransport([errnoError('ETIMEDOUT')])
    const counts = trackToolCallSends(transport, () => false, new Set())

    // Act
    await expect(transport.send(toolsCall())).rejects.toThrow()

    // Assert
    expect(counts.started).toBe(1)
    expect(counts.ranNothing).toEqual([])
  })

  test('increments ownSends on the uniquely-matching watchdog and records its ranNothing', async () => {
    // Arrange
    const watch = watchdog('tu_1')
    const watchdogs = new Set<ToolCallWatchdog>([watch, watchdog('tu_other')])
    const { transport } = makeFakeTransport([errnoError('ENOTFOUND')])
    const counts = trackToolCallSends(transport, () => false, watchdogs)

    // Act
    await expect(transport.send(toolsCall('tu_1'))).rejects.toThrow()

    // Assert — official: matching watchdogs get ownSends.started++; only the
    // UNIQUE match (`y.length===1`) also gets ownSends.ranNothing++.
    expect(watch.ownSends).toEqual({ started: 1, ranNothing: 1 })
    expect([...watchdogs][1]!.ownSends).toEqual({ started: 0, ranNothing: 0 })
    expect(counts.ranNothing).toEqual([1])
  })

  test('counts ownSends.started for every matching watchdog but skips ownSends.ranNothing when the match is ambiguous', async () => {
    // Arrange — two in-flight calls share a toolUseId (ambiguous attribution).
    const first = watchdog('tu_dup')
    const second = watchdog('tu_dup')
    const { transport } = makeFakeTransport([errnoError('ECONNREFUSED')])
    trackToolCallSends(
      transport,
      () => false,
      new Set<ToolCallWatchdog>([first, second]),
    )

    // Act
    await expect(transport.send(toolsCall('tu_dup'))).rejects.toThrow()

    // Assert
    expect(first.ownSends).toEqual({ started: 1, ranNothing: 0 })
    expect(second.ownSends).toEqual({ started: 1, ranNothing: 0 })
  })
})

describe('2.1.307 B3 allSendsRanNothing', () => {
  test('answers from ownSends when it recorded any send', () => {
    expect(allSendsRanNothing(undefined, undefined, { started: 2, ranNothing: 2 })).toBe(true)
    expect(allSendsRanNothing(undefined, undefined, { started: 2, ranNothing: 1 })).toBe(false)
  })

  test('falls through to the tracker baseline when ownSends recorded nothing', () => {
    // Tracker started 3 sends total; baseline was 1; sends 2 and 3 both ran
    // nothing → true.
    expect(
      allSendsRanNothing({ started: 3, ranNothing: [2, 3] }, 1, {
        started: 0,
        ranNothing: 0,
      }),
    ).toBe(true)
    // One of the post-baseline sends may have run → false.
    expect(
      allSendsRanNothing({ started: 3, ranNothing: [2] }, 1, undefined),
    ).toBe(false)
  })

  test('returns false without a tracker or baseline', () => {
    expect(allSendsRanNothing(undefined, undefined, undefined)).toBe(false)
    expect(allSendsRanNothing({ started: 2, ranNothing: [1, 2] }, undefined, undefined)).toBe(false)
  })

  test('returns false when no sends started after the baseline', () => {
    expect(
      allSendsRanNothing({ started: 2, ranNothing: [1, 2] }, 2, undefined),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session-recovery result text (official z_ + Jt)
// ---------------------------------------------------------------------------

describe('2.1.307 B3 renderSessionRecoveryResultText', () => {
  test('renders the may-have-run variant verbatim with the em dash', () => {
    expect(
      renderSessionRecoveryResultText({
        serverName: 'srv',
        error: { mayHaveRun: true, expiryKind: 'connection_closed_http' },
        namesMcpCall: false,
        detail: 'boom',
      }),
    ).toBe(
      'MCP connection to srv closed during the call — send mcp_reconnect, and check whether the tool ran before retrying: boom',
    )
  })

  test('appends the mcp_call suffix when namesMcpCall is set', () => {
    expect(
      renderSessionRecoveryResultText({
        serverName: 'srv',
        error: { mayHaveRun: true, expiryKind: 'connection_closed_http' },
        namesMcpCall: true,
        detail: 'boom',
      }),
    ).toBe(
      'MCP connection to srv closed during the call — send mcp_reconnect, and check whether the tool ran before retrying mcp_call: boom',
    )
  })

  test('renders the call-not-run variant verbatim', () => {
    expect(
      renderSessionRecoveryResultText({
        serverName: 'srv',
        error: { mayHaveRun: false, expiryKind: 'connection_closed_call_not_run' },
        namesMcpCall: false,
        detail: 'MCP server "srv" connection closed before the tool call ran',
      }),
    ).toBe(
      'MCP connection closed before the call ran on srv — send mcp_reconnect and retry: MCP server "srv" connection closed before the tool call ran',
    )
  })

  test('renders the session-expired variant for every other kind', () => {
    for (const expiryKind of [
      'session_expired_404',
      'connection_closed_call_refused',
    ]) {
      expect(
        renderSessionRecoveryResultText({
          serverName: 'srv',
          error: { mayHaveRun: false, expiryKind },
          namesMcpCall: true,
          detail: 'detail',
        }),
      ).toBe(
        'MCP session expired for srv — send mcp_reconnect and retry mcp_call: detail',
      )
    }
  })
})

describe('2.1.307 B3 sanitizeSessionRecoveryText (official Jt)', () => {
  test('returns empty string for non-string input', () => {
    expect(sanitizeSessionRecoveryText(undefined)).toBe('')
    expect(sanitizeSessionRecoveryText(42 as unknown as string)).toBe('')
  })

  test('strips lone surrogates but keeps well-formed pairs', () => {
    expect(sanitizeSessionRecoveryText('a\uD800b')).toBe('ab')
    expect(sanitizeSessionRecoveryText('a\uDC00b')).toBe('ab')
    expect(sanitizeSessionRecoveryText('a\u{1F600}b')).toBe('a\u{1F600}b')
  })

  test('strips invisible characters to EMPTY (not space) and keeps normal spaces', () => {
    // U+200B ZERO WIDTH SPACE (Cf), U+00A0 NBSP (non-space Zs), U+2800 braille
    // blank — all stripped; ASCII space preserved.
    expect(sanitizeSessionRecoveryText('a\u200Bb')).toBe('ab')
    expect(sanitizeSessionRecoveryText('a\u00A0b')).toBe('ab')
    expect(sanitizeSessionRecoveryText('a\u2800b')).toBe('ab')
    expect(sanitizeSessionRecoveryText('a b')).toBe('a b')
  })

  test('pre-slices at 4096 and truncates to 1024 display length', () => {
    // Arrange — 5000 chars: slice(0,4096) then truncateToDisplayLength(_,1024).
    const input = 'x'.repeat(5000)

    // Act
    const result = sanitizeSessionRecoveryText(input)

    // Assert
    expect(result).toBe('x'.repeat(1024))
    expect(sanitizeSessionRecoveryText('y'.repeat(1024))).toBe('y'.repeat(1024))
  })

  test('sanitizes both the server name and the detail inside the renderer', () => {
    expect(
      renderSessionRecoveryResultText({
        serverName: 'sr\u200Bv',
        error: { mayHaveRun: false, expiryKind: 'session_expired_404' },
        namesMcpCall: false,
        detail: 'de\u00A0tail',
      }),
    ).toBe(
      'MCP session expired for srv — send mcp_reconnect and retry: detail',
    )
  })
})
