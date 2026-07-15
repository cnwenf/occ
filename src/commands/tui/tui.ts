import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { isScreenReaderEnabled } from '../../utils/screenReader.js'

/**
 * Valid /tui renderer values. Mirrors the official `nYo` array — the binary
 * joins these with "|" in its usage hints ("Usage: /tui <default|fullscreen>").
 */
const RENDERERS = ['default', 'fullscreen'] as const
type Renderer = (typeof RENDERERS)[number]

/**
 * Resolve the *effective* current renderer from the merged `tui` setting,
 * falling back to the env-based fullscreen check (CLAUDE_CODE_NO_FLICKER /
 * USER_TYPE). Mirrors the official switch(Rr().tui) → env-fallback resolution.
 */
function getCurrentRenderer(): Renderer {
  const setting = getSettings_DEPRECATED().tui
  if (setting === 'fullscreen') return 'fullscreen'
  if (setting === 'default') return 'default'
  return isFullscreenEnvEnabled() ? 'fullscreen' : 'default'
}

/**
 * /tui — set the terminal UI renderer ("default" | "fullscreen").
 *
 * Saves the `tui` setting to userSettings so it persists across sessions and
 * takes effect on the next session start (the renderer is selected at REPL
 * boot, not hot-swapped). Mirrors the official 2.1.110 /tui command:
 *   - bare invocation lists the current renderer + usage
 *   - unknown value → "Unknown renderer" + usage
 *   - already on the requested renderer → "Already using the X renderer"
 *   - saves via updateSettingsForSource('userSettings', { tui })
 *   - logs tengu_tui_command with from/to/session_age_ms
 *
 * The live renderer switch (restart-and-resume) is not wired here; the setting
 * is saved and applied on the next session. The official falls back to the
 * same "restart Claude Code to apply it" message when the live switch fails.
 */
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  // 2.1.208: screen reader mode always uses the classic renderer, so /tui is
  // a no-op while it is active (binary:
  // `if(K2())return e("Screen-reader mode always uses the classic renderer, so the tui setting has no effect while it is active.",{display:"system"}),null`).
  if (isScreenReaderEnabled()) {
    onDone(
      'Screen-reader mode always uses the classic renderer, so the tui setting has no effect while it is active.',
      { display: 'system' },
    )
    return null
  }
  const trimmed = (args ?? '').trim().toLowerCase()
  const current = getCurrentRenderer()

  if (!trimmed) {
    onDone(
      `Current renderer: ${current}. Usage: /tui <${RENDERERS.join('|')}>`,
      { display: 'system' },
    )
    return null
  }

  if (!RENDERERS.includes(trimmed as Renderer)) {
    onDone(
      `Unknown renderer "${trimmed}". Usage: /tui <${RENDERERS.join('|')}>`,
      { display: 'system' },
    )
    return null
  }

  const target = trimmed as Renderer
  if (target === current) {
    onDone(`Already using the ${target} renderer.`, { display: 'system' })
    return null
  }

  const { error } = updateSettingsForSource('userSettings', { tui: target })
  if (error) {
    onDone(`Failed to save setting: ${error.message}`, { display: 'system' })
    return null
  }

  logEvent('tengu_tui_command', {
    fullscreen: target === 'fullscreen',
    from: current,
    to: target,
    session_age_ms: Math.round(process.uptime() * 1000),
  })

  // The renderer is selected at REPL boot; a live hot-swap is not supported in
  // this build. Tell the user the setting was saved and applies on restart —
  // the same message the official surfaces when its live switch fails.
  onDone(
    `Renderer set to ${target}. The setting was saved; restart Claude Code to apply it.`,
    { display: 'system' },
  )
  return null
}
