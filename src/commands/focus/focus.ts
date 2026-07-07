import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

/**
 * Whether focus view is currently on. Mirrors the official runtime toggle — a
 * module-level flag flipped by /focus. The REPL reads this via isFocusViewEnabled()
 * to switch to the minimal prompt/summary/response layout (fullscreen only).
 */
let focusViewEnabled = false

export function isFocusViewEnabled(): boolean {
  return focusViewEnabled
}

export function setFocusViewEnabled(value: boolean): void {
  focusViewEnabled = value
}

/**
 * Resolve whether the fullscreen renderer is active, mirroring the /tui
 * resolution: the persisted `tui` setting wins, then the env-based fullscreen
 * check (CLAUDE_CODE_NO_FLICKER / USER_TYPE).
 */
function isFullscreenActive(): boolean {
  const setting = getSettings_DEPRECATED().tui
  if (setting === 'fullscreen') return true
  if (setting === 'default') return false
  return isFullscreenEnvEnabled()
}

const NEEDS_FULLSCREEN = [
  'Focus view needs the fullscreen renderer. Run /tui fullscreen to switch',
  '(this restarts and resumes your session), or set CLAUDE_CODE_NO_FLICKER=1 and restart.',
].join(' ')

/**
 * /focus — toggle the focus view.
 *
 * Mirrors the official 2.1.110 /focus command:
 *   - refuses the toggle (and surfaces the /tui fullscreen hint) when the
 *     fullscreen renderer isn't active
 *   - otherwise flips the runtime focus-view flag and reports
 *     "Focus view enabled" / "Focus view disabled"
 *   - logs tengu_focus_command with the new state
 */
export const call: LocalJSXCommandCall = async (onDone, _context, _args) => {
  if (!isFullscreenActive()) {
    onDone(NEEDS_FULLSCREEN, { display: 'system' })
    return null
  }

  focusViewEnabled = !focusViewEnabled
  logEvent('tengu_focus_command', { enabled: focusViewEnabled })
  onDone(
    focusViewEnabled ? 'Focus view enabled' : 'Focus view disabled',
    { display: 'system' },
  )
  return null
}
