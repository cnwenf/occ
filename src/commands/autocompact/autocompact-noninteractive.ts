/**
 * Non-interactive (-p) variant of /autocompact — ported from official
 * Claude Code 2.1.221+ (OCC-58), upgraded to the official 2.1.288 per-model
 * shape (Gap-288 #79: `Kcs` entrypoint → `w` describe builder + `nPt` setter).
 * Registration metadata and every user-facing string are byte-verified from
 * the official linux-x64 ELFs (2.1.223 for the OCC-58 baseline, 2.1.288 for
 * the per-model cluster @220563600-220565900):
 *
 *   /autocompact            -> current window description (official `w`)
 *   /autocompact <value>    -> parse + persist under
 *                              modelSettings[canonicalKey] (official `nPt`
 *                              via the `Mqr` writer); auto|reset|unset|
 *                              default save a per-model "auto"
 *
 * Precedence mirrors the official `Dw` resolver as far as OCC surfaces go:
 * env CLAUDE_CODE_AUTO_COMPACT_WINDOW > settings (byModel → default) > auto.
 * The server-driven "experiment"/"clientdata" window sources are
 * Anthropic-backend-bound and stay staged (gap doc §4).
 *
 * DIVERGENCES (documented, no invented behavior):
 * - Official formats the settingsKey for display via `No(...)` — that symbol
 *   is an unresolvable minified-name collision in the binary; OCC displays
 *   the raw canonical settingsKey (identical for all first-party models).
 * - Official `w`'s "experiment"/"clientdata" ternary branch is omitted
 *   (unreachable in OCC — those sources stay staged).
 * - The env guard goes through the resolver's `source === 'env'` (official
 *   `Dw(o,void 0).source==="env"`), so a garbage env value that fails to
 *   parse does not block the setter.
 * - After saving, the session override is refreshed to the fresh aggregate
 *   (OCC equivalent of the official `apply_flag_settings {autoCompactWindow:
 *   null}` reset) so the change takes effect without a restart.
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
  aggregateAutoCompactWindow,
  buildAutoCompactWindowPatch,
  ENV_WINDOW_KEY,
  getSessionAutoCompactWindow,
  parseAutoCompactWindowInput,
  resolveAutoCompactWindow,
  setSessionAutoCompactWindow,
  type AutoCompactWindowValue,
} from '../../utils/autoCompactWindow.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { formatTokens } from '../../utils/format.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

/**
 * Official `g` source-label map (byte-verified). The "unknown-model" and
 * "model-default" entries are staged-source labels kept verbatim so the map
 * matches the official shape; OCC's resolver currently only returns
 * env/settings/auto.
 */
const SOURCE_LABELS: Record<string, string> = {
  env: 'from CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'unknown-model': 'default for an unrecognized model',
  'model-default': 'default for this model',
  settings: 'from settings',
}

/** Port of the official `w` current-state description builder. */
function describeCurrentWindow(model: string): string {
  const settingsKey = getCanonicalName(model)
  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  const { window, configured, source } = resolveAutoCompactWindow(
    model,
    contextWindow,
    getSessionAutoCompactWindow(),
  )

  const cappedSuffix =
    configured > window ? ` · capped to ${formatTokens(window)} by model` : ''
  const detail =
    source === 'auto'
      ? 'auto'
      : `${formatTokens(configured)} tokens (${SOURCE_LABELS[source]})${cappedSuffix}`

  const lines = [`Auto-compact window for ${settingsKey}: ${detail}`]
  if (!getGlobalConfig().autoCompactEnabled) {
    lines.push('Auto-compact is currently disabled (see /config)')
  }
  lines.push(
    "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window.",
  )
  lines.push(
    'The auto setting picks a window tuned for your model and is strongly recommended for the best cost and performance.',
  )
  if (source === 'env' || source === 'settings') {
    lines.push(
      'Overriding auto may result in high token usage, especially when resuming long sessions.',
    )
  }
  return lines.join('\n')
}

/** Port of the official `nPt` setter. `raw` arrives pre-trimmed (official Kcs). */
async function setWindow(raw: string, model: string): Promise<string> {
  const settingsKey = getCanonicalName(model)
  const contextWindow = getContextWindowForModel(model, getSdkBetas())

  // Official env guard: `if(Dw(o,void 0).source==="env")return"..."`.
  if (
    resolveAutoCompactWindow(model, contextWindow, undefined).source === 'env'
  ) {
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

  // Official `r` — the top-level fallback value (undefined for "auto", which
  // DELETES the legacy top-level key via mergeWith semantics).
  const topLevelValue = parsed === 'auto' ? undefined : parsed

  // Official `_n("userSettings", Mqr(o.model,{autoCompactWindow:t},{autoCompactWindow:r}), ...)`.
  const { error } = updateSettingsForSource(
    'userSettings',
    buildAutoCompactWindowPatch(model, parsed, topLevelValue),
  )
  if (error) {
    return `Couldn't save setting: ${error.message}`
  }

  // Official re-reads via `WIt()` after the write, then reports.
  const fresh = aggregateAutoCompactWindow()
  const { window, configured, source } = resolveAutoCompactWindow(
    model,
    contextWindow,
    fresh,
  )
  // Official `p=(f==="settings"?l:void 0)!==r` — a higher-priority file still
  // overrides what this write recorded.
  const overrideActive =
    (source === 'settings' ? configured : undefined) !== topLevelValue

  // Always refresh the session override (official clears it via
  // apply_flag_settings so the bootstrap aggregate is re-derived).
  setSessionAutoCompactWindow(fresh)

  logEvent('tengu_autocompact_command', {
    action: (parsed === 'auto' ? 'auto' : 'set') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(topLevelValue !== undefined && { tokens: topLevelValue }),
  })

  const prefix = `Auto-compact window for ${settingsKey}`
  if (parsed === 'auto') {
    return overrideActive
      ? `${prefix} set to auto in settings, but a higher-priority override is active (${formatTokens(window)} tokens)`
      : `${prefix} set to auto`
  }

  let suffix = ''
  if (overrideActive) {
    suffix = `, but a higher-priority override is active (${formatTokens(window)} tokens)`
  } else if (window < parsed) {
    suffix = ` (capped to model limit of ${formatTokens(window)})`
  }
  return `${prefix} set to ${formatTokens(parsed)} tokens${suffix}`
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
