import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetSyncCache,
  setEligibility,
  setSessionCache,
} from '../../../services/remoteManagedSettings/syncCacheState.js'
import { enableConfigs } from '../../config.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from '../managedPath.js'
import { clearMdmSettingsCache, setMdmSettingsCache } from '../mdm/settings.js'
import {
  applyLocalAuthPinPrecedence,
  getLocalAuthPinOverrides,
  getSettingsForSource,
  getSettingsWithErrors,
} from '../settings.js'
import { resetSettingsCache } from '../settingsCache.js'
import type { SettingsJson } from '../types.js'

/**
 * PORT (CC 2.1.299, gap entry #097): MDM forceLoginOrgUUID / forceLoginMethod
 * precedence — local admin auth pins must outrank the remote (server-managed)
 * source when the remote wins the policySettings first-wins pick.
 *
 * Official v299 composition spec (byte-exact, linux-x64 binary @110685262
 * region; full quote in settings.ts above AUTH_PIN_KEYS):
 *   "... the keys taken from the highest source only: the auth pins
 *    forceLoginOrgUUID, forceLoginMethod, forceLoginGatewayUrl and
 *    gatewayInternalNetworks ... In both modes, a forceLoginOrgUUID, or a
 *    forceLoginMethod of claudeai or console, that this machine's own MDM
 *    policy or managed settings file sets applies ahead of server-managed
 *    settings. ... HKCU and --managed-settings never take part in the merge."
 *
 * Behavior under test:
 *   - remote wins the base pick, but per auth-pin key the value resolves
 *     MDM (HKLM/plist) → managed-settings.json → remote (first set wins);
 *   - remote-only pin → remote applies; local-only pin → local applies;
 *   - HKCU pins never override (HKCU excluded from the local override set);
 *   - the rest of the first-wins order is UNCHANGED (non-auth-pin content of
 *     the winning source is returned whole).
 *
 * Test architecture follows managedReadDenial285.test.ts: zero mock.module,
 * zero top-level env mutation; env window in beforeAll + restore in afterAll;
 * managed-settings path via USER_TYPE=ant + CLAUDE_CODE_MANAGED_SETTINGS_PATH;
 * remote cache via setSessionCache + setEligibility(true); MDM/HKCU via
 * setMdmSettingsCache. All process-wide caches cleared around every test.
 */

const ENV_KEYS = [
  'USER_TYPE',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
  'CLAUDE_CONFIG_DIR',
  'NODE_ENV',
  'CI',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

let savedEnv: Record<string, string | undefined> = {}
let testRoot = ''
let managedDir = ''
let configDir = ''

const clearManagedPathCaches = (): void => {
  ;(getManagedFilePath as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    getManagedSettingsDropInDir as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

const clearAllCaches = (): void => {
  clearManagedPathCaches()
  resetSettingsCache()
  clearMdmSettingsCache()
  resetSyncCache()
}

const seedRemote = (settings: Record<string, unknown>): void => {
  setSessionCache(settings as SettingsJson)
  setEligibility(true)
}

const seedMdm = (mdm: Record<string, unknown>, hkcu = {}): void => {
  setMdmSettingsCache(
    { settings: mdm as SettingsJson, errors: [] },
    { settings: hkcu as SettingsJson, errors: [] },
  )
}

const writeManagedFile = (settings: Record<string, unknown>): void => {
  writeFileSync(
    join(managedDir, 'managed-settings.json'),
    JSON.stringify(settings),
    'utf8',
  )
}

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-authpin-299-'))
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  enableConfigs()
})

beforeEach(() => {
  for (const key of ENV_KEYS) {
    if (key !== 'NODE_ENV' && key !== 'CI') {
      delete process.env[key]
    }
  }
  managedDir = mkdtempSync(join(testRoot, 'managed-'))
  configDir = mkdtempSync(join(testRoot, 'config-'))
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managedDir
  process.env.CLAUDE_CONFIG_DIR = configDir
  clearAllCaches()
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  clearAllCaches()
  rmSync(testRoot, { recursive: true, force: true })
})

describe('auth-pin local precedence — getSettingsForSource(policySettings)', () => {
  test('local managed-file org UUID A beats remote org UUID B (the #097 fix)', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote' })
    writeManagedFile({ forceLoginOrgUUID: 'A-local' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('A-local')
  })

  test('MDM (HKLM/plist) pin beats both the remote pin and the managed-file pin', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote' })
    writeManagedFile({ forceLoginOrgUUID: 'A-file' })
    seedMdm({ forceLoginOrgUUID: 'M-mdm', forceLoginMethod: 'console' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('M-mdm')
    expect(policy?.forceLoginMethod).toBe('console')
  })

  test('remote-only pin applies unchanged (remote value honored when no local pin)', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote', forceLoginMethod: 'claudeai' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('B-remote')
    expect(policy?.forceLoginMethod).toBe('claudeai')
  })

  test('local-only pin applies (file wins the first-wins pick with no remote)', () => {
    writeManagedFile({ forceLoginOrgUUID: 'A-local' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('A-local')
  })

  test('per-key resolution: remote forceLoginMethod survives when local pins only the org UUID', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote', forceLoginMethod: 'claudeai' })
    writeManagedFile({ forceLoginOrgUUID: 'A-local' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('A-local')
    expect(policy?.forceLoginMethod).toBe('claudeai')
  })

  test('HKCU auth pin never overrides the remote pin (HKCU excluded from the merge)', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote' })
    seedMdm({}, { forceLoginOrgUUID: 'HKCU-X' })
    const policy = getSettingsForSource('policySettings')
    expect(policy?.forceLoginOrgUUID).toBe('B-remote')
  })

  test('rest of the merge order unchanged: remote-won non-auth-pin content is returned whole', () => {
    seedRemote({ permissions: { allow: ['Bash(remote:*)'] } })
    writeManagedFile({
      forceLoginOrgUUID: 'A-local',
      permissions: { allow: ['Bash(local:*)'] },
    })
    const policy = getSettingsForSource('policySettings')
    // Remote still wins the whole-source first-wins pick...
    expect(policy?.permissions?.allow).toEqual(['Bash(remote:*)'])
    // ...only the auth-pin keys get the local override.
    expect(policy?.forceLoginOrgUUID).toBe('A-local')
  })
})

describe('auth-pin local precedence — merged loadSettingsFromDisk path', () => {
  test('merged settings expose the local pin over the remote pin', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote' })
    writeManagedFile({ forceLoginOrgUUID: 'A-local' })
    const { settings } = getSettingsWithErrors()
    expect(settings.forceLoginOrgUUID).toBe('A-local')
  })

  test('merged settings keep the remote pin when no local source pins', () => {
    seedRemote({ forceLoginOrgUUID: 'B-remote' })
    const { settings } = getSettingsWithErrors()
    expect(settings.forceLoginOrgUUID).toBe('B-remote')
  })
})

describe('auth-pin helpers (pure)', () => {
  test('getLocalAuthPinOverrides resolves per-key MDM → managed file', () => {
    seedMdm({ forceLoginOrgUUID: 'M-mdm' })
    writeManagedFile({
      forceLoginOrgUUID: 'A-file',
      forceLoginMethod: 'console',
    })
    const overrides = getLocalAuthPinOverrides()
    expect(overrides).toEqual({
      forceLoginOrgUUID: 'M-mdm',
      forceLoginMethod: 'console',
    })
  })

  test('getLocalAuthPinOverrides is empty when no local admin source pins', () => {
    seedMdm({}, { forceLoginOrgUUID: 'HKCU-X' })
    expect(getLocalAuthPinOverrides()).toEqual({})
  })

  test('applyLocalAuthPinPrecedence returns the same object when nothing overrides (no-op, immutable contract)', () => {
    const remote = { forceLoginOrgUUID: 'B-remote' } as SettingsJson
    expect(applyLocalAuthPinPrecedence(remote)).toBe(remote)
  })

  test('applyLocalAuthPinPrecedence returns a NEW object with local pins on top (no mutation)', () => {
    writeManagedFile({ forceLoginOrgUUID: 'A-local' })
    const remote = {
      forceLoginOrgUUID: 'B-remote',
      forceLoginMethod: 'claudeai',
    } as SettingsJson
    const result = applyLocalAuthPinPrecedence(remote)
    expect(result).not.toBe(remote)
    expect(result.forceLoginOrgUUID).toBe('A-local')
    expect(result.forceLoginMethod).toBe('claudeai')
    // Original untouched.
    expect(remote.forceLoginOrgUUID).toBe('B-remote')
  })
})
