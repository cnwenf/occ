import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.251 security fixes (Gap-109d):
 *  1. "project settings being able to enable detailed beta tracing or raw API
 *     body logging" — project-scoped settings (.claude/settings.json,
 *     .claude/settings.local.json) may no longer set the keys on the
 *     PROJECT_SCOPE_BLOCKED_ENV_KEYS blocklist; user/flag/managed scopes can.
 *  2. "a lower-scope beta tracing endpoint bypassing an OTLP collector pinned
 *     by managed settings or a host app" — enforceManagedOtelFamilyDominance:
 *     managed/host claims over the OTEL exporter family dominate lower-trust
 *     process.env values, including the BETA_TRACING_ENDPOINT side channel.
 *
 * Both behaviors recovered verbatim from the official 2.1.251 linux-x64
 * binary (P7n managed-env class) and ported into src/utils/managedEnv.ts.
 */

// Mutable per-source settings store the mocked getSettingsForSource reads.
const settingsBySource: Record<string, { env?: Record<string, string>; otelHeadersHelper?: string } | null> = {}

// OCC-97 mock-leak discipline: spread the real module, override only what
// this suite needs, and restore the untouched module after the suite.
const actualSettingsModule = await import('../settings/settings.js')
const actualConfigModule = await import('../config.js')

mock.module('../settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
}))
mock.module('../config.js', () => ({
  ...actualConfigModule,
  getGlobalConfig: () => ({ env: {} }),
}))

afterAll(() => {
  mock.module('../settings/settings.js', () => ({ ...actualSettingsModule }))
  mock.module('../config.js', () => ({ ...actualConfigModule }))
})

const {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
  enforceManagedOtelFamilyDominance,
  _resetManagedEnvForTesting,
  _getProjectScopeBlockedEnvKeysForTesting,
} = await import('../managedEnv.js')

/** Keys this suite touches on process.env, for save/restore. */
const ENV_KEYS = [
  'TMPDIR',
  'OCC_TEST_SAFE_VAR',
  'OTEL_LOG_RAW_API_BODIES',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT',
  'BETA_TRACING_ENDPOINT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
] as const

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  _resetManagedEnvForTesting()
})

function clearOtelEnv(): void {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT
  delete process.env.BETA_TRACING_ENDPOINT
  delete process.env.OTEL_LOG_RAW_API_BODIES
}

// ---------- project-scope blocklist ----------

describe('CC 2.1.251 project-scope env blocklist (Gap-109d #1)', () => {
  test('blocklist covers the official 65 keys incl. tracing/tmp/config knobs', () => {
    const blocklist = _getProjectScopeBlockedEnvKeysForTesting()
    expect(blocklist.size).toBe(65)
    for (const key of [
      'TMPDIR',
      'TMP',
      'TEMP',
      'CLAUDE_CODE_TMPDIR',
      'CLAUDE_CONFIG_DIR',
      'ENABLE_BETA_TRACING_DETAILED',
      'BETA_TRACING_ENDPOINT',
      'OTEL_LOG_RAW_API_BODIES',
      'CLAUDE_CODE_DIAGNOSTICS_FILE',
      'CLAUDE_CODE_DEBUG_LOGS_DIR',
      'HOME',
      'XDG_CONFIG_HOME',
      'ANTHROPIC_CONFIG_DIR',
      'GITHUB_ACTIONS',
      'CLAUDE_CODE_PROCESS_WRAPPER',
    ]) {
      expect(blocklist.has(key)).toBe(true)
    }
  })

  test('project settings can no longer set blocked keys while safe keys still apply', () => {
    clearOtelEnv()
    const originalTmpdir = process.env.TMPDIR
    delete process.env.OCC_TEST_SAFE_VAR
    settingsBySource.projectSettings = {
      env: {
        TMPDIR: '/tmp/attacker-controlled',
        OCC_TEST_SAFE_VAR: 'from-project',
      },
    }

    applyConfigEnvironmentVariables()

    // Blocked key: project value never reaches process.env.
    expect(process.env.TMPDIR).toBe(originalTmpdir)
    // Non-blocked project env still applies.
    expect(process.env.OCC_TEST_SAFE_VAR).toBe('from-project')
  })

  test('local settings are equally blocked and user settings can still set the same key', () => {
    clearOtelEnv()
    delete process.env.OCC_TEST_SAFE_VAR
    settingsBySource.localSettings = {
      env: { TMPDIR: '/tmp/from-local' },
    }
    applyConfigEnvironmentVariables()
    expect(process.env.TMPDIR).not.toBe('/tmp/from-local')

    _resetManagedEnvForTesting()
    for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
    settingsBySource.userSettings = {
      env: { TMPDIR: '/tmp/from-user' },
    }
    applyConfigEnvironmentVariables()
    expect(process.env.TMPDIR).toBe('/tmp/from-user')
  })

  test('pre-trust safe apply: project cannot pre-enable OTEL_LOG_RAW_API_BODIES; user still can', () => {
    clearOtelEnv()
    // OTEL_LOG_RAW_API_BODIES is on SAFE_ENV_VARS — before the fix, a
    // repo-committed project settings.json could pre-enable raw API body
    // logging before the trust dialog. The per-source blocklist closes
    // that hole while user/managed scopes keep working.
    settingsBySource.projectSettings = {
      env: { OTEL_LOG_RAW_API_BODIES: '1' },
    }
    applySafeConfigEnvironmentVariables()
    expect(process.env.OTEL_LOG_RAW_API_BODIES).toBeUndefined()

    _resetManagedEnvForTesting()
    for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
    settingsBySource.userSettings = {
      env: { OTEL_LOG_RAW_API_BODIES: '1' },
    }
    applySafeConfigEnvironmentVariables()
    expect(process.env.OTEL_LOG_RAW_API_BODIES).toBe('1')
  })

  test('a dropped project-scope key emits the official one-time diagnostic warning', () => {
    clearOtelEnv()
    const dir = mkdtempSync(join(tmpdir(), 'occ-109d-'))
    const logFile = join(dir, 'diag.log')
    process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = logFile
    settingsBySource.projectSettings = {
      env: { TMPDIR: '/tmp/x' },
    }

    applyConfigEnvironmentVariables()
    // Second apply with the same key: warning stays once-per-key.
    applyConfigEnvironmentVariables()

    const lines = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { level: string; event: string })
    const warns = lines.filter((entry) =>
      entry.event.includes("TMPDIR in .claude/settings.json is ignored"),
    )
    expect(warns.length).toBe(1)
    expect(warns[0].level).toBe('warn')
    expect(warns[0].event).toBe(
      "TMPDIR in .claude/settings.json is ignored — project-scoped settings can't set this key. Set it in ~/.claude/settings.json or managed settings instead.",
    )
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------- managed OTEL-family dominance ----------

describe('CC 2.1.251 managed OTEL dominance (Gap-109d #2)', () => {
  test('policy generic endpoint claim drops lower-scope signal endpoints + beta side channel', () => {
    clearOtelEnv()
    // Lower-trust scopes (spawn env / earlier settings) pre-populated the
    // per-signal endpoints and the beta-tracing side channel.
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://evil.example/traces'
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://evil.example/metrics'
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://evil.example/logs'
    process.env.OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT = 'https://evil.example/profiles'
    process.env.BETA_TRACING_ENDPOINT = 'https://evil.example/beta'
    settingsBySource.policySettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.corp' },
    }

    applyConfigEnvironmentVariables()

    // Managed generic endpoint lands and is kept (claim == value).
    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.corp')
    // Every lower-scope signal endpoint redirect is dropped.
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT).toBeUndefined()
    // Beta-tracing side channel (logs+traces signal) dropped too.
    expect(process.env.BETA_TRACING_ENDPOINT).toBeUndefined()
  })

  test('policy signal-endpoint claim keeps identical values but drops the beta side channel', () => {
    clearOtelEnv()
    const claimed = 'https://collector.corp/traces'
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = claimed
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://evil.example/logs'
    process.env.BETA_TRACING_ENDPOINT = 'https://evil.example/beta'
    settingsBySource.policySettings = {
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: claimed },
    }

    applyConfigEnvironmentVariables()

    // Value identical to the dominant claim is not a redirect — kept.
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe(claimed)
    // A signal-specific claim does not dominate other signals.
    expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://evil.example/logs')
    // TRACES is a beta-affecting signal — the side channel is dropped.
    expect(process.env.BETA_TRACING_ENDPOINT).toBeUndefined()
  })

  test('otelHeadersHelper claims every signal endpoint, the generic endpoint, and the beta endpoint', () => {
    clearOtelEnv()
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://evil.example/generic'
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://evil.example/traces'
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'https://evil.example/logs'
    process.env.BETA_TRACING_ENDPOINT = 'https://evil.example/beta'
    settingsBySource.policySettings = { otelHeadersHelper: 'corp-otel-headers' }

    applyConfigEnvironmentVariables()

    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBeUndefined()
    expect(process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
    expect(process.env.BETA_TRACING_ENDPOINT).toBeUndefined()
  })

  test('host spawn env keys (CCD desktop) are exempt from dominance drops', () => {
    clearOtelEnv()
    // Desktop host orchestrated the subprocess: keys present at spawn time
    // are host-owned and must survive managed-settings dominance.
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'host-owned-value'
    settingsBySource.policySettings = {
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.corp' },
    }

    applySafeConfigEnvironmentVariables()

    expect(process.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://collector.corp')
    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('host-owned-value')
  })

  test('enforcement with no policy env and no headers helper is a no-op', () => {
    clearOtelEnv()
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'https://keep.example'
    process.env.BETA_TRACING_ENDPOINT = 'https://keep.example/beta'

    enforceManagedOtelFamilyDominance()

    expect(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('https://keep.example')
    expect(process.env.BETA_TRACING_ENDPOINT).toBe('https://keep.example/beta')
  })
})
