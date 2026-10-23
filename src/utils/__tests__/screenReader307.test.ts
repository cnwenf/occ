/**
 * occ B14 — official 2.1.307 (since 2.1.305) axScreenReader settings-source
 * gating + project-settings warning.
 *
 * Changelog (2.1.307): "Changed the axScreenReader setting and
 * CLAUDE_AX_SCREEN_READER in a settings env block to apply only from user,
 * managed or --settings settings (since 2.1.305)".
 *
 * Binary evidence (v307 linux-x64 ELF; v306 logic-identical):
 *
 * - isEnabled settings branch @241429201:
 *     `e=Y8("axScreenReader").find((l)=>Qt(l.source))?.value===!0,n="settings"`
 * - accessor @240100650 (v307; v306 @239103916 `f8`/`Yli`):
 *     `var gmi=["policySettings","flagSettings","userSettings"];
 *      function Y8(e){let n=[];for(let r of gmi){let s=pe(r)?.[e];
 *      if(s!==void 0)n.push({source:r,value:s})}return n}`
 *   → first-defined-wins over the three privileged sources IN THAT ORDER,
 *   filtered by enabled sources (`Qt(e){return Io().includes(e)}` @239248799).
 * - warning builder `U()` @241430678 (see getScreenReaderProjectSettingsWarning
 *   doc in ../screenReader.ts for the full quoted body).
 * - caller `S7s` @241431432: announcement wins; when no announcement, the
 *   warning is written through the same callback — call site @258318961:
 *     `S7s(!St&&process.stdout.isTTY===!0,(s)=>{console.log(s)})`
 * - schema describe @239376087 (see the describe-text test below).
 *
 * Env-block gating finding (spec item 2): OCC DOES materialize settings `env`
 * blocks into process.env — applySafeConfigEnvironmentVariables (init.ts:74,
 * trusted sources only for CLAUDE_AX_*; project-scoped keys pass only the
 * SAFE_ENV_VARS allowlist, which does NOT include CLAUDE_AX_SCREEN_READER) and
 * applyConfigEnvironmentVariables (main.tsx:2356 for -p, interactiveHelpers
 * after trust, onChangeAppState on settings.env change) which DOES inject
 * project/local env keys into live process.env. The isEnabled() env branch is
 * therefore gated to: enabled privileged source env blocks (policy > flag >
 * user — the official Object.assign materialization order user→flag→policy,
 * later-wins) or the REAL launch env (pre-settings snapshot; live process.env
 * only before the snapshot is captured).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getAllowedSettingSources,
  getOriginalCwd,
  setAllowedSettingSources,
  setFlagSettingsPath,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import type { SettingSource } from '../settings/constants.js'
import {
  getPreSettingsEnvSnapshot,
  dropPreSettingsEnvSnapshot,
} from '../managedEnv.js'
import {
  screenReader,
  isScreenReaderEnabled,
  getScreenReaderProjectSettingsWarning,
} from '../screenReader.js'
import {
  clearMdmSettingsCache,
  setMdmSettingsCache,
} from '../settings/mdm/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { SettingsSchema } from '../settings/types.js'
import { resetSyncCache } from '../../services/remoteManagedSettings/syncCacheState.js'

const SAVED_ARGV = process.argv.slice()
const SAVED_ENV_KEYS = [
  'CLAUDE_AX_SCREEN_READER',
  'CLAUDE_CONFIG_DIR',
  'USER_TYPE',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
] as const
const SAVED_ENV: Record<string, string | undefined> = {}
for (const key of SAVED_ENV_KEYS) SAVED_ENV[key] = process.env[key]
const SAVED_CWD = getOriginalCwd()
const SAVED_ALLOWED_SOURCES = getAllowedSettingSources()

let tmpDirs: string[] = []

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Seed userSettings (~/.claude/settings.json equivalent) via CLAUDE_CONFIG_DIR. */
function seedUserSettings(settings: object): void {
  const configDir = makeTmpDir('occ-sr307-user-')
  process.env.CLAUDE_CONFIG_DIR = configDir
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
}

/** Set CLAUDE_CONFIG_DIR without writing a settings file (path derivation only). */
function seedConfigDirOnly(dirName: string): void {
  process.env.CLAUDE_CONFIG_DIR = join(homedir(), dirName)
}

/** Seed projectSettings + localSettings under a fresh non-git cwd. */
function seedProjectDir(opts: {
  project?: object
  local?: object
}): string {
  const projectDir = makeTmpDir('occ-sr307-proj-')
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  if (opts.project !== undefined) {
    writeFileSync(
      join(projectDir, '.claude', 'settings.json'),
      JSON.stringify(opts.project),
    )
  }
  if (opts.local !== undefined) {
    writeFileSync(
      join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify(opts.local),
    )
  }
  setOriginalCwd(projectDir)
  return projectDir
}

/** Seed flagSettings (--settings <path>). */
function seedFlagSettings(settings: object): void {
  const dir = makeTmpDir('occ-sr307-flag-')
  const filePath = join(dir, 'flag-settings.json')
  writeFileSync(filePath, JSON.stringify(settings))
  setFlagSettingsPath(filePath)
}

/** Seed policySettings via the MDM cache (remote cache cleared first). */
function seedPolicySettings(settings: object): void {
  resetSyncCache()
  setMdmSettingsCache(
    { settings: settings as never, errors: [] },
    { settings: {} as never, errors: [] },
  )
}

beforeEach(() => {
  screenReader.reset()
  resetSettingsCache()
  clearMdmSettingsCache()
  resetSyncCache()
  dropPreSettingsEnvSnapshot()
  process.argv = ['/bin/occ', 'repl']
  delete process.env.CLAUDE_AX_SCREEN_READER
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  screenReader.reset()
  resetSettingsCache()
  clearMdmSettingsCache()
  resetSyncCache()
  dropPreSettingsEnvSnapshot()
  process.argv = SAVED_ARGV.slice()
  for (const key of SAVED_ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED_ENV[key]
  }
  setOriginalCwd(SAVED_CWD)
  setAllowedSettingSources(SAVED_ALLOWED_SOURCES)
  setFlagSettingsPath(undefined)
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

function setSources(sources: SettingSource[]): void {
  setAllowedSettingSources(sources)
  resetSettingsCache()
  screenReader.reset()
}

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

describe('2.1.307 B14: axScreenReader settings-source hierarchy (binary Y8/gmi + Qt find)', () => {
  test('projectSettings axScreenReader:true does NOT enable (the 2.1.305 bug fix)', () => {
    // Arrange
    seedProjectDir({ project: { axScreenReader: true } })
    // Act / Assert
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('localSettings axScreenReader:true does NOT enable', () => {
    seedProjectDir({ local: { axScreenReader: true } })
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('userSettings axScreenReader:true enables with source "settings"', () => {
    seedUserSettings({ axScreenReader: true })
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('settings')
  })

  test('userSettings axScreenReader:false stays disabled', () => {
    seedUserSettings({ axScreenReader: false })
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('flagSettings axScreenReader:true enables', () => {
    seedFlagSettings({ axScreenReader: true })
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('settings')
  })

  test('policySettings wins over userSettings when both defined (first-defined-wins order)', () => {
    seedUserSettings({ axScreenReader: true })
    seedPolicySettings({ axScreenReader: false })
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('policySettings:true enables over userSettings:false', () => {
    seedUserSettings({ axScreenReader: false })
    seedPolicySettings({ axScreenReader: true })
    expect(isScreenReaderEnabled()).toBe(true)
  })

  test('flagSettings wins over userSettings (first-defined-wins order policy→flag→user)', () => {
    seedUserSettings({ axScreenReader: true })
    seedFlagSettings({ axScreenReader: false })
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('projectSettings:false does NOT override userSettings:true (project ignored entirely)', () => {
    seedUserSettings({ axScreenReader: true })
    seedProjectDir({ project: { axScreenReader: false } })
    expect(isScreenReaderEnabled()).toBe(true)
  })

  test('--setting-sources filtering: userSettings disabled → its axScreenReader:true is ignored', () => {
    seedUserSettings({ axScreenReader: true })
    setSources([
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('--setting-sources filtering: userSettings re-enabled → honored again', () => {
    seedUserSettings({ axScreenReader: true })
    setSources([
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    expect(isScreenReaderEnabled()).toBe(false)
    setSources(ALL_SOURCES)
    expect(isScreenReaderEnabled()).toBe(true)
  })

  test('flag branch still outranks the settings branch (--ax-screen-reader)', () => {
    seedUserSettings({ axScreenReader: false })
    process.argv = ['/bin/occ', '--ax-screen-reader', 'repl']
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('flag')
  })

  test('real process env branch still outranks the settings branch', () => {
    seedUserSettings({ axScreenReader: false })
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('env')
  })
})

describe('2.1.307 B14: CLAUDE_AX_SCREEN_READER env-block gating', () => {
  test('project env-block value materialized into process.env does NOT enable', () => {
    // Arrange: clean launch env captured in the pre-settings snapshot, then
    // simulate applyConfigEnvironmentVariables injecting the project env block.
    seedProjectDir({ project: { env: { CLAUDE_AX_SCREEN_READER: '1' } } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    // Act / Assert
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('localSettings env-block value materialized into process.env does NOT enable', () => {
    seedProjectDir({ local: { env: { CLAUDE_AX_SCREEN_READER: '1' } } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('userSettings env block DOES enable (privileged source env block counts)', () => {
    seedUserSettings({ env: { CLAUDE_AX_SCREEN_READER: '1' } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    expect(isScreenReaderEnabled()).toBe(true)
    expect(screenReader.activationSource()).toBe('env')
  })

  test('flagSettings (--settings) env block DOES enable', () => {
    seedFlagSettings({ env: { CLAUDE_AX_SCREEN_READER: '1' } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    expect(isScreenReaderEnabled()).toBe(true)
  })

  test('policySettings env block DOES enable', () => {
    seedPolicySettings({ env: { CLAUDE_AX_SCREEN_READER: '1' } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    expect(isScreenReaderEnabled()).toBe(true)
  })

  test('policySettings env block overrides userSettings env block (later-wins materialization)', () => {
    seedUserSettings({ env: { CLAUDE_AX_SCREEN_READER: '1' } })
    seedPolicySettings({ env: { CLAUDE_AX_SCREEN_READER: '0' } })
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('disabled userSettings source: its env block is ignored even if materialized into live env', () => {
    seedUserSettings({ env: { CLAUDE_AX_SCREEN_READER: '1' } })
    setSources([
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    delete process.env.CLAUDE_AX_SCREEN_READER
    getPreSettingsEnvSnapshot()
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    expect(isScreenReaderEnabled()).toBe(false)
  })

  test('real launch env (pre-settings snapshot) still enables', () => {
    process.env.CLAUDE_AX_SCREEN_READER = '1'
    getPreSettingsEnvSnapshot()
    // Simulate a later full-apply clobbering it to off — launch env wins.
    process.env.CLAUDE_AX_SCREEN_READER = '0'
    expect(isScreenReaderEnabled()).toBe(true)
  })
})

describe('2.1.307 B14: getScreenReaderProjectSettingsWarning (binary U())', () => {
  const SHORT =
    "Screen reader mode is off: project settings can't turn it on. To turn it on, start Claude Code with --ax-screen-reader."
  const longWith = (path: string) =>
    `Screen reader mode is off: project settings can't turn it on. To turn it on, start Claude Code with --ax-screen-reader, or add "axScreenReader": true to your own settings file at ${path} and restart.`

  test('null when nothing attempts to turn SR on', () => {
    seedProjectDir({ project: { env: {} } })
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('null when SR is enabled via userSettings', () => {
    seedUserSettings({ axScreenReader: true })
    seedProjectDir({ project: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('null when SR is enabled via the CLI flag', () => {
    seedProjectDir({ project: { axScreenReader: true } })
    process.argv = ['/bin/occ', '--ax-screen-reader', 'repl']
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('null when CLAUDE_AX_SCREEN_READER is defined in the real env (even falsy)', () => {
    // Official guard: `a.CLAUDE_AX_SCREEN_READER!==void 0` — DEFINED (not
    // truthy) suppresses the warning.
    seedProjectDir({ project: { axScreenReader: true } })
    process.env.CLAUDE_AX_SCREEN_READER = '0'
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('null when an enabled privileged source DEFINES axScreenReader (even false)', () => {
    // Official guard: `Y8("axScreenReader").some((i)=>Qt(i.source))` — the
    // key being defined in user settings suppresses the warning.
    seedUserSettings({ axScreenReader: false })
    seedProjectDir({ project: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('LONG variant with ~-relative userSettings path when project axScreenReader:true', () => {
    seedConfigDirOnly('.occ-sr307-long')
    seedProjectDir({ project: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith('~/.occ-sr307-long/settings.json'),
    )
  })

  test('LONG variant renders tabs/newlines in the path as spaces', () => {
    seedConfigDirOnly('.occ\tsr307\nx')
    seedProjectDir({ project: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith('~/.occ sr307 x/settings.json'),
    )
  })

  test('LONG variant when localSettings axScreenReader:true', () => {
    seedConfigDirOnly('.occ-sr307-local')
    seedProjectDir({ local: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith('~/.occ-sr307-local/settings.json'),
    )
  })

  test('LONG variant when project env-block CLAUDE_AX_SCREEN_READER is truthy', () => {
    seedConfigDirOnly('.occ-sr307-env')
    seedProjectDir({ project: { env: { CLAUDE_AX_SCREEN_READER: '1' } } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith('~/.occ-sr307-env/settings.json'),
    )
  })

  test('project env-block key match is case-insensitive (toUpperCase)', () => {
    seedConfigDirOnly('.occ-sr307-case')
    seedProjectDir({ project: { env: { claude_ax_screen_reader: 'true' } } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith('~/.occ-sr307-case/settings.json'),
    )
  })

  test('falsy project env-block value does NOT trigger the warning', () => {
    seedConfigDirOnly('.occ-sr307-falsy')
    seedProjectDir({ project: { env: { CLAUDE_AX_SCREEN_READER: '0' } } })
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('project axScreenReader:false does NOT trigger the warning', () => {
    seedConfigDirOnly('.occ-sr307-off')
    seedProjectDir({ project: { axScreenReader: false } })
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('SHORT variant when the userSettings source is not enabled', () => {
    // Official: `if(!Qt("userSettings"))return` SHORT — no userSettings path
    // is inserted when --setting-sources excluded user settings.
    seedProjectDir({ project: { axScreenReader: true } })
    setSources([
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ])
    expect(getScreenReaderProjectSettingsWarning()).toBe(SHORT)
  })

  test('disabled project/local sources are not scanned (Qt(i)?pe(i):null)', () => {
    seedConfigDirOnly('.occ-sr307-disabled')
    seedProjectDir({ project: { axScreenReader: true } })
    setSources(['userSettings', 'flagSettings', 'policySettings'])
    expect(getScreenReaderProjectSettingsWarning()).toBeNull()
  })

  test('non-home config dir renders as an absolute path (no ~ prefix)', () => {
    const configDir = makeTmpDir('occ-sr307-abs-')
    process.env.CLAUDE_CONFIG_DIR = configDir
    seedProjectDir({ project: { axScreenReader: true } })
    expect(getScreenReaderProjectSettingsWarning()).toBe(
      longWith(`${configDir}/settings.json`),
    )
  })
})

describe('2.1.307 B14: axScreenReader schema describe text (binary @239376087)', () => {
  test('describe text is byte-identical to the official', () => {
    const OFFICIAL_DESCRIBE =
      'Render screen-reader friendly output (flat text, no decorative borders or animations). Overridden by the CLAUDE_AX_SCREEN_READER env var and the --ax-screen-reader CLI flag. Ignored in project and local settings.'
    const shape = SettingsSchema().shape as unknown as Record<
      string,
      { description?: string }
    >
    expect(shape.axScreenReader.description).toBe(OFFICIAL_DESCRIBE)
  })
})
