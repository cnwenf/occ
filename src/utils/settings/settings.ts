import { feature } from 'src/utils/featureFlags.js'
import mergeWith from 'lodash-es/mergeWith.js'
import { dirname, join, resolve } from 'path'
import { z } from 'zod/v4'
import {
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getUseCoworkPlugins,
} from '../../bootstrap/state.js'
import { getRemoteManagedSettingsSyncFromCache } from '../../services/remoteManagedSettings/syncCacheState.js'
import { uniq } from '../array.js'
import { logForDebugging } from '../debug.js'
import { logForDiagnosticsNoPII } from '../diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../envUtils.js'
import { getErrnoCode, isENOENT } from '../errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from '../file.js'
import { readFileSync } from '../fileRead.js'
import { getFsImplementation, safeResolvePath } from '../fsOperations.js'
import { addFileGlobRuleToGitignore } from '../git/gitignore.js'
import { safeParseJSON } from '../json.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { gte, lte, parseVersion } from '../semver.js'
import { clone, jsonStringify } from '../slowOperations.js'
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from '../../services/analytics/index.js'
import { profileCheckpoint } from '../startupProfiler.js'
import {
  type EditableSettingSource,
  getEnabledSettingSources,
  type SettingSource,
} from './constants.js'
import { markInternalWrite } from './internalWrites.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from './managedPath.js'
import { getHkcuSettings, getMdmSettings } from './mdm/settings.js'
import {
  getCachedParsedFile,
  getCachedSettingsForSource,
  getPluginSettingsBase,
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedParsedFile,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from './settingsCache.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import {
  filterInvalidPermissionRules,
  formatZodError,
  type SettingsWithErrors,
  type ValidationError,
} from './validation.js'

/**
 * Get the path to the managed settings file based on the current platform
 */
function getManagedSettingsFilePath(): string {
  return join(getManagedFilePath(), 'managed-settings.json')
}

/**
 * Load file-based managed settings: managed-settings.json + managed-settings.d/*.json.
 *
 * managed-settings.json is merged first (lowest precedence / base), then drop-in
 * files are sorted alphabetically and merged on top (higher precedence, later
 * files win). This matches the systemd/sudoers drop-in convention: the base
 * file provides defaults, drop-ins customize. Separate teams can ship
 * independent policy fragments (e.g. 10-otel.json, 20-security.json) without
 * coordinating edits to a single admin-owned file.
 *
 * Exported for testing.
 */
export function loadManagedFileSettings(): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const errors: ValidationError[] = []
  let merged: SettingsJson = {}
  let found = false

  const { settings, errors: baseErrors } = parseSettingsFile(
    getManagedSettingsFilePath(),
  )
  errors.push(...baseErrors)
  if (settings && Object.keys(settings).length > 0) {
    merged = mergeWith(merged, settings, settingsMergeCustomizer)
    found = true
  }

  const dropInDir = getManagedSettingsDropInDir()
  try {
    const entries = getFsImplementation()
      .readdirSync(dropInDir)
      .filter(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
      .map(d => d.name)
      .sort()
    for (const name of entries) {
      const { settings, errors: fileErrors } = parseSettingsFile(
        join(dropInDir, name),
      )
      errors.push(...fileErrors)
      if (settings && Object.keys(settings).length > 0) {
        merged = mergeWith(merged, settings, settingsMergeCustomizer)
        found = true
      }
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logError(e)
    }
  }

  return { settings: found ? merged : null, errors }
}

/**
 * Check which file-based managed settings sources are present.
 * Used by /status to show "(file)", "(drop-ins)", or "(file + drop-ins)".
 */
export function getManagedFileSettingsPresence(): {
  hasBase: boolean
  hasDropIns: boolean
} {
  const { settings: base } = parseSettingsFile(getManagedSettingsFilePath())
  const hasBase = !!base && Object.keys(base).length > 0

  let hasDropIns = false
  const dropInDir = getManagedSettingsDropInDir()
  try {
    hasDropIns = getFsImplementation()
      .readdirSync(dropInDir)
      .some(
        d =>
          (d.isFile() || d.isSymbolicLink()) &&
          d.name.endsWith('.json') &&
          !d.name.startsWith('.'),
      )
  } catch {
    // dir doesn't exist
  }

  return { hasBase, hasDropIns }
}

/**
 * Handles file system errors appropriately
 * @param error The error to handle
 * @param path The file path that caused the error
 */
function handleFileSystemError(error: unknown, path: string): void {
  if (
    typeof error === 'object' &&
    error &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    logForDebugging(
      `Broken symlink or missing file encountered for settings.json at path: ${path}`,
    )
  } else {
    logError(error)
  }
}

/**
 * Parses a settings file into a structured format
 * @param path The path to the permissions file
 * @param source The source of the settings (optional, for error reporting)
 * @returns Parsed settings data and validation errors
 */
export function parseSettingsFile(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  const cached = getCachedParsedFile(path)
  if (cached) {
    // Clone so callers (e.g. mergeWith in getSettingsForSourceUncached,
    // updateSettingsForSource) can't mutate the cached entry.
    return {
      settings: cached.settings ? clone(cached.settings) : null,
      errors: cached.errors,
    }
  }
  const result = parseSettingsFileUncached(path)
  setCachedParsedFile(path, result)
  // Clone the first return too — the caller may mutate before
  // another caller reads the same cache entry.
  return {
    settings: result.settings ? clone(result.settings) : null,
    errors: result.errors,
  }
}

function parseSettingsFileUncached(path: string): {
  settings: SettingsJson | null
  errors: ValidationError[]
} {
  try {
    const { resolvedPath } = safeResolvePath(getFsImplementation(), path)
    const content = readFileSync(resolvedPath)

    if (content.trim() === '') {
      return { settings: {}, errors: [] }
    }

    const data = safeParseJSON(content, false)

    // Filter invalid permission rules before schema validation so one bad
    // rule doesn't cause the entire settings file to be rejected.
    const ruleWarnings = filterInvalidPermissionRules(data, path)

    const result = SettingsSchema().safeParse(data)

    if (!result.success) {
      const errors = formatZodError(result.error, path)
      return { settings: null, errors: [...ruleWarnings, ...errors] }
    }

    return { settings: result.data, errors: ruleWarnings }
  } catch (error) {
    handleFileSystemError(error, path)
    return { settings: null, errors: [] }
  }
}

/**
 * Get the absolute path to the associated file root for a given settings source
 * (e.g. for $PROJ_DIR/.claude/settings.json, returns $PROJ_DIR)
 * @param source The source of the settings
 * @returns The root path of the settings file
 */
export function getSettingsRootPathForSource(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return resolve(getClaudeConfigHomeDir())
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings': {
      return resolve(getOriginalCwd())
    }
    case 'flagSettings': {
      const path = getFlagSettingsPath()
      return path ? dirname(resolve(path)) : resolve(getOriginalCwd())
    }
  }
}

/**
 * Get the user settings filename based on cowork mode.
 * Returns 'cowork_settings.json' when in cowork mode, 'settings.json' otherwise.
 *
 * Priority:
 * 1. Session state (set by CLI flag --cowork)
 * 2. Environment variable CLAUDE_CODE_USE_COWORK_PLUGINS
 * 3. Default: 'settings.json'
 */
function getUserSettingsFilePath(): string {
  if (
    getUseCoworkPlugins() ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_COWORK_PLUGINS)
  ) {
    return 'cowork_settings.json'
  }
  return 'settings.json'
}

export function getSettingsFilePathForSource(
  source: SettingSource,
): string | undefined {
  switch (source) {
    case 'userSettings':
      return join(
        getSettingsRootPathForSource(source),
        getUserSettingsFilePath(),
      )
    case 'projectSettings':
    case 'localSettings': {
      return join(
        getSettingsRootPathForSource(source),
        getRelativeSettingsFilePathForSource(source),
      )
    }
    case 'policySettings':
      return getManagedSettingsFilePath()
    case 'flagSettings': {
      return getFlagSettingsPath()
    }
  }
}

export function getRelativeSettingsFilePathForSource(
  source: 'projectSettings' | 'localSettings',
): string {
  switch (source) {
    case 'projectSettings':
      return join('.claude', 'settings.json')
    case 'localSettings':
      return join('.claude', 'settings.local.json')
  }
}

export function getSettingsForSource(
  source: SettingSource,
): SettingsJson | null {
  const cached = getCachedSettingsForSource(source)
  if (cached !== undefined) return cached
  const result = getSettingsForSourceUncached(source)
  setCachedSettingsForSource(source, result)
  return result
}

function getSettingsForSourceUncached(
  source: SettingSource,
): SettingsJson | null {
  // For policySettings: first source wins (remote > HKLM/plist > file > HKCU)
  if (source === 'policySettings') {
    const remoteSettings = getRemoteManagedSettingsSyncFromCache()
    if (remoteSettings && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }

    const mdmResult = getMdmSettings()
    if (Object.keys(mdmResult.settings).length > 0) {
      return mdmResult.settings
    }

    const { settings: fileSettings } = loadManagedFileSettings()
    if (fileSettings) {
      return fileSettings
    }

    const hkcu = getHkcuSettings()
    if (Object.keys(hkcu.settings).length > 0) {
      return hkcu.settings
    }

    return null
  }

  const settingsFilePath = getSettingsFilePathForSource(source)
  const { settings: fileSettings } = settingsFilePath
    ? parseSettingsFile(settingsFilePath)
    : { settings: null }

  // For flagSettings, merge in any inline settings set via the SDK
  if (source === 'flagSettings') {
    const inlineSettings = getFlagSettingsInline()
    if (inlineSettings) {
      const parsed = SettingsSchema().safeParse(inlineSettings)
      if (parsed.success) {
        return mergeWith(
          fileSettings || {},
          parsed.data,
          settingsMergeCustomizer,
        ) as SettingsJson
      }
    }
  }

  return fileSettings
}

/**
 * Get the origin of the highest-priority active policy settings source.
 * Uses "first source wins" — returns the first source that has content.
 * Priority: remote > plist/hklm > file (managed-settings.json) > hkcu
 */
export function getPolicySettingsOrigin():
  | 'remote'
  | 'plist'
  | 'hklm'
  | 'file'
  | 'hkcu'
  | null {
  // 1. Remote (highest)
  const remoteSettings = getRemoteManagedSettingsSyncFromCache()
  if (remoteSettings && Object.keys(remoteSettings).length > 0) {
    return 'remote'
  }

  // 2. Admin-only MDM (HKLM / macOS plist)
  const mdmResult = getMdmSettings()
  if (Object.keys(mdmResult.settings).length > 0) {
    return getPlatform() === 'macos' ? 'plist' : 'hklm'
  }

  // 3. managed-settings.json + managed-settings.d/ (file-based, requires admin)
  const { settings: fileSettings } = loadManagedFileSettings()
  if (fileSettings) {
    return 'file'
  }

  // 4. HKCU (lowest — user-writable)
  const hkcu = getHkcuSettings()
  if (Object.keys(hkcu.settings).length > 0) {
    return 'hkcu'
  }

  return null
}

/**
 * Merges `settings` into the existing settings for `source` using lodash mergeWith.
 *
 * To delete a key from a record field (e.g. enabledPlugins, extraKnownMarketplaces),
 * set it to `undefined` — do NOT use `delete`. mergeWith only detects deletion when
 * the key is present with an explicit `undefined` value.
 */
export function updateSettingsForSource(
  source: EditableSettingSource,
  settings: SettingsJson,
): { error: Error | null } {
  if (
    (source as unknown) === 'policySettings' ||
    (source as unknown) === 'flagSettings'
  ) {
    return { error: null }
  }

  // Create the folder if needed
  const filePath = getSettingsFilePathForSource(source)
  if (!filePath) {
    return { error: null }
  }

  try {
    getFsImplementation().mkdirSync(dirname(filePath))

    // Try to get existing settings with validation. Bypass the per-source
    // cache — mergeWith below mutates its target (including nested refs),
    // and mutating the cached object would leak unpersisted state if the
    // write fails before resetSettingsCache().
    let existingSettings = getSettingsForSourceUncached(source)

    // If validation failed, check if file exists with a JSON syntax error
    if (!existingSettings) {
      let content: string | null = null
      try {
        content = readFileSync(filePath)
      } catch (e) {
        if (!isENOENT(e)) {
          throw e
        }
        // File doesn't exist — fall through to merge with empty settings
      }
      if (content !== null) {
        const rawData = safeParseJSON(content)
        if (rawData === null) {
          // JSON syntax error - return validation error instead of overwriting
          // safeParseJSON will already log the error, so we'll just return the error here
          return {
            error: new Error(
              `Invalid JSON syntax in settings file at ${filePath}`,
            ),
          }
        }
        if (rawData && typeof rawData === 'object') {
          existingSettings = rawData as SettingsJson
          logForDebugging(
            `Using raw settings from ${filePath} due to validation failure`,
          )
        }
      }
    }

    const updatedSettings = mergeWith(
      existingSettings || {},
      settings,
      (
        _objValue: unknown,
        srcValue: unknown,
        key: string | number | symbol,
        object: Record<string | number | symbol, unknown>,
      ) => {
        // Handle undefined as deletion
        if (srcValue === undefined && object && typeof key === 'string') {
          delete object[key]
          return undefined
        }
        // For arrays, always replace with the provided array
        // This puts the responsibility on the caller to compute the desired final state
        if (Array.isArray(srcValue)) {
          return srcValue
        }
        // For non-arrays, let lodash handle the default merge behavior
        return undefined
      },
    )

    // Mark this as an internal write before writing the file
    markInternalWrite(filePath)

    writeFileSyncAndFlush_DEPRECATED(
      filePath,
      jsonStringify(updatedSettings, null, 2) + '\n',
    )

    // Invalidate the session cache since settings have been updated
    resetSettingsCache()

    if (source === 'localSettings') {
      // Okay to add to gitignore async without awaiting
      void addFileGlobRuleToGitignore(
        getRelativeSettingsFilePathForSource('localSettings'),
        getOriginalCwd(),
      )
    }
  } catch (e) {
    const error = new Error(
      `Failed to read raw settings from ${filePath}: ${e}`,
    )
    logError(error)
    return { error }
  }

  return { error: null }
}

/**
 * Custom merge function for arrays - concatenate and deduplicate
 */
function mergeArrays<T>(targetArray: T[], sourceArray: T[]): T[] {
  return uniq([...targetArray, ...sourceArray])
}

/**
 * Custom merge function for lodash mergeWith when merging settings.
 * Arrays are concatenated and deduplicated; other values use default lodash merge behavior.
 * Exported for testing.
 */
export function settingsMergeCustomizer(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return mergeArrays(objValue, srcValue)
  }
  // Return undefined to let lodash handle default merge behavior
  return undefined
}

/**
 * Get a list of setting keys from managed settings for logging purposes.
 * For certain nested settings (permissions, sandbox, hooks), expands to show
 * one level of nesting (e.g., "permissions.allow"). For other settings,
 * returns only the top-level key.
 *
 * @param settings The settings object to extract keys from
 * @returns Sorted array of key paths
 */
export function getManagedSettingsKeysForLogging(
  settings: SettingsJson,
): string[] {
  // Use .strip() to get only valid schema keys
  const validSettings = SettingsSchema().strip().parse(settings) as Record<
    string,
    unknown
  >
  const keysToExpand = ['permissions', 'sandbox', 'hooks']
  const allKeys: string[] = []

  // Define valid nested keys for each nested setting we expand
  const validNestedKeys: Record<string, Set<string>> = {
    permissions: new Set([
      'allow',
      'deny',
      'ask',
      'defaultMode',
      'disableBypassPermissionsMode',
      ...(feature('TRANSCRIPT_CLASSIFIER') ? ['disableAutoMode'] : []),
      'additionalDirectories',
    ]),
    sandbox: new Set([
      'enabled',
      'failIfUnavailable',
      'allowUnsandboxedCommands',
      'network',
      'filesystem',
      'ignoreViolations',
      'excludedCommands',
      'autoAllowBashIfSandboxed',
      'enableWeakerNestedSandbox',
      'enableWeakerNetworkIsolation',
      'allowAppleEvents',
      'ripgrep',
    ]),
    // For hooks, we use z.record with enum keys, so we validate separately
    hooks: new Set([
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'TeammateIdle',
      'TaskCreated',
      'TaskCompleted',
    ]),
  }

  for (const key of Object.keys(validSettings)) {
    if (
      keysToExpand.includes(key) &&
      validSettings[key] &&
      typeof validSettings[key] === 'object'
    ) {
      // Expand nested keys for these special settings (one level deep only)
      const nestedObj = validSettings[key] as Record<string, unknown>
      const validKeys = validNestedKeys[key]

      if (validKeys) {
        for (const nestedKey of Object.keys(nestedObj)) {
          // Only include known valid nested keys
          if (validKeys.has(nestedKey)) {
            allKeys.push(`${key}.${nestedKey}`)
          }
        }
      }
    } else {
      // For other settings, just use the top-level key
      allKeys.push(key)
    }
  }

  return allKeys.sort()
}

// Flag to prevent infinite recursion when loading settings
let isLoadingSettings = false

/**
 * Load settings from disk without using cache
 * This is the original implementation that actually reads from files
 */
function loadSettingsFromDisk(): SettingsWithErrors {
  // Prevent recursive calls to loadSettingsFromDisk
  if (isLoadingSettings) {
    return { settings: {}, errors: [] }
  }

  const startTime = Date.now()
  profileCheckpoint('loadSettingsFromDisk_start')
  logForDiagnosticsNoPII('info', 'settings_load_started')

  isLoadingSettings = true
  try {
    // Start with plugin settings as the lowest priority base.
    // All file-based sources (user, project, local, flag, policy) override these.
    // Plugin settings only contain allowlisted keys (e.g., agent) that are valid SettingsJson fields.
    const pluginSettings = getPluginSettingsBase()
    let mergedSettings: SettingsJson = {}
    if (pluginSettings) {
      mergedSettings = mergeWith(
        mergedSettings,
        pluginSettings,
        settingsMergeCustomizer,
      )
    }
    const allErrors: ValidationError[] = []
    const seenErrors = new Set<string>()
    const seenFiles = new Set<string>()

    // Merge settings from each source in priority order with deep merging
    for (const source of getEnabledSettingSources()) {
      // policySettings: "first source wins" — use the highest-priority source
      // that has content. Priority: remote > HKLM/plist > managed-settings.json > HKCU
      if (source === 'policySettings') {
        let policySettings: SettingsJson | null = null
        const policyErrors: ValidationError[] = []

        // 1. Remote (highest priority)
        const remoteSettings = getRemoteManagedSettingsSyncFromCache()
        if (remoteSettings && Object.keys(remoteSettings).length > 0) {
          const result = SettingsSchema().safeParse(remoteSettings)
          if (result.success) {
            policySettings = result.data
          } else {
            // Remote exists but is invalid — surface errors even as we fall through
            policyErrors.push(
              ...formatZodError(result.error, 'remote managed settings'),
            )
          }
        }

        // 2. Admin-only MDM (HKLM / macOS plist)
        if (!policySettings) {
          const mdmResult = getMdmSettings()
          if (Object.keys(mdmResult.settings).length > 0) {
            policySettings = mdmResult.settings
          }
          policyErrors.push(...mdmResult.errors)
        }

        // 3. managed-settings.json + managed-settings.d/ (file-based, requires admin)
        if (!policySettings) {
          const { settings, errors } = loadManagedFileSettings()
          if (settings) {
            policySettings = settings
          }
          policyErrors.push(...errors)
        }

        // 4. HKCU (lowest — user-writable, only if nothing above exists)
        if (!policySettings) {
          const hkcu = getHkcuSettings()
          if (Object.keys(hkcu.settings).length > 0) {
            policySettings = hkcu.settings
          }
          policyErrors.push(...hkcu.errors)
        }

        // Merge the winning policy source into the settings chain
        if (policySettings) {
          mergedSettings = mergeWith(
            mergedSettings,
            policySettings,
            settingsMergeCustomizer,
          )
        }
        for (const error of policyErrors) {
          const errorKey = `${error.file}:${error.path}:${error.message}`
          if (!seenErrors.has(errorKey)) {
            seenErrors.add(errorKey)
            allErrors.push(error)
          }
        }

        continue
      }

      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)

        // Skip if we've already loaded this file from another source
        if (!seenFiles.has(resolvedPath)) {
          seenFiles.add(resolvedPath)

          const { settings, errors } = parseSettingsFile(filePath)

          // Add unique errors (deduplication)
          for (const error of errors) {
            const errorKey = `${error.file}:${error.path}:${error.message}`
            if (!seenErrors.has(errorKey)) {
              seenErrors.add(errorKey)
              allErrors.push(error)
            }
          }

          if (settings) {
            mergedSettings = mergeWith(
              mergedSettings,
              settings,
              settingsMergeCustomizer,
            )
          }
        }
      }

      // For flagSettings, also merge any inline settings set via the SDK
      if (source === 'flagSettings') {
        const inlineSettings = getFlagSettingsInline()
        if (inlineSettings) {
          const parsed = SettingsSchema().safeParse(inlineSettings)
          if (parsed.success) {
            mergedSettings = mergeWith(
              mergedSettings,
              parsed.data,
              settingsMergeCustomizer,
            )
          }
        }
      }
    }

    logForDiagnosticsNoPII('info', 'settings_load_completed', {
      duration_ms: Date.now() - startTime,
      source_count: seenFiles.size,
      error_count: allErrors.length,
    })

    return { settings: mergedSettings, errors: allErrors }
  } finally {
    isLoadingSettings = false
  }
}

/**
 * Get merged settings from all sources in priority order
 * Settings are merged from lowest to highest priority:
 * userSettings -> projectSettings -> localSettings -> policySettings
 *
 * This function returns a snapshot of settings at the time of call.
 * For React components, prefer using useSettings() hook for reactive updates
 * when settings change on disk.
 *
 * Uses session-level caching to avoid repeated file I/O.
 * Cache is invalidated when settings files change via resetSettingsCache().
 *
 * @returns Merged settings from all available sources (always returns at least empty object)
 */
export function getInitialSettings(): SettingsJson {
  const { settings } = getSettingsWithErrors()
  return settings || {}
}

/**
 * @deprecated Use getInitialSettings() instead. This alias exists for backwards compatibility.
 */
export const getSettings_DEPRECATED = getInitialSettings

export type SettingsWithSources = {
  effective: SettingsJson
  /** Ordered low-to-high priority — later entries override earlier ones. */
  sources: Array<{ source: SettingSource; settings: SettingsJson }>
}

/**
 * Get the effective merged settings alongside the raw per-source settings,
 * in merge-priority order. Only includes sources that are enabled and have
 * non-empty content.
 *
 * Always reads fresh from disk — resets the session cache so that `effective`
 * and `sources` are consistent even if the change detector hasn't fired yet.
 */
export function getSettingsWithSources(): SettingsWithSources {
  // Reset both caches so getSettingsForSource (per-source cache) and
  // getInitialSettings (session cache) agree on the current disk state.
  resetSettingsCache()
  const sources: SettingsWithSources['sources'] = []
  for (const source of getEnabledSettingSources()) {
    const settings = getSettingsForSource(source)
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings })
    }
  }
  return { effective: getInitialSettings(), sources }
}

/**
 * Get merged settings and validation errors from all sources
 * This function now uses session-level caching to avoid repeated file I/O.
 * Settings changes require Claude Code restart, so cache is valid for entire session.
 * @returns Merged settings and all validation errors encountered
 */
export function getSettingsWithErrors(): SettingsWithErrors {
  // Use cached result if available
  const cached = getSessionSettingsCache()
  if (cached !== null) {
    return cached
  }

  // Load from disk and cache the result
  const result = loadSettingsFromDisk()
  profileCheckpoint('loadSettingsFromDisk_end')
  setSessionSettingsCache(result)
  return result
}

/**
 * Check if any raw settings file contains a specific key, regardless of validation.
 * This is useful for detecting user intent even when settings validation fails.
 * For example, if a user set cleanupPeriodDays but has validation errors elsewhere,
 * we can detect they explicitly configured cleanup and skip cleanup rather than
 * falling back to defaults.
 */
/**
 * Returns true if any trusted settings source has accepted the bypass
 * permissions mode dialog. projectSettings is intentionally excluded —
 * a malicious project could otherwise auto-bypass the dialog (RCE risk).
 */
export function hasSkipDangerousModePermissionPrompt(): boolean {
  return !!(
    getSettingsForSource('userSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('localSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('flagSettings')?.skipDangerousModePermissionPrompt ||
    getSettingsForSource('policySettings')?.skipDangerousModePermissionPrompt
  )
}

/**
 * 2.1.207 #1: auto mode no longer requires opt-in. Mirrors official `fui`,
 * which unconditionally returns `!0` — the opt-in dialog (`AutoModeOptInDialog`
 * / `showAutoModeOptIn`) was removed by 2.1.210. Auto mode is available without
 * consent on every provider, including Bedrock/Vertex/Foundry. The
 * `skipAutoPermissionPrompt` setting is no longer consulted here; the default
 * offer (`hasResetAutoModeOptInForDefaultOffer`) is a separate, one-time
 * migration flow. `disableAutoMode` (settings) still turns auto mode off.
 */
export function hasAutoModeOptIn(): boolean {
  return feature('TRANSCRIPT_CLASSIFIER')
}

/**
 * Returns true if the user dismissed the auto mode opt-in dialog with
 * "No, don't ask again". Mirrors official `autoModeOptInDismissed`. When true,
 * the opt-in dialog must NOT be shown again on future Shift+Tab cycles
 * (the user explicitly declined persistent opt-in). projectSettings excluded
 * (RCE hardening, same as hasAutoModeOptIn).
 */
export function hasAutoModeOptInDismissed(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return !!(
      getSettingsForSource('userSettings')?.autoModeOptInDismissed ||
      getSettingsForSource('localSettings')?.autoModeOptInDismissed ||
      getSettingsForSource('flagSettings')?.autoModeOptInDismissed ||
      getSettingsForSource('policySettings')?.autoModeOptInDismissed
    )
  }
  return false
}

/**
 * Returns whether plan mode should use auto mode semantics. Default true
 * (opt-out). Returns false if any trusted source explicitly sets false.
 * projectSettings is excluded so a malicious project can't control this.
 */
export function getUseAutoModeDuringPlan(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return (
      getSettingsForSource('policySettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('flagSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('userSettings')?.useAutoModeDuringPlan !== false &&
      getSettingsForSource('localSettings')?.useAutoModeDuringPlan !== false
    )
  }
  return true
}

/**
 * 2.1.207 #20: `mXe` — true when projectSettings and userSettings resolve to the
 * same file path. The binary skips the projectSettings ignore-warning in that
 * case (a single-file setup must not double-fire the warning).
 */
function isProjectSettingsSameAsUserSettings(): boolean {
  const projectPath = getSettingsFilePathForSource('projectSettings')
  const userPath = getSettingsFilePathForSource('userSettings')
  return (
    !!projectPath &&
    !!userPath &&
    resolve(projectPath) === resolve(userPath)
  )
}

// 2.1.207 #20: fire-once flag for the untrusted-source warning (binary `Lhl`).
// Re-running the scan on every getAutoModeConfig call would re-warn; the
// official binary sets `Lhl=!0` once and skips thereafter.
let autoModeUntrustedSourceWarningEmitted = false

/**
 * Returns the merged autoMode config from trusted settings sources.
 * Only available when TRANSCRIPT_CLASSIFIER is active; returns undefined otherwise.
 *
 * 2.1.207 #20: `autoMode` is no longer read from repo-controllable settings
 * (projectSettings/localSettings) — a malicious project could otherwise inject
 * classifier allow/deny rules (RCE risk). Mirrors official `Pve`: the read loop
 * only consumes `$hl = ["userSettings","flagSettings","policySettings"]`; when
 * `autoMode` is present in a repo-controllable source, warn once + emit
 * `tengu_settings_auto_mode_rules_untrusted_source_ignored`.
 */
export function getAutoModeConfig():
  | { allow?: string[]; soft_deny?: string[]; environment?: string[] }
  | undefined {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const schema = z.object({
      allow: z.array(z.string()).optional(),
      soft_deny: z.array(z.string()).optional(),
      hard_deny: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      environment: z.array(z.string()).optional(),
    })

    // Ignore-warn loop: repo-controllable sources are NOT trusted for classifier
    // rules. Scan once per process; warn + telemetry when `autoMode` is present.
    if (!autoModeUntrustedSourceWarningEmitted) {
      for (const untrusted of [
        'projectSettings',
        'localSettings',
      ] as const) {
        if (
          untrusted === 'projectSettings' &&
          isProjectSettingsSameAsUserSettings()
        ) {
          continue
        }
        const untrustedSettings = getSettingsForSource(untrusted)
        if (!untrustedSettings) continue
        if (
          schema.safeParse(
            (untrustedSettings as Record<string, unknown>).autoMode,
          ).success
        ) {
          autoModeUntrustedSourceWarningEmitted = true
          logForDebugging(
            `settings autoMode in ${untrusted} ignored — only user/flag/managed settings may set classifier rules (projectSettings and localSettings are repo-controllable)`,
            { level: 'warn' },
          )
          logEvent(
            'tengu_settings_auto_mode_rules_untrusted_source_ignored',
            {
              source:
                untrusted as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            },
          )
          break
        }
      }
    }

    const allow: string[] = []
    const soft_deny: string[] = []
    const hard_deny: string[] = []
    const environment: string[] = []

    // 2.1.207 #20: trusted sources only (binary `$hl`). localSettings/projectSettings
    // are excluded — see the ignore-warn loop above.
    for (const source of [
      'userSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const settings = getSettingsForSource(source)
      if (!settings) continue
      const result = schema.safeParse(
        (settings as Record<string, unknown>).autoMode,
      )
      if (result.success) {
        if (result.data.allow) allow.push(...result.data.allow)
        if (result.data.soft_deny) soft_deny.push(...result.data.soft_deny)
        if (result.data.hard_deny) hard_deny.push(...result.data.hard_deny)
        if (process.env.USER_TYPE === 'ant') {
          if (result.data.deny) soft_deny.push(...result.data.deny)
        }
        if (result.data.environment)
          environment.push(...result.data.environment)
      }
    }

    if (allow.length > 0 || soft_deny.length > 0 || hard_deny.length > 0 || environment.length > 0) {
      return {
        ...(allow.length > 0 && { allow }),
        ...(soft_deny.length > 0 && { soft_deny }),
        ...(hard_deny.length > 0 && { hard_deny }),
        ...(environment.length > 0 && { environment }),
      }
    }
  }
  return undefined
}

/**
 * Returns true if autoMode.classifyAllShell is set in any trusted settings
 * source. Mirrors official `aFr`: when true AND the session is in auto mode,
 * Bash/PowerShell allow rules are SUSPENDED so every shell command routes
 * through the classifier (rather than being short-circuited by an allow rule).
 * projectSettings excluded (RCE hardening, same as getAutoModeConfig).
 */
export function isAutoModeClassifyAllShellEnabled(): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 2.1.207 #20: trusted sources only (binary `$hl`). localSettings is
    // repo-controllable and excluded — a malicious project must not be able to
    // force classifyAllShell (which suspends shell allow rules).
    for (const source of [
      'userSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      const settings = getSettingsForSource(source)
      if (settings && (settings as Record<string, unknown>)?.autoMode) {
        const autoMode = (settings as Record<string, { classifyAllShell?: boolean }>).autoMode
        if (autoMode?.classifyAllShell === true) return true
      }
    }
  }
  return false
}

/**
 * Test-only reset for the fire-once `autoModeUntrustedSourceWarningEmitted`
 * flag. Mirrors the `_resetClassifierSonnet5DefaultCache` pattern in
 * yoloClassifier.ts. Not wired into any production code path.
 */
export function _resetAutoModeUntrustedSourceWarning(): void {
  autoModeUntrustedSourceWarningEmitted = false
}

export function rawSettingsContainsKey(key: string): boolean {
  for (const source of getEnabledSettingSources()) {
    // Skip policySettings - we only care about user-configured settings
    if (source === 'policySettings') {
      continue
    }

    const filePath = getSettingsFilePathForSource(source)
    if (!filePath) {
      continue
    }

    try {
      const { resolvedPath } = safeResolvePath(getFsImplementation(), filePath)
      const content = readFileSync(resolvedPath)
      if (!content.trim()) {
        continue
      }

      const rawData = safeParseJSON(content, false)
      if (rawData && typeof rawData === 'object' && key in rawData) {
        return true
      }
    } catch (error) {
      // File not found is expected - not all settings files exist
      // Other errors (permissions, I/O) should be tracked
      handleFileSystemError(error, filePath)
    }
  }

  return false
}

/**
 * Top-level commands exempt from the managed version gate. Users must be able
 * to remediate an out-of-range version, so `update`/`install`/`doctor` always
 * run regardless of requiredMinimumVersion/requiredMaximumVersion. Mirrors
 * the official `Dxm` set (2.1.163).
 */
const VERSION_GATE_SKIP_COMMANDS = new Set(['update', 'install', 'doctor'])

/**
 * Startup version gate (2.1.163). Returns a human-readable error string when
 * the current Claude Code version is outside the managed
 * requiredMinimumVersion/requiredMaximumVersion range enforced via policy
 * settings, or null to allow startup.
 *
 * Behavior mirrors the official `xwc`:
 * - No constraints → null.
 * - `topLevelCommand` in the skip set (update/install/doctor) → null (remediate).
 * - Current version not valid semver → null (can't compare).
 * - Invalid semver constraint → log at error level and ignore that constraint.
 * - current < requiredMinimumVersion → "older than the minimum version…".
 * - current > requiredMaximumVersion → "newer than the maximum version…".
 *
 * The caller writes the returned string to stderr and exits non-zero.
 */
export function getRequiredVersionError(opts: {
  currentVersion: string
  topLevelCommand?: string
}): string | null {
  const { currentVersion, topLevelCommand } = opts
  const policy = getSettingsForSource('policySettings')
  const requiredMinimumVersion = policy?.requiredMinimumVersion
  const requiredMaximumVersion = policy?.requiredMaximumVersion
  if (!requiredMinimumVersion && !requiredMaximumVersion) return null
  if (
    topLevelCommand !== undefined &&
    VERSION_GATE_SKIP_COMMANDS.has(topLevelCommand)
  ) {
    return null
  }
  // Current version must be a valid semver to compare meaningfully.
  if (!parseVersion(currentVersion)) return null

  if (requiredMinimumVersion) {
    const min = parseVersion(requiredMinimumVersion)
    if (!min) {
      logForDebugging(
        `requiredMinimumVersion '${requiredMinimumVersion}' is not a valid semver version — ignoring`,
        { level: 'error' },
      )
    } else if (!gte(currentVersion, min)) {
      return `Claude Code ${currentVersion} is older than the minimum version required by your organization (${requiredMinimumVersion}).\nUpdate Claude Code using your organization's approved method, then try again. If automatic updates are available, \`claude update\` may also work.`
    }
  }
  if (requiredMaximumVersion) {
    const max = parseVersion(requiredMaximumVersion)
    if (!max) {
      logForDebugging(
        `requiredMaximumVersion '${requiredMaximumVersion}' is not a valid semver version — ignoring`,
        { level: 'error' },
      )
    } else if (!lte(currentVersion, max)) {
      return `Claude Code ${currentVersion} is newer than the maximum version allowed by your organization (${requiredMaximumVersion}).\nYour organization requires version ${requiredMaximumVersion} or older. Install an approved version using your organization's approved method. \`claude install <version>\` may also work.`
    }
  }
  return null
}

/**
 * 2.1.129 (C2): resolve the per-skill listing override for a skill.
 *
 * Mirrors the official disable check `c=a.skillOverrides?.[e.name]` (where
 * `a` is the merged settings). Looks up the merged `skillOverrides` by the
 * skill's qualified name, falling back to its unqualified name. Returns the
 * override enum ('on'|'name-only'|'user-invocable-only'|'off') or undefined
 * (absent = 'on').
 *
 * The /skills toggle (cmd_skill_override_off) and override filtering wiring
 * live in skill-loading code; this helper centralizes the lookup so callers
 * don't each re-derive source precedence. (Skill filtering wiring = follow-up.)
 */
export function getSkillOverride(
  name: string,
  unqualifiedName?: string,
): 'on' | 'name-only' | 'user-invocable-only' | 'off' | undefined {
  const overrides = getInitialSettings().skillOverrides
  if (!overrides) return undefined
  return (
    overrides[name] ??
    (unqualifiedName ? overrides[unqualifiedName] : undefined)
  )
}

/**
 * 2.1.169 (C3): whether bundled skills/workflows are disabled.
 *
 * Mirrors the official `Mz`: true when CLAUDE_CODE_DISABLE_BUNDLED_SKILLS is
 * truthy OR the `disableBundledSkills` setting === true. When true, bundled
 * skills and workflows are removed entirely and built-in slash commands stay
 * typable but are hidden from the model. Plugins, .claude/skills/, and
 * .claude/commands/ are unaffected.
 */
export function isDisableBundledSkills(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS)) return true
  return getInitialSettings().disableBundledSkills === true
}

/**
 * 2.1.175 (A6): whether availableModels also constrains the Default model.
 *
 * Mirrors the official `enforceAvailableModels` flag. When true and
 * availableModels is a non-empty array, the Default model must be in
 * availableModels — otherwise Default resolves to the first allowed
 * availableModels entry (see the surgical wire in model.ts
 * `getDefaultMainLoopModelSetting`).
 *
 * Cascade-trust note (follow-up): the official binary refuses to honor
 * user/project-level enforceAvailableModels when a policy source exists but
 * failed to load ("enforceAvailableModels: a policy source exists but failed
 * to load; refusing cascade-trust mode"). This helper reads the merged flag;
 * the policy-failure refusal is a follow-up edge case.
 */
export function getEnforceAvailableModels(): boolean {
  return getInitialSettings().enforceAvailableModels === true
}

/**
 * 2.1.187 + 2.1.196 (A11): label suffix appended to a model display when an
 * org-configured default model is in effect. Mirrors the official `qFa()`:
 * ' · Org default'. (Verified: the binary has no "Role default" — only
 * "Org default" and "tier default".)
 */
export const ORG_DEFAULT_MODEL_LABEL = ' · Org default'

/**
 * 2.1.187 + 2.1.196 (A11): the org-configured default model, if any.
 *
 * Mirrors the official `m5()` → `eue()` → `zVr()`, which reads
 * `Pt().orgModelDefaultCache` ({name, updated_at, data_source,
 * override_user_selection}) — a server-side (claude.ai) model_access cache.
 * OCC does not yet plumb this cache; returns null until that lands (follow-up).
 * The /model "Org default" label wiring (ModelPicker) consumes this helper.
 */
export function getOrgDefaultModel(): string | null {
  // TODO(A11 follow-up): read orgModelDefaultCache from bootstrap state once
  // the server-side model_access entitlement cache is plumbed, then resolve
  // its `.name` the way the official vyi(e.name) does.
  return null
}

/**
 * 2.1.187 + 2.1.196 (A11): message fragment for a model rejected by org model
 * restrictions. Mirrors the official wording (used in plan-mode upgrade
 * refusals and the /model rejection path): "...is not permitted by the org
 * model restrictions (availableModels allowlist or model_access entitlement)".
 */
export const ORG_MODEL_RESTRICTION_REASON =
  'is not permitted by the org model restrictions (availableModels allowlist or model_access entitlement)'

/**
 * 2.1.139 (F7): CLAUDE_CODE_DISABLE_AGENT_VIEW env var + disableAgentView
 * setting. Mirrors the official `vto()`: returns a human-readable reason
 * string when the agent view (the on-demand daemon) is disabled, else null.
 * The env var and the managed setting are equivalent.
 */
export function getDisableAgentViewReason(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_AGENT_VIEW)) {
    return 'is disabled by CLAUDE_CODE_DISABLE_AGENT_VIEW'
  }
  if (getInitialSettings().disableAgentView === true) {
    return 'is disabled by the disableAgentView setting'
  }
  return null
}

/**
 * 2.1.98 (F8): CLAUDE_CODE_SCRIPT_CAPS — per-session script-invocation limit.
 * Mirrors the official `bga()`: reads the env var once per session, JSON-parses
 * it, and keeps only entries whose value is a finite number (script name →
 * max invocations). Returns null when unset or unparseable. Cached in a
 * module-level variable (EPe equivalent) so repeated calls don't re-parse.
 */
let scriptCapsCache: Record<string, number> | null | undefined
export function getScriptCaps(): Record<string, number> | null {
  if (scriptCapsCache !== undefined) {
    return scriptCapsCache
  }
  const raw = process.env.CLAUDE_CODE_SCRIPT_CAPS
  if (!raw) {
    scriptCapsCache = null
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const caps: Record<string, number> = {}
      for (const [name, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          caps[name] = value
        }
      }
      scriptCapsCache = caps
    } else {
      scriptCapsCache = null
    }
  } catch {
    scriptCapsCache = null
  }
  return scriptCapsCache
}

/**
 * 2.1.181 (F21): CLAUDE_CLIENT_PRESENCE_FILE env var. Mirrors the official
 * `qDm()`: when set, returns true iff the referenced presence-marker file
 * exists and is stat-able (another client is active). Returns false when the
 * env var is unset or the file cannot be statted.
 */
export function isClientPresenceFileActive(): boolean {
  const presenceFile = process.env.CLAUDE_CLIENT_PRESENCE_FILE
  if (!presenceFile) {
    return false
  }
  try {
    // statSync throws when the file is missing or inaccessible.
    getFsImplementation().statSync(presenceFile)
    return true
  } catch {
    return false
  }
}
