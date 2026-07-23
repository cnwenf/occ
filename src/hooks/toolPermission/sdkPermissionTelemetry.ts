// SDK / headless permission-prompt telemetry classification.
//
// Centralizes the mapping from a PermissionDecisionReason + behavior to the
// OTel `source` label and `decision` label used by the headless
// `tool_decision` event and the `tengu_tool_use_can_use_tool_rejected`
// analytics event. Extracted from toolExecution.ts so the categorization is
// unit-testable without pulling in the full tool-execution dependency graph.
//
// CC 2.1.216 #29 — telemetry misreporting permission denials:
//   - A permission-prompt REQUEST that FAILED (no host response, or the host
//     signaled an interrupt) must NOT be telemetered as a user rejection.
//   - A user INTERRUPT is reported as a user ABORT, not a rejection.
//   - A genuine host-issued deny (real user rejection) is unchanged.

import type { PermissionDecisionReason } from '../../types/permissions.js'

/**
 * Map a rule's origin to the documented OTel `source` vocabulary, matching
 * the interactive path's semantics (permissionLogging.ts): session-scoped
 * grants are temporary, on-disk grants are permanent, and user-authored
 * denies are user_reject regardless of persistence. Everything the user
 * didn't write (cliArg, policySettings, projectSettings, flagSettings) is
 * config.
 */
export function ruleSourceToOTelSource(
  ruleSource: string,
  behavior: 'allow' | 'deny',
): string {
  switch (ruleSource) {
    case 'session':
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    case 'localSettings':
    case 'userSettings':
      return behavior === 'allow' ? 'user_permanent' : 'user_reject'
    default:
      return 'config'
  }
}

// Shape of the SDK host's permission-prompt tool result. `toolResult` is
// `unknown` on PermissionDecisionReason; narrow at runtime rather than widen
// the cross-file type.
type PermissionPromptToolResult = {
  behavior?: string
  interrupt?: boolean
  decisionClassification?: string
}

/**
 * Returns true when a deny is the result of a failed/aborted permission-prompt
 * REQUEST rather than a genuine user rejection — i.e. the host never produced
 * a usable response (`toolResult` undefined, the request failed/aborted) OR
 * the host explicitly flagged the deny as an interrupt. CC 2.1.216 #29.
 */
export function isSdkPermissionAbort(
  reason: PermissionDecisionReason | undefined,
): boolean {
  if (reason?.type !== 'permissionPromptTool') return false
  const result = reason.toolResult as PermissionPromptToolResult | undefined
  // No host response at all (request failed / aborted) → not a rejection.
  if (result === undefined) return true
  // Host explicitly signaled an interrupt → user abort, not rejection.
  if (result.interrupt === true) return true
  return false
}

/**
 * Map a PermissionDecisionReason to the OTel `source` label for the
 * non-interactive tool_decision path, staying within the documented
 * vocabulary (config, hook, user_permanent, user_temporary, user_reject,
 * user_abort).
 *
 * For permissionPromptTool, the SDK host may set decisionClassification on
 * the PermissionResult to tell us exactly what happened (once vs always vs
 * cache hit — the host knows, we can't tell from {behavior:'allow'} alone).
 * Without it, we fall back conservatively: allow → user_temporary,
 * deny → user_reject — EXCEPT a failed/interrupted prompt request which is
 * reported as user_abort (CC 2.1.216 #29).
 */
export function decisionReasonToOTelSource(
  reason: PermissionDecisionReason | undefined,
  behavior: 'allow' | 'deny',
): string {
  if (!reason) {
    return 'config'
  }
  switch (reason.type) {
    case 'permissionPromptTool': {
      const toolResult = reason.toolResult as
        | PermissionPromptToolResult
        | undefined
      const classified = toolResult?.decisionClassification
      if (
        classified === 'user_temporary' ||
        classified === 'user_permanent' ||
        classified === 'user_reject'
      ) {
        return classified
      }
      // CC 2.1.216 #29: a failed/interrupted prompt request is an abort, not
      // a user rejection. Only a genuine host-issued deny (with a real
      // response and no interrupt) counts as user_reject.
      if (isSdkPermissionAbort(reason)) {
        return 'user_abort'
      }
      return behavior === 'allow' ? 'user_temporary' : 'user_reject'
    }
    case 'rule':
      return ruleSourceToOTelSource(reason.rule.source, behavior)
    case 'hook':
      return 'hook'
    case 'mode':
    case 'classifier':
    case 'subcommandResults':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return 'config'
    default: {
      const _exhaustive: never = reason
      return 'config'
    }
  }
}

/**
 * The OTel `decision` label for the non-interactive permission path:
 * 'accept' for allow, 'abort' for a failed/interrupted permission-prompt
 * request (CC 2.1.216 #29), and 'reject' for a genuine user denial.
 */
export function sdkPermissionDecisionLabel(
  behavior: 'allow' | 'deny' | 'ask',
  reason: PermissionDecisionReason | undefined,
): 'accept' | 'reject' | 'abort' {
  if (behavior === 'allow') return 'accept'
  if (behavior === 'deny') {
    // A failed/interrupted prompt request is an abort, not a rejection.
    if (isSdkPermissionAbort(reason)) return 'abort'
    return 'reject'
  }
  // 'ask' (no decision reached) — treat as abort; callers only log when
  // behavior !== 'ask', so this is a defensive fallback.
  return 'abort'
}
