import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * CC 2.1.277 (C4): `claude update` on winget/apk reported "Claude is up to
 * date!" when the version lookup FAILED (null) — the official v277 binary
 * distinguishes null from up-to-date on every package-manager path.
 *
 * Binary evidence (v277 ELF):
 *   winget @0xcd0b197 / apk @0xcd0b694:
 *     `Could not check for updates (npm lookup failed or returned an invalid response).\n`
 *     `To update manually, run:\n` + bold(`  winget upgrade Anthropic.ClaudeCode`)
 *     / bold(`  apk upgrade claude-code`)
 *   homebrew (present since v276):
 *     `Could not check for updates (network check skipped or unavailable).\n`
 *     `To update manually, run:\n` + bold(`  brew upgrade ${cask}`)
 */

process.env.NODE_ENV = 'test'
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.276',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// -- Mock leaf collaborators (spread-real keeps every other export intact) --
// E-9/P2: `await import()` namespaces are LIVE bindings — once mock.module()
// installs a fake, `realX.foo` IS the fake. Snapshot the real export values
// into plain objects BEFORE mocking so both the factory and the afterAll
// restore spread genuine real values (pattern: diskOutputDrainGuard247.test.ts).

const realDiagnostic = { ...(await import('../../utils/doctorDiagnostic.js')) }
mock.module('../../utils/doctorDiagnostic.js', () => ({
  ...realDiagnostic,
  getDoctorDiagnostic: async () => ({
    installationType: 'package-manager',
    configInstallMethod: 'not set',
    multipleInstallations: [],
    warnings: [],
  }),
}))

const realPm = {
  ...(await import('../../utils/nativeInstaller/packageManagers.js')),
}
let currentPm: string = 'winget'
mock.module('../../utils/nativeInstaller/packageManagers.js', () => ({
  ...realPm,
  getPackageManager: async () => currentPm,
  getHomebrewCaskName: () => 'claude-code',
}))

const realUpdater = { ...(await import('../../utils/autoUpdater.js')) }
let npmLookup: string | null = null
let gcsLookup: string | null = null
let caskLookup: string | null = null
mock.module('../../utils/autoUpdater.js', () => ({
  ...realUpdater,
  getLatestVersion: async () => npmLookup,
  getLatestVersionFromGcs: async () => gcsLookup,
  getLatestVersionFromHomebrewCask: async () => caskLookup,
}))

const realShutdown = { ...(await import('../../utils/gracefulShutdown.js')) }
const SHUTDOWN_SENTINEL = Symbol('shutdown')
mock.module('../../utils/gracefulShutdown.js', () => ({
  ...realShutdown,
  gracefulShutdown: async () => {
    throw SHUTDOWN_SENTINEL
  },
}))

const realProcessUtils = { ...(await import('../../utils/process.js')) }
let stdoutChunks: string[] = []
mock.module('../../utils/process.js', () => ({
  ...realProcessUtils,
  writeToStdout: (s: string) => {
    stdoutChunks.push(s)
  },
}))

const realSettings = {
  ...(await import('../../utils/settings/settings.js')),
}
mock.module('../../utils/settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: () => ({ autoUpdatesChannel: 'latest' }),
}))

const realDebug = { ...(await import('../../utils/debug.js')) }
mock.module('../../utils/debug.js', () => ({
  ...realDebug,
  logForDebugging: () => {},
}))

const { update } = await import('../update.js')

async function runUpdate(): Promise<string> {
  stdoutChunks = []
  try {
    await update()
  } catch (error) {
    if (error !== SHUTDOWN_SENTINEL) throw error
  }
  return stdoutChunks.join('')
}

beforeEach(() => {
  currentPm = 'winget'
  npmLookup = null
  gcsLookup = null
  caskLookup = null
})

describe('C4: winget update path distinguishes null lookup from up-to-date', () => {
  test('null lookup prints Could-not-check + manual command, never "up to date"', async () => {
    currentPm = 'winget'
    npmLookup = null
    const out = await runUpdate()
    expect(out).toContain(
      'Could not check for updates (npm lookup failed or returned an invalid response).\n',
    )
    expect(out).toContain('To update manually, run:\n')
    expect(out).toContain('  winget upgrade Anthropic.ClaudeCode')
    expect(out).not.toContain('Claude is up to date!')
    expect(out).not.toContain('Update available')
  })

  test('successful lookup with newer version still shows Update available', async () => {
    currentPm = 'winget'
    npmLookup = '99.0.0'
    const out = await runUpdate()
    expect(out).toContain('Update available: 2.1.276 → 99.0.0')
    expect(out).not.toContain('Could not check for updates')
  })

  test('successful lookup at current/older version still shows up to date', async () => {
    currentPm = 'winget'
    npmLookup = '2.0.0'
    const out = await runUpdate()
    expect(out).toContain('Claude is up to date!\n')
    expect(out).not.toContain('Could not check for updates')
  })
})

describe('C4: apk update path distinguishes null lookup from up-to-date', () => {
  test('null lookup prints Could-not-check + apk manual command', async () => {
    currentPm = 'apk'
    npmLookup = null
    const out = await runUpdate()
    expect(out).toContain(
      'Could not check for updates (npm lookup failed or returned an invalid response).\n',
    )
    expect(out).toContain('To update manually, run:\n')
    expect(out).toContain('  apk upgrade claude-code')
    expect(out).not.toContain('Claude is up to date!')
  })

  test('successful apk lookup unchanged (up to date)', async () => {
    currentPm = 'apk'
    npmLookup = '2.1.276'
    const out = await runUpdate()
    expect(out).toContain('Claude is up to date!\n')
    expect(out).not.toContain('Could not check for updates')
  })
})

describe('C4: homebrew update path distinguishes null lookup from up-to-date', () => {
  test('both lookups null prints network-check message + brew manual command', async () => {
    currentPm = 'homebrew'
    caskLookup = null
    gcsLookup = null
    const out = await runUpdate()
    expect(out).toContain(
      'Could not check for updates (network check skipped or unavailable).\n',
    )
    expect(out).toContain('To update manually, run:\n')
    expect(out).toContain('  brew upgrade claude-code')
    expect(out).not.toContain('Claude is up to date!')
  })

  test('cask lookup success still shows Update available', async () => {
    currentPm = 'homebrew'
    caskLookup = '99.0.0'
    const out = await runUpdate()
    expect(out).toContain('Update available: 2.1.276 → 99.0.0')
    expect(out).not.toContain('Could not check for updates')
  })

  test('cask null but GCS fallback succeeds does not print Could-not-check', async () => {
    currentPm = 'homebrew'
    caskLookup = null
    gcsLookup = '99.0.0'
    const out = await runUpdate()
    expect(out).toContain('Update available: 2.1.276 → 99.0.0')
    expect(out).not.toContain('Could not check for updates')
  })
})

// E-9/P2: restore every module-level mock.module() so the shared-process
// `npm test` run does not leak these fakes into later test files. Bun's
// mock.restore() does NOT undo mock.module — re-mock with the load-time real
// snapshots (same pattern as diskOutputDrainGuard247.test.ts).
afterAll(() => {
  mock.module('../../utils/doctorDiagnostic.js', () => ({ ...realDiagnostic }))
  mock.module('../../utils/nativeInstaller/packageManagers.js', () => ({
    ...realPm,
  }))
  mock.module('../../utils/autoUpdater.js', () => ({ ...realUpdater }))
  mock.module('../../utils/gracefulShutdown.js', () => ({ ...realShutdown }))
  mock.module('../../utils/process.js', () => ({ ...realProcessUtils }))
  mock.module('../../utils/settings/settings.js', () => ({ ...realSettings }))
  mock.module('../../utils/debug.js', () => ({ ...realDebug }))
})
