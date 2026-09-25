/**
 * Denial tracking infrastructure for permission classifiers.
 * Tracks consecutive denials and total denials to determine
 * when to fall back to prompting.
 */

export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

export const DENIAL_LIMITS = {
  maxConsecutive: 3,
  maxTotal: 20,
} as const

export function createDenialTrackingState(): DenialTrackingState {
  return {
    consecutiveDenials: 0,
    totalDenials: 0,
  }
}

export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    ...state,
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  }
}

export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state // No change needed
  return {
    ...state,
    consecutiveDenials: 0,
  }
}

export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}

// ---------------------------------------------------------------------------
// CC 2.1.281 #137: session counter for UNANSWERED dangerous-rm safety
// dialogs. Official binary @201962445 (byte-verified):
//   `var hee=0;function Xyt(){return hee}function n7r(){return hee+=1,hee}
//    function Qje(){hee=0}`
// Incremented when a dangerous-rm auto-deny window expires with no user
// answer (`tengu_safety_check_dialog_auto_denied`); reset to 0 on ANY
// answered dialog (allow, deny, or dismissal — @220028984/@220029626). Once
// the counter reaches config.maxDialogTimeouts the safety dialog stops being
// shown and dangerous removals are denied immediately
// (`tengu_safety_check_dialog_capped`).
//
// Module-level mutable singleton matches the official (`hee`) and OCC's
// autoModeState.ts precedent — unlike the immutable state-object API above,
// this counter is session-scoped, not per-permission-decision.
// ---------------------------------------------------------------------------

let unansweredSafetyDialogsThisSession = 0

/** Official `Xyt()` @201962445 — current unanswered-dialog count. */
export function getUnansweredSafetyDialogCount(): number {
  return unansweredSafetyDialogsThisSession
}

/** Official `n7r()` @201962445 — increments and returns the new count. */
export function incrementUnansweredSafetyDialogs(): number {
  unansweredSafetyDialogsThisSession += 1
  return unansweredSafetyDialogsThisSession
}

/** Official `Qje()` @201962445 — resets the counter (dialog answered). */
export function resetUnansweredSafetyDialogCount(): void {
  unansweredSafetyDialogsThisSession = 0
}
