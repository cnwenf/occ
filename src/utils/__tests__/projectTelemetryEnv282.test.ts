import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.282 (P0): "project/local settings ignore telemetry-enabling env vars".
 *
 * Official mechanism (byte-verified against the 2.1.282 linux-x64 ELF):
 *  - `Gcn` @~194559000: 48 telemetry env names spread into the project-scope
 *    blocklist `MBn` (absent from the 2.1.281 ELF).
 *  - `U(e,n,o,r)` 4-param filter @~198149900: keep-condition
 *    `if(!j(E)||Vcn(E,e[E],r))continue`.
 *  - `Vcn` off-only exception: a blocked key from project/local scope is KEPT
 *    only when the value turns telemetry OFF (`ko`-falsy for the Wd set
 *    OTEL_LOG_USER_PROMPTS/OTEL_LOG_TOOL_CONTENT/OTEL_LOG_TOOL_DETAILS; the
 *    literal "none" for the Gd exporter-selection set OTEL_LOGS_EXPORTER/
 *    OTEL_METRICS_EXPORTER/OTEL_TRACES_EXPORTER) AND no same-name variable
 *    exists above project settings (`envAboveProjectSettings()` = pre-settings
 *    spawn-env snapshot minus user-tier shadow keys, plus flagSettings.env,
 *    plus policySettings.env).
 *  - `B` class snapshot members @~198156000: getPreSettingsEnvSnapshot /
 *    latchPreSettingsEnvSnapshot / envAboveProjectSettings / peek / drop.
 *    Both apply functions capture the snapshot as their first statement.
 *
 * Mock.module hygiene per OCC-97: snapshot real namespaces before mocking,
 * restore in afterAll.
 */

// Mutable per-source settings store the mocked getSettingsForSource reads.
const settingsBySource: Record<
  string,
  { env?: Record<string, string>; otelHeadersHelper?: string } | null
> = {}

// NOTE: bun's mock.module mutates the captured namespace object in place when
// the mock registers — spreading the live namespace in afterAll would
// "restore" the mock itself. Snapshot the exports into plain objects BEFORE
// any mock.module call and restore from those snapshots (277-suite pattern).
const actualSettingsModule = await import('../settings/settings.js')
const actualConfigModule = await import('../config.js')
const actualSettingsExports = { ...actualSettingsModule }
const actualConfigExports = { ...actualConfigModule }

mock.module('../settings/settings.js', () => ({
  ...actualSettingsExports,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
}))
mock.module('../config.js', () => ({
  ...actualConfigExports,
  getGlobalConfig: () => ({ env: {} }),
}))

afterAll(() => {
  mock.module('../settings/settings.js', () => ({ ...actualSettingsExports }))
  mock.module('../config.js', () => ({ ...actualConfigExports }))
})

const {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
  _resetManagedEnvForTesting,
  _getProjectScopeBlockedEnvKeysForTesting,
  getPreSettingsEnvSnapshot,
  peekPreSettingsEnvSnapshot,
  dropPreSettingsEnvSnapshot,
  envAboveProjectSettings,
} = await import('../managedEnv.js')

/**
 * The official `Gcn` list — 48 names, byte-exact and in binary order
 * (extracted from the 2.1.282 ELF @~194559000 via grep -aboF + dd).
 */
const GCN_TELEMETRY_KEYS = [
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

const EXTRA_ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'OCC_SNAPSHOT_TEST',
  'OCC_TIER_VAR',
] as const

const ENV_KEYS = [...GCN_TELEMETRY_KEYS, ...EXTRA_ENV_KEYS]

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

beforeEach(() => {
  // Start each test with a clean slate: none of the 48 keys in the spawn env
  // (the pre-settings snapshot must not shadow them for the kept-cases).
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  restoreEnv()
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  _resetManagedEnvForTesting()
})

/** Read the diagnostics-log warning lines emitted during `fn`. */
function captureWarnings(fn: () => void): Array<{ level: string; event: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'occ-282-'))
  const logFile = join(dir, 'diag.log')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = logFile
  try {
    fn()
    // The diagnostics file is created lazily — no warning means no file.
    if (!existsSync(logFile)) return []
    return readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { level: string; event: string })
  } finally {
    delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('CC 2.1.282 P0 — project/local settings ignore telemetry-enabling env vars', () => {
  test('all 48 official Gcn names are on the project-scope blocklist', () => {
    expect(GCN_TELEMETRY_KEYS.length).toBe(48)
    const blocklist = _getProjectScopeBlockedEnvKeysForTesting()
    for (const key of GCN_TELEMETRY_KEYS) {
      expect(blocklist.has(key)).toBe(true)
    }
  })

  test('table-driven: every one of the 48 names set by projectSettings is dropped', () => {
    settingsBySource.projectSettings = {
      env: Object.fromEntries(GCN_TELEMETRY_KEYS.map((key) => [key, '1'])),
    }

    applyConfigEnvironmentVariables()

    for (const key of GCN_TELEMETRY_KEYS) {
      expect(process.env[key]).toBeUndefined()
    }
  })

  test('table-driven: every one of the 48 names set by localSettings is dropped', () => {
    settingsBySource.localSettings = {
      env: Object.fromEntries(
        GCN_TELEMETRY_KEYS.map((key) => [key, 'https://evil.example']),
      ),
    }

    applyConfigEnvironmentVariables()

    for (const key of GCN_TELEMETRY_KEYS) {
      expect(process.env[key]).toBeUndefined()
    }
  })

  test('byte-exact one-time warning per dropped key, for both project files', () => {
    const entries = captureWarnings(() => {
      settingsBySource.projectSettings = {
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.example' },
      }
      settingsBySource.localSettings = {
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
      }
      applyConfigEnvironmentVariables()
      // Second apply: warnings stay once-per-key.
      applyConfigEnvironmentVariables()
    })

    const endpointWarns = entries.filter((entry) =>
      entry.event.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT in '),
    )
    expect(endpointWarns.length).toBe(1)
    expect(endpointWarns[0]!.level).toBe('warn')
    expect(endpointWarns[0]!.event).toBe(
      "OTEL_EXPORTER_OTLP_ENDPOINT in .claude/settings.json is ignored — project-scoped settings can't set this key. Set it in ~/.claude/settings.json or managed settings instead.",
    )

    const telemetryWarns = entries.filter((entry) =>
      entry.event.startsWith('CLAUDE_CODE_ENABLE_TELEMETRY in '),
    )
    expect(telemetryWarns.length).toBe(1)
    expect(telemetryWarns[0]!.event).toBe(
      "CLAUDE_CODE_ENABLE_TELEMETRY in .claude/settings.local.json is ignored — project-scoped settings can't set this key. Set it in ~/.claude/settings.json or managed settings instead.",
    )
  })

  test('trusted sources (userSettings / flagSettings / policySettings) keep all 48 names', () => {
    for (const source of ['userSettings', 'flagSettings', 'policySettings']) {
      _resetManagedEnvForTesting()
      for (const key of ENV_KEYS) delete process.env[key]
      for (const key of Object.keys(settingsBySource)) {
        delete settingsBySource[key]
      }
      settingsBySource[source] = {
        env: Object.fromEntries(
          GCN_TELEMETRY_KEYS.map((key) => [key, `from-${source}`]),
        ),
      }

      applyConfigEnvironmentVariables()

      for (const key of GCN_TELEMETRY_KEYS) {
        expect(process.env[key]).toBe(`from-${source}`)
      }
    }
  })

  test('pre-trust safe apply path also enforces the filter (both apply paths)', () => {
    // CLAUDE_CODE_ENABLE_TELEMETRY and OTEL_LOGS_EXPORTER are SAFE_ENV_VARS
    // members — before 2.1.282 the safe path applied them from project scope.
    settingsBySource.projectSettings = {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_LOG_USER_PROMPTS: '1',
      },
    }

    applySafeConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined()
    expect(process.env.OTEL_LOGS_EXPORTER).toBeUndefined()
    expect(process.env.OTEL_LOG_USER_PROMPTS).toBeUndefined()

    _resetManagedEnvForTesting()
    for (const key of ENV_KEYS) delete process.env[key]
    for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
    settingsBySource.userSettings = {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
    }

    applySafeConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
  })
})

describe('CC 2.1.282 P0 — Vcn off-only exception', () => {
  test('OTEL_LOGS_EXPORTER="none" from projectSettings is KEPT (disables the exporter)', () => {
    settingsBySource.projectSettings = {
      env: { OTEL_LOGS_EXPORTER: 'none' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.OTEL_LOGS_EXPORTER).toBe('none')
  })

  test('OTEL_LOGS_EXPORTER=" none " is kept (official trims) but "NONE"/"otlp" are dropped', () => {
    for (const [value, kept] of [
      [' none ', true],
      ['NONE', false],
      ['otlp', false],
      ['console', false],
    ] as Array<[string, boolean]>) {
      _resetManagedEnvForTesting()
      delete process.env.OTEL_LOGS_EXPORTER
      for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
      settingsBySource.projectSettings = { env: { OTEL_LOGS_EXPORTER: value } }

      applyConfigEnvironmentVariables()

      if (kept) expect(process.env.OTEL_LOGS_EXPORTER).toBe(value)
      else expect(process.env.OTEL_LOGS_EXPORTER).toBeUndefined()
    }
  })

  test('OTEL_LOG_USER_PROMPTS ko-falsy values ("0"/"false") are kept; truthy values dropped', () => {
    for (const [value, kept] of [
      ['0', true],
      ['false', true],
      ['no', true],
      ['off', true],
      ['1', false],
      ['true', false],
      ['otlp', false],
    ] as Array<[string, boolean]>) {
      _resetManagedEnvForTesting()
      delete process.env.OTEL_LOG_USER_PROMPTS
      for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
      settingsBySource.projectSettings = { env: { OTEL_LOG_USER_PROMPTS: value } }

      applyConfigEnvironmentVariables()

      if (kept) expect(process.env.OTEL_LOG_USER_PROMPTS).toBe(value)
      else expect(process.env.OTEL_LOG_USER_PROMPTS).toBeUndefined()
    }
  })

  test('non-string/number/boolean value (object) is dropped even for a Wd key', () => {
    settingsBySource.projectSettings = {
      env: {
        OTEL_LOG_USER_PROMPTS: { off: true } as unknown as string,
      },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.OTEL_LOG_USER_PROMPTS).toBeUndefined()
  })

  test('lowercase-name variant with an off value is dropped (key must be exact-uppercase)', () => {
    // Official Vcn: `if(e!==e.toUpperCase()...)return!1` — the blocklist still
    // matches case-insensitively (j(E) uppercases), so the key is blocked
    // WITHOUT the off-only exception.
    settingsBySource.projectSettings = {
      env: {
        otel_log_user_prompts: '0',
        Otel_Logs_Exporter: 'none',
      } as Record<string, string>,
    }

    applyConfigEnvironmentVariables()

    expect(process.env.otel_log_user_prompts).toBeUndefined()
    expect(process.env.Otel_Logs_Exporter).toBeUndefined()
  })

  test('shell-env shadow: same name in the launch env drops the project off-value', () => {
    // Spawn env sets it → envAboveProjectSettings() contains the name → the
    // official Vcn shadow check `!Object.keys(s()).some(i=>i.toUpperCase()===e)`
    // fails → dropped.
    process.env.OTEL_LOG_USER_PROMPTS = '1'
    settingsBySource.projectSettings = {
      env: { OTEL_LOG_USER_PROMPTS: '0' },
    }

    applyConfigEnvironmentVariables()

    // The launch-env value stands; the project value never applies.
    expect(process.env.OTEL_LOG_USER_PROMPTS).toBe('1')
  })

  test('policy shadow: policySettings.env with the same name drops the project off-value', () => {
    settingsBySource.policySettings = {
      env: { OTEL_LOG_USER_PROMPTS: '1' },
    }
    settingsBySource.projectSettings = {
      env: { OTEL_LOG_USER_PROMPTS: '0' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.OTEL_LOG_USER_PROMPTS).toBe('1')
  })

  test('flag shadow: flagSettings.env with the same name drops the project off-value', () => {
    settingsBySource.flagSettings = {
      env: { OTEL_LOGS_EXPORTER: 'otlp' },
    }
    settingsBySource.projectSettings = {
      env: { OTEL_LOGS_EXPORTER: 'none' },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.OTEL_LOGS_EXPORTER).toBe('otlp')
  })

  test('a kept off-value emits NO warning (official keep-condition skips before delete/warn)', () => {
    const entries = captureWarnings(() => {
      settingsBySource.projectSettings = {
        env: { OTEL_LOGS_EXPORTER: 'none' },
      }
      applyConfigEnvironmentVariables()
    })
    expect(
      entries.filter((entry) => entry.event.includes('OTEL_LOGS_EXPORTER')),
    ).toEqual([])
  })
})

describe('CC 2.1.282 P0 — preSettingsEnvSnapshot semantics', () => {
  test('lazy capture: peek is undefined until first get; snapshot is frozen and stable', () => {
    expect(peekPreSettingsEnvSnapshot()).toBeUndefined()

    process.env.OCC_SNAPSHOT_TEST = 'at-capture'
    const snapshot = getPreSettingsEnvSnapshot()
    expect(snapshot.OCC_SNAPSHOT_TEST).toBe('at-capture')
    expect(Object.isFrozen(snapshot)).toBe(true)

    // Later process.env mutations do not change the captured snapshot.
    process.env.OCC_SNAPSHOT_TEST = 'mutated'
    expect(snapshot.OCC_SNAPSHOT_TEST).toBe('at-capture')
    // Second get returns the same object; peek agrees.
    expect(getPreSettingsEnvSnapshot()).toBe(snapshot)
    expect(peekPreSettingsEnvSnapshot()).toBe(snapshot)
  })

  test('both apply functions capture the snapshot as their first statement', () => {
    _resetManagedEnvForTesting()
    process.env.OCC_SNAPSHOT_TEST = 'before-safe'
    applySafeConfigEnvironmentVariables()
    const afterSafe = peekPreSettingsEnvSnapshot()
    expect(afterSafe?.OCC_SNAPSHOT_TEST).toBe('before-safe')

    _resetManagedEnvForTesting()
    process.env.OCC_SNAPSHOT_TEST = 'before-full'
    applyConfigEnvironmentVariables()
    expect(peekPreSettingsEnvSnapshot()?.OCC_SNAPSHOT_TEST).toBe('before-full')
  })

  test('envAboveProjectSettings = spawn env + flagSettings.env + policySettings.env', () => {
    process.env.OCC_SNAPSHOT_TEST = 'from-spawn'
    getPreSettingsEnvSnapshot()
    settingsBySource.flagSettings = { env: { OCC_FLAG_VAR: 'f' } }
    settingsBySource.policySettings = { env: { OCC_POLICY_VAR: 'p' } }

    const above = envAboveProjectSettings()

    expect(above.OCC_SNAPSHOT_TEST).toBe('from-spawn')
    expect(above.OCC_FLAG_VAR).toBe('f')
    expect(above.OCC_POLICY_VAR).toBe('p')
  })

  test('drop clears the snapshot; re-latch computes userTierNamesInSnapshot against launchNamesBeforeClaim', () => {
    // First apply: userSettings env puts OCC_TIER_VAR into userTierNames and
    // into process.env; the snapshot was captured BEFORE that.
    settingsBySource.userSettings = { env: { OCC_TIER_VAR: '1' } }
    applyConfigEnvironmentVariables()
    expect(process.env.OCC_TIER_VAR).toBe('1')

    const firstSnapshot = peekPreSettingsEnvSnapshot()
    expect(firstSnapshot).toBeDefined()
    expect(firstSnapshot?.OCC_TIER_VAR).toBeUndefined()

    // Drop with an (empty) extra-names list: launchNamesBeforeClaim becomes
    // the previous snapshot's keys — which predate OCC_TIER_VAR. On the next
    // capture the latch finds OCC_TIER_VAR in the snapshot, in userTierNames,
    // and NOT in launchNamesBeforeClaim → it lands in userTierNamesInSnapshot
    // → excluded from envAboveProjectSettings (a user-tier key that merely
    // shadowed into the env does not count as "above project settings").
    dropPreSettingsEnvSnapshot([])
    expect(peekPreSettingsEnvSnapshot()).toBeUndefined()
    getPreSettingsEnvSnapshot()
    expect(envAboveProjectSettings().OCC_TIER_VAR).toBeUndefined()

    // Drop WITH the name claimed as a launch name: the latch filters it out
    // of userTierNamesInSnapshot → it IS above project settings again.
    dropPreSettingsEnvSnapshot(['OCC_TIER_VAR'])
    getPreSettingsEnvSnapshot()
    expect(envAboveProjectSettings().OCC_TIER_VAR).toBe('1')

    // Plain drop (no extras): launchNamesBeforeClaim resets to undefined →
    // official first-capture semantics → userTierNamesInSnapshot is empty.
    dropPreSettingsEnvSnapshot()
    getPreSettingsEnvSnapshot()
    expect(envAboveProjectSettings().OCC_TIER_VAR).toBe('1')
  })

  test('user-tier shadow: a userSettings env key already in the launch env stays above project settings', () => {
    // OCC_TIER_VAR exists at spawn time; userSettings also sets it. On the
    // FIRST capture userTierNamesInSnapshot is empty (official: empty on
    // first capture), so the launch-env key remains above project settings
    // and shadows a project off-value.
    process.env.OCC_TIER_VAR = 'from-spawn'
    settingsBySource.userSettings = { env: { OCC_TIER_VAR: 'from-user' } }
    settingsBySource.projectSettings = { env: { OTEL_LOG_USER_PROMPTS: '0' } }
    getPreSettingsEnvSnapshot()

    // OCC_TIER_VAR is not one of the 48; the project off-value for
    // OTEL_LOG_USER_PROMPTS is kept because nothing above sets THAT name.
    applyConfigEnvironmentVariables()
    expect(process.env.OTEL_LOG_USER_PROMPTS).toBe('0')
    expect(envAboveProjectSettings().OCC_TIER_VAR).toBe('from-spawn')
  })
})
