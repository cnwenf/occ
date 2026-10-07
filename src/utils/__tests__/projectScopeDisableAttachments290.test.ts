import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

/**
 * CC 2.1.290 (#161): "Changed CLAUDE_CODE_DISABLE_ATTACHMENTS so a
 * repository's .claude/settings.json or .claude/settings.local.json can no
 * longer set it; shell, user and managed settings still can."
 *
 * Byte-forensics (official linux-x64 ELFs, never executed):
 *  - 2.1.289 reserved-env set `sZn` @205191667 region:
 *    `...,"CLAUDE_CODE_SYNC_SKILLS","CLAUDE_CODE_SYNC_PLUGINS",
 *      "CLAUDE_CODE_TRANSCRIPT_LOCAL_GC","CLAUDE_CODE_CCR_SURFACE",
 *      "CLAUDE_CODE_TETHER_LIVE",...` — NO CLAUDE_CODE_DISABLE_ATTACHMENTS
 *      (all 8 occurrences of the string in the 289 ELF are live consumers:
 *      env-module re-export @199874621, `AN()` deferred-tools gate
 *      @206734244, telemetry gates @208974391/@209053530, main-loop
 *      attachment gate @210931211, plugin manifests @233186321/@233193287).
 *  - 2.1.290 reserved-env set `mir` @5736663 region INSERTS
 *    `"CLAUDE_CODE_RELAUNCH_PROACTIVITY_*"(4),"CLAUDE_CODE_DISABLE_PROACTIVITY",
 *     "CLAUDE_CODE_DISABLE_ATTACHMENTS"` between "CLAUDE_CODE_CCR_SURFACE"
 *    and "CLAUDE_CODE_TETHER_LIVE"; same set in 2.1.291 @5759460 region.
 *  - The other new members gate official-only dormant surfaces (proactivity /
 *    remote-tools) OCC does not ship; DISABLE_ATTACHMENTS has a live OCC
 *    consumer (attachments.ts:848), so only it is ported.
 *
 * OCC mechanism: PROJECT_SCOPE_BLOCKED_ENV_KEYS in src/utils/managedEnv.ts —
 * projectSettings/localSettings env values for blocked keys are dropped
 * (with a once-per-key diagnostic warning) before reaching process.env;
 * user/flag/policy scopes still apply. Same pattern as the 2.1.251 (#Gap-109d)
 * blocklist and the 2.1.285 CLAUDE_CODE_DISABLE_WEB_FETCH entry.
 */

// Mutable per-source settings store the mocked getSettingsForSource reads.
const settingsBySource: Record<
  string,
  { env?: Record<string, string> } | null
> = {}

// OCC-97 mock-leak discipline (277-suite pattern): snapshot the real exports
// BEFORE any mock.module call and restore from the snapshots in afterAll.
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
  mock.module('../settings/settings.js', () => ({
    ...actualSettingsExports,
  }))
  mock.module('../config.js', () => ({ ...actualConfigExports }))
})

const {
  applyConfigEnvironmentVariables,
  _resetManagedEnvForTesting,
  _getProjectScopeBlockedEnvKeysForTesting,
} = await import('../managedEnv.js')

const KEY = 'CLAUDE_CODE_DISABLE_ATTACHMENTS'

const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  saved[KEY] = process.env[KEY]
})

afterEach(() => {
  if (saved[KEY] === undefined) delete process.env[KEY]
  else process.env[KEY] = saved[KEY]
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  _resetManagedEnvForTesting()
})

describe('CC 2.1.290 #161 — CLAUDE_CODE_DISABLE_ATTACHMENTS project-scope block', () => {
  test('key is on PROJECT_SCOPE_BLOCKED_ENV_KEYS', () => {
    expect(_getProjectScopeBlockedEnvKeysForTesting().has(KEY)).toBe(true)
  })

  test('project settings can no longer set it', () => {
    delete process.env[KEY]
    settingsBySource.projectSettings = { env: { [KEY]: '1' } }

    applyConfigEnvironmentVariables()

    expect(process.env[KEY]).toBeUndefined()
  })

  test('local settings can no longer set it either', () => {
    delete process.env[KEY]
    settingsBySource.localSettings = { env: { [KEY]: '1' } }

    applyConfigEnvironmentVariables()

    expect(process.env[KEY]).toBeUndefined()
  })

  test('user settings CAN still set it (blocklist is project/local-scope only)', () => {
    delete process.env[KEY]
    settingsBySource.userSettings = { env: { [KEY]: '1' } }

    applyConfigEnvironmentVariables()

    expect(process.env[KEY]).toBe('1')
  })

  test('policy (managed) settings CAN still set it', () => {
    delete process.env[KEY]
    settingsBySource.policySettings = { env: { [KEY]: '1' } }

    applyConfigEnvironmentVariables()

    expect(process.env[KEY]).toBe('1')
  })

  test('a real shell env value is untouched by the settings path', () => {
    // The official changelog keeps the SHELL channel working: attachments.ts
    // reads process.env directly, and the blocklist only filters
    // settings-sourced env objects.
    process.env[KEY] = '1'
    settingsBySource.projectSettings = { env: { [KEY]: '0' } }

    applyConfigEnvironmentVariables()

    expect(process.env[KEY]).toBe('1')
  })
})
