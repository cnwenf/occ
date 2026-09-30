import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getManagedFilePath, getManagedSettingsDropInDir } from '../managedPath.js'
import {
  setCachedAdminPolicyLoad,
  resetSettingsCache,
} from '../settingsCache.js'
import {
  getBlockingAdminPolicyLoadErrors,
  hasAdminPolicyLoadFailures,
  hasNonOsDeniedAdminPolicyLoadFailures,
  isOsDeniedUnreadableRecord,
  loadManagedFileSettings,
  managedUnreadableRecord,
  parseSettingsFile,
  getSettingsWithErrors,
} from '../settings.js'
import type { ValidationError } from '../validation.js'
import { validateForceLoginOrg } from '../../auth.js'
import { enableConfigs } from '../../config.js'

/**
 * PORT (CC 2.1.285): "Fixed Claude Code refusing to start when the OS denies
 * reading the managed settings file; it now warns and starts without that
 * file's policies. Other read errors and unparseable files stop every
 * session."
 *
 * Official v285 machinery (byte-verified):
 *   - `G1t` @196303347 — unreadable-source record: severity:"fatal",
 *     errorClass:"unreadable", NEW `...E(n)!==void 0&&{errno:E(n)}`
 *     (v284's `mjt` @198431475 had everything EXCEPT the errno spread).
 *   - Drop-in walk catch @196295743 — non-ENOENT/ENOTDIR readdir failure
 *     pushes `G1t(g,h,"directory")`.
 *   - Classifier @196726844: `var ts=new Set(["EACCES","EPERM"]);
 *     function WYn(e){return e.errorClass==="unreadable"&&e.errno!==void 0&&ts.has(e.errno)}`
 *   - Predicates @196726200: `Yde()=sxe(yr())` (severity!=="warning" filter),
 *     `jhn(){return !k1o()&&Yde().length>0}`, `Y6(){return !k1o()&&Yde().some(e=>!WYn(e))}`.
 *   - `JL` gate @198654100: `if(jhn()&&!Y6())` → telemetry
 *     policy_denied_passthrough + fall through (warn+start); `else if(jhn())`
 *     → `{valid:!1,reason:"managed_settings_invalid",policyUnreadable:!0,
 *     message:"Unable to read managed policy settings.\n..."}`. v284's gate
 *     (@200814100, `M_e()`) failed close on ANY blocking record INCLUDING
 *     OS-denied reads — the changelog bug — and ran only inside the
 *     first-party-auth branch.
 *   - `Qzr` stderr printer @196727280: "Managed settings failed to load;
 *     policies from the failed source are NOT in effect:" + `pr()` lines.
 *
 * Test architecture: zero mock.module, zero top-level env mutation (bun
 * loads every file's top level before any tests run — see
 * envBearerFallback285.test.ts header). The managed-settings path override
 * (USER_TYPE=ant + CLAUDE_CODE_MANAGED_SETTINGS_PATH) and the config-dir /
 * NODE_ENV window are established in beforeAll and restored in afterAll;
 * lodash-memoize caches (getManagedFilePath/getManagedSettingsDropInDir) and
 * the process-wide settings caches are cleared around every test so sibling
 * files re-resolve under their own env.
 *
 * Root-privilege note: tests run as uid 0, which bypasses DAC permission
 * checks — a real chmod-000 EACCES cannot be produced. Real-filesystem
 * branches therefore use symlink loops (ELOOP, works for root) and the
 * OS-denial (EACCES/EPERM) classifier + gate branches are driven through
 * fabricated errno errors / seeded aggregates, exercising the same code
 * paths the loader feeds.
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
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
] as const

let savedEnv: Record<string, string | undefined> = {}
let testRoot = ''
let managedDir = ''
let configDir = ''

const clearManagedPathCaches = (): void => {
  // lodash memoize exposes .cache — same pattern as getGlobalClaudeFile.cache
  ;(getManagedFilePath as unknown as { cache: { clear(): void } }).cache.clear()
  ;(
    getManagedSettingsDropInDir as unknown as { cache: { clear(): void } }
  ).cache.clear()
}

const errnoError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-msd-285-'))
  // bun test defaults NODE_ENV to "test", which makes the real
  // getAnthropicApiKeyWithSource throw its CI guard when no env credential
  // exists (validateForceLoginOrg → isAnthropicAuthEnabled calls it
  // unguarded). Run the window on the normal path.
  process.env.NODE_ENV = 'development'
  delete process.env.CI
  // NODE_ENV≠test arms the config-reading guard; enableConfigs() is the
  // idempotent process-wide unlock the production bootstrap calls.
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
  clearManagedPathCaches()
  resetSettingsCache()
})

afterEach(() => {
  resetSettingsCache()
  clearManagedPathCaches()
})

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  resetSettingsCache()
  clearManagedPathCaches()
  rmSync(testRoot, { recursive: true, force: true })
})

describe('managedUnreadableRecord — official G1t (v285 adds errno)', () => {
  test('EACCES read failure → unreadable record with errno, classified OS-denied (WYn)', () => {
    const record = managedUnreadableRecord(
      '/etc/claude-code/managed-settings.json',
      errnoError('EACCES', "permission denied, open '/etc/claude-code/managed-settings.json'"),
    )
    expect(record.severity).toBe('error')
    expect(record.errorClass).toBe('unreadable')
    expect(record.errno).toBe('EACCES')
    expect(record.path).toBe('')
    expect(record.message).toBe(
      "Settings file could not be read: permission denied, open '/etc/claude-code/managed-settings.json'",
    )
    expect(isOsDeniedUnreadableRecord(record)).toBe(true)
  })

  test('EPERM is the second OS-denial errno in the official ts set', () => {
    const record = managedUnreadableRecord(
      '/x/managed-settings.json',
      errnoError('EPERM', 'operation not permitted'),
    )
    expect(record.errno).toBe('EPERM')
    expect(isOsDeniedUnreadableRecord(record)).toBe(true)
  })

  test('other errnos (EIO) stay fail-close — WYn is false', () => {
    const record = managedUnreadableRecord(
      '/x/managed-settings.json',
      errnoError('EIO', 'i/o error'),
    )
    expect(record.errno).toBe('EIO')
    expect(isOsDeniedUnreadableRecord(record)).toBe(false)
  })

  test('directory kind uses the official drop-in message prefix', () => {
    const record = managedUnreadableRecord(
      '/etc/claude-code/managed-settings.d',
      errnoError('EACCES', 'permission denied'),
      'directory',
    )
    expect(record.message).toBe(
      'Managed settings drop-in directory could not be read: permission denied',
    )
    expect(isOsDeniedUnreadableRecord(record)).toBe(true)
  })

  test('error without a code → no errno field → never OS-denied (WYn errno!==void 0 guard)', () => {
    const record = managedUnreadableRecord(
      '/x/managed-settings.json',
      new Error('weird failure'),
    )
    expect(record.errno).toBeUndefined()
    expect('errno' in record).toBe(false)
    expect(record.errorClass).toBe('unreadable')
    expect(isOsDeniedUnreadableRecord(record)).toBe(false)
  })

  test('non-Error throw value is stringified (G1t `String(n)` arm)', () => {
    const record = managedUnreadableRecord('/x/managed-settings.json', 'boom')
    expect(record.message).toBe('Settings file could not be read: boom')
  })

  test('a non-unreadable record is never classified OS-denied', () => {
    const parseRecord: ValidationError = {
      file: '/x/managed-settings.json',
      path: '',
      message: 'Managed settings document could not be parsed...',
      severity: 'error',
      errno: 'EACCES',
    }
    expect(isOsDeniedUnreadableRecord(parseRecord)).toBe(false)
  })
})

describe('parseSettingsFile policySource read failures — official Yd', () => {
  test('ENOENT (absent file) stays silent with no record (Y_e)', () => {
    const result = parseSettingsFile(join(managedDir, 'missing.json'), {
      policySource: true,
    })
    expect(result.settings).toBeNull()
    expect(result.errors).toEqual([])
  })

  test('real ELOOP read failure on a policy source produces the unreadable record (fail-close class)', () => {
    const loop = join(managedDir, 'loop.json')
    symlinkSync('loop.json', loop) // self-referential symlink → statSync ELOOP
    const result = parseSettingsFile(loop, { policySource: true })
    expect(result.settings).toBeNull()
    expect(result.errors.length).toBe(1)
    const record = result.errors[0]
    expect(record.errorClass).toBe('unreadable')
    expect(record.errno).toBe('ELOOP')
    expect(record.severity).toBe('error')
    expect(record.message).toContain('Settings file could not be read:')
    expect(isOsDeniedUnreadableRecord(record)).toBe(false)
  })

  test('real ENOTDIR read failure on a policy source produces the unreadable record', () => {
    const regularFile = join(managedDir, 'regular.json')
    writeFileSync(regularFile, '{}', 'utf8')
    const result = parseSettingsFile(join(regularFile, 'nested.json'), {
      policySource: true,
    })
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].errorClass).toBe('unreadable')
    expect(result.errors[0].errno).toBe('ENOTDIR')
  })

  test('non-policy sources keep the pre-285 swallow+log behavior (scoped port)', () => {
    const loop = join(managedDir, 'loop-user.json')
    symlinkSync('loop-user.json', loop)
    const result = parseSettingsFile(loop)
    expect(result.settings).toBeNull()
    expect(result.errors).toEqual([])
  })
})

describe('loadManagedFileSettings drop-in directory — official G1t directory arm', () => {
  test('symlink-loop managed-settings.d produces the directory-variant unreadable record', () => {
    symlinkSync('managed-settings.d', join(managedDir, 'managed-settings.d'))
    const { errors } = loadManagedFileSettings()
    const dirRecords = errors.filter(
      record =>
        record.errorClass === 'unreadable' &&
        record.message.startsWith('Managed settings drop-in directory'),
    )
    expect(dirRecords.length).toBe(1)
    expect(dirRecords[0].errno).toBe('ELOOP')
    expect(isOsDeniedUnreadableRecord(dirRecords[0])).toBe(false)
  })

  test('absent base file + absent drop-in dir → no records (unchanged)', () => {
    const { settings, errors } = loadManagedFileSettings()
    expect(settings).toBeNull()
    expect(errors).toEqual([])
  })

  test('readable base file still loads while the drop-in dir is unreadable', () => {
    writeFileSync(
      join(managedDir, 'managed-settings.json'),
      JSON.stringify({ forceLoginOrgUUID: 'org-123' }),
      'utf8',
    )
    symlinkSync('managed-settings.d', join(managedDir, 'managed-settings.d'))
    const { settings, errors } = loadManagedFileSettings()
    expect(settings?.forceLoginOrgUUID).toBe('org-123')
    expect(
      errors.some(record => record.errorClass === 'unreadable'),
    ).toBe(true)
  })
})

describe('admin aggregate predicates — official jhn/Y6/k1o/WYn', () => {
  const eaccesRecord = managedUnreadableRecord(
    '/etc/claude-code/managed-settings.json',
    errnoError('EACCES', 'permission denied'),
  )
  const eioRecord = managedUnreadableRecord(
    '/etc/claude-code/managed-settings.json',
    errnoError('EIO', 'i/o error'),
  )
  const warningRecord: ValidationError = {
    file: '/etc/claude-code/managed-settings.json',
    path: 'deniedModels',
    message: 'strict-parser warning',
    severity: 'warning',
  }

  test('OS-denied-only aggregate: jhn true, Y6 false (the passthrough shape)', () => {
    setCachedAdminPolicyLoad([eaccesRecord], false)
    expect(hasAdminPolicyLoadFailures()).toBe(true)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(false)
    expect(getBlockingAdminPolicyLoadErrors()).toEqual([eaccesRecord])
  })

  test('surviving admin policy content suppresses the gate (k1o)', () => {
    setCachedAdminPolicyLoad([eioRecord], true)
    expect(hasAdminPolicyLoadFailures()).toBe(false)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(false)
  })

  test('non-OS-denied errno: jhn true, Y6 true (the fail-close shape)', () => {
    setCachedAdminPolicyLoad([eioRecord], false)
    expect(hasAdminPolicyLoadFailures()).toBe(true)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(true)
  })

  test('warning-severity records never block (sxe filter)', () => {
    setCachedAdminPolicyLoad([warningRecord], false)
    expect(hasAdminPolicyLoadFailures()).toBe(false)
    expect(getBlockingAdminPolicyLoadErrors()).toEqual([])
  })

  test('mixed OS-denied + parse-fatal aggregate fails close (Y6 some(!WYn))', () => {
    const parseFatal: ValidationError = {
      file: '/etc/claude-code/managed-settings.json',
      path: '',
      message:
        'Managed settings document could not be parsed as a JSON object; none of its settings are in effect. Fix or remove it.',
      severity: 'error',
    }
    setCachedAdminPolicyLoad([eaccesRecord, parseFatal], false)
    expect(hasAdminPolicyLoadFailures()).toBe(true)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(true)
    // The official gate reads Yde()[0] for the fail-close Detail line.
    expect(getBlockingAdminPolicyLoadErrors()[0]).toEqual(eaccesRecord)
  })

  test('unset aggregate (no policy load yet) → gate dormant', () => {
    expect(hasAdminPolicyLoadFailures()).toBe(false)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(false)
  })
})

describe('validateForceLoginOrg — official JL leading gate', () => {
  test('real loader fail-close: unreadable policy file (ELOOP) stops the session with the official message', async () => {
    symlinkSync('managed-settings.json', join(managedDir, 'managed-settings.json'))
    // Prime the full settings load under the controlled managed path — this
    // populates the admin aggregate exactly as startup does.
    getSettingsWithErrors()
    expect(hasAdminPolicyLoadFailures()).toBe(true)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(true)

    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(false)
    if (result.valid === false) {
      expect(result.reason).toBe('managed_settings_invalid')
      expect(result.policyUnreadable).toBe(true)
      expect(result.message.startsWith('Unable to read managed policy settings.\n')).toBe(true)
      expect(result.message).toContain(
        'This machine may require organization login enforcement, but the policy file failed to load.',
      )
      expect(result.message).toContain('Contact your administrator.')
      expect(result.message).toContain('Detail: ')
      expect(result.message).toContain('Settings file could not be read:')
    }
  })

  test('OS-denied aggregate passes through: warn + valid (the 2.1.285 fix — v284 refused startup here)', async () => {
    // Clean managed dir → no real policy errors; prime caches first.
    getSettingsWithErrors()
    expect(hasAdminPolicyLoadFailures()).toBe(false)
    // Seed the OS-denial shape the loader would produce for EACCES/EPERM
    // (unproducible as uid 0 through the real filesystem).
    setCachedAdminPolicyLoad(
      [
        managedUnreadableRecord(
          join(managedDir, 'managed-settings.json'),
          errnoError('EACCES', 'permission denied'),
        ),
      ],
      false,
    )
    expect(hasAdminPolicyLoadFailures()).toBe(true)
    expect(hasNonOsDeniedAdminPolicyLoadFailures()).toBe(false)

    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(true)
  })

  test('fail-close Detail line names the file (official `${D.file}: ${D.message}`)', async () => {
    // Prime first — validateForceLoginOrg's getSettingsWithErrors() would
    // otherwise run a fresh load and re-seed the aggregate over the seed.
    getSettingsWithErrors()
    setCachedAdminPolicyLoad(
      [
        managedUnreadableRecord(
          '/etc/claude-code/managed-settings.json',
          errnoError('EIO', 'i/o error'),
        ),
      ],
      false,
    )
    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(false)
    if (result.valid === false) {
      expect(result.message).toContain(
        'Detail: /etc/claude-code/managed-settings.json: Settings file could not be read: i/o error',
      )
    }
  })

  test('no admin load failures → unchanged org validation path (valid without a policy pin)', async () => {
    getSettingsWithErrors()
    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(true)
  })
})
