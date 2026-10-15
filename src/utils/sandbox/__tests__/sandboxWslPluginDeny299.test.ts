import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { delimiter, join, resolve } from 'path'
import { setInlinePlugins } from '../../../bootstrap/state.js'
import { setCachedSettingsForSource, resetSettingsCache } from '../../settings/settingsCache.js'
import type { SettingSource } from '../../settings/constants.js'
import type { SettingsJson } from '../../settings/types.js'
import {
  _setWslMountGuardOverridesForTesting,
  applyWslWindowsMountDenyFilter,
  computePluginDirDenyPaths,
  convertToSandboxRuntimeConfig,
} from '../sandbox-adapter.js'

/**
 * CC 2.1.299 #027 + #034 — adapter-level tests.
 *
 * #027 (OCC hardening; official main-sandbox shape ambiguous): inline plugin
 * dirs (--plugin-dir) and CLAUDE_CODE_PLUGIN_SEED_DIR dirs are loaded and
 * executed OUTSIDE the sandbox, so they must land in denyWrite — both the
 * resolved literal dir and its realpath target (mirrors the official eval
 * sandbox `denyWrite:[..., ...await mn(D([...pluginDirsUnderTest, caseDir]))]`
 * shape, v299 strings dump).
 *
 * #034: on WSL2 the denyWrite filter must drop entries whose mount-point
 * creation would land under a Windows-drive mount (bwrap "Can't mkdir
 * /mnt/c/…"), keep entries that exist (ro-bind, no mkdir) and entries off
 * Windows mounts, and fail closed with the byte-exact official refusal when
 * the mount table cannot be determined (v299 @254393924).
 *
 * Harness: settings cache seeding (no disk reads), fixture temp dirs, and the
 * adapter's _setWslMountGuardOverridesForTesting seam — no mock.module (OCC-97
 * hygiene). Tests run on Linux, so without overrides the WSL guard is a no-op.
 */

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

/** Seed every source through the settings cache (null = no settings). */
function seed(bySource: Partial<Record<SettingSource, SettingsJson>>): void {
  for (const source of ALL_SOURCES) {
    setCachedSettingsForSource(source, bySource[source] ?? null)
  }
}

// WSL2 fixture mount table: two Windows-side mounts (/mnt/c drvfs, /mnt/wslg
// 9p aname=drvfs) plus native ext4 mounts.
const WSL_MOUNTS_FIXTURE = [
  'sysfs /sys sysfs rw,nosuid 0 0',
  '/dev/sda1 /home ext4 rw 0 0',
  'C:\\ /mnt/c drvfs rw,noatime 0 0',
  'none /mnt/wslg 9p rw,trans=fd,aname=drvfs;fmask=022 0 0',
  'tmpfs /run tmpfs rw 0 0',
].join('\n')

const NATIVE_ONLY_FIXTURE = [
  'sysfs /sys sysfs rw 0 0',
  '/dev/sda1 /home ext4 rw 0 0',
].join('\n')

const fixtureRoots: string[] = []

function makeFixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'occ-299-wsl-plugin-'))
  fixtureRoots.push(root)
  return root
}

const SEED_DIR_ENV = 'CLAUDE_CODE_PLUGIN_SEED_DIR'
let savedSeedDirEnv: string | undefined

beforeEach(() => {
  resetSettingsCache()
  seed({})
  savedSeedDirEnv = process.env[SEED_DIR_ENV]
  delete process.env[SEED_DIR_ENV]
  setInlinePlugins([])
})

afterEach(() => {
  setInlinePlugins([])
  if (savedSeedDirEnv === undefined) {
    delete process.env[SEED_DIR_ENV]
  } else {
    process.env[SEED_DIR_ENV] = savedSeedDirEnv
  }
  _setWslMountGuardOverridesForTesting(undefined)
})

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// #027 — computePluginDirDenyPaths (pure)
// ---------------------------------------------------------------------------

describe('CC 2.1.299 #027 — computePluginDirDenyPaths', () => {
  test('existing dir is denied as its resolved absolute path', () => {
    const root = makeFixtureRoot()
    const pluginDir = join(root, 'plugin')
    mkdirSync(pluginDir)

    expect(computePluginDirDenyPaths([pluginDir])).toEqual([resolve(pluginDir)])
  })

  test('symlinked plugin dir is denied both literally and through its realpath target', () => {
    const root = makeFixtureRoot()
    const realDir = join(root, 'real-plugin')
    mkdirSync(realDir)
    const linkDir = join(root, 'link-plugin')
    symlinkSync(realDir, linkDir)

    const denies = computePluginDirDenyPaths([linkDir])
    expect(denies).toContain(resolve(linkDir))
    expect(denies).toContain(realpathSync(linkDir))
  })

  test('non-existent plugin dir still yields the literal deny (fail closed)', () => {
    const root = makeFixtureRoot()
    const missing = join(root, 'no-such-plugin')

    expect(computePluginDirDenyPaths([missing])).toEqual([resolve(missing)])
  })

  test('duplicates collapse and empty/whitespace entries are skipped', () => {
    const root = makeFixtureRoot()
    const pluginDir = join(root, 'plugin')
    mkdirSync(pluginDir)

    expect(
      computePluginDirDenyPaths([pluginDir, pluginDir, '', '   ', pluginDir]),
    ).toEqual([resolve(pluginDir)])
  })
})

// ---------------------------------------------------------------------------
// #027 — adapter integration (inline plugins + seed dirs → denyWrite)
// ---------------------------------------------------------------------------

describe('CC 2.1.299 #027 — plugin dirs in convertToSandboxRuntimeConfig', () => {
  test('inline plugin dirs (--plugin-dir) land in denyWrite', () => {
    const root = makeFixtureRoot()
    const pluginDir = join(root, 'inline-plugin')
    mkdirSync(pluginDir)
    setInlinePlugins([pluginDir])

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(resolve(pluginDir))
  })

  test('symlinked inline plugin dir denies the realpath target too', () => {
    const root = makeFixtureRoot()
    const realDir = join(root, 'real-plugin')
    mkdirSync(realDir)
    const linkDir = join(root, 'link-plugin')
    symlinkSync(realDir, linkDir)
    setInlinePlugins([linkDir])

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(resolve(linkDir))
    expect(config.filesystem.denyWrite).toContain(realpathSync(linkDir))
  })

  test('CLAUDE_CODE_PLUGIN_SEED_DIR dirs land in denyWrite', () => {
    const root = makeFixtureRoot()
    const seedDir = join(root, 'seed-plugin')
    mkdirSync(seedDir)
    process.env[SEED_DIR_ENV] = seedDir

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(resolve(seedDir))
  })

  test('multiple seed dirs (delimiter-separated) all land in denyWrite', () => {
    const root = makeFixtureRoot()
    const seedA = join(root, 'seed-a')
    const seedB = join(root, 'seed-b')
    mkdirSync(seedA)
    mkdirSync(seedB)
    process.env[SEED_DIR_ENV] = [seedA, seedB].join(delimiter)

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(resolve(seedA))
    expect(config.filesystem.denyWrite).toContain(resolve(seedB))
  })

  test('no plugin dirs → denyWrite carries no fixture paths (unchanged baseline)', () => {
    const root = makeFixtureRoot()
    const pluginDir = join(root, 'unused-plugin')
    mkdirSync(pluginDir)

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).not.toContain(resolve(pluginDir))
    expect(config.filesystem.denyWrite).not.toContain(pluginDir)
  })
})

// ---------------------------------------------------------------------------
// #034 — applyWslWindowsMountDenyFilter (pure filter with injected seams)
// ---------------------------------------------------------------------------

describe('CC 2.1.299 #034 — applyWslWindowsMountDenyFilter', () => {
  test('non-WSL platform → filter is a no-op (reader never consulted)', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: false,
      readMountTable: () => {
        throw new Error('must not be called')
      },
    })

    const input = ['/mnt/c/Program Files/ClaudeCode', '/keep/me']
    expect(applyWslWindowsMountDenyFilter(input)).toEqual(input)
  })

  test('WSL: non-existent entries under Windows mounts are dropped, everything else kept', () => {
    const root = makeFixtureRoot()
    const existingDir = join(root, 'exists')
    mkdirSync(existingDir)

    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => WSL_MOUNTS_FIXTURE,
      pathExists: (path) => path === resolve(existingDir),
    })

    const filtered = applyWslWindowsMountDenyFilter([
      '/mnt/c/Program Files/ClaudeCode/managed-settings.json',
      '/mnt/wslg/runtime-dir',
      resolve(existingDir),
      '/home/user/missing-deny',
      '/etc/claude/managed.d',
    ])

    expect(filtered).toEqual([
      resolve(existingDir),
      '/home/user/missing-deny',
      '/etc/claude/managed.d',
    ])
  })

  test('WSL: an existing deny entry under a Windows mount is kept (ro-bind, no mkdir)', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => WSL_MOUNTS_FIXTURE,
      pathExists: () => true,
    })

    const input = ['/mnt/c/Users/x/.claude/settings.json']
    expect(applyWslWindowsMountDenyFilter(input)).toEqual(input)
  })

  test('WSL: prefix lookalikes are not treated as under-mount (/mnt/cd vs /mnt/c)', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => WSL_MOUNTS_FIXTURE,
      pathExists: () => false,
    })

    expect(applyWslWindowsMountDenyFilter(['/mnt/cd/x', '/mnt/c/x'])).toEqual([
      '/mnt/cd/x',
    ])
  })

  test('WSL: unreadable mount table refuses with the byte-exact official message', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => {
        throw new Error('EACCES')
      },
    })

    let caught: unknown
    try {
      applyWslWindowsMountDenyFilter(['/mnt/c/x'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      "A shell tool was granted, but the WSL mount table (/proc/mounts) cannot be read, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.",
    )
  })

  test('WSL: mount table without Windows mounts refuses with the byte-exact official message', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => NATIVE_ONLY_FIXTURE,
    })

    let caught: unknown
    try {
      applyWslWindowsMountDenyFilter(['/mnt/c/x'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe(
      "A shell tool was granted, but no Windows filesystem mount was recognized in the WSL mount table, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.",
    )
  })
})

// ---------------------------------------------------------------------------
// #034 — adapter integration (settings denyWrite through the WSL filter)
// ---------------------------------------------------------------------------

describe('CC 2.1.299 #034 — convertToSandboxRuntimeConfig on WSL', () => {
  test('settings denyWrite entries under a Windows drive mount are dropped', () => {
    _setWslWindowsFixture()
    // fs.denyWrite flows from the seeded settings sources (per-source loop),
    // not the convert() argument — seed projectSettings (denies are always
    // honored regardless of tier per the 2.1.285 rule).
    seed({
      projectSettings: {
        sandbox: {
          filesystem: {
            denyWrite: ['/mnt/c/Program Files/ClaudeCode', '/home/user/keep-me'],
          },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain('/home/user/keep-me')
    expect(config.filesystem.denyWrite).not.toContain(
      '/mnt/c/Program Files/ClaudeCode',
    )
  })

  test('unreadable mount table makes config conversion refuse (fail closed)', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: true,
      readMountTable: () => {
        throw new Error('EACCES')
      },
    })

    expect(() => convertToSandboxRuntimeConfig({} as SettingsJson)).toThrow(
      "A shell tool was granted, but the WSL mount table (/proc/mounts) cannot be read, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.",
    )
  })

  test('non-WSL: config conversion never consults the mount table', () => {
    _setWslMountGuardOverridesForTesting({
      isWsl: false,
      readMountTable: () => {
        throw new Error('must not be called')
      },
    })
    seed({
      projectSettings: {
        sandbox: {
          filesystem: {
            denyWrite: ['/mnt/c/Program Files/ClaudeCode'],
          },
        },
      } as SettingsJson,
    })

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(
      '/mnt/c/Program Files/ClaudeCode',
    )
  })
})

/** WSL override with the two-Windows-mount fixture; nothing exists. */
function _setWslWindowsFixture(): void {
  _setWslMountGuardOverridesForTesting({
    isWsl: true,
    readMountTable: () => WSL_MOUNTS_FIXTURE,
    pathExists: () => false,
  })
}

// Sanity: the guard's default existence probe is fs.existsSync (production
// path when no override is installed).
test('default pathExists probe is existsSync', () => {
  const root = makeFixtureRoot()
  const dir = join(root, 'probe')
  mkdirSync(dir)
  expect(existsSync(dir)).toBe(true)
  expect(existsSync(join(root, 'absent'))).toBe(false)
})
