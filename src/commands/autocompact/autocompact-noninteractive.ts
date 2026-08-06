/**
 * Non-interactive (-p) variant of /autocompact — ported from official
 * Claude Code 2.1.221+ (OCC-58; silent addition, no changelog entry).
 * Registration metadata and every user-facing string are byte-verified
 * from the 2.1.223 linux-x64 ELF (`e$_` entrypoint + `MEr` setter):
 *
 *   /autocompact            -> current window description (ZO_)
 *   /autocompact <value>    -> parse + persist to userSettings
 *                              (auto|reset|unset|default clear the override)
 *
 * Precedence mirrors the official `S3` resolver as far as OCC surfaces go:
 * env CLAUDE_CODE_AUTO_COMPACT_WINDOW > settings autoCompactWindow > auto.
 * The server-driven "experiment"/"clientdata" window sources are
 * Anthropic-backend-bound and stay staged (gap doc §4).
 */
import {
  getIsNonInteractiveSession,
  getSdkBetas,
} from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  parseAutoCompactWindowInput,
  type AutoCompactWindowValue,
} from '../../utils/autoCompactWindow.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { formatTokens } from '../../utils/format.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

const ENV_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

type WindowResolution = {
  /** Effective window after capping to the model's context window. */
  window: number
  /** The user-visible configured value before capping (undefined = auto). */
  configured: number | undefined
  source: 'env' | 'settings' | 'auto'
}

function resolveWindow(model: string): WindowResolution {
  const modelWindow = getContextWindowForModel(model, getSdkBetas())

  const envRaw = process.env[ENV_WINDOW_KEY]
  if (envRaw) {
    const parsed = parseInt(envRaw, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return {
        window: Math.min(modelWindow, parsed),
        configured: parsed,
        source: 'env',
      }
    }
  }

  const fromSettings = getInitialSettings().autoCompactWindow
  if (typeof fromSettings === 'number') {
    return {
      window: Math.min(modelWindow, fromSettings),
      configured: fromSettings,
      source: 'settings',
    }
  }

  return { window: modelWindow, configured: undefined, source: 'auto' }
}

/** Port of the official `ZO_` current-state description. */
function describeCurrentWindow(model: string): string {
  const { window, configured, source } = resolveWindow(model)
  const cappedSuffix =
    configured !== undefined && configured > window
      ? ` · capped to ${formatTokens(window)} by model`
      : ''

  const sourceLine =
    source === 'auto'
      ? 'auto'
      : source === 'env'
        ? `${formatTokens(configured as number)} tokens (from ${ENV_WINDOW_KEY})${cappedSuffix}`
        : `${formatTokens(configured as number)} tokens (from settings)${cappedSuffix}`

  const lines = [`Auto-compact window: ${sourceLine}`]
  if (!getGlobalConfig().autoCompactEnabled) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.",
  )
  return lines.join('\n')
}

/** Port of the official `MEr` setter. */
async function setWindow(raw: string, model: string): Promise<string> {
  if (process.env[ENV_WINDOW_KEY]) {
    return `${ENV_WINDOW_KEY} is set and takes precedence. Unset it to change this setting.`
  }

  const normalized = raw.trim().toLowerCase()
  const parsed: AutoCompactWindowValue | undefined =
    normalized === 'reset' || normalized === 'unset' || normalized === 'default'
      ? 'auto'
      : parseAutoCompactWindowInput(normalized)

  if (parsed === undefined) {
    return `Couldn't parse '${raw}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`
  }

  const valueToSave = parsed === 'auto' ? undefined : parsed
  const { error } = updateSettingsForSource('userSettings', {
    autoCompactWindow: valueToSave,
  })
  if (error) {
    return `Couldn't save setting: ${error.message}`
  }

  // updateSettingsForSource resets the settings cache, so this re-read sees
  // the freshly written value (official reloads the merged settings too).
  const reloaded = getInitialSettings().autoCompactWindow
  const { window, source } = resolveWindow(model)
  const overrideActive = source === 'env' || reloaded !== valueToSave

  logEvent('tengu_autocompact_command', {
    action: (parsed === 'auto' ? 'auto' : 'set') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(valueToSave !== undefined && { tokens: valueToSave }),
  })

  if (parsed === 'auto') {
    return overrideActive
      ? `Auto-compact window set to auto in settings, but a higher-priority override is active (${formatTokens(window)} tokens)`
      : 'Auto-compact window set to auto'
  }

  let suffix = ''
  if (overrideActive) {
    suffix = `, but a higher-priority override is active (${formatTokens(window)} tokens)`
  } else if (window < parsed) {
    suffix = ` (capped to model limit of ${formatTokens(window)})`
  }
  return `Auto-compact window set to ${formatTokens(parsed)} tokens${suffix}`
}

export async function call(
  args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const raw = (args ?? '').trim()
  const model = context.options.mainLoopModel
  if (!raw) {
    return { type: 'text' as const, value: describeCurrentWindow(model) }
  }
  return { type: 'text' as const, value: await setWindow(raw, model) }
}

export const autocompactNonInteractive: Command = {
  type: 'local',
  name: 'autocompact',
  supportsNonInteractive: true,
  description: 'Configure the auto-compact window size',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  argumentHint: '[auto|<tokens>]',
  load: () => import('./autocompact-noninteractive.js'),
}
