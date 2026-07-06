// Auto mode state functions — lives in its own module so callers can
// conditionally require() it on feature('TRANSCRIPT_CLASSIFIER').

let autoModeActive = false
let autoModeFlagCli = false
// Set by the async verifyAutoModeGateAccess check when it
// reads a fresh tengu_auto_mode_config.enabled === 'disabled' from GrowthBook.
// Used by isAutoModeGateEnabled() to block SDK/explicit re-entry after kick-out.
let autoModeCircuitBroken = false

// 2.1.193 (G13): timestamp of the most recent auto-mode classifier denial.
// When a previously-denied action is subsequently allowed (user/coordinator
// approval, a new rule, etc.), the caller computes msSinceDeny against this
// and emits tengu_auto_mode_subsequent_approval. Session-scoped: a denial in
// a prior session does not count (no cross-session approval laundering).
let lastAutoModeDenialMs: number | null = null

/** Record the timestamp of an auto-mode denial (called from the deny path). */
export function recordAutoModeDenialTimestamp(ms: number = Date.now()): void {
  lastAutoModeDenialMs = ms
}

/**
 * Return ms since the last auto-mode denial and clear it, or null if there
 * was no prior denial in this session. Called from the allow path to emit
 * tengu_auto_mode_subsequent_approval.
 */
export function takeMsSinceAutoModeDenial(): number | null {
  if (lastAutoModeDenialMs === null) return null
  const delta = Date.now() - lastAutoModeDenialMs
  lastAutoModeDenialMs = null
  return delta
}

export function setAutoModeActive(active: boolean): void {
  autoModeActive = active
}

export function isAutoModeActive(): boolean {
  return autoModeActive
}

export function setAutoModeFlagCli(passed: boolean): void {
  autoModeFlagCli = passed
}

export function getAutoModeFlagCli(): boolean {
  return autoModeFlagCli
}

export function setAutoModeCircuitBroken(broken: boolean): void {
  autoModeCircuitBroken = broken
}

export function isAutoModeCircuitBroken(): boolean {
  return autoModeCircuitBroken
}

export function _resetForTesting(): void {
  autoModeActive = false
  autoModeFlagCli = false
  autoModeCircuitBroken = false
  lastAutoModeDenialMs = null
}
