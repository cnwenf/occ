import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { feature } from 'src/utils/featureFlags.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { PermissionMode } from './PermissionMode.js'
import { isAutoModeGateEnabled } from './permissionSetup.js'

/**
 * 2.1.296 auto-default nudge (Gap B port).
 *
 * Official surfaces (byte-verified in the official linux-x64 binary):
 * - gate `aMr`: show the nudge when onboarding is complete, the user has not
 *   answered before (`hasSeenAutoDefaultNudge`), GrowthBook `tengu_maple_pier`
 *   is on (default true), the USER settings layer explicitly pins a non-auto
 *   `permissions.defaultMode`, no other settings layer pins defaultMode, and
 *   auto mode is available.
 * - dialog `qhe`: "Make auto mode your default permission mode?" with
 *   accept/decline options; Esc/cancel counts as decline.
 * - resolver `Ckt`/`Tkt`: accept → live-switch to auto + persist
 *   `permissions.defaultMode: "auto"` to userSettings ("switched"); decline →
 *   just set the one-shot config flag ("declined"); accept while the auto gate
 *   is unavailable → "gate_off" WITHOUT setting the flag (so the nudge can
 *   reappear once the gate recovers). Non-gate_off outcomes log
 *   `tengu_auto_default_nudge_resolved {choice, outcome, current_mode}`.
 *
 * Documented OCC divergences (pre-REPL dialog slot has no live REPL context):
 * - No first-turn-activity wait (official `HKt`) — the nudge runs in the
 *   startup dialog sequence instead of mid-session.
 * - No `[auto mode on]` toast on switch — the REPL footer chip shows the new
 *   mode once the REPL mounts.
 * - gate_off degrades to a debug log instead of a warning notification (no
 *   notification host exists before the REPL mounts).
 * - No refusedWithin cooldown (official dialog-queue infra); Esc = decline,
 *   matching the official `onCancel -> at("decline")`.
 * - Auto availability re-checks `isAutoModeGateEnabled()` synchronously at
 *   accept time instead of consulting a live ToolPermissionContext.
 */

/** Official `aMr` checks these layers for a competing defaultMode pin. */
const OTHER_DEFAULT_MODE_SOURCES = [
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

export type AutoDefaultNudgeChoice = 'accept' | 'decline' | 'cancelled'
export type AutoDefaultNudgeOutcome = 'switched' | 'declined' | 'gate_off'

/**
 * Official `kj(ctx)` (auto-mode availability). Pre-REPL there is no
 * ToolPermissionContext yet, so availability = the auto feature is compiled in
 * and the gate (circuit breaker + settings + model support) is enabled.
 */
function isAutoModeAvailable(): boolean {
  return feature('TRANSCRIPT_CLASSIFIER') && isAutoModeGateEnabled()
}

/**
 * Official gate `aMr`. Returns the current user-pinned defaultMode when the
 * nudge should be shown, or null when any gate condition fails.
 */
export function shouldShowAutoDefaultNudge(options: {
  requireOnboarding?: boolean
} = {}): PermissionMode | null {
  const { requireOnboarding = true } = options
  const config = getGlobalConfig()
  if (requireOnboarding && !config.hasCompletedOnboarding) return null
  if (config.hasSeenAutoDefaultNudge) return null
  if (!feature('tengu_maple_pier')) return null

  const userDefaultMode = getSettingsForSource('userSettings')?.permissions
    ?.defaultMode
  const otherLayerPinsDefaultMode = OTHER_DEFAULT_MODE_SOURCES.some(
    source => getSettingsForSource(source)?.permissions?.defaultMode,
  )
  if (
    userDefaultMode &&
    userDefaultMode !== 'auto' &&
    !otherLayerPinsDefaultMode &&
    isAutoModeAvailable()
  ) {
    return userDefaultMode
  }
  return null
}

/** Official `Ae(...hasSeenAutoDefaultNudge...)` — idempotent one-shot write. */
function markNudgeSeen(): void {
  try {
    saveGlobalConfig(current =>
      current.hasSeenAutoDefaultNudge
        ? current
        : { ...current, hasSeenAutoDefaultNudge: true },
    )
  } catch (error) {
    logForDebugging(
      `auto-default-nudge: failed to persist hasSeenAutoDefaultNudge: ${error}`,
    )
  }
}

/**
 * Official `Tkt`: attempt the live switch to auto as the persisted default.
 * Returns 'switched' on success, 'gate_off' when the auto gate is unavailable
 * at accept time (flag deliberately NOT set so the nudge can reappear).
 */
function trySwitchToAutoDefault(): AutoDefaultNudgeOutcome {
  if (isAutoModeAvailable()) {
    const { error } = updateSettingsForSource('userSettings', {
      permissions: { defaultMode: 'auto' },
    })
    if (!error) {
      // Official also emits a `[auto mode on]` toast here; OCC shows the
      // switched mode via the REPL footer chip after mount (see divergences).
      return 'switched'
    }
    logForDebugging(
      `auto-default-nudge: userSettings write failed at accept: ${error.message}`,
    )
  } else {
    logForDebugging(
      'auto-default-nudge: auto gate unavailable at accept time (official shows the auto-mode-unavailable warning notification here)',
    )
  }
  return 'gate_off'
}

/**
 * Official resolver `Ckt`. `cancelled` (dialog dismissed without a choice —
 * not reachable in the official terminal flow, kept for host flexibility)
 * performs NO writes and NO events and returns null.
 */
export async function resolveAutoDefaultNudge(
  choice: AutoDefaultNudgeChoice,
  currentMode: PermissionMode,
): Promise<AutoDefaultNudgeOutcome | null> {
  if (choice === 'cancelled') return null

  const outcome: AutoDefaultNudgeOutcome =
    choice === 'accept' ? trySwitchToAutoDefault() : 'declined'
  if (outcome !== 'gate_off') {
    markNudgeSeen()
  }
  logEvent('tengu_auto_default_nudge_resolved', {
    choice:
      choice as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome:
      outcome as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    current_mode:
      currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return outcome
}
