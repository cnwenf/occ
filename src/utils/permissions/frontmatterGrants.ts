/**
 * CC 2.1.282 frontmatter allowed-tools trust gate.
 *
 * Byte-exact port of the official minified cluster (v2.1.282 linux-x64 ELF):
 *   - ZMe  @197945770  getAllowedToolsGated — apply-time gate
 *   - yrn            isAllowedToolsSourceTrusted
 *   - ku             plugin-trust predicate (id defined && namespace !== "skills-dir")
 *   - lC             pluginIdNamespace ("inline" / "synced" / "skills-dir"; "@" ⇒ none)
 *   - FU @197592858  TRUSTED_ALLOWED_TOOLS_SOURCES set
 *   - iUn @197944950 warnAllowedToolsWithheld (log warn + session set + telemetry
 *                    + stderr variant in text-output non-interactive mode)
 *   - kb/Pu @194409548 source label mapping
 *   - f_ @195162471    control/format-char sanitizer for warning text
 *
 * When policySettings.allowManagedPermissionRulesOnly is true (the managed
 * lock, official zw()), permission rules may only come from managed settings.
 * Frontmatter `allowed-tools` grants from untrusted sources (user/project/
 * local/flag settings, MCP, skills dirs) are therefore withheld: the tools
 * list is dropped and a warning is emitted once per name per session.
 *
 * OCC deviations (documented, see gap report):
 *   - The official warns at APPLY time via per-command getAllowedTools
 *     closures; OCC scrubs the raw `allowedTools` field at LOAD time (the
 *     official apply-site in processSlashCommand is out of this cluster's
 *     file set). Warning text/dedupe are byte-identical; only timing differs.
 *   - OCC has no skills-dir plugin id namespace (no synced/account plugin
 *     infrastructure), so pluginIdNamespace() never returns "skills-dir" in
 *     practice and plugins are trusted — matching official ku∘lC semantics
 *     for marketplace ("name@marketplace") plugin ids.
 *   - IX()==="text" && !Et() (official stderr-variant condition) is
 *     approximated from process.argv: print mode with default/text output.
 */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { shouldAllowManagedPermissionRulesOnly } from './permissionsLoader.js'

/** Official FU @197592858: `new Set(["plugin","policySettings","built-in","builtin","bundled"])` */
export const TRUSTED_ALLOWED_TOOLS_SOURCES: ReadonlySet<string> = new Set([
  'plugin',
  'policySettings',
  'built-in',
  'builtin',
  'bundled',
])

/** Official Nd — the plugin id namespace that marks an untrusted (skills-dir) plugin. */
const SKILLS_DIR_NAMESPACE = 'skills-dir'

/**
 * Official kb/Pu @194409548: settings sources map to user-facing labels;
 * builtin/bundled/mcp/memoryStore/plugin pass through unchanged.
 */
const SETTING_SOURCE_LABELS: Record<string, string> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'project, gitignored',
  flagSettings: 'cli flag',
  policySettings: 'managed',
}

export function allowedToolsSourceLabel(source: string): string {
  return SETTING_SOURCE_LABELS[source] ?? source
}

/**
 * Official f_ @195162471 (byte-exact regex):
 *   r => t(r).replace(/(?![\t\n])[\p{Cc}\p{Cf}  ]/gu,"")
 * Strips control/format characters (except tab/newline) and line/paragraph
 * separators from untrusted text before it reaches log/stderr output.
 */
export function sanitizeAllowedToolsWarningText(text: string): string {
  return text.replace(/(?![\t\n])[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')
}

/**
 * Official lC: plugin id namespace. Marketplace ids ("name@marketplace") have
 * no namespace. Bracket-prefixed ids encode the namespace they came from.
 * OCC never generates "skills-dir[...]" ids (no synced-skills plugin infra),
 * so this is forward-compat parity.
 */
export function pluginIdNamespace(pluginId: string): string | undefined {
  if (pluginId.includes('@')) {
    return undefined
  }
  if (pluginId.startsWith('inline[')) {
    return 'inline'
  }
  if (pluginId.startsWith('synced[')) {
    return 'synced'
  }
  if (pluginId.startsWith(`${SKILLS_DIR_NAMESPACE}[`)) {
    return SKILLS_DIR_NAMESPACE
  }
  return undefined
}

/** Official ku: a plugin is trusted iff it has an id outside the skills-dir namespace. */
function isPluginAllowedToolsTrusted(
  pluginInfo: { id?: string } | undefined,
): boolean {
  return (
    pluginInfo?.id !== undefined &&
    pluginIdNamespace(pluginInfo.id) !== SKILLS_DIR_NAMESPACE
  )
}

/**
 * Official yrn: with the managed lock off everything is trusted; with it on,
 * plugins are trusted per ku and all other sources per FU.
 */
export function isAllowedToolsSourceTrusted(
  source: string | undefined,
  pluginInfo?: { id?: string },
): boolean {
  if (!shouldAllowManagedPermissionRulesOnly()) {
    return true
  }
  if (source === 'plugin') {
    return isPluginAllowedToolsTrusted(pluginInfo)
  }
  return source !== undefined && TRUSTED_ALLOWED_TOOLS_SOURCES.has(source)
}

/** Minimal command shape consumed by getAllowedToolsGated (official ZMe input). */
export type AllowedToolsGateCommandLike = {
  name: string
  source?: string
  allowedTools?: string[]
  pluginInfo?: { repository?: string }
  getAllowedTools?: () => Promise<string[]> | string[]
}

/**
 * Official ZMe @197945770 (byte-exact semantics):
 *   n = await e.getAllowedTools?.() ?? e.allowedTools ?? []
 *   if n.length === 0 return n
 *   return isAllowedToolsSourceTrusted(e.source, e.source==="plugin" ? {id: e.pluginInfo?.repository} : undefined) ? n : []
 */
export async function getAllowedToolsGated(
  command: AllowedToolsGateCommandLike,
): Promise<string[]> {
  const tools =
    (await command.getAllowedTools?.()) ?? command.allowedTools ?? []
  if (tools.length === 0) {
    return tools
  }
  return isAllowedToolsSourceTrusted(
    command.source,
    command.source === 'plugin' ? { id: command.pluginInfo?.repository } : undefined,
  )
    ? tools
    : []
}

/** Origin discriminator for warnAllowedToolsWithheld (official `{source}` | `{pluginId}`). */
export type WithheldAllowedToolsOrigin =
  | { source: string }
  | { pluginId: string }

/**
 * Official ds session set: records every `/${name} (${label})` key that has
 * been warned about this session. The official iUn adds unconditionally and
 * once-per-name dedupe lives in the loader closures; OCC scrubs at load time,
 * so callers check membership first (hasAllowedToolsWithheldWarningBeenShown)
 * to reproduce the once-per-name behavior.
 */
const withheldAllowedToolsSessionSet = new Set<string>()

export function getWithheldAllowedToolsSessionSet(): ReadonlySet<string> {
  return withheldAllowedToolsSessionSet
}

/** Test-only: clear the session set between test cases. */
export function resetWithheldAllowedToolsSessionSet_FOR_TESTING(): void {
  withheldAllowedToolsSessionSet.clear()
}

function withheldOriginLabel(origin: WithheldAllowedToolsOrigin): string {
  return 'pluginId' in origin
    ? origin.pluginId
    : allowedToolsSourceLabel(origin.source)
}

/** The `/${name} (${label})` key (pre-sanitizer) used for once-per-name dedupe. */
export function withheldAllowedToolsKey(
  name: string,
  origin: WithheldAllowedToolsOrigin,
): string {
  return `/${name} (${withheldOriginLabel(origin)})`
}

export function hasAllowedToolsWithheldWarningBeenShown(
  name: string,
  origin: WithheldAllowedToolsOrigin,
): boolean {
  return withheldAllowedToolsSessionSet.has(
    sanitizeAllowedToolsWarningText(withheldAllowedToolsKey(name, origin)),
  )
}

/**
 * Official IX()==="text" && !Et(): print/headless mode with text output
 * format. OCC has no global launch-options getter for printOutputFormat, so
 * this reads process.argv directly (same pattern as main.tsx's isPrintMode).
 */
function isTextOutputNonInteractive(): boolean {
  const argv = process.argv
  const printMode = argv.includes('-p') || argv.includes('--print')
  if (!printMode) {
    return false
  }
  const flagIndex = argv.indexOf('--output-format')
  const format = flagIndex >= 0 ? argv[flagIndex + 1] : undefined
  return format === undefined || format === 'text'
}

/**
 * Official iUn @197944950 (byte-exact messages):
 *   1. log warn: `Ignoring allowed-tools ${tools} from /${name} (${label}):
 *      permission rules are restricted to managed settings
 *      (allowManagedPermissionRulesOnly).`
 *   2. add `/${name} (${label})` (sanitized) to the session set
 *   3. telemetry `tengu_frontmatter_grant_withheld` {origin, tool_count}
 *      origin = raw source, or plugin_skills_dir / plugin_other for plugins
 *   4. text-output non-interactive: console.error stderr variant
 * Like the official, this warns on EVERY call; once-per-name dedupe is the
 * caller's job (see hasAllowedToolsWithheldWarningBeenShown).
 */
export function warnAllowedToolsWithheld(
  name: string,
  origin: WithheldAllowedToolsOrigin,
  tools: string[],
): void {
  const display = sanitizeAllowedToolsWarningText(
    withheldAllowedToolsKey(name, origin),
  )
  const telemetryOrigin =
    'pluginId' in origin
      ? pluginIdNamespace(origin.pluginId) === SKILLS_DIR_NAMESPACE
        ? 'plugin_skills_dir'
        : 'plugin_other'
      : origin.source

  logForDebugging(
    `Ignoring allowed-tools ${sanitizeAllowedToolsWarningText(tools.join(', '))} from ${display}: permission rules are restricted to managed settings (allowManagedPermissionRulesOnly).`,
    { level: 'warn' },
  )
  withheldAllowedToolsSessionSet.add(display)
  logEvent('tengu_frontmatter_grant_withheld', {
    origin:
      telemetryOrigin as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    tool_count: tools.length,
  })
  if (isTextOutputNonInteractive()) {
    console.error(
      `allowed-tools from ${display} ignored: your organization restricts permission rules to managed settings (allowManagedPermissionRulesOnly). Ask an admin to add the rules it needs to managed settings.`,
    )
  }
}

/**
 * OCC load-time scrub helper (documented deviation from the official
 * apply-time getAllowedTools closure): returns the command's allowed-tools
 * when the source is trusted, otherwise warns once per name per session and
 * returns []. Trusted sources keep their tools untouched.
 */
export function gateAllowedToolsAtLoad(
  command: AllowedToolsGateCommandLike,
): string[] {
  const tools = command.allowedTools ?? []
  if (tools.length === 0) {
    return tools
  }
  const origin: WithheldAllowedToolsOrigin =
    command.source === 'plugin'
      ? { pluginId: command.pluginInfo?.repository ?? '' }
      : { source: command.source ?? 'unknown' }
  if (
    isAllowedToolsSourceTrusted(
      command.source,
      command.source === 'plugin'
        ? { id: command.pluginInfo?.repository }
        : undefined,
    )
  ) {
    return tools
  }
  if (!hasAllowedToolsWithheldWarningBeenShown(command.name, origin)) {
    warnAllowedToolsWithheld(command.name, origin, tools)
  }
  return []
}
