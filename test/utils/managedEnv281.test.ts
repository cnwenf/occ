import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.281 (#120): debug-log the settings `env` keys that were dropped
 * because the launch environment already sets them.
 *
 * Byte-verified against the official 2.1.281 linux-x64 ELF
 * (/tmp/cc-diff-281/vver/package/claude); "already sets" is 0 hits in 2.1.280.
 *
 *   `v()` @197082825 (the host-spawn-env strip):
 *     for (let [s, E] of Object.entries(e)) {
 *       if (!n.has(s.toUpperCase())) { o[s] = E; continue }
 *       if (r && process.env[s] !== E) i.push(s)      // only DIFFERING values
 *     }
 *     if (r && i.length > 0) J(i, r.source, r.warned)
 *
 *   `J()` warn emitter @197082825:
 *     let o = e.filter(s => { let E = `${n}:${s}`; if (r.has(E)) return false; r.add(E); return true })
 *     if (o.length === 0) return
 *     let i = o.map(g).join(", ")
 *     t(`Ignoring ${i} from ${n}: the environment this session was launched with
 *        already sets ${o.length === 1 ? "it" : "them"}, and when the desktop app
 *        or a runner starts the session, the launch environment takes precedence
 *        over settings.`, {level:"warn"})
 *
 *   `g()` key renderer @197075905 (with `Ha(e) === JSON.stringify(e)` @193092071):
 *     Ha(e).slice(1,-1).replace(/[^\x20-\x7e]/g, n => `\\u${n.charCodeAt(0).toString(16).padStart(4,"0")}`)
 *
 *   Caller @197088028: `filterSettingsEnv(e, n)` threads `n` (the settings
 *   source) plus the per-instance `hostSpawnEnvDropWarned` Set into `v()`.
 */

// Mutable per-source settings store the mocked getSettingsForSource reads.
const settingsBySource: Record<
  string,
  { env?: Record<string, string>; otelHeadersHelper?: string } | null
> = {}

// OCC-97 mock-leak discipline: spread the real module, override only what this
// suite needs, and restore the untouched module after the suite.
const actualSettingsModule = await import('../../src/utils/settings/settings.js')
const actualConfigModule = await import('../../src/utils/config.js')
const actualConstantsModule = await import('../../src/utils/settings/constants.js')

mock.module('../../src/utils/settings/settings.js', () => ({
  ...actualSettingsModule,
  getSettingsForSource: (source: string) => settingsBySource[source] ?? null,
}))
mock.module('../../src/utils/config.js', () => ({
  ...actualConfigModule,
  getGlobalConfig: () => ({ env: {} }),
}))
mock.module('../../src/utils/settings/constants.js', () => ({
  ...actualConstantsModule,
  getEnabledSettingSources: () => [...actualConstantsModule.SETTING_SOURCES],
}))

afterAll(() => {
  mock.module('../../src/utils/settings/settings.js', () => ({ ...actualSettingsModule }))
  mock.module('../../src/utils/config.js', () => ({ ...actualConfigModule }))
  mock.module('../../src/utils/settings/constants.js', () => ({ ...actualConstantsModule }))
})

const { applySafeConfigEnvironmentVariables, _resetManagedEnvForTesting } = await import(
  '../../src/utils/managedEnv.js'
)

const SPAWN_KEY_ONE = 'OCC_TEST_HOST_SPAWN_ONE'
const SPAWN_KEY_TWO = 'OCC_TEST_HOST_SPAWN_TWO'
const NON_SPAWN_KEY = 'OCC_TEST_NOT_IN_SPAWN_ENV'
const QUOTED_KEY = 'OCC"TEST'

/** Keys this suite touches on process.env, for save/restore. */
const ENV_KEYS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'ANTHROPIC_UNIX_SOCKET',
  SPAWN_KEY_ONE,
  SPAWN_KEY_TWO,
  NON_SPAWN_KEY,
  QUOTED_KEY,
] as const

const saved: Record<string, string | undefined> = {}
const tempDirs: string[] = []

beforeAll(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  for (const key of Object.keys(settingsBySource)) delete settingsBySource[key]
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  _resetManagedEnvForTesting()
})

/** Point the diagnostics logger at a fresh temp file and return its path. */
function startDiagnosticsLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'occ-281-env-'))
  tempDirs.push(dir)
  const logFile = join(dir, 'diag.log')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = logFile
  return logFile
}

function readIgnoredWarns(logFile: string): string[] {
  let raw: string
  try {
    raw = readFileSync(logFile, 'utf8')
  } catch {
    return [] // nothing logged yet
  }
  const trimmed = raw.trim()
  if (trimmed === '') return []
  return trimmed
    .split('\n')
    .map((line) => JSON.parse(line) as { level: string; event: string })
    .filter((entry) => entry.level === 'warn' && entry.event.startsWith('Ignoring '))
    .map((entry) => entry.event)
}

/**
 * Enter CCD/desktop-host mode: the spawn-env snapshot is taken from
 * process.env on the first applySafeConfigEnvironmentVariables() call, so the
 * host-owned keys must already be present here.
 */
function enterDesktopHostMode(spawnEnv: Record<string, string>): void {
  for (const [key, value] of Object.entries(spawnEnv)) process.env[key] = value
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
}

const TAIL =
  ', and when the desktop app or a runner starts the session, the launch environment takes precedence over settings.'

describe('CC 2.1.281 #120 launch-env-overridden settings env keys are reported', () => {
  test('one differing key warns once with the exact v281 message (singular "it")', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-value' })
    settingsBySource.userSettings = { env: { [SPAWN_KEY_ONE]: 'settings-value' } }

    applySafeConfigEnvironmentVariables()
    // A second apply pass must not repeat the warning (one-time per key).
    applySafeConfigEnvironmentVariables()

    const warns = readIgnoredWarns(logFile)
    expect(warns.length).toBe(1)
    expect(warns[0]).toBe(
      `Ignoring ${SPAWN_KEY_ONE} from userSettings: the environment this session was launched with already sets it${TAIL}`,
    )
    // The launch value wins — the settings value never lands.
    expect(process.env[SPAWN_KEY_ONE]).toBe('launch-value')
  })

  test('two differing keys warn together with the plural "them" and a ", " join', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-1', [SPAWN_KEY_TWO]: 'launch-2' })
    settingsBySource.userSettings = {
      env: { [SPAWN_KEY_ONE]: 'settings-1', [SPAWN_KEY_TWO]: 'settings-2' },
    }

    applySafeConfigEnvironmentVariables()

    const warns = readIgnoredWarns(logFile)
    expect(warns.length).toBe(1)
    expect(warns[0]).toBe(
      `Ignoring ${SPAWN_KEY_ONE}, ${SPAWN_KEY_TWO} from userSettings: the environment this session was launched with already sets them${TAIL}`,
    )
  })

  test('an identical launch-env value loses nothing, so it stays silent', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'same-value' })
    settingsBySource.userSettings = { env: { [SPAWN_KEY_ONE]: 'same-value' } }

    applySafeConfigEnvironmentVariables()

    expect(readIgnoredWarns(logFile).length).toBe(0)
    expect(process.env[SPAWN_KEY_ONE]).toBe('same-value')
  })

  test('dedupe is per (source, key): a second source re-warns for the same key', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-value' })
    settingsBySource.userSettings = { env: { [SPAWN_KEY_ONE]: 'from-user' } }

    applySafeConfigEnvironmentVariables()
    settingsBySource.policySettings = { env: { [SPAWN_KEY_ONE]: 'from-policy' } }
    applySafeConfigEnvironmentVariables()

    const warns = readIgnoredWarns(logFile)
    expect(warns.length).toBe(2)
    expect(warns[0]).toContain(`from userSettings:`)
    expect(warns[1]).toContain(`from policySettings:`)
  })

  test('the source name is threaded from filterSettingsEnv (globalConfig vs userSettings)', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-value' })
    // globalConfig (~/.claude.json) env is filtered first, through the same
    // pipeline, and must name its own source.
    mock.module('../../src/utils/config.js', () => ({
      ...actualConfigModule,
      getGlobalConfig: () => ({ env: { [SPAWN_KEY_ONE]: 'from-global-config' } }),
    }))

    applySafeConfigEnvironmentVariables()

    const warns = readIgnoredWarns(logFile)
    expect(warns.some((line) => line.includes(`Ignoring ${SPAWN_KEY_ONE} from globalConfig:`))).toBe(
      true,
    )
    mock.module('../../src/utils/config.js', () => ({
      ...actualConfigModule,
      getGlobalConfig: () => ({ env: {} }),
    }))
  })

  test('outside desktop-host mode nothing is dropped and nothing warns', () => {
    const logFile = startDiagnosticsLog()
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    process.env[SPAWN_KEY_ONE] = 'launch-value'
    settingsBySource.userSettings = { env: { [SPAWN_KEY_ONE]: 'settings-value' } }

    applySafeConfigEnvironmentVariables()

    expect(readIgnoredWarns(logFile).length).toBe(0)
    // No spawn-env snapshot ⇒ the settings value applies as before.
    expect(process.env[SPAWN_KEY_ONE]).toBe('settings-value')
  })

  test('a key the host did not set still applies and does not warn', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-value' })
    delete process.env[NON_SPAWN_KEY]
    settingsBySource.userSettings = { env: { [NON_SPAWN_KEY]: 'from-settings' } }

    applySafeConfigEnvironmentVariables()

    expect(readIgnoredWarns(logFile).length).toBe(0)
    expect(process.env[NON_SPAWN_KEY]).toBe('from-settings')
  })

  test('key names are rendered through the binary `g()` escaper (quotes escaped)', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [QUOTED_KEY]: 'launch-value' })
    settingsBySource.userSettings = { env: { [QUOTED_KEY]: 'settings-value' } }

    applySafeConfigEnvironmentVariables()

    const warns = readIgnoredWarns(logFile)
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain('Ignoring OCC\\"TEST from userSettings:')
  })

  test('_resetManagedEnvForTesting clears the one-per-key state', () => {
    const logFile = startDiagnosticsLog()
    enterDesktopHostMode({ [SPAWN_KEY_ONE]: 'launch-value' })
    settingsBySource.userSettings = { env: { [SPAWN_KEY_ONE]: 'settings-value' } }

    applySafeConfigEnvironmentVariables()
    expect(readIgnoredWarns(logFile).length).toBe(1)

    _resetManagedEnvForTesting()
    // Re-enter host mode (the reset also cleared the spawn-env snapshot).
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    applySafeConfigEnvironmentVariables()

    expect(readIgnoredWarns(logFile).length).toBe(2)
  })
})
