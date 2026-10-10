import type {
  EditableSettingSource,
  SettingSource,
} from '../settings/constants.js'
import { sliceHead } from '../truncateMiddle.js'
import {
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  type PluginScope,
} from './schemas.js'

/**
 * Extended scope type that includes 'flag' for session-only plugins.
 * 'flag' scope is NOT persisted to installed_plugins.json.
 */
export type ExtendedPluginScope = PluginScope | 'flag'

/**
 * Scopes that are persisted to installed_plugins.json.
 * Excludes 'flag' which is session-only.
 */
export type PersistablePluginScope = Exclude<ExtendedPluginScope, 'flag'>

/**
 * Map from SettingSource to plugin scope.
 * Note: flagSettings maps to 'flag' which is session-only and not persisted.
 */
export const SETTING_SOURCE_TO_SCOPE = {
  policySettings: 'managed',
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  flagSettings: 'flag',
} as const satisfies Record<SettingSource, ExtendedPluginScope>

/**
 * Parsed plugin identifier with name and optional marketplace
 */
export type ParsedPluginIdentifier = {
  name: string
  marketplace?: string
}

/**
 * Parse a plugin identifier string into name and marketplace components
 * @param plugin The plugin identifier (name or name@marketplace)
 * @returns Parsed plugin name and optional marketplace
 *
 * Note: Only the first '@' is used as separator. If the input contains multiple '@' symbols
 * (e.g., "plugin@market@place"), everything after the second '@' is ignored.
 * This is intentional as marketplace names should not contain '@'.
 */
export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  if (plugin.includes('@')) {
    const parts = plugin.split('@')
    return { name: parts[0] || '', marketplace: parts[1] }
  }
  return { name: plugin }
}

/**
 * Build a plugin ID from name and marketplace
 * @param name The plugin name
 * @param marketplace Optional marketplace name
 * @returns Plugin ID in format "name" or "name@marketplace"
 */
export function buildPluginId(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name
}

/**
 * Official 2.1.295 `mt` — the shape every half of a plugin id
 * (`plugin@marketplace`) must have for Claude Code to be able to install
 * from it: starts with a letter or digit, then letters/digits/`.`/`_`/`-`,
 * up to 128 characters total.
 */
const PLUGIN_ID_HALF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * True when `part` can serve as one half of a plugin id
 * (`plugin@marketplace`) — official 2.1.295 `r0` check used by
 * `marketplace add` to refuse names no plugin can ever be installed under.
 */
export function isValidPluginIdPart(part: string): boolean {
  return PLUGIN_ID_HALF_PATTERN.test(part)
}

/** Official 2.1.295 shared rule sentence (`a3n`), verbatim. */
export const PLUGIN_ID_PART_RULES_SENTENCE =
  'Each part of a plugin id (plugin@marketplace) may use only the letters a-z and A-Z, digits, ".", "_" and "-", and must start with a letter or digit.'

/** Official `je(ke, 64)` — the refusal message caps the name at 64 chars. */
const MARKETPLACE_NAME_DISPLAY_CAP = 64

/**
 * Official 2.1.295 `marketplace add` refusal message for a name no plugin
 * can be installed under, verbatim template.
 */
export function buildMarketplaceNameRefusalMessage(name: string): string {
  return (
    `Cannot add marketplace "${sliceHead(name, MARKETPLACE_NAME_DISPLAY_CAP)}": ` +
    `Claude Code cannot install plugins from a marketplace with this name. ` +
    `${PLUGIN_ID_PART_RULES_SENTENCE} ` +
    `The name is set by "name" in the marketplace's marketplace.json; ask its maintainer to change it.`
  )
}

/**
 * Check if a marketplace name is an official (Anthropic-controlled) marketplace.
 * Used for telemetry redaction — official plugin identifiers are safe to log to
 * general-access additional_metadata; third-party identifiers go only to the
 * PII-tagged _PROTO_* BQ columns.
 */
export function isOfficialMarketplaceName(
  marketplace: string | undefined,
): boolean {
  return (
    marketplace !== undefined &&
    ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(marketplace.toLowerCase())
  )
}

/**
 * Map from installable plugin scope to editable setting source.
 * This is the inverse of SETTING_SOURCE_TO_SCOPE for editable scopes only.
 * Note: 'managed' scope cannot be installed to, so it's not included here.
 */
const SCOPE_TO_EDITABLE_SOURCE: Record<
  Exclude<PluginScope, 'managed'>,
  EditableSettingSource
> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

/**
 * Convert a plugin scope to its corresponding editable setting source
 * @param scope The plugin installation scope
 * @returns The corresponding setting source for reading/writing settings
 * @throws Error if scope is 'managed' (cannot install plugins to managed scope)
 */
export function scopeToSettingSource(
  scope: PluginScope,
): EditableSettingSource {
  if (scope === 'managed') {
    throw new Error('Cannot install plugins to managed scope')
  }
  return SCOPE_TO_EDITABLE_SOURCE[scope]
}

/**
 * Convert an editable setting source to its corresponding plugin scope.
 * Derived from SETTING_SOURCE_TO_SCOPE to maintain a single source of truth.
 * @param source The setting source
 * @returns The corresponding plugin scope
 */
export function settingSourceToScope(
  source: EditableSettingSource,
): Exclude<PluginScope, 'managed'> {
  return SETTING_SOURCE_TO_SCOPE[source] as Exclude<PluginScope, 'managed'>
}
