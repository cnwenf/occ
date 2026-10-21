/**
 * CC 2.1.305 (/usage one-line fixes): OCC adaptation of the official `vYe`
 * effort-state resolver (v306 binary @256635621 region):
 *
 *   vYe(e,t,n) → {
 *     isEffortBelowMaxSaved: r!==void 0,            // r = saved setting
 *     effortBelowMax: ZS(e,t)!=="max" ? void 0      // t = current effective
 *                     : typeof i==="string"&&i!=="max" ? i : "high",
 *     isEffortSwitchFree: ALo(e)&&uA()===void 0,    // model ok, no override
 *     isUltracodeOn: bm(n,e),
 *   }
 *
 * OCC adaptation notes:
 *   - The official resolves the CURRENT effective effort per model
 *     (`ZS(e,t)`, model-aware). The non-interactive /usage path has no
 *     model/session context, so the effective level is resolved as
 *     env-override → saved setting (the same precedence head as
 *     resolveAppliedEffort, minus the model default — an unknown model
 *     default can never read as "max" spuriously; worst case the
 *     recommendation is the generic "Save max effort for hard tasks").
 *   - `isEffortSwitchFree` (official: model supports effort AND no
 *     session/turn override `uA()`) maps to "no CLAUDE_CODE_EFFORT_LEVEL
 *     pin": an env pin (including explicit 'unset'/'auto' → null) would
 *     override any /effort switch on the next turn, so the switch is only
 *     "free" when the env is not set at all.
 *   - `isUltracodeOn` → isUltracodeEnabled() (src/utils/effort/ultracode.ts).
 */
import { getEffortEnvOverride, getInitialEffortSetting } from '../../utils/effort.js'
import { isUltracodeEnabled } from '../../utils/effort/ultracode.js'
import type { UsageEffortState } from './usageRecommendations.js'

/** Official `vYe` — effort state feeding the max_effort recommendation. */
export function computeUsageEffortState(): UsageEffortState {
  const saved = getInitialEffortSetting()
  const envOverride = getEffortEnvOverride()
  const envLevel = typeof envOverride === 'string' ? envOverride : undefined
  const current = envLevel ?? saved
  return {
    isEffortBelowMaxSaved: saved !== undefined,
    effortBelowMax:
      current === 'max'
        ? typeof saved === 'string' && saved !== 'max'
          ? saved
          : 'high'
        : undefined,
    isEffortSwitchFree: envOverride === undefined,
    isUltracodeOn: isUltracodeEnabled(),
  }
}
