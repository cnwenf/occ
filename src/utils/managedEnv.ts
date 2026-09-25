import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
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
import { jsonStringify } from './slowOperations.js'

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

/**
 * CC 2.1.281 (#120) binary `g()` @197075905 — renders an env key for a debug
 * log line: JSON-string-escaped with the surrounding quotes dropped, then any
 * remaining non-printable-ASCII code point escaped as `\uXXXX`. Keeps the
 * warning single-line regardless of what a settings file put in the key name.
 * The range is intentional: printable ASCII starts at \x20, so every control
 * and non-ASCII code point gets escaped.
 */
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g

function formatEnvKeyName(key: string): string {
  return jsonStringify(key)
    .slice(1, -1)
    .replace(
      NON_PRINTABLE_ASCII,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
}

/**
 * One-time-per-(source, key) warning state for host-spawn-env drops (binary
 * `hostSpawnEnvDropWarned`). `filterSettingsEnv` runs several times per session
 * (pre-trust safe apply, then the full apply), so the Set keeps a single
 * ignored key from warning on every pass.
 */
const hostSpawnEnvDropWarned = new Set<string>()

/**
 * CC 2.1.281 (#120) binary `J()` @197082825 — report settings `env` keys that
 * were dropped because the launch environment already sets them. Message is
 * byte-exact against the official 2.1.281 ELF, including the `it`/`them`
 * plural switch, which keys off the number of NEWLY-reported keys (not the
 * number passed in).
 */
function warnHostSpawnEnvKeysIgnored(
  keys: ReadonlyArray<string>,
  source: string,
): void {
  const newKeys = keys.filter((key) => {
    const dedupeKey = `${source}:${key}`
    if (hostSpawnEnvDropWarned.has(dedupeKey)) return false
    hostSpawnEnvDropWarned.add(dedupeKey)
    return true
  })
  if (newKeys.length === 0) return
  const rendered = newKeys.map(formatEnvKeyName).join(', ')
  logForDiagnosticsNoPII(
    'warn',
    `Ignoring ${rendered} from ${source}: the environment this session was launched with already sets ${
      newKeys.length === 1 ? 'it' : 'them'
    }, and when the desktop app or a runner starts the session, the launch environment takes precedence over settings.`,
  )
}

/**
 * Drop settings `env` keys the host already set in the spawn environment
 * (binary `v()`). Since 2.1.281 (#120) each dropped key whose launch-env value
 * actually DIFFERS from the settings value is also reported once per
 * (source, key) — an identical value loses nothing, so it stays silent.
 */
function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
  source: SettingSource | 'globalConfig',
): Record<string, string> {
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  const overriddenKeys: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!ccdSpawnEnvKeys.has(key.toUpperCase())) {
      out[key] = value
      continue
    }
    if (process.env[key] !== value) overriddenKeys.push(key)
  }
  if (overriddenKeys.length > 0) {
    warnHostSpawnEnvKeysIgnored(overriddenKeys, source)
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
/**
 * CC 2.1.282 (P0) binary `Gcn` @~194559000 — the 48 telemetry env names that
 * project-scoped settings may no longer set, byte-exact and in binary order:
 * 35 OTLP exporter keys (7 suffixes × 5 signal families incl. PROFILES),
 * 2 Prometheus exporter keys, the telemetry enable/exporter selection vars,
 * the enhanced-telemetry beta flags, and the OTEL_LOG_* content knobs.
 * (OTEL_LOG_RAW_API_BODIES / ENABLE_BETA_TRACING_DETAILED / BETA_TRACING_ENDPOINT
 * are blocked separately — they were already on the 2.1.251 list above.)
 */
export const TELEMETRY_PROJECT_SCOPE_BLOCKED_ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_INSECURE',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_TRACES_INSECURE',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_INSECURE',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_LOGS_INSECURE',
  'OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROFILES_HEADERS',
  'OTEL_EXPORTER_OTLP_PROFILES_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROFILES_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_PROFILES_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_PROFILES_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_PROFILES_INSECURE',
  'OTEL_EXPORTER_PROMETHEUS_HOST',
  'OTEL_EXPORTER_PROMETHEUS_PORT',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'ENABLE_ENHANCED_TELEMETRY_BETA',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_MANAGED_SETTINGS',
] as const

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
  'CLAUDE_CODE_DISABLE_SUBSTITUTION_RM_PROMPT',
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
  // CC 2.1.282 (P0): project/local settings may no longer enable telemetry —
  // the official binary spreads `...Gcn` (48 telemetry env names, byte-exact
  // from the 2.1.282 ELF @~194559000) into the project-scope blocklist at this
  // position (right after OTEL_LOG_RAW_API_BODIES). An off-only exception
  // (isTelemetryOffOnlyException below, binary `Vcn`) keeps values that turn
  // telemetry OFF.
  ...TELEMETRY_PROJECT_SCOPE_BLOCKED_ENV_KEYS,
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

const PROJECT_SCOPED_SOURCES = new Set<SettingSource | 'globalConfig'>([
  'projectSettings',
  'localSettings',
])

/** One-time-per-key warning state for dropped project-scope env keys. */
const projectScopeDropWarned = new Set<string>()

/**
 * CC 2.1.282 binary `Wd` — blocked telemetry keys kept from project/local
 * scope when their value turns the feature OFF (falsy per `ko`).
 */
const TELEMETRY_OFF_ONLY_FALSY_KEYS = new Set([
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_TOOL_DETAILS',
])

/**
 * CC 2.1.282 binary `Gd` — exporter-selection keys kept from project/local
 * scope only when the value is exactly "none" (disables the exporter).
 */
const TELEMETRY_EXPORTER_NONE_KEYS = new Set([
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_EXPORTER',
])

/**
 * CC 2.1.282 binary `Vcn` — the off-only exception to the project-scope
 * telemetry blocklist. A blocked key set by project/local settings is KEPT
 * when (a) the key is exact-uppercase, (b) the value is a string/number/
 * boolean, (c) the value turns telemetry off — `ko`-falsy for the
 * OTEL_LOG_* content knobs, or the literal "none" for the exporter-selection
 * vars — and (d) no same-name variable exists in the env above project
 * settings (spawn env, --settings, or managed settings), so a project file
 * can never downgrade a higher tier's telemetry configuration.
 */
export function isTelemetryOffOnlyException(
  key: string,
  value: unknown,
  getEnvAbove: () => Record<string, string | undefined>,
): boolean {
  if (key !== key.toUpperCase()) return false
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    return false
  }
  const isOffValue = TELEMETRY_OFF_ONLY_FALSY_KEYS.has(key)
    ? // Binary calls ko(boolean ? v : String(v)) — isEnvDefinedFalsy is OCC's
      // byte-equivalent `ko` parser ("0"/"false"/"no"/"off", boolean negated).
      isEnvDefinedFalsy(typeof value === 'boolean' ? value : String(value))
    : TELEMETRY_EXPORTER_NONE_KEYS.has(key) && String(value).trim() === 'none'
  if (!isOffValue) return false
  return !Object.keys(getEnvAbove()).some((k) => k.toUpperCase() === key)
}

// ---------------------------------------------------------------------------
// CC 2.1.282 pre-settings env snapshot (binary class `B` members
// getPreSettingsEnvSnapshot / latchPreSettingsEnvSnapshot /
// envAboveProjectSettings / peekPreSettingsEnvSnapshot /
// dropPreSettingsEnvSnapshot, @~198156000-198160500).
//
// The official binary keeps this state on the env-store class inside the
// managed-env module. OCC keeps it as module-level state here — same module
// boundary, same semantics: a lazily-captured frozen copy of process.env from
// BEFORE any settings.env is applied, used to decide what counts as "above
// project settings" for the Vcn off-only exception. Both apply functions
// (applySafeConfigEnvironmentVariables / applyConfigEnvironmentVariables)
// capture it as their first statement, exactly like the official.
// ---------------------------------------------------------------------------

/** Frozen `{...process.env}` captured before any settings.env is applied. */
let preSettingsEnvSnapshot:
  | Readonly<Record<string, string | undefined>>
  | undefined

/** Uppercase env names present at launch (set when the snapshot is dropped). */
let launchNamesBeforeClaim: Set<string> | undefined

/** Snapshot keys (uppercase) that came from user-tier settings.env. */
let userTierNamesInSnapshot: Set<string> = new Set()

/**
 * Uppercase env keys contributed by globalConfig/userSettings env (binary
 * `userTierNames`, populated at the end of filterSettingsEnv). Excluded from
 * envAboveProjectSettings so a user-tier key that merely shadowed a launch
 * env var doesn't count as "above project settings" on a later re-latch.
 */
const userTierNames = new Set<string>()

/** Binary `latchPreSettingsEnvSnapshot` — freeze + compute the user-tier overlap. */
function latchPreSettingsEnvSnapshot(
  snapshot: Record<string, string | undefined>,
): Readonly<Record<string, string | undefined>> {
  const launchNames = launchNamesBeforeClaim
  userTierNamesInSnapshot = new Set(
    launchNames === undefined
      ? []
      : Object.keys(snapshot)
          .map((key) => key.toUpperCase())
          .filter((key) => userTierNames.has(key) && !launchNames.has(key)),
  )
  return Object.freeze(snapshot)
}

/** Binary `getPreSettingsEnvSnapshot` — lazy one-shot capture. */
export function getPreSettingsEnvSnapshot(): Readonly<
  Record<string, string | undefined>
> {
  preSettingsEnvSnapshot ??= latchPreSettingsEnvSnapshot({ ...process.env })
  return preSettingsEnvSnapshot
}

/** Binary `peekPreSettingsEnvSnapshot` — read without capturing. */
export function peekPreSettingsEnvSnapshot():
  | Readonly<Record<string, string | undefined>>
  | undefined {
  return preSettingsEnvSnapshot
}

/** Binary `dropPreSettingsEnvSnapshot` — release the snapshot (e.g. after claim). */
export function dropPreSettingsEnvSnapshot(
  extraLaunchNames?: readonly string[],
): void {
  if (extraLaunchNames !== undefined && preSettingsEnvSnapshot) {
    launchNamesBeforeClaim = new Set(
      [...Object.keys(preSettingsEnvSnapshot), ...extraLaunchNames].map((key) =>
        key.toUpperCase(),
      ),
    )
  }
  preSettingsEnvSnapshot = undefined
}

/**
 * Binary `envAboveProjectSettings` — everything that outranks project/local
 * settings for the Vcn shadow check: the pre-settings spawn env (minus keys
 * that only exist because user-tier settings put them there), then
 * --settings (flagSettings) env, then managed (policySettings) env.
 */
export function envAboveProjectSettings(): Record<
  string,
  string | undefined
> {
  const snapshot = getPreSettingsEnvSnapshot()
  const spawnOnly: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(snapshot)) {
    if (!userTierNamesInSnapshot.has(key.toUpperCase())) {
      spawnOnly[key] = value
    }
  }
  return {
    ...spawnOnly,
    ...getSettingsForSource('flagSettings')?.env,
    ...getSettingsForSource('policySettings')?.env,
  }
}

/**
 * Drop env keys that project-scoped settings may not set (binary `U`, 2.1.282
 * 4-param form `U(e, n, o, r)`). Non-project scopes pass through unchanged.
 * Since 2.1.282 a blocked telemetry key is KEPT when it only turns telemetry
 * off and nothing above project settings sets the same name (binary `Vcn`).
 * Each dropped key warns once:
 * "<KEY> in .claude/settings.json is ignored — project-scoped settings
 * can't set this key. Set it in ~/.claude/settings.json or managed
 * settings instead."
 */
function filterProjectScopeBlockedKeys(
  env: Record<string, string> | undefined,
  source: SettingSource | 'globalConfig',
  warned: Set<string>,
  getEnvAbove: () => Record<string, string | undefined>,
): Record<string, string> {
  if (!env || !PROJECT_SCOPED_SOURCES.has(source)) return env || {}
  let filtered: Record<string, string> | undefined
  for (const key of Object.keys(env)) {
    // Official keep-condition: `if(!j(E)||Vcn(E,e[E],r))continue`
    if (
      !PROJECT_SCOPE_BLOCKED_ENV_KEYS.has(key.toUpperCase()) ||
      isTelemetryOffOnlyException(key, env[key], getEnvAbove)
    ) {
      continue
    }
    filtered ??= { ...env }
    delete filtered[key]
    if (!warned.has(key)) {
      warned.add(key)
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
 * The source name is threaded down to the last filter so the 2.1.281 "already
 * sets it" warning can name the settings file the key came from.
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
  source: SettingSource | 'globalConfig',
): Record<string, string> {
  const filtered = withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(
      withoutSSHTunnelVars(
        filterProjectScopeBlockedKeys(
          env,
          source,
          projectScopeDropWarned,
          envAboveProjectSettings,
        ),
      ),
    ),
    source,
  )
  // CC 2.1.282 binary tail of filterSettingsEnv: record user-tier env key
  // names so a later snapshot re-latch can tell spawn-env keys from keys the
  // user's own settings put into the environment.
  if (source === 'globalConfig' || source === 'userSettings') {
    for (const key of Object.keys(filtered)) {
      userTierNames.add(key.toUpperCase())
    }
  }
  return filtered
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
  // CC 2.1.282: official `applySafeConfigEnvironmentVariables(){this.getPreSettingsEnvSnapshot(),...}`
  // — capture the pre-settings env snapshot first, before anything mutates
  // process.env, so the Vcn off-only exception can see the launch env.
  getPreSettingsEnvSnapshot()

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
  // CC 2.1.282: official `applyConfigEnvironmentVariables(){this.getPreSettingsEnvSnapshot(),...}`
  // — same first-statement snapshot capture as the safe path.
  getPreSettingsEnvSnapshot()

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
  hostSpawnEnvDropWarned.clear()
  otelDominanceDropWarned = new Set<string>()
  ccdSpawnEnvKeys = undefined
  preSettingsEnvSnapshot = undefined
  launchNamesBeforeClaim = undefined
  userTierNamesInSnapshot = new Set()
  userTierNames.clear()
}

/** Test-only accessor for the project-scope blocklist. */
export function _getProjectScopeBlockedEnvKeysForTesting(): ReadonlySet<string> {
  return PROJECT_SCOPE_BLOCKED_ENV_KEYS
}
