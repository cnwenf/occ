import type { PermissionMode } from '../../types/permissions.js'

/**
 * PORT (CC 2.1.299, gap entry #011): one-time plan-mode bypass notice.
 *
 * Official v299 byte-exact references (linux-x64 ELF @101543100-101543286,
 * strings/dd only — never executed):
 *   - notice id: `plan-mode-bypass-notice`
 *   - text (`jRo`): "Session was started with bypass permissions, so plan
 *     mode won't ask before most edits or commands. Start a new session
 *     without bypass permissions for prompts in plan mode."
 *   - delay (`URo`): 800 ms
 *   - mechanism (`vmt`): reactive on deps [permissionMode,
 *     isBypassPermissionsModeAvailable, transcript, clock]; a session-local
 *     `h` flag makes it fire at most ONCE per session (never persisted);
 *     gate `PU(permissionMode, isBypassPermissionsModeAvailable)` = plan
 *     mode while bypass permissions is available; on fire it emits telemetry
 *     `mode_plan_bypass_notice` and appends the notice (non-persisted).
 *
 * OCC divergence (documented): the official appends a non-persisted transcript
 * notice message; OCC surfaces the same text through its existing footer
 * notification mechanism (src/context/notifications.tsx) per the work-package
 * instruction. The official `Fn()` guard (non-interactive check) is implicit:
 * the consuming component only mounts in the interactive REPL footer. The
 * fire-once flag lives in this module (session-local, not persisted), matching
 * the official `h` closure variable.
 */

/** Official notice id — byte-exact. */
export const PLAN_MODE_BYPASS_NOTICE_KEY = 'plan-mode-bypass-notice'

/** Official notice text (`jRo`) — byte-exact. */
export const PLAN_MODE_BYPASS_NOTICE_TEXT =
  "Session was started with bypass permissions, so plan mode won't ask before most edits or commands. Start a new session without bypass permissions for prompts in plan mode."

/** Official delay (`URo` = 800) — byte-exact. */
export const PLAN_MODE_BYPASS_NOTICE_DELAY_MS = 800

/** Official telemetry event name (`g("mode_plan_bypass_notice")`). */
export const PLAN_MODE_BYPASS_NOTICE_EVENT = 'mode_plan_bypass_notice'

/** Session-local fire-once flag (official `h`). Never persisted. */
let noticeShownThisSession = false

/**
 * Official `PU(permissionMode, isBypassPermissionsModeAvailable)` gate:
 * plan mode is only silent-without-prompts when bypass permissions is
 * actually available in this session.
 */
export function shouldShowPlanModeBypassNotice(
  permissionMode: PermissionMode | undefined,
  isBypassPermissionsModeAvailable: boolean | undefined,
): boolean {
  return permissionMode === 'plan' && isBypassPermissionsModeAvailable === true
}

export type PlanModeBypassNotice = {
  readonly key: string
  readonly text: string
}

/**
 * Consume the one-time notice: returns the notice payload exactly once per
 * session when the gate passes, null otherwise (already shown, or gate not
 * met). Calling this marks the notice as shown — callers should only invoke
 * it at the moment they will actually surface the notice (official fires the
 * flag inside the 800 ms timeout, together with the append).
 */
export function consumePlanModeBypassNotice(
  permissionMode: PermissionMode | undefined,
  isBypassPermissionsModeAvailable: boolean | undefined,
): PlanModeBypassNotice | null {
  if (noticeShownThisSession) return null
  if (
    !shouldShowPlanModeBypassNotice(
      permissionMode,
      isBypassPermissionsModeAvailable,
    )
  ) {
    return null
  }
  noticeShownThisSession = true
  return {
    key: PLAN_MODE_BYPASS_NOTICE_KEY,
    text: PLAN_MODE_BYPASS_NOTICE_TEXT,
  }
}

/** Test seam: reset the session-local fire-once flag. */
export function resetPlanModeBypassNoticeForTesting(): void {
  noticeShownThisSession = false
}
