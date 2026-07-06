import { isFirstPartyAnthropicBaseUrl } from '../model/providers.js'
import { isEnvTruthy } from '../envUtils.js'

// Mirrors the official 2.1.200 distributed trace linking (U1t/Jc):
// traceparent/tracestate are forwarded to the API when the client is talking
// to a first-party Anthropic endpoint, or when CLAUDE_CODE_PROPAGATE_TRACEPARENT
// is explicitly set.
export function shouldPropagateTraceparent(): boolean {
  // Jc(): _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL || wwn()
  if (isFirstPartyAnthropicBaseUrl()) {
    return true
  }
  return isEnvTruthy(process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT)
}

// The incoming W3C trace context from the environment (set by a parent
// process). Returns undefined when no TRACEPARENT is present.
export function getIncomingTraceContext(): {
  traceparent: string
  tracestate?: string
} | undefined {
  const traceparent = process.env.TRACEPARENT
  if (!traceparent) return undefined
  const tracestate = process.env.TRACESTATE
  return tracestate ? { traceparent, tracestate } : { traceparent }
}
