import type { PluginError } from '../../types/plugin.js'
import { parsePluginIdentifier } from './pluginIdentifier.js'

/**
 * CC 2.1.277 fix (report_C C13): "Fixed uninstalled plugins reappearing as
 * 'failed to load' rows in /plugin Installed, and Remove not clearing such a
 * row."
 *
 * Root cause in OCC: `uninstallPluginOp` never touches `appState.plugins.errors`
 * (only marketplace removal clears errors — PluginSettings.tsx). Stale errors
 * for the removed plugin survive in app state and `orphanErrorsBySource`
 * (ManagePlugins.tsx) resurrects them as `failed-plugin` rows on the next
 * Installed-list rebuild.
 *
 * Returns a NEW array without the uninstalled plugin's error entries,
 * matching both source forms:
 *   - `name@marketplace` — the plugin id form set by pluginLoader.ts
 *   - `plugin:<name>`    — the MCP-integration form (mcpPluginIntegration.ts)
 * Errors belonging to other plugins are untouched. Pure + immutable.
 */
export function withoutUninstalledPluginErrors(
  errors: readonly PluginError[],
  pluginId: string,
): PluginError[] {
  const { name } = parsePluginIdentifier(pluginId)
  const mcpSource = `plugin:${name === '' ? pluginId : name}`
  return errors.filter(
    error => error.source !== pluginId && error.source !== mcpSource,
  )
}
