import { useEffect } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  PROJECT_TELEMETRY_ENV_NOTICE_KEY,
  PROJECT_TELEMETRY_ENV_NOTICE_TIMEOUT_MS,
  getProjectTelemetryEnvNoticeText,
} from '../../utils/settings/telemetryEnvStatus.js'

/**
 * CC 2.1.282 startup notice — port of the official notification plugin
 * `C7e`/`Nao` (@222520299):
 *
 *   var C7e = {id:"project-telemetry-env", setup:()=>Nao};
 *   function Nao({addNotification:h}) {
 *     if (Lt()) return;                       // remote workspace/session gate
 *     let {ignored:M, turnedOff:E} = etr();
 *     if (M.length === 0 && E.length === 0) return;
 *     h({key:"project-telemetry-env", kind:"warning", text:"This project's
 *        settings set telemetry environment variables. Run /status to see
 *        which ones Claude Code ignored and which turned telemetry off.",
 *        color:"warning", priority:"medium", timeoutMs:15000})
 *   }
 *
 * The official plugin has no `deps` array, so it fires exactly once per
 * session at setup — mirrored here with a mount-only effect. OCC's
 * Notification type has no `kind` field; `color:"warning"` carries the
 * severity, matching the official payload's color. `Lt()` (remote workspace
 * or remote control session) maps to OCC's `getIsRemoteMode()`, the same gate
 * `useSettingsErrors` uses.
 */
export function useProjectTelemetryEnvNotice(): void {
  const { addNotification } = useNotifications()
  // Fire-once startup notice — the official plugin registers with no deps;
  // addNotification is a stable store ref.
  useEffect(() => {
    if (getIsRemoteMode()) {
      return
    }
    const text = getProjectTelemetryEnvNoticeText()
    if (text === null) {
      return
    }
    addNotification({
      key: PROJECT_TELEMETRY_ENV_NOTICE_KEY,
      text,
      color: 'warning',
      priority: 'medium',
      timeoutMs: PROJECT_TELEMETRY_ENV_NOTICE_TIMEOUT_MS,
    })
  }, [])
}
