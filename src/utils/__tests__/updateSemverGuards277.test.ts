import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.277 (C3): official v277 semver-validates every version string that
 * flows into the update skip-checks and version lookups before comparing.
 *
 * Binary evidence (v277 ELF @0xc16fe39, `Xcn`/`YEe`):
 *   `update target is not a valid semver version — skip checks constrain nothing`
 *   `minimumVersion is not a valid semver version — ignoring. Value (first 300 chars, JSON-encoded): …`
 *   `below your minimumVersion setting (${r})`
 *   `requiredMaximumVersion is not a valid semver version — ignoring. …`
 *   `above your organization's requiredMaximumVersion (${n})`
 *   `Skipping update to ${e}: ${r}`
 * npm lookup (`pLe`), GCS lookup (`Jcn`), homebrew lookup (`tt`):
 *   `npm view exited ${code} but printed a valid version (${v}) — treating stderr as a warning`
 *   `npm view exited 0 but stdout is not a valid semver version — treating as no result`
 *   `npm stdout (first 300 chars, JSON-encoded): …`
 *   `GCS ${channel} version response is not a valid semver version — treating as no result`
 *   `formulae.brew.sh ${cask} version is not a valid semver version — treating as no result`
 *
 * Pre-port, OCC called gte(target, minimumVersion) unguarded — a malformed
 * settings value made every 30-min update check throw "Invalid SemVer".
 */

process.env.NODE_ENV = 'test'
const TMP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-c3-'))
process.env.CLAUDE_CONFIG_DIR = TMP_CONFIG_DIR
;(globalThis as { MACRO?: unknown }).MACRO = {
  VERSION: '2.1.276',
  BINARY_NAME: 'occ',
  PACKAGE_URL: '@cnwenf/occ',
  NATIVE_PACKAGE_URL: '',
}

// -- Mock leaf collaborators (spread-real keeps every other export intact) --
// E-9/P2: snapshot real export values into plain objects BEFORE mocking —
// `await import()` namespaces are live bindings that become the fake once
// mock.module() installs (pattern: diskOutputDrainGuard247.test.ts).

const realSettings = { ...(await import('../settings/settings.js')) }
let currentSettings: { minimumVersion?: string } | null = null
let currentPolicy: { requiredMaximumVersion?: string } | null = null
// Passthrough flag (OCC-96 leak hunt): with it off (afterAll) every leaked
// closure below delegates to the real implementation instead of serving this
// file's frozen seams (currentSettings=null gated #103 refreshes off, the
// frozen npmResult {code:0} faked marketplaceKeptStale281's git clones, the
// frozen axiosResponder threw on every late axios.get).
let semverMocksActive = true
mock.module('../settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: () =>
    semverMocksActive
      ? currentSettings
      : (realSettings.getInitialSettings as () => unknown)(),
  getSettingsForSource: (source: string) =>
    semverMocksActive
      ? source === 'policySettings'
        ? currentPolicy
        : null
      : (realSettings.getSettingsForSource as (s: string) => unknown)(source),
}))

const realDebug = { ...(await import('../debug.js')) }
const debugLogs: string[] = []
mock.module('../debug.js', () => ({
  ...realDebug,
  logForDebugging: (message: string) => {
    if (!semverMocksActive) {
      return (realDebug.logForDebugging as (m: string) => void)(message)
    }
    debugLogs.push(message)
  },
}))

const realExec = { ...(await import('../execFileNoThrow.js')) }
let npmResult: { code: number; stdout: string; stderr: string } = {
  code: 0,
  stdout: '',
  stderr: '',
}
mock.module('../execFileNoThrow.js', () => ({
  ...realExec,
  execFileNoThrowWithCwd: async (
    file: string,
    args: string[],
    opts: unknown,
  ) =>
    semverMocksActive
      ? npmResult
      : (
          realExec.execFileNoThrowWithCwd as (
            f: string,
            a: string[],
            o: unknown,
          ) => Promise<unknown>
        )(file, args, opts),
}))

const realAxios = { ...(await import('axios')) }
const realAxiosDefault = { ...realAxios.default }
let axiosResponder: (url: string) => { data: unknown } = () => {
  throw new Error('unexpected axios call')
}
mock.module('axios', () => ({
  ...realAxios,
  default: {
    ...realAxiosDefault,
    get: async (url: string) =>
      semverMocksActive
        ? axiosResponder(url)
        : (realAxiosDefault.get as (u: string) => Promise<unknown>)(url),
  },
}))

const {
  shouldSkipVersion,
  getVersionSkipReason,
  getLatestVersion,
  getLatestVersionFromGcs,
  getLatestVersionFromHomebrewCask,
} = await import('../autoUpdater.js')

beforeEach(() => {
  currentSettings = null
  currentPolicy = null
  debugLogs.length = 0
  npmResult = { code: 0, stdout: '', stderr: '' }
})

describe('C3: shouldSkipVersion semver guards', () => {
  test('invalid minimumVersion is logged and ignored (no throw)', () => {
    currentSettings = { minimumVersion: 'not-a-version' }
    expect(() => shouldSkipVersion('2.0.0')).not.toThrow()
    expect(shouldSkipVersion('2.0.0')).toBe(false)
    expect(
      debugLogs.some(l =>
        l.startsWith(
          'minimumVersion is not a valid semver version — ignoring. Value (first 300 chars, JSON-encoded): ',
        ),
      ),
    ).toBe(true)
  })

  test('valid minimumVersion is still honored', () => {
    currentSettings = { minimumVersion: '3.0.0' }
    expect(shouldSkipVersion('2.0.0')).toBe(true)
    expect(getVersionSkipReason('2.0.0')).toBe(
      'below your minimumVersion setting (3.0.0)',
    )
    expect(
      debugLogs.some(l => l === 'Skipping update to 2.0.0: below your minimumVersion setting (3.0.0)'),
    ).toBe(true)
    // target at/above the minimum is not skipped
    expect(shouldSkipVersion('3.1.0')).toBe(false)
  })

  test('malformed update target does not throw and constrains nothing', () => {
    currentSettings = { minimumVersion: '3.0.0' }
    const garbage = '<html>\n502 Bad Gateway\n</html>'
    expect(() => shouldSkipVersion(garbage)).not.toThrow()
    expect(getVersionSkipReason(garbage)).toBeNull()
    expect(
      debugLogs.some(
        l =>
          l ===
          'update target is not a valid semver version — skip checks constrain nothing',
      ),
    ).toBe(true)
    expect(
      debugLogs.some(l =>
        l.startsWith('update target (first 300 chars, JSON-encoded): '),
      ),
    ).toBe(true)
  })

  test('invalid requiredMaximumVersion is logged and ignored (no throw)', () => {
    currentPolicy = { requiredMaximumVersion: 'nope' }
    expect(() => shouldSkipVersion('2.0.0')).not.toThrow()
    expect(shouldSkipVersion('2.0.0')).toBe(false)
    expect(
      debugLogs.some(l =>
        l.startsWith(
          'requiredMaximumVersion is not a valid semver version — ignoring. Value (first 300 chars, JSON-encoded): ',
        ),
      ),
    ).toBe(true)
  })

  test('valid requiredMaximumVersion is honored', () => {
    currentPolicy = { requiredMaximumVersion: '1.5.0' }
    expect(shouldSkipVersion('2.0.0')).toBe(true)
    expect(getVersionSkipReason('2.0.0')).toBe(
      "above your organization's requiredMaximumVersion (1.5.0)",
    )
    expect(shouldSkipVersion('1.4.0')).toBe(false)
  })
})

describe('C3: npm lookup validation (pLe port)', () => {
  test('non-zero exit with valid stdout version treats stderr as a warning', async () => {
    npmResult = { code: 1, stdout: '2.0.0\n', stderr: 'npm WARN proxy' }
    expect(await getLatestVersion('latest')).toBe('2.0.0')
    expect(
      debugLogs.some(
        l =>
          l ===
          'npm view exited 1 but printed a valid version (2.0.0) — treating stderr as a warning',
      ),
    ).toBe(true)
  })

  test('non-zero exit with junk stdout returns null', async () => {
    npmResult = { code: 1, stdout: '<html>502</html>', stderr: '' }
    expect(await getLatestVersion('latest')).toBeNull()
    expect(debugLogs.some(l => l === 'npm view failed with code 1')).toBe(true)
    expect(debugLogs.some(l => l === 'npm stderr: (empty)')).toBe(true)
    expect(
      debugLogs.some(l =>
        l.startsWith('npm stdout (first 300 chars, JSON-encoded): '),
      ),
    ).toBe(true)
  })

  test('zero exit with non-semver stdout returns null (invalid treated as no result)', async () => {
    npmResult = { code: 0, stdout: 'not a version at all', stderr: '' }
    expect(await getLatestVersion('stable')).toBeNull()
    expect(
      debugLogs.some(
        l =>
          l ===
          'npm view exited 0 but stdout is not a valid semver version — treating as no result',
      ),
    ).toBe(true)
  })

  test('zero exit with valid stdout returns the version', async () => {
    npmResult = { code: 0, stdout: ' 2.1.278\n', stderr: '' }
    expect(await getLatestVersion('latest')).toBe('2.1.278')
  })
})

describe('C3: GCS + homebrew lookup validation (Jcn/tt ports)', () => {
  test('GCS garbage response is treated as no result', async () => {
    axiosResponder = () => ({ data: '<html>proxy error</html>' })
    expect(await getLatestVersionFromGcs('latest')).toBeNull()
    expect(
      debugLogs.some(
        l =>
          l ===
          'GCS latest version response is not a valid semver version — treating as no result',
      ),
    ).toBe(true)
    expect(
      debugLogs.some(l =>
        l.startsWith('GCS response body (first 300 chars, JSON-encoded): '),
      ),
    ).toBe(true)
  })

  test('GCS valid response is returned', async () => {
    axiosResponder = () => ({ data: ' 2.1.278\n' })
    expect(await getLatestVersionFromGcs('stable')).toBe('2.1.278')
  })

  test('homebrew cask with malformed version is treated as no result', async () => {
    axiosResponder = () => ({ data: { version: 'v2.0-beta!!' } })
    expect(await getLatestVersionFromHomebrewCask('claude-code')).toBeNull()
    expect(
      debugLogs.some(
        l =>
          l ===
          'formulae.brew.sh claude-code version is not a valid semver version — treating as no result',
      ),
    ).toBe(true)
    expect(
      debugLogs.some(l =>
        l.startsWith('brew response (first 300 chars, JSON-encoded): '),
      ),
    ).toBe(true)
  })

  test('homebrew cask with valid version is returned trimmed', async () => {
    axiosResponder = () => ({ data: { version: ' 2.1.277 ' } })
    expect(await getLatestVersionFromHomebrewCask('claude-code')).toBe(
      '2.1.277',
    )
  })
})

// E-9/P2: restore every module-level mock.module() so the shared-process
// `npm test` run does not leak these fakes into later test files. Bun's
// mock.restore() does NOT undo mock.module — re-mock with the load-time real
// snapshots (same pattern as diskOutputDrainGuard247.test.ts).
afterAll(() => {
  semverMocksActive = false
  mock.module('../settings/settings.js', () => ({ ...realSettings }))
  mock.module('../debug.js', () => ({ ...realDebug }))
  mock.module('../execFileNoThrow.js', () => ({ ...realExec }))
  mock.module('axios', () => ({ ...realAxios, default: realAxiosDefault }))
})
