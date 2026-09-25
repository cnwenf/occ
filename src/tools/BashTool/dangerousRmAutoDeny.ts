/**
 * CC 2.1.281 #137: dangerous-rm auto-deny window.
 *
 * Official binary evidence (v2.1.281 linux-x64 ELF, all byte-verified;
 * zero-hit proofs on v2.1.280 for `tengu_splendid_horizon`,
 * `maxDialogTimeouts`, `tengu_safety_check_dialog_auto_denied`):
 *
 *   - Config key + accessor `p1()` @201961701:
 *     `E3n="tengu_splendid_horizon"`, defaults
 *     `{enabled:!0,showDialog:!0,timeoutMs:120000,maxDialogTimeouts:3}`,
 *     clamp bounds 5000..3600000 ms, maxDialogTimeouts integer 0..100, and
 *     the env kill-switch `CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT` which
 *     forces `enabled:false` (official uses RAW truthiness — any non-empty
 *     value disables, including "0").
 *   - Session counters `hee`/`Xyt`/`n7r`/`Qje` @201962445 — ported in
 *     `src/utils/permissions/denialTracking.ts`.
 *   - Result builder `b0t` @203102345: attaches
 *     `autoDenyWindow:VFt({autoDenyAfterMs,resolution})` (@202939624) to the
 *     safety-check ask; immediate `$0t` deny when a dialog cannot be shown;
 *     capped immediate deny (with the "gone unanswered N times" sentence and
 *     `tengu_safety_check_dialog_capped`) once maxDialogTimeouts is reached.
 *   - Dialog-layer timer `oo` @220031905: an unanswered window expiry
 *     resolves the pre-built deny, increments the session counter (`n7r()`)
 *     and emits `tengu_safety_check_dialog_auto_denied` with
 *     `unansweredThisSession`; ANY answered dialog (allow, deny, or dismiss)
 *     resets the counter (`Qje()` @220028984/@220029626) — `timer.unref?.()`.
 *   - Deny-message builder `$0t` @204142297 — reproduced verbatim below.
 *
 * OCC wiring note: OCC's catastrophic-substitution site (bashPermissions.ts,
 * `findCatastrophicSubstitutionBlock`) denies immediately instead of opening
 * a safety dialog, and OCC's dialog layer does not yet consume auto-deny
 * windows — so the live path takes the official's cannot-prompt deny branch
 * (the `$0t` text covers both cases: "the permission prompt timed out, or
 * this session cannot prompt"). `resolveDangerousRmSafetyCheck` +
 * `startDangerousRmAutoDenyTimer` are the faithful, unit-tested mechanism
 * (official `b0t` + `oo` semantics) ready for dialog-layer adoption.
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { PermissionDenyDecision } from '../../types/permissions.js'
import {
  getUnansweredSafetyDialogCount,
  incrementUnansweredSafetyDialogs,
  resetUnansweredSafetyDialogCount,
} from '../../utils/permissions/denialTracking.js'

/** Official `E3n` @201961701 — remote-config key (default-on). */
export const DANGEROUS_RM_AUTO_DENY_CONFIG_KEY = 'tengu_splendid_horizon'

/** Official env kill-switch @201961862 — any non-empty value disables. */
export const DANGEROUS_RM_TIMEOUT_KILL_SWITCH_ENV_VAR =
  'CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT'

/** Official `gee` @201961701 defaults. */
export const DANGEROUS_RM_AUTO_DENY_DEFAULTS = {
  enabled: true,
  showDialog: true,
  timeoutMs: 120_000,
  maxDialogTimeouts: 3,
} as const

/** Official `C3n` @201961750 — minimum accepted remote timeoutMs. */
export const DANGEROUS_RM_TIMEOUT_MS_MIN = 5_000
/** Official `x3n` @201961757 — maximum accepted remote timeoutMs. */
export const DANGEROUS_RM_TIMEOUT_MS_MAX = 3_600_000
/** Official `R3n` @201961765 — maximum accepted remote maxDialogTimeouts. */
export const DANGEROUS_RM_MAX_DIALOG_TIMEOUTS_LIMIT = 100
/** Official maxDialogTimeouts lower bound (integer, >= 0) @201962090. */
export const DANGEROUS_RM_MAX_DIALOG_TIMEOUTS_FLOOR = 0

/** Official `promptSurface:b("terminal")` in the auto-deny telemetry @220032338. */
export const DANGEROUS_RM_AUTO_DENY_PROMPT_SURFACE = 'terminal'

export type DangerousRmAutoDenyConfig = {
  enabled: boolean
  showDialog: boolean
  timeoutMs: number
  maxDialogTimeouts: number
}

/** Official `VFt({autoDenyAfterMs,resolution})` @202939624 window shape. */
export type DangerousRmAutoDenyWindow = {
  autoDenyAfterMs: number
  autoDenyResolution: PermissionDenyDecision
}

export type DangerousRmSafetyCheckResolution =
  | { kind: 'deny'; decision: PermissionDenyDecision }
  | {
      kind: 'prompt-with-auto-deny-window'
      window: DangerousRmAutoDenyWindow
    }

/**
 * Official `$0t` @204142297 — verbatim deny message for dangerous removals
 * that no person approved (prompt timed out, session cannot prompt, or the
 * unanswered-dialog cap was reached). `unansweredCount` adds the official's
 * capped-dialog sentence (passed only on the capped path, mirroring `h(_)`).
 */
export function buildDangerousRmAutoDenyMessage(
  flaggedText: string,
  unansweredCount?: number,
): string {
  return (
    'Permission for this command was denied by a built-in Claude Code safety check, not by the user. The check stops removals that can delete far more than intended: a system, home or workspace directory, or a target it cannot resolve, such as a shell variable that, if unset or empty, turns this into `rm -rf /` or `rm -rf /*`. Only a person may approve such a removal, and no person did (the permission prompt timed out, or this session cannot prompt). ' +
    (unansweredCount !== undefined
      ? `The prompt for such removals has already gone unanswered ${unansweredCount} times in this session, so it was not shown again. `
      : '') +
    `The command was NOT run; do not claim it succeeded. Do not work around the check by splitting, scripting, or re-issuing the removal through another tool or shell: the check exists because a removal like this can destroy the user's data, and getting past it would not make it safe. If the text below suggests a safe rewrite, run that instead; it goes through the same check. Otherwise finish the rest of the task without this removal, tell the user what you wanted to delete and why, and leave the removal to them. What was flagged: ${flaggedText}`
  )
}

/**
 * Pure config resolution — official `p1()` validation logic @201961701.
 * Split out from the env/remote reads so the clamping is unit-testable.
 *
 * Divergence note: the official additionally requires the remote value's
 * source to be the GrowthBook payload (`n==="payload"`) before honoring a
 * remote `enabled` override; OCC's `getFeatureValue_CACHED_MAY_BE_STALE`
 * does not expose the value's source, so any override resolved through it
 * (env override / config override / remote payload / disk cache) is treated
 * as authoritative.
 */
export function resolveDangerousRmAutoDenyConfig(
  remoteValue: unknown,
  killSwitchActive: boolean,
): DangerousRmAutoDenyConfig {
  const remote = (
    typeof remoteValue === 'object' && remoteValue !== null ? remoteValue : {}
  ) as Record<string, unknown>
  const timeoutMs = remote.timeoutMs
  const maxDialogTimeouts = remote.maxDialogTimeouts
  return {
    enabled: killSwitchActive
      ? false
      : typeof remote.enabled === 'boolean'
        ? remote.enabled
        : DANGEROUS_RM_AUTO_DENY_DEFAULTS.enabled,
    showDialog:
      typeof remote.showDialog === 'boolean'
        ? remote.showDialog
        : DANGEROUS_RM_AUTO_DENY_DEFAULTS.showDialog,
    timeoutMs:
      typeof timeoutMs === 'number' &&
      Number.isFinite(timeoutMs) &&
      timeoutMs >= DANGEROUS_RM_TIMEOUT_MS_MIN &&
      timeoutMs <= DANGEROUS_RM_TIMEOUT_MS_MAX
        ? timeoutMs
        : DANGEROUS_RM_AUTO_DENY_DEFAULTS.timeoutMs,
    maxDialogTimeouts:
      typeof maxDialogTimeouts === 'number' &&
      Number.isInteger(maxDialogTimeouts) &&
      maxDialogTimeouts >= DANGEROUS_RM_MAX_DIALOG_TIMEOUTS_FLOOR &&
      maxDialogTimeouts <= DANGEROUS_RM_MAX_DIALOG_TIMEOUTS_LIMIT
        ? maxDialogTimeouts
        : DANGEROUS_RM_AUTO_DENY_DEFAULTS.maxDialogTimeouts,
  }
}

/** Official `p1()` @201961701 — env kill-switch + remote config + defaults. */
export function getDangerousRmAutoDenyConfig(): DangerousRmAutoDenyConfig {
  return resolveDangerousRmAutoDenyConfig(
    getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
      DANGEROUS_RM_AUTO_DENY_CONFIG_KEY,
      undefined,
    ),
    // Official uses raw truthiness (`a.CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT?!1:…`)
    // — deliberately NOT isEnvTruthy: any non-empty value disables, even "0".
    Boolean(process.env[DANGEROUS_RM_TIMEOUT_KILL_SWITCH_ENV_VAR]),
  )
}

/**
 * Official `b0t` @203102345 — decide how a flagged dangerous removal is
 * resolved:
 *   - feature disabled (kill-switch / remote) → the caller's pre-2.1.281 deny,
 *     unchanged;
 *   - dialog cannot be shown (headless, prompts suppressed, showDialog off) →
 *     immediate `$0t` deny without the unanswered-count sentence;
 *   - unanswered-dialog cap reached → immediate `$0t` deny WITH the count
 *     sentence + `tengu_safety_check_dialog_capped`;
 *   - otherwise → a prompt carrying the auto-deny window (official
 *     `autoDenyWindow:VFt({autoDenyAfterMs,resolution})`).
 *
 * The official capped telemetry also carries `circuitBreaker`; OCC has no
 * circuit-breaker field on this path, so it is omitted.
 */
export function resolveDangerousRmSafetyCheck(params: {
  flaggedText: string
  canShowDialog: boolean
  config: DangerousRmAutoDenyConfig
  legacyDeny: PermissionDenyDecision
  permissionMode?: string
}): DangerousRmSafetyCheckResolution {
  const { flaggedText, canShowDialog, config, legacyDeny, permissionMode } =
    params

  if (!config.enabled) {
    return { kind: 'deny', decision: legacyDeny }
  }

  const buildDeny = (unansweredCount?: number): PermissionDenyDecision => ({
    behavior: 'deny',
    message: buildDangerousRmAutoDenyMessage(flaggedText, unansweredCount),
    decisionReason: legacyDeny.decisionReason,
  })

  // Official: `if(!s.showDialog||!A0t(r))return h()` — cannot-prompt deny.
  if (!config.showDialog || !canShowDialog) {
    return { kind: 'deny', decision: buildDeny() }
  }

  const unanswered = getUnansweredSafetyDialogCount()
  if (config.maxDialogTimeouts > 0 && unanswered >= config.maxDialogTimeouts) {
    logEvent('tengu_safety_check_dialog_capped', {
      permissionMode: (permissionMode ??
        'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      unansweredPrompts: unanswered,
      maxDialogTimeouts: config.maxDialogTimeouts,
    })
    // Official passes the current count so `$0t` includes the
    // "gone unanswered ${n} times … not shown again" sentence (`h(_)`).
    return { kind: 'deny', decision: buildDeny(unanswered) }
  }

  return {
    kind: 'prompt-with-auto-deny-window',
    window: {
      autoDenyAfterMs: config.timeoutMs,
      autoDenyResolution: buildDeny(),
    },
  }
}

/**
 * Official dialog-layer timer `oo(S,L)` @220031905 — races the user's answer
 * against the auto-deny window:
 *   - window expires unanswered → increments the session counter (`n7r()`),
 *     emits `tengu_safety_check_dialog_auto_denied` (with
 *     `unansweredThisSession`, `timeoutMs`, `elapsedMs`, `promptSurface:
 *     "terminal"`, `isMcp:false`), and resolves the pre-built `$0t` deny;
 *   - dialog answered first (allow, deny, or dismiss) → clears the timer and
 *     resets the session counter (`Qje()` @220028984), resolving `'answered'`.
 *
 * The official also emits the `permission_safety_check_timed_dialog`
 * growthbook-style log (`autoDenied:!0/!1`); OCC's analytics surface only has
 * logEvent, so the tengu_* events are the ported telemetry. `timer.unref?.()`
 * matches the official — an unanswered prompt must never hold the process up.
 */
export function startDangerousRmAutoDenyTimer(params: {
  window: DangerousRmAutoDenyWindow
  answered: Promise<'allow' | 'deny'>
  toolName: string
  permissionMode?: string
}): Promise<PermissionDenyDecision | 'answered'> {
  const startedAtMs = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const unansweredThisSession = incrementUnansweredSafetyDialogs()
      logEvent('tengu_safety_check_dialog_auto_denied', {
        toolName:
          params.toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        isMcp: false,
        permissionMode: (params.permissionMode ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        promptSurface:
          DANGEROUS_RM_AUTO_DENY_PROMPT_SURFACE as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        timeoutMs: params.window.autoDenyAfterMs,
        elapsedMs: Date.now() - startedAtMs,
        unansweredThisSession,
      })
      resolve(params.window.autoDenyResolution)
    }, params.window.autoDenyAfterMs)
    timer.unref?.()

    const onAnswered = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Official resets on ANY answered dialog (allow @220028984, deny
      // @220029626, dismissal path) when an autoDenyWindow was attached.
      resetUnansweredSafetyDialogCount()
      resolve('answered')
    }
    // A rejected `answered` promise means the dialog went away (dismissed /
    // aborted) — the official treats a dismissal as an answered dialog.
    void params.answered.then(onAnswered, onAnswered)
  })
}
