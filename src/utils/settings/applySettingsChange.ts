import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { getEffortEnvOverride, modelSupportsEffort } from '../effort.js'
import { clampEffortToCap } from '../effort/cap.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { getMainLoopModel } from '../model/model.js'
import {
  createDisabledBypassPermissionsContext,
  findOverlyBroadBashPermissions,
  isBypassPermissionsModeDisabled,
  removeDangerousPermissions,
  transitionPlanAutoMode,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

/**
 * Apply a settings change to app state. Re-reads settings from disk,
 * reloads permissions and hooks, and pushes the new state.
 *
 * Used by both the interactive path (AppState.tsx via useSettingsChange) and
 * the headless/SDK path (print.ts direct subscribe) so that managed-settings
 * / policy changes are fully applied in both modes.
 *
 * The settings cache is reset by the notifier (changeDetector.fanOut) before
 * listeners are iterated, so getInitialSettings() here reads fresh disk
 * state. Previously this function reset the cache itself, which — combined
 * with useSettingsChange's own reset — caused N disk reloads per notification
 * for N subscribers.
 *
 * Side-effects like clearing auth caches and applying env vars are handled by
 * `onChangeAppState` which fires when `settings` changes in state.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (f: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()

  logForDebugging(`Settings changed from ${source}, updating app state`)

  const updatedRules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()

  setAppState(prev => {
    let newContext = syncPermissionRulesFromDisk(
      prev.toolPermissionContext,
      updatedRules,
    )

    // Ant-only: re-strip overly broad Bash allow rules after settings sync
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent'
    ) {
      const overlyBroad = findOverlyBroadBashPermissions(updatedRules, [])
      if (overlyBroad.length > 0) {
        newContext = removeDangerousPermissions(newContext, overlyBroad)
      }
    }

    if (
      newContext.isBypassPermissionsModeAvailable &&
      isBypassPermissionsModeDisabled()
    ) {
      newContext = createDisabledBypassPermissionsContext(newContext)
    }

    newContext = transitionPlanAutoMode(newContext)

    // Sync effortLevel from settings to top-level AppState when it changes
    // (e.g. via applyFlagSettings from IDE). Only propagate if the setting
    // itself changed — otherwise unrelated settings churn (e.g. tips dismissal
    // on startup) would clobber a --effort CLI flag value held in AppState.
    const prevEffort = prev.settings.effortLevel
    const newEffort = newSettings.effortLevel
    const effortChanged = prevEffort !== newEffort

    // OCC-82 (official 2.1.267 `oRt`): when a settings change syncs an
    // effortLevel into AppState, it is clamped to the effective cap for the
    // current model — an out-of-band settings write (managed/policy/IDE) can
    // never lift effort above the cap.
    //
    // Review P3 fix — official leading gates `if(!Nh(e)||DP()!==void 0)return`:
    // when the model does NOT support effort, or a CLAUDE_CODE_EFFORT_LEVEL
    // override is present, oRt writes NOTHING (the env/resolve path owns the
    // effective value; writing effortValue here would let AppState/SDK
    // subscribers read a value that differs from the applied one). The
    // official's pinning/org-default branches (`uF`/`uxe`→`LP`) are N/A in
    // OCC (no launch-pin subsystem §5.4, no org registry §5.1 — see
    // docs/upstream-version-gap-occ82.md).
    const effortSyncModel = getMainLoopModel()
    const effortSyncBlocked =
      !modelSupportsEffort(effortSyncModel) ||
      getEffortEnvOverride() !== undefined
    const clampedEffort =
      effortSyncBlocked || newEffort === undefined
        ? undefined
        : clampEffortToCap(newEffort, effortSyncModel)

    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext: newContext,
      // Only propagate a defined new value — when the disk key is absent
      // (e.g. /effort max for non-ants writes undefined; --effort CLI flag),
      // prev.settings.effortLevel can be stale (internal writes suppress the
      // watcher that would resync AppState.settings), so effortChanged would
      // be true and we'd wipe a session-scoped value held in effortValue.
      ...(effortChanged && clampedEffort !== undefined
        ? { effortValue: clampedEffort }
        : {}),
    }
  })
}
