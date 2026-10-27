import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

// MACRO polyfill (repo convention — transitive imports read MACRO.VERSION).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * CC 2.1.311 item 72 (OCC WP-AA) — DISABLE_COMPACT is a ONE-WAY settings env
 * knob: settings files may only turn compaction OFF, never back ON.
 *
 * Official v311 host-rule env filter `K(e,n)` @243147475 (byte-verified,
 * docs/gap-research-311/triage-T4-sweep.md Item 72):
 *   function K(e,n){let s=e.toUpperCase();return Ne.has(s)||s.startsWith(Me)||
 *     s==="DISABLE_COMPACT"&&!Le(n)||me.has(s)||ve.has(s)||Pe.has(s)||
 *     N.has(s)&&Eqe()&&!k(s,n)||!1||s==="CLAUDE_CODE_REMOTE_TOOLS_FORWARD"}
 *   function zbn(e,n){return U.has(e.toUpperCase())||K(e,n)}
 * v310's `K` @241907308 has NO `s==="DISABLE_COMPACT"&&!Le(n)` clause.
 * The all-sources settings-env filter `H(e){…if(!K(s,r))n[s]=r…}` @243158106
 * applies it to every settings source (strippedSettingsEnv pipeline
 * `H(te(ie(…)))` @243163922). `Le` @238646027 is the env-truthy parser
 * (["1","true","yes","on"] after lowercase+trim) — OCC's `isEnvTruthy` is
 * byte-equivalent.
 *
 * Semantics: key (uppercased) === "DISABLE_COMPACT" && value NOT env-truthy
 * → dropped from settings-sourced env. A truthy value passes (settings can
 * disable compaction); a falsy one never re-enables it — only the launch
 * environment can. OCC has no host-rule predicate and no mod `$.env.set`,
 * so only this clause is ported, wired into filterSettingsEnv (applies to
 * every settings source on both the safe and full apply paths).
 *
 * Test architecture follows managedHostTlsProxyStrip300.test.ts: mock
 * settings.js (getSettingsForSource) + config.js (getGlobalConfig), drive the
 * real apply functions, restore modules in afterAll (OCC-97).
 */

const settingsBySource: Record<
  string,
  { env?: Record<string, string> } | null
> = {}
let globalConfigEnv: Record<string, string> = {}

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
  getGlobalConfig: () => ({ env: globalConfigEnv }),
}))

afterAll(() => {
  mock.module('../settings/settings.js', () => ({ ...actualSettingsExports }))
  mock.module('../config.js', () => ({ ...actualConfigExports }))
})

const {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
  _resetManagedEnvForTesting,
} = await import('../managedEnv.js')
const { SAFE_ENV_VARS } = await import('../managedEnvConstants.js')

const ENV_KEYS = [
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_ENTRYPOINT',
  'OCC_TEST_NEUTRAL',
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
  globalConfigEnv = {}
  _resetManagedEnvForTesting()
})

function clearTargets(): void {
  for (const key of [
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'CLAUDE_CODE_ENTRYPOINT',
    'OCC_TEST_NEUTRAL',
  ]) {
    delete process.env[key]
  }
}

describe('item 72 — DISABLE_COMPACT one-way clause through applyConfigEnvironmentVariables', () => {
  test('truthy DISABLE_COMPACT from user settings is applied (settings CAN turn compaction off)', () => {
    clearTargets()
    settingsBySource.userSettings = { env: { DISABLE_COMPACT: '1' } }

    applyConfigEnvironmentVariables()

    expect(process.env.DISABLE_COMPACT).toBe('1')
  })

  test.each(['0', 'false', 'no', 'off', '', '2'])(
    'falsy value %p from user settings is dropped (settings can NOT turn compaction back on)',
    (value) => {
      clearTargets()
      settingsBySource.userSettings = { env: { DISABLE_COMPACT: value } }

      applyConfigEnvironmentVariables()

      expect(process.env.DISABLE_COMPACT).toBeUndefined()
    },
  )

  test('a falsy settings value never overrides a truthy launch-env value', () => {
    clearTargets()
    process.env.DISABLE_COMPACT = '1'
    settingsBySource.userSettings = { env: { DISABLE_COMPACT: '0' } }

    applyConfigEnvironmentVariables()

    expect(process.env.DISABLE_COMPACT).toBe('1')
  })

  test('clause applies to every settings source (globalConfig / project / policy)', () => {
    clearTargets()
    globalConfigEnv = { DISABLE_COMPACT: '0' }
    settingsBySource.projectSettings = { env: { DISABLE_COMPACT: 'false' } }
    settingsBySource.policySettings = { env: { DISABLE_COMPACT: 'off' } }

    applyConfigEnvironmentVariables()

    expect(process.env.DISABLE_COMPACT).toBeUndefined()
  })

  test('truthy env-truthy spellings pass (Le parser: 1/true/yes/on, case+trim insensitive)', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      clearTargets()
      _resetManagedEnvForTesting()
      settingsBySource.userSettings = { env: { DISABLE_COMPACT: value } }

      applyConfigEnvironmentVariables()

      expect(process.env.DISABLE_COMPACT).toBe(value)
    }
  })

  test('key match is case-insensitive like the official `e.toUpperCase()`', () => {
    clearTargets()
    settingsBySource.userSettings = { env: { disable_compact: '0' } }

    applyConfigEnvironmentVariables()

    expect(process.env.disable_compact).toBeUndefined()
  })

  test('sibling keys are untouched — the clause is exact-key (DISABLE_AUTO_COMPACT, neutral var survive)', () => {
    clearTargets()
    settingsBySource.userSettings = {
      env: {
        DISABLE_AUTO_COMPACT: '0',
        OCC_TEST_NEUTRAL: 'keep-me',
        DISABLE_COMPACT: '0',
      },
    }

    applyConfigEnvironmentVariables()

    expect(process.env.DISABLE_AUTO_COMPACT).toBe('0')
    expect(process.env.OCC_TEST_NEUTRAL).toBe('keep-me')
    expect(process.env.DISABLE_COMPACT).toBeUndefined()
  })
})

describe('item 72 — safe (pre-trust) apply path', () => {
  test('DISABLE_COMPACT is on the project-safe allowlist, so the safe path needs the clause too', () => {
    expect(SAFE_ENV_VARS.has('DISABLE_COMPACT')).toBe(true)
  })

  test('truthy DISABLE_COMPACT from project settings applies via the safe path', () => {
    clearTargets()
    settingsBySource.projectSettings = { env: { DISABLE_COMPACT: '1' } }

    applySafeConfigEnvironmentVariables()

    expect(process.env.DISABLE_COMPACT).toBe('1')
  })

  test('falsy DISABLE_COMPACT from project settings is dropped via the safe path', () => {
    clearTargets()
    settingsBySource.projectSettings = { env: { DISABLE_COMPACT: '0' } }

    applySafeConfigEnvironmentVariables()

    expect(process.env.DISABLE_COMPACT).toBeUndefined()
  })
})
