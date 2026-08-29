import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import {
  getEnabledSettingSources,
  SETTING_SOURCES,
  type SettingSource,
} from './settings/constants.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * `claude ssh` remote: ANTHROPIC_UNIX_SOCKET routes auth through a -R forwarded
 * socket to a local proxy, and the launcher sets a handful of placeholder auth
 * env vars that the remote's ~/.claude settings.env MUST NOT clobber (see
 * isAnthropicAuthEnabled). Strip them from any settings-sourced env object.
 */
function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    ANTHROPIC_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    CLAUDE_CODE_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * When the host owns inference routing (sets
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST in spawn env), strip
 * provider-selection / model-default vars from settings-sourced env so a
 * user's ~/.claude/settings.json can't redirect requests away from the
 * host-configured provider.
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * Snapshot of env keys present before any settings.env is applied — for CCD,
 * these are the keys the desktop host set to orchestrate the subprocess.
 * Settings must not override them (OTEL_LOGS_EXPORTER=console would corrupt
 * the stdio JSON-RPC transport). Keys added LATER by user/project settings
 * are not in this set, so mid-session settings.json changes still apply.
 * Lazy-captured on first applySafeConfigEnvironmentVariables() call.
 * Uppercase-normalized (env keys are compared case-insensitively here).
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key.toUpperCase())) out[key] = value
  }
  return out
}

/**
 * CC 2.1.251 security fix: "project settings being able to enable detailed
 * beta tracing or raw API body logging" (plus the related project-scope env
 * hardening). Env keys that project-scoped settings (.claude/settings.json,
 * .claude/settings.local.json) may never set — a repo-committed settings file
 * must not be able to point detailed tracing / raw API body logging (or the
 * other session-control knobs below) at an attacker-controlled destination.
 * User (~/.claude/settings.json), CLI-flag, and managed settings may still
 * set them. Recovered verbatim from the official 2.1.251 binary.
 */
const PROJECT_SCOPE_BLOCKED_ENV_KEYS = new Set<string>([
  'CLAUDE_CODE_PROCESS_WRAPPER',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_SYNC_SKILLS',
  'CLAUDE_CODE_SYNC_PLUGINS',
  'CLAUDE_CODE_SKILL_PROPOSALS',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'CLAUDE_CODE_PLUGIN_ATTRIBUTION',
  'CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE',
  'CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER',
  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
  'CLAUDE_CODE_RATE_LIMIT_TIER',
  'CLAUDE_CODE_FEDERATION_CACHE_DIR',
  'ANTHROPIC_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'HOME',
  'APPDATA',
  'USERPROFILE',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'CLAUDE_CODE_SAFE_MODE',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_HARBOR_KITE',
  'CLAUDE_CODE_HARBOR_KITE_CLOUD',
  'CLAUDE_CODE_HARBOR_KITE_PACING_OFF',
  'CLAUDE_CODE_SILENT_TURN_REMINDER',
  'CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS',
  'CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT',
  'CLAUDE_CODE_ARTIFACT_ROOM',
  'CLAUDE_CODE_ARTIFACT_PRESENCE',
  'USER_TYPE',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CODE_TOASTY_THIMBLE',
  'CLAUDE_CODE_GENTLE_PARASOL',
  'CLAUDE_CODE_DIR_SYNC_DISABLE_ANCHORING',
  'CLAUDE_CODE_LEGACY_BUNDLE',
  'CLAUDE_CODE_DIR_SYNC_ENGINE',
  'CLAUDE_CODE_DIR_SYNC_FFWD',
  'CLAUDE_CODE_DIR_SYNC_STREAM',
  'GITHUB_ACTIONS',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'ENABLE_BETA_TRACING_DETAILED',
  'BETA_TRACING_ENDPOINT',
  'OTEL_LOG_RAW_API_BODIES',
  'CLAUDE_PTY_RECORD',
  'CLAUDE_CODE_DEBUG_LOGS_DIR',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_CODE_PERFETTO_TRACE',
  'CLAUDE_CODE_FRAME_TIMING_LOG',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'AUTOMODE_DECISION_LOG',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_TMPDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_RUNTIME_DIR',
  'CLAUDE_JOB_DIR',
])

const PROJECT_SCOPED_SOURCES = new Set<SettingSource>([
  'projectSettings',
  'localSettings',
])

/** One-time-per-key warning state for dropped project-scope env keys. */
const projectScopeDropWarned = new Set<string>()

/**
 * Drop env keys that project-scoped settings may not set (binary `N`).
 * Non-project scopes pass through unchanged. Each dropped key warns once:
 * "<KEY> in .claude/settings.json is ignored — project-scoped settings
 * can't set this key. Set it in ~/.claude/settings.json or managed
 * settings instead."
 */
function filterProjectScopeBlockedKeys(
  env: Record<string, string> | undefined,
  source: SettingSource | 'globalConfig',
): Record<string, string> {
  if (!env || !PROJECT_SCOPED_SOURCES.has(source)) return env || {}
  let filtered: Record<string, string> | undefined
  for (const key of Object.keys(env)) {
    if (!PROJECT_SCOPE_BLOCKED_ENV_KEYS.has(key.toUpperCase())) continue
    filtered ??= { ...env }
    delete filtered[key]
    if (!projectScopeDropWarned.has(key)) {
      projectScopeDropWarned.add(key)
      logForDiagnosticsNoPII(
        'warn',
        `${key} in ${
          source === 'localSettings'
            ? '.claude/settings.local.json'
            : '.claude/settings.json'
        } is ignored — project-scoped settings can't set this key. Set it in ~/.claude/settings.json or managed settings instead.`,
      )
    }
  }
  return filtered ?? env
}

/**
 * Compose the strip filters applied to every settings-sourced env object.
 * Order mirrors the official binary pipeline: project-scope blocklist →
 * SSH-tunnel strip → host-managed-provider strip → host spawn-env strip.
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
  source: SettingSource | 'globalConfig',
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(
      withoutSSHTunnelVars(filterProjectScopeBlockedKeys(env, source)),
    ),
  )
}

/**
 * CC 2.1.251 security fix: "a lower-scope beta tracing endpoint bypassing
 * an OTLP collector pinned by managed settings or a host app". When managed
 * (policy) settings or the host spawn env claim the OTEL exporter family,
 * lower-trust scopes must not be able to redirect the signals — including
 * through the independent BETA_TRACING_ENDPOINT side channel. Recovered
 * verbatim from the official 2.1.251 binary (enforceManagedOtelFamilyDominance
 * and helpers).
 */
const OTEL_EXPORTER_PREFIX = 'OTEL_EXPORTER_OTLP_'
const OTEL_SIGNALS = ['TRACES', 'METRICS', 'LOGS', 'PROFILES'] as const
const OTEL_CLAIM_EXPANSION_SUFFIXES = new Set([
  'HEADERS',
  'CLIENT_KEY',
  'CLIENT_CERTIFICATE',
])
const OTEL_EXPORTER_SELECTION_VARS = new Set([
  'OTEL_LOGS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
])
const ENABLE_TELEMETRY_VAR = 'CLAUDE_CODE_ENABLE_TELEMETRY'
const BETA_TRACING_ENDPOINT_VAR = 'BETA_TRACING_ENDPOINT'

/** One-time-per-key warning state for dominance drops. */
let otelDominanceDropWarned = new Set<string>()

/** True when an OTEL_*_EXPORTER value does not include the `otlp` exporter. */
function exporterLacksOtlp(value: string): boolean {
  return !value
    .split(',')
    .map((part) => part.trim())
    .includes('otlp')
}

function dropDominatedOtelKey(
  key: string,
  redirectedWhat: string,
  claimer: string,
  claims: Map<string, string>,
  claimSource = 'managed settings',
): void {
  // Value identical to the dominant claim → not a redirect; keep it.
  if (claims.get(key) === process.env[key]) return
  // Set directly by the host spawn env → host-owned, keep it.
  if (ccdSpawnEnvKeys?.has(key.toUpperCase())) return
  if (process.env[key] === undefined) return
  if (!otelDominanceDropWarned.has(key)) {
    otelDominanceDropWarned.add(key)
    logForDiagnosticsNoPII(
      'warn',
      `Dropping ${key}: ${claimer} is claimed by ${claimSource}, so lower-trust scopes cannot redirect ${redirectedWhat}`,
    )
  }
  delete process.env[key]
}

function dropDominatedBetaTracingEndpoint(
  claimer: string,
  claims: Map<string, string>,
  claimSource = 'managed settings',
): void {
  dropDominatedOtelKey(
    BETA_TRACING_ENDPOINT_VAR,
    'the logs and traces signals through detailed beta tracing',
    claimer,
    claims,
    claimSource,
  )
}

/**
 * Telemetry claims contributed by the host spawn env (CCD desktop host):
 * when the host orchestrated the subprocess, every spawn-time env key is
 * host-owned. The telemetry claims are the exporter-selection vars,
 * CLAUDE_CODE_ENABLE_TELEMETRY, and all OTEL_EXPORTER_OTLP_* keys when any
 * OTEL endpoint (incl. BETA_TRACING_ENDPOINT) is non-empty in the spawn env.
 */
function hostSpawnOtelClaims(): Map<string, string> {
  const claims = new Map<string, string>()
  if (!ccdSpawnEnvKeys) return claims
  const anyEndpointNonEmpty = [...ccdSpawnEnvKeys].some((key) => {
    return (
      (key.startsWith(OTEL_EXPORTER_PREFIX) && key.endsWith('_ENDPOINT')) ||
      key === BETA_TRACING_ENDPOINT_VAR
    ) &&
      (process.env[key] ?? '').trim() !== ''
  })
  for (const key of ccdSpawnEnvKeys) {
    const isExporterOrTelemetry =
      OTEL_EXPORTER_SELECTION_VARS.has(key) || key === ENABLE_TELEMETRY_VAR
    const isOtelFamily = anyEndpointNonEmpty && key.startsWith(OTEL_EXPORTER_PREFIX)
    if (!isExporterOrTelemetry && !isOtelFamily) continue
    const value = process.env[key]
    if (value !== undefined) claims.set(key, value)
  }
  return claims
}

/**
 * Expand dominant claims: a claim on one OTEL family key dominates the
 * related keys of every signal (and, for logs/traces-affecting claims, the
 * BETA_TRACING_ENDPOINT side channel).
 */
function applyOtelFamilyClaims(
  claims: Map<string, string>,
  allClaims: Map<string, string>,
  claimSource: string,
): void {
  for (const [key, value] of claims) {
    if (key === ENABLE_TELEMETRY_VAR) {
      // Managed/host disables telemetry → kill the beta-tracing side channel.
      if (process.env[key] === value && !isEnvTruthy(value)) {
        dropDominatedBetaTracingEndpoint(key, allClaims, claimSource)
      }
      continue
    }
    if (OTEL_EXPORTER_SELECTION_VARS.has(key)) {
      // Managed/host exporter selection is not otlp → kill the otlp side channel.
      if (process.env[key] === value && exporterLacksOtlp(value)) {
        dropDominatedBetaTracingEndpoint(key, allClaims, claimSource)
      }
      continue
    }
    if (!key.startsWith(OTEL_EXPORTER_PREFIX)) continue
    if (value.trim() === '') continue
    if (process.env[key] !== value) continue
    const signal = OTEL_SIGNALS.find((candidate) =>
      key.startsWith(`${OTEL_EXPORTER_PREFIX}${candidate}_`),
    )
    if (signal) {
      const suffix = key.slice(`${OTEL_EXPORTER_PREFIX}${signal}_`.length)
      const isLogsOrTraces = signal === 'TRACES' || signal === 'LOGS'
      if (OTEL_CLAIM_EXPANSION_SUFFIXES.has(suffix)) {
        dropDominatedOtelKey(
          `${OTEL_EXPORTER_PREFIX}${signal}_ENDPOINT`,
          `the ${signal.toLowerCase()} signal`,
          key,
          allClaims,
          claimSource,
        )
        if (isLogsOrTraces) {
          dropDominatedBetaTracingEndpoint(key, allClaims, claimSource)
        }
      } else if (suffix === 'ENDPOINT' && isLogsOrTraces) {
        dropDominatedBetaTracingEndpoint(key, allClaims, claimSource)
      }
      continue
    }
    const bareSuffix = key.slice(OTEL_EXPORTER_PREFIX.length)
    const isExpansionSuffix = OTEL_CLAIM_EXPANSION_SUFFIXES.has(bareSuffix)
    const impliedSuffixes = isExpansionSuffix
      ? [bareSuffix, 'ENDPOINT']
      : [bareSuffix]
    for (const suffix of impliedSuffixes) {
      for (const signal of OTEL_SIGNALS) {
        dropDominatedOtelKey(
          `${OTEL_EXPORTER_PREFIX}${signal}_${suffix}`,
          `the ${signal.toLowerCase()} signal`,
          key,
          allClaims,
          claimSource,
        )
      }
    }
    if (isExpansionSuffix) {
      dropDominatedOtelKey(
        `${OTEL_EXPORTER_PREFIX}ENDPOINT`,
        'telemetry for any signal',
        key,
        allClaims,
        claimSource,
      )
    }
    if (impliedSuffixes.includes('ENDPOINT')) {
      dropDominatedBetaTracingEndpoint(key, allClaims, claimSource)
    }
  }
}

/**
 * Enforce managed/host dominance over the OTEL exporter family. Called at
 * the end of both env-apply paths (pre-trust safe apply and full apply),
 * mirroring the official call sites.
 */
export function enforceManagedOtelFamilyDominance(): void {
  const policySettings = getSettingsForSource('policySettings')
  const policyEnv = policySettings?.env
  const hasHeadersHelper =
    (policySettings?.otelHeadersHelper ?? '').trim() !== ''
  const claims = new Map<string, string>()
  for (const [key, value] of Object.entries(policyEnv ?? {})) {
    const upper = key.toUpperCase()
    // First writer wins; prefer the exact-uppercase spelling when present.
    if (!claims.has(upper) || key === upper) claims.set(upper, value)
  }
  applyOtelFamilyClaims(hostSpawnOtelClaims(), claims, 'the host spawn env')
  if (!policyEnv && !hasHeadersHelper) return
  if (hasHeadersHelper) {
    // otelHeadersHelper pins every signal endpoint (and the beta endpoint).
    for (const signal of OTEL_SIGNALS) {
      dropDominatedOtelKey(
        `${OTEL_EXPORTER_PREFIX}${signal}_ENDPOINT`,
        `the ${signal.toLowerCase()} signal`,
        'otelHeadersHelper',
        claims,
      )
    }
    dropDominatedOtelKey(
      `${OTEL_EXPORTER_PREFIX}ENDPOINT`,
      'telemetry for any signal',
      'otelHeadersHelper',
      claims,
    )
    dropDominatedBetaTracingEndpoint('otelHeadersHelper', claims)
  }
  applyOtelFamilyClaims(claims, claims, 'managed settings')
}

/**
 * Sources applied per-source in canonical low-to-high priority order
 * (SETTING_SOURCES order), filtered by enabled sources. Applying per source
 * (instead of the merged env blob) is what lets the project-scope blocklist
 * see which scope each env key came from — mirroring the official binary.
 */
function getApplicationOrderSources(): SettingSource[] {
  const enabled = new Set(getEnabledSettingSources())
  return SETTING_SOURCES.filter((source) => enabled.has(source))
}

/**
 * Trusted setting sources whose env vars can be applied before the trust dialog.
 *
 * - userSettings (~/.claude/settings.json): controlled by the user, not project-specific
 * - flagSettings (--settings CLI flag or SDK inline settings): explicitly passed by the user
 * - policySettings (managed settings from enterprise API or local managed-settings.json):
 *   controlled by IT/admin (highest priority, cannot be overridden)
 *
 * Project-scoped sources (projectSettings, localSettings) are excluded because they live
 * inside the project directory and could be committed by a malicious actor to redirect
 * traffic (e.g., ANTHROPIC_BASE_URL) to an attacker-controlled server.
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * Apply environment variables from trusted sources to process.env.
 * Called before the trust dialog so that user/enterprise env vars like
 * ANTHROPIC_BASE_URL take effect during first-run/onboarding.
 *
 * For trusted sources (user settings, managed settings, CLI flags), ALL env vars
 * are applied — including ones like ANTHROPIC_BASE_URL that would be dangerous
 * from project-scoped settings.
 *
 * For project-scoped sources (projectSettings, localSettings), only safe env vars
 * from the SAFE_ENV_VARS allowlist are applied, and keys on the project-scope
 * blocklist (PROJECT_SCOPE_BLOCKED_ENV_KEYS) are never applied from those
 * scopes. These are applied after trust is fully established via
 * applyConfigEnvironmentVariables().
 */
export function applySafeConfigEnvironmentVariables(): void {
  // Capture CCD spawn-env keys before any settings.env is applied (once).
  // Uppercase-normalized for case-insensitive comparison.
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env).map((key) => key.toUpperCase()))
        : null
  }

  // Global config (~/.claude.json) is user-controlled. In CCD mode,
  // filterSettingsEnv strips keys that were in the spawn env snapshot so
  // the desktop host's operational vars (OTEL, etc.) are not overridden.
  Object.assign(
    process.env,
    filterSettingsEnv(getGlobalConfig().env, 'globalConfig'),
  )

  // Apply ALL env vars from trusted setting sources, policySettings last.
  // Gate on isSettingSourceEnabled so SDK settingSources: [] (isolation mode)
  // doesn't get clobbered by ~/.claude/settings.json env (gh#217). policy/flag
  // sources are always enabled, so this only ever filters userSettings.
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue
    if (!getEnabledSettingSources().includes(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env, source),
    )
  }

  // Compute remote-managed-settings eligibility now, with userSettings and
  // flagSettings env applied. Eligibility reads CLAUDE_CODE_USE_BEDROCK,
  // ANTHROPIC_BASE_URL — both settable via settings.env.
  // getSettingsForSource('policySettings') below consults the remote cache,
  // which guards on this. The two-phase structure makes the ordering
  // dependency visible: non-policy env → eligibility → policy env.
  isRemoteManagedSettingsEligible()

  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env, 'policySettings'),
  )

  // Apply only safe env vars, per source in priority order (each source
  // blocklist-filtered). Later sources override earlier ones via the
  // uppercase-keyed map, matching the merged-settings priority — except
  // project-scoped values for blocked keys never contribute (that is the
  // CC 2.1.251 fix: e.g. OTEL_LOG_RAW_API_BODIES stays applicable from
  // user/managed settings but not from a repo-committed .claude/settings.json).
  const safeEnv = new Map<string, { key: string; value: string }>()
  for (const source of getApplicationOrderSources()) {
    const sourceEnv = filterSettingsEnv(getSettingsForSource(source)?.env, source)
    for (const [key, value] of Object.entries(sourceEnv)) {
      safeEnv.set(key.toUpperCase(), { key, value })
    }
  }
  for (const { key, value } of safeEnv.values()) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }

  enforceManagedOtelFamilyDominance()
}

/**
 * Apply environment variables from settings to process.env.
 * This applies ALL environment variables (except provider-routing vars when
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is set — see filterSettingsEnv, and
 * except project-scope-blocked keys from project/local sources) and should
 * only be called after trust is established. This applies potentially
 * dangerous environment variables such as LD_PRELOAD, PATH, etc.
 */
export function applyConfigEnvironmentVariables(): void {
  Object.assign(
    process.env,
    filterSettingsEnv(getGlobalConfig().env, 'globalConfig'),
  )

  // Per-source application in priority order (each source blocklist-filtered)
  // instead of the merged env blob, so project-scoped settings can't set the
  // blocked keys (CC 2.1.251 fix).
  for (const source of getApplicationOrderSources()) {
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env, source),
    )
  }

  enforceManagedOtelFamilyDominance()

  // Clear caches so agents are rebuilt with the new env vars
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()

  // Reconfigure proxy/mTLS agents to pick up any proxy env vars from settings
  configureGlobalAgents()
}

/** Test-only reset of the module-level warning sets and spawn-env snapshot. */
export function _resetManagedEnvForTesting(): void {
  projectScopeDropWarned.clear()
  otelDominanceDropWarned = new Set<string>()
  ccdSpawnEnvKeys = undefined
}

/** Test-only accessor for the project-scope blocklist. */
export function _getProjectScopeBlockedEnvKeysForTesting(): ReadonlySet<string> {
  return PROJECT_SCOPE_BLOCKED_ENV_KEYS
}
