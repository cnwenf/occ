/**
 * Bundled `.mcpb` "needs configuration" messaging (official Claude Code
 * 2.1.285, changelog item 13).
 *
 * When a plugin bundles a `.mcpb` whose MCP server declares required
 * `userConfig` the user has not supplied, the official 2.1.285 build does NOT
 * silently skip the server — it logs a byte-exact line, pushes an
 * `mcpb-needs-config` warning into the plugin-error list, and surfaces
 * "needs configuration before it can start" guidance across the CLI and the
 * /plugin UI. In v284 the warning type and its four render sites did not
 * exist (`needs configuration` 0→4, `mcpb-needs-config` 0→8 in the string
 * table).
 *
 * Ported byte-faithfully from the decompiled official 2.1.285 linux-x64 ELF:
 *
 *   official (v285 offset)      here
 *   ----------------------      ----
 *   `zJe(e,n)`   @203325978     mcpbNeedsConfigWarning
 *   warning text @199242977     needsConfigWarningText
 *   guidance     @199245847     needsConfigGuidanceText
 *   `V(e,n)`     @222233220     buildNeedsConfigCliMessage
 *   `wo`         @231879482     NEEDS_CONFIG_UI_SUFFIX_PLUGIN
 *   `Rc`         @231907459     NEEDS_CONFIG_UI_SUFFIX_SERVER
 *   `WJe` log    @203321935     buildNeedsConfigLogMessage
 *   `vt`                        pluginDisplayText.sanitizePluginMessageText
 *   `Kt`                        pluginDisplayText.sanitizePluginDisplayText
 *
 * `zJe` verbatim:
 *   function zJe(e,n){return{type:"mcpb-needs-config",source:e.repository,
 *     plugin:e.name,serverName:n}}
 *
 * The `WJe` needs-config branch verbatim (S = sanitized mcpb path, t = log,
 * s = warnings array, e = plugin, M = the needs-config load result):
 *   if("status"in M&&M.status==="needs-config")
 *     return t(`MCPB ${S} requires user configuration; MCP server
 *       "${vt(M.manifest.name)}" not started. Configure via: /plugin
 *       → Installed → ${e.name} → Configure`),
 *       s.push(zJe(e,M.manifest.name)),null;
 *
 * Known omissions / notes (documented, not invented):
 * - `buildNeedsConfigCliMessage` reproduces the official `V` literal
 *   "...or in Claude Code run /plugin..." byte-for-byte. Whether OCC localizes
 *   the product name "Claude Code" → "OCC" at the (out-of-domain) call site is
 *   an integrator decision, flagged in the port report; the ported string here
 *   stays byte-identical to the binary.
 * - The path passed to `buildNeedsConfigLogMessage` is expected to be already
 *   display-sanitized/credential-redacted by the caller (OCC uses
 *   `redactMcpbPathForDisplay`); the official `vp(n)` path sanitizer is the
 *   same display-only transform.
 * - `mcpb-needs-config` is NOT yet a member of OCC's `PluginError` union
 *   (`src/types/plugin.ts`, out of this module's domain). The warning object,
 *   the union variant, and both render-site switch cases must land together —
 *   see the staged-wiring section of the port report. Pushing the warning
 *   before the union + renderer cases exist would fall through the exhaustive
 *   switches and render `undefined`, so the push itself is staged.
 */

import {
  sanitizePluginDisplayText,
  sanitizePluginMessageText,
} from './pluginDisplayText.js'

/**
 * The `mcpb-needs-config` plugin-warning shape (official `zJe` output). Once
 * `src/types/plugin.ts` adds the matching union variant this object satisfies
 * `PluginError` structurally; until then it is constructed here and staged for
 * the push site.
 */
export interface McpbNeedsConfigWarning {
  readonly type: 'mcpb-needs-config'
  readonly source: string
  readonly plugin: string
  readonly serverName: string
}

/** Minimal structural view of a loaded plugin (avoids the out-of-domain type). */
export interface McpbNeedsConfigPluginRef {
  readonly name: string
  readonly repository: string
}

/**
 * Official `zJe(e,n)`: build the needs-config warning. `source` is the plugin
 * repository (already `name@marketplace` in OCC), `plugin` is the plugin name,
 * `serverName` is the bundled MCP server's manifest name.
 */
export function mcpbNeedsConfigWarning(
  plugin: McpbNeedsConfigPluginRef,
  serverName: string,
): McpbNeedsConfigWarning {
  return {
    type: 'mcpb-needs-config',
    source: plugin.repository,
    plugin: plugin.name,
    serverName,
  }
}

/**
 * Official warning text (v285 @199242977):
 *   `Bundled MCP server "${vt(e.serverName)}" was not started: it needs
 *    configuration`
 */
export function needsConfigWarningText(
  warning: Pick<McpbNeedsConfigWarning, 'serverName'>,
): string {
  return `Bundled MCP server "${sanitizePluginMessageText(warning.serverName)}" was not started: it needs configuration`
}

/**
 * Official guidance (v285 @199245847):
 *   `Open "${vt(e.plugin)}" in the Installed tab and choose Configure`
 */
export function needsConfigGuidanceText(
  warning: Pick<McpbNeedsConfigWarning, 'plugin'>,
): string {
  return `Open "${sanitizePluginMessageText(warning.plugin)}" in the Installed tab and choose Configure`
}

/**
 * Official `wo` (v285 @231879482, chunk-675ch139.js) — UI suffix appended to a
 * PLUGIN row whose bundled server needs configuration. Leading space, em-dash,
 * ASCII apostrophe in `/plugin's` — all byte-identical to the binary.
 */
export const NEEDS_CONFIG_UI_SUFFIX_PLUGIN =
  " Its bundled MCP server needs configuration before it can start — select the plugin in /plugin's Installed tab and choose Configure."

/**
 * Official `Rc` (v285 @231907459, chunk-675ch139.js) — UI suffix appended to a
 * SERVER row that needs configuration. Byte-identical to the binary.
 */
export const NEEDS_CONFIG_UI_SUFFIX_SERVER =
  " A bundled MCP server needs configuration before it can start — select its plugin in /plugin's Installed tab and choose Configure."

/** One declared `userConfig` option of a bundled `.mcpb` server. */
export interface NeedsConfigSchemaOption {
  readonly required?: boolean
}

/** Parameters for the official `V(e,n)` CLI message builder. */
export interface NeedsConfigCliMessageParams {
  /** Bundled MCP server name (also the `--config <server>.<key>` prefix). */
  readonly serverName: string
  /** Plugin name shown for the `/plugin` Installed-tab selection. */
  readonly pluginName: string
  /** The server's declared `userConfig` schema. */
  readonly schema: Readonly<Record<string, NeedsConfigSchemaOption>>
  /** The user's currently-stored config values for the server. */
  readonly existingConfig: Readonly<Record<string, string | undefined>>
  /** Validation errors from the stored config (used when nothing is missing). */
  readonly validationErrors: ReadonlyArray<string>
}

/**
 * Official `V(e,n)` (v285 @222233220) — the CLI `plugin install` message when
 * a bundled server needs configuration. Two branches:
 *
 *   let d = Object.entries(e.schema)
 *     .filter(([g,p]) => p.required === true &&
 *       (e.existingConfig[g] === undefined || e.existingConfig[g] === ""))
 *     .map(([g]) => Kt(`${s}.${g}`)),
 *   r = d.length > 0
 *     ? `set ${d.join(", ")} with --config KEY=VALUE`
 *     : `${o.errors.map(g => Kt(g)).join("; ")} — fix it with --config ${s}.KEY=VALUE`;
 *   return `MCP server "${vt(e.serverName)}" needs configuration before it can
 *     start: ${r}, or in Claude Code run /plugin, select "${vt(n)}" in the
 *     Installed tab, and choose Configure.`
 *
 * (`s` = serverName, `n` = pluginName, `Kt` = sanitizePluginDisplayText,
 * `vt` = sanitizePluginMessageText.)
 */
export function buildNeedsConfigCliMessage(
  params: NeedsConfigCliMessageParams,
): string {
  const { serverName, pluginName, schema, existingConfig, validationErrors } =
    params
  const missingRequired = Object.entries(schema)
    .filter(
      ([key, option]) =>
        option.required === true &&
        (existingConfig[key] === undefined || existingConfig[key] === ''),
    )
    .map(([key]) => sanitizePluginDisplayText(`${serverName}.${key}`))
  const detail =
    missingRequired.length > 0
      ? `set ${missingRequired.join(', ')} with --config KEY=VALUE`
      : `${validationErrors
          .map(error => sanitizePluginDisplayText(error))
          .join('; ')} — fix it with --config ${serverName}.KEY=VALUE`
  return `MCP server "${sanitizePluginMessageText(serverName)}" needs configuration before it can start: ${detail}, or in Claude Code run /plugin, select "${sanitizePluginMessageText(pluginName)}" in the Installed tab, and choose Configure.`
}

/**
 * Official `WJe` needs-config log line (v285 @203321935). `displayPath` must
 * already be display-sanitized / credential-redacted by the caller; the
 * server name is sanitized here with `vt` exactly as the official does.
 *   `MCPB ${S} requires user configuration; MCP server "${vt(name)}" not
 *    started. Configure via: /plugin → Installed → ${pluginName} → Configure`
 */
export function buildNeedsConfigLogMessage(
  displayPath: string,
  serverName: string,
  pluginName: string,
): string {
  return `MCPB ${displayPath} requires user configuration; MCP server "${sanitizePluginMessageText(serverName)}" not started. Configure via: /plugin → Installed → ${pluginName} → Configure`
}
