import * as React from 'react'
import { useEffect } from 'react'
import { useNotifications } from '../../context/notifications.js'
import { logEvent } from '../../services/analytics/index.js'
import { useAppState } from '../../state/AppState.js'
import {
  consumePlanModeBypassNotice,
  PLAN_MODE_BYPASS_NOTICE_DELAY_MS,
  PLAN_MODE_BYPASS_NOTICE_EVENT,
} from '../../utils/permissions/planModeBypassNotice.js'

/**
 * PORT (CC 2.1.299, gap entry #011): one-time plan-mode bypass notice.
 *
 * Null-rendering reactive watcher mirroring the official `vmt` notice spec
 * (deps [permissionMode, isBypassPermissionsModeAvailable, transcript,
 * clock]): when the session enters plan mode while bypass permissions is
 * available, wait the official 800 ms (URo), then surface the byte-exact
 * notice text once per session through OCC's footer notification mechanism.
 * The fire-once latch lives in planModeBypassNotice.ts (session-local, never
 * persisted), so re-entering plan mode later in the same session does not
 * re-fire. Telemetry event `mode_plan_bypass_notice` fires with the notice,
 * matching the official `g(...)` call inside the timeout.
 */
export function PlanModeBypassNotice(): null {
  const { addNotification } = useNotifications()
  const permissionMode = useAppState(s => s.toolPermissionContext.mode)
  const isBypassPermissionsModeAvailable = useAppState(
    s => s.toolPermissionContext.isBypassPermissionsModeAvailable,
  )

  useEffect(() => {
    // Gate cheaply before arming the timer; consumePlanModeBypassNotice
    // re-checks inside the timeout so a stale timer can never double-fire.
    if (permissionMode !== 'plan' || !isBypassPermissionsModeAvailable) {
      return
    }
    const timeoutId = setTimeout(() => {
      const notice = consumePlanModeBypassNotice(
        permissionMode,
        isBypassPermissionsModeAvailable,
      )
      if (notice === null) return
      logEvent(PLAN_MODE_BYPASS_NOTICE_EVENT, {})
      addNotification({
        key: notice.key,
        priority: 'medium',
        text: notice.text,
      })
    }, PLAN_MODE_BYPASS_NOTICE_DELAY_MS)
    return () => clearTimeout(timeoutId)
  }, [permissionMode, isBypassPermissionsModeAvailable, addNotification])

  return null
}
