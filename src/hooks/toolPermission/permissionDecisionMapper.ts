// CC 2.1.288 `Aho` port — the pure permission-decision → telemetry-label
// mapper (OCC-106 #31/#32).
//
// The official 2.1.288 linux-x64 binary computes a single `{decision, source}`
// pair from the resolved permission decision plus the abort signal, ONCE, right
// after the permission decision resolves (`Aho(e,n)` @208819059; `n` is
// `s.abortController.signal.aborted`). That pair then feeds BOTH the headless
// `tool_decision` OTel event and, as the fallback, the `tool.blocked_on_user`
// span ends — replacing the v287 `"unknown"` fallbacks (#31) — and the emit is
// no longer gated on `behavior !== "ask"` (#32).
//
// Official `Aho` (verbatim):
//   function Aho(e,n){switch(e.behavior){
//     case"allow":return{decision:"accept",source:MIt(e.decisionReason,"allow")};
//     case"deny" :return{decision:"reject",source:MIt(e.decisionReason,"deny")};
//     case"ask"  :return{decision:"reject",source:n?"user_abort":"config"}}}
//
// `MIt` (@208818518) is OCC's existing `decisionReasonToOTelSource` and `xho`
// (@208818313) is OCC's `ruleSourceToOTelSource` (both in
// ./sdkPermissionTelemetry.js). This file adds ONLY the missing `Aho` wrapper
// (behavior + aborted) on top of those exports; it does not modify them.
//
// DOCUMENTED OCC DIVERGENCE (CC 2.1.216 #29): a FAILED / INTERRUPTED SDK
// permission-prompt request is labelled decision `abort` (official literal is
// `reject`) and source `user_abort`. It is preserved by routing the deny
// decision through `sdkPermissionDecisionLabel`. OCC never emits the official
// `_Kt` "tool permission request aborted" (@199852507) `other`-branch reason —
// its headless abort path yields `behavior:'deny'` + a `permissionPromptTool`
// reason with `toolResult===undefined`, which `decisionReasonToOTelSource`
// already maps to `user_abort` — so the source path is behaviourally equivalent
// to `MIt` on every live OCC path.

import type { PermissionDecisionReason } from '../../types/permissions.js'
import {
  decisionReasonToOTelSource,
  sdkPermissionDecisionLabel,
} from './sdkPermissionTelemetry.js'

/**
 * The minimal shape `Aho` reads off a resolved permission decision: the
 * behavior discriminant plus the (optional) reason. `PermissionDecision`
 * (allow/ask/deny) is structurally assignable to this.
 */
export interface PermissionDecisionTelemetryInput {
  behavior: 'allow' | 'deny' | 'ask'
  decisionReason?: PermissionDecisionReason
}

/** The `{decision, source}` telemetry label pair produced by `Aho`. */
export interface MappedToolDecision {
  /** OCC's label vocabulary: `accept` / `reject` / `abort` (the last is the
   * CC 2.1.216 #29 interrupted-prompt label; official `Aho` only emits
   * `accept` / `reject`). */
  decision: 'accept' | 'reject' | 'abort'
  /** The OTel `source` label (config, hook, user_permanent, user_temporary,
   * user_reject, user_abort). */
  source: string
}

/**
 * Port of the official `Aho(e,n)`: map a resolved permission decision and the
 * abort flag to the `{decision, source}` telemetry labels used by the headless
 * `tool_decision` event and as the span-end fallback.
 *
 * @param permissionDecision the resolved decision (`behavior` + `decisionReason`)
 * @param aborted `abortController.signal.aborted`, read ONCE by the caller —
 *   only the `ask` branch's SOURCE consults it (official `n?"user_abort":"config"`)
 */
export function mapPermissionDecisionToTelemetry(
  permissionDecision: PermissionDecisionTelemetryInput,
  aborted: boolean,
): MappedToolDecision {
  switch (permissionDecision.behavior) {
    case 'allow':
      // Official: {decision:"accept",source:MIt(e.decisionReason,"allow")}
      return {
        decision: 'accept',
        source: decisionReasonToOTelSource(
          permissionDecision.decisionReason,
          'allow',
        ),
      }
    case 'deny':
      // Official: {decision:"reject",source:MIt(e.decisionReason,"deny")}.
      // OCC CC 2.1.216 #29: a failed/interrupted SDK prompt request is labelled
      // `abort` (not the official literal `reject`); `sdkPermissionDecisionLabel`
      // encapsulates that and still returns `reject` for a genuine denial.
      return {
        decision: sdkPermissionDecisionLabel(
          'deny',
          permissionDecision.decisionReason,
        ),
        source: decisionReasonToOTelSource(
          permissionDecision.decisionReason,
          'deny',
        ),
      }
    case 'ask':
      // Official (verbatim): {decision:"reject",source:n?"user_abort":"config"}.
      // This is the branch the `aborted` flag exists for — the only behavior
      // whose SOURCE depends on it. Newly telemetered by #32 (the v287
      // `behavior !== "ask"` emit gate was removed in v288).
      return {
        decision: 'reject',
        source: aborted ? 'user_abort' : 'config',
      }
  }
}
