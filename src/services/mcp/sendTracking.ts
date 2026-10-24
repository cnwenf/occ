/**
 * claude-code 2.1.307 PORT B3 — MCP tool-call send tracking.
 *
 * Byte-verified port of the official 2.1.307 linux ELF symbols (never
 * executed):
 *  - `Amo` @278908635 — the rejection-code set. A send rejected with one of
 *    these errno/socket codes never reached the server, so the call
 *    definitively ran nothing.
 *  - `rNn(transport, isSessionExpiredError, activeCallWatchdogs)` — wraps
 *    `transport.send` so every `tools/call` send is counted; when a send
 *    rejects with a rejection code (official `E(w)` = errno extraction) or a
 *    session-expired error, its sequence number is recorded in `ranNothing`
 *    and the uniquely-matching in-flight watchdog (matched via
 *    `params._meta["claudecode/toolUseId"]`) gets `ownSends.ranNothing++`.
 *  - `oNn(tracker, baselineStarted, ownSends)` — "did EVERY send since this
 *    call's baseline run nothing?" Prefers the call's own watchdog counts
 *    when it recorded any send; otherwise falls back to the shared tracker
 *    filtered by sequence number (official `F(e.ranNothing,(a)=>a>n)===s`).
 *
 * Consumed by client.ts: wired at connect success for http/claudeai-proxy
 * servers (official `fe.toolCallSends=rNn(Z.transport,so,fe.activeCallWatchdogs)`)
 * and read at the session-expiry throw site to pick the `expiryKind`
 * (`connection_closed_call_not_run` vs `connection_closed_http`) — which in
 * turn decides whether the tool call may be retried.
 */
import { getErrnoCode } from '../../utils/errors.js'

/**
 * Official `Amo` — verbatim rejection-code set. These are transport-level
 * connect/socket failures: the request never went out, so nothing ran.
 */
export const SEND_REJECTION_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ConnectionRefused',
  'ENOTFOUND',
  'EAI_AGAIN',
  'FailedToOpenSocket',
  'ERR_PROXY_TUNNEL',
])

/** Official `s={started:0,ranNothing:[]}` — shared per-connection tracker. */
export interface ToolCallSendCounts {
  started: number
  /** Sequence numbers (`++started` at send time) of sends that ran nothing. */
  ranNothing: number[]
}

/** Official per-call `ownSends:{started:0,ranNothing:0}` counts. */
export interface ToolCallOwnSends {
  started: number
  ranNothing: number
}

/**
 * Official per-call watchdog `Z={armedAt:0,offCriticalPath:C,toolUseId:...,
 * ownSends:{started:0,ranNothing:0}}`. OCC has no watchdog-timer /
 * off-critical-path machinery, so `armedAt` stays 0 and `offCriticalPath`
 * stays false at the arm site; both fields are kept for shape parity.
 */
export interface ToolCallWatchdog {
  armedAt: number
  offCriticalPath: boolean
  toolUseId?: string
  ownSends?: ToolCallOwnSends
  /**
   * CC 2.1.310 (#12) — official `openQuestions` (BIN310 elicitation handler
   * @275511304): incremented when the server opens an elicitation question
   * while this watchdog is the ONLY active call (`$n.length===1` attribution
   * guard), decremented in the handler's `finally`. Read at the tool-call
   * timeout as `(rt.openQuestions??0)>0` to arm the question-unanswered
   * message + the `mcp_question_unanswered` error class.
   */
  openQuestions?: number
}

/** Minimal structural view of the SDK transport (only `send` is wrapped). */
export interface SendTrackingTransport {
  send: (message: unknown, options?: unknown) => Promise<void>
}

/**
 * Official `rNn` — wrap `transport.send` to count `tools/call` sends and
 * record which of them definitively ran nothing.
 *
 * Verbatim official logic: non-`tools/call` (or non-object) messages pass
 * straight through uncounted; the toolUseId is read from
 * `params._meta["claudecode/toolUseId"]`; ALL watchdogs with that toolUseId
 * get `ownSends.started++`, but only a UNIQUE match also gets
 * `ownSends.ranNothing++` on a ran-nothing rejection; the rejection is
 * always rethrown.
 */
export function trackToolCallSends(
  transport: SendTrackingTransport,
  isSessionExpiredError: (error: Error) => boolean,
  activeCallWatchdogs: ReadonlySet<ToolCallWatchdog>,
): ToolCallSendCounts {
  const counts: ToolCallSendCounts = { started: 0, ranNothing: [] }
  const originalSend = transport.send.bind(transport)
  transport.send = (message: unknown, options?: unknown) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      !('method' in message) ||
      (message as { method?: unknown }).method !== 'tools/call'
    ) {
      return originalSend(message, options)
    }
    const sequence = ++counts.started
    const params = 'params' in message
      ? (message as { params?: unknown }).params
      : undefined
    const paramsMeta =
      typeof params === 'object' && params !== null && '_meta' in params
        ? (params as { _meta?: unknown })._meta
        : undefined
    const toolUseIdMeta =
      typeof paramsMeta === 'object' &&
      paramsMeta !== null &&
      'claudecode/toolUseId' in paramsMeta
        ? (paramsMeta as Record<string, unknown>)['claudecode/toolUseId']
        : undefined
    const matching =
      typeof toolUseIdMeta === 'string'
        ? [...activeCallWatchdogs].filter(w => w.toolUseId === toolUseIdMeta)
        : []
    for (const match of matching) {
      if (match.ownSends !== undefined) {
        match.ownSends.started++
      }
    }
    const ownSends = matching.length === 1 ? matching[0]?.ownSends : undefined
    return originalSend(message, options).catch((error: unknown) => {
      if (
        SEND_REJECTION_CODES.has(getErrnoCode(error) ?? '') ||
        (error instanceof Error && isSessionExpiredError(error))
      ) {
        counts.ranNothing.push(sequence)
        if (ownSends !== undefined) {
          ownSends.ranNothing++
        }
      }
      throw error
    })
  }
  return counts
}

/**
 * Official `oNn` — true when every tools/call send since `baselineStarted`
 * definitively ran nothing (so the failed call cannot have run server-side).
 *
 * `F(e.ranNothing,(a)=>a>n)===s` = the count of ranNothing sequence numbers
 * strictly greater than the baseline must equal the number of sends started
 * after the baseline.
 */
export function allSendsRanNothing(
  tracker: ToolCallSendCounts | undefined,
  baselineStarted: number | undefined,
  ownSends: ToolCallOwnSends | undefined,
): boolean {
  if (ownSends !== undefined && ownSends.started > 0) {
    return ownSends.ranNothing === ownSends.started
  }
  if (tracker === undefined || baselineStarted === undefined) {
    return false
  }
  const startedAfterBaseline = tracker.started - baselineStarted
  return (
    startedAfterBaseline > 0 &&
    tracker.ranNothing.filter(sequence => sequence > baselineStarted).length ===
      startedAfterBaseline
  )
}

/**
 * Official `fe` — per-connection state shared by the transport close path
 * (`closeReason`), the send tracker (`toolCallSends`), and in-flight tool
 * calls (`activeCallWatchdogs`).
 */
export interface McpConnectionState {
  closeReason?: string
  toolCallSends?: ToolCallSendCounts
  activeCallWatchdogs: Set<ToolCallWatchdog>
}
