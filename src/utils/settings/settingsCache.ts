import type { SettingSource } from './constants.js'
import type { SettingsJson } from './types.js'
import type { SettingsWithErrors, ValidationError } from './validation.js'

let sessionSettingsCache: SettingsWithErrors | null = null

export function getSessionSettingsCache(): SettingsWithErrors | null {
  return sessionSettingsCache
}

export function setSessionSettingsCache(value: SettingsWithErrors): void {
  sessionSettingsCache = value
}

/**
 * Per-source cache for getSettingsForSource. Invalidated alongside the
 * merged sessionSettingsCache — same resetSettingsCache() triggers
 * (settings write, --add-dir, plugin init, hooks refresh).
 */
const perSourceCache = new Map<SettingSource, SettingsJson | null>()

export function getCachedSettingsForSource(
  source: SettingSource,
): SettingsJson | null | undefined {
  // undefined = cache miss; null = cached "no settings for this source"
  return perSourceCache.has(source) ? perSourceCache.get(source) : undefined
}

export function setCachedSettingsForSource(
  source: SettingSource,
  value: SettingsJson | null,
): void {
  perSourceCache.set(source, value)
}

/**
 * Admin-policy load-error aggregate (CC 2.1.285, official `yr()` @196726200 —
 * the memoized `adminLoadErrors`): every ValidationError produced while
 * loading the policy chain (remote / MDM / managed file + drop-ins / HKCU).
 * `adminPolicySurvivor` mirrors the official memoized `adminSurvivor`
 * (`k1o()`): true when a readable admin source produced policy content, in
 * which case unreadable lower-priority sources must NOT fail-close the
 * session (official k1o disjuncts each test one source for content; OCC's
 * first-wins chain collapses them into the single winning source).
 * Populated by loadSettingsFromDisk; cleared by resetSettingsCache. Consumers:
 * the startup org gate in validateForceLoginOrg (official `JL`).
 */
let adminPolicyLoadErrors: ValidationError[] | undefined
let adminPolicySurvivor: boolean | undefined

export function getCachedAdminPolicyLoadErrors():
  | ValidationError[]
  | undefined {
  return adminPolicyLoadErrors
}

export function getCachedAdminPolicySurvivor(): boolean | undefined {
  return adminPolicySurvivor
}

export function setCachedAdminPolicyLoad(
  errors: ValidationError[],
  survivor: boolean,
): void {
  adminPolicyLoadErrors = errors
  adminPolicySurvivor = survivor
}

/**
 * Path-keyed cache for parseSettingsFile. Both getSettingsForSource and
 * loadSettingsFromDisk call parseSettingsFile on the same paths during
 * startup — this dedupes the disk read + zod parse.
 */
type ParsedSettings = {
  settings: SettingsJson | null
  errors: ValidationError[]
}
const parseFileCache = new Map<string, ParsedSettings>()

export function getCachedParsedFile(path: string): ParsedSettings | undefined {
  return parseFileCache.get(path)
}

export function setCachedParsedFile(path: string, value: ParsedSettings): void {
  parseFileCache.set(path, value)
}

export function resetSettingsCache(): void {
  sessionSettingsCache = null
  perSourceCache.clear()
  parseFileCache.clear()
  adminPolicyLoadErrors = undefined
  adminPolicySurvivor = undefined
}

/**
 * Plugin settings base layer for the settings cascade.
 * pluginLoader writes here after loading plugins;
 * loadSettingsFromDisk reads it as the lowest-priority base.
 */
let pluginSettingsBase: Record<string, unknown> | undefined

export function getPluginSettingsBase(): Record<string, unknown> | undefined {
  return pluginSettingsBase
}

export function setPluginSettingsBase(
  settings: Record<string, unknown> | undefined,
): void {
  pluginSettingsBase = settings
}

export function clearPluginSettingsBase(): void {
  pluginSettingsBase = undefined
}
