import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getManagedFilePath, getManagedSettingsDropInDir } from '../managedPath.js'
import { resetSettingsCache, setCachedAdminPolicyLoad } from '../settingsCache.js'
import { getSettingsWithErrors, loadManagedFileSettings, parseSettingsFile } from '../settings.js'
import {
  assertProviderAllowed,
  buildProviderRefusalMessage,
  decideProviderAllowance,
  effectiveAllowedProviders,
  endpointVerdict,
  providerAllowanceMessage,
  resetAllowedProvidersCaches,
  setSettleRemotePolicy,
  setWifProfileBaseUrlInUse,
  validateProviderAllowed,
} from '../allowedProvidersEnforcement.js'
import {
  ALLOWED_PROVIDER_NAMES,
  CUSTOM_ANTHROPIC_PROVIDER_PATTERN,
  hasProviderLabel,
  isValidProviderEntry,
  MANAGED_UNREADABLE_PROVIDER_TEXT,
  ProviderNotAllowedError,
} from '../allowedProviders.js'
import { validateForceLoginOrg } from '../../auth.js'
import { enableConfigs } from '../../config.js'

/**
 * PORT (CC 2.1.285): bucket A item #5 — the `allowedProviders` managed
 * setting (0→93 binary hits v284→v285). Official machinery byte-verified in
 * `allowedProvidersEnforcement.ts` header (parse layer `Ni`/`An`
 * @196186xxx/196199750; enforcement region @198036300–198055000; `E` host
 * topology @196623664; `B$t` sites @201969594 + Files API `mje` @205945826;
 * `nmn` inside `JL` @198653600).
 *
 * Test architecture mirrors managedReadDenial285.test.ts: zero mock.module,
 * zero top-level env mutation, ENV_KEYS window in beforeAll/afterAll, real
 * managed-file loader via USER_TYPE=ant + CLAUDE_CODE_MANAGED_SETTINGS_PATH,
 * lodash-memoize cache clears + resetSettingsCache + resetAllowedProvidersCaches
 * around every test, fabricated admin aggregates via setCachedAdminPolicyLoad.
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
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'AWS_ENDPOINT_URL',
  'AWS_BEDROCK_ENDPOINT_URL',
  'VERTEX_API_CLAUDE_ENDPOINT',
  'FOUNDRY_BASE_URL',
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

const resetAll = (): void => {
  resetSettingsCache()
  resetAllowedProvidersCaches()
}

/** Write the managed-settings.json and prime the settings caches like startup. */
const armManaged = (doc: Record<string, unknown>): void => {
  writeFileSync(join(managedDir, 'managed-settings.json'), JSON.stringify(doc), 'utf8')
  resetAll()
  getSettingsWithErrors()
}

const errnoError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-ap-285-'))
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
  clearManagedPathCaches()
  resetAll()
})

afterEach(() => {
  resetAll()
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
  resetAll()
  clearManagedPathCaches()
  rmSync(testRoot, { recursive: true, force: true })
})

describe('leaf vocabulary — official isValidProviderEntry (Eo)', () => {
  test('every official list name is valid', () => {
    for (const name of ALLOWED_PROVIDER_NAMES) {
      expect(isValidProviderEntry(name)).toBe(true)
    }
  })

  test('official names include the 285 set', () => {
    expect([...ALLOWED_PROVIDER_NAMES].sort()).toEqual(
      [
        'anthropic',
        'anthropicAws',
        'bedrock',
        'customEndpoint',
        'foundry',
        'gateway',
        'mantle',
        'vertex',
      ].sort(),
    )
  })

  test('non-strings and unknown names are invalid', () => {
    expect(isValidProviderEntry('bogus')).toBe(false)
    expect(isValidProviderEntry(42)).toBe(false)
    expect(isValidProviderEntry(null)).toBe(false)
    expect(isValidProviderEntry({ name: 'bedrock' })).toBe(false)
  })
})

describe('plain schema — official Ni preprocess filter (types.ts)', () => {
  test('unknown entries are filtered out of a plain settings file', () => {
    const file = join(configDir, 'plain.json')
    writeFileSync(file, JSON.stringify({ allowedProviders: ['bedrock', 'bogus', 7] }), 'utf8')
    const result = parseSettingsFile(file)
    expect(result.settings?.allowedProviders).toEqual(['bedrock'])
    expect(result.errors).toEqual([])
  })

  test('non-array values fall through to catch(undefined)', () => {
    const file = join(configDir, 'plain2.json')
    writeFileSync(file, JSON.stringify({ allowedProviders: 'bedrock' }), 'utf8')
    const result = parseSettingsFile(file)
    expect(result.settings?.allowedProviders).toBeUndefined()
  })
})

describe('strict policy parser — official An fail-closed allowlist', () => {
  test('unknown entry in the managed file → statusOnly record, entry dropped', () => {
    writeFileSync(
      join(managedDir, 'managed-settings.json'),
      JSON.stringify({ allowedProviders: ['bedrock', 'bogus'] }),
      'utf8',
    )
    const { settings, errors } = loadManagedFileSettings()
    expect(settings?.allowedProviders).toEqual(['bedrock'])
    const records = errors.filter(e => e.path.startsWith('allowedProviders['))
    expect(records.length).toBe(1)
    expect(records[0].message).toContain('not a known provider name')
    // statusOnly records never block startup (Y6 passthrough).
    expect(records[0].severity).toBe('warning')
  })

  test('all-invalid list → empty list (fail-closed: allows no provider)', () => {
    writeFileSync(
      join(managedDir, 'managed-settings.json'),
      JSON.stringify({ allowedProviders: ['bogus'] }),
      'utf8',
    )
    const { settings } = loadManagedFileSettings()
    expect(settings?.allowedProviders).toEqual([])
  })
})

describe('effectiveAllowedProviders — official Gye (machine ∩ slot)', () => {
  test('no managed list → undefined (every provider allowed)', () => {
    getSettingsWithErrors()
    expect(effectiveAllowedProviders()).toBeUndefined()
  })

  test('managed list flows through the machine tier', () => {
    armManaged({ allowedProviders: ['anthropic', 'bedrock'] })
    expect(effectiveAllowedProviders()).toEqual(['anthropic', 'bedrock'])
  })
})

describe('decideProviderAllowance — official MJ', () => {
  test('no list → undefined regardless of provider', () => {
    getSettingsWithErrors()
    expect(decideProviderAllowance('firstParty')).toBeUndefined()
    expect(decideProviderAllowance('bedrock')).toBeUndefined()
  })

  test('listed provider with no overrides → allowed', () => {
    armManaged({ allowedProviders: ['bedrock'] })
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(decideProviderAllowance('bedrock')).toBeUndefined()
  })

  test('unlisted provider → not_listed refusal with the official list message', () => {
    armManaged({ allowedProviders: ['bedrock'] })
    const decision = decideProviderAllowance('firstParty')
    expect(decision).toBeDefined()
    expect(decision?.refused.length).toBe(1)
    expect(decision?.refused[0].reason).toBe('not_listed')
    expect(decision?.allowed).toEqual(['bedrock'])
    expect(decision?.message.startsWith("Your organization's managed settings allow Claude Code to use: ")).toBe(true)
  })

  test('empty list → "no API provider at all … is an empty list" message', () => {
    armManaged({ allowedProviders: [] })
    const decision = decideProviderAllowance('firstParty')
    expect(decision?.message).toContain(
      "allow Claude Code to use no API provider at all",
    )
    expect(decision?.message).toContain('is an empty list')
    expect(decision?.message).toContain('cannot start on this machine')
  })

  test('all-unrecognized list → "lists only unrecognized entries" variant', () => {
    armManaged({ allowedProviders: ['bogus'] })
    const decision = decideProviderAllowance('firstParty')
    expect(decision?.message).toContain('lists only unrecognized entries')
    expect(decision?.message).toContain('cannot start on this machine')
  })

  test('firstParty behind an unpinned custom ANTHROPIC_BASE_URL → customEndpoint promotion refuses (qf → not_listed)', () => {
    armManaged({ allowedProviders: ['anthropic'] })
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'
    const decision = decideProviderAllowance('firstParty')
    expect(decision).toBeDefined()
    // Official MJ: the promoted customEndpoint descriptor is not in the list →
    // reason 'not_listed' with the ANTHROPIC_BASE_URL override named.
    expect(decision?.refused.some(r => r.reason === 'not_listed')).toBe(true)
    expect(decision?.message).toContain('customEndpoint')
    expect(decision?.message).toContain('ANTHROPIC_BASE_URL')
  })

  test('firstParty behind a pinned custom base URL with customEndpoint listed → allowed', () => {
    armManaged({
      allowedProviders: ['customEndpoint'],
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'
    expect(decideProviderAllowance('firstParty')).toBeUndefined()
  })

  test('customEndpoint listed but the live base URL is NOT pinned → endpoint refusal', () => {
    armManaged({
      allowedProviders: ['customEndpoint'],
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example'
    const decision = decideProviderAllowance('firstParty')
    expect(decision?.refused.some(r => r.reason === 'endpoint')).toBe(true)
    expect(decision?.message).toContain('not pinned')
  })

  test('unix-socket override refuses even when firstParty is listed (arm 1)', () => {
    armManaged({ allowedProviders: ['anthropic'] })
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/occ-ap-285.sock'
    const decision = decideProviderAllowance('firstParty')
    expect(decision).toBeDefined()
    expect(decision?.message).toContain('ANTHROPIC_UNIX_SOCKET')
  })

  test('bedrock + CLAUDE_CODE_USE_MANTLE → the mantle descriptor is also judged (N_e)', () => {
    armManaged({ allowedProviders: ['bedrock'] })
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_USE_MANTLE = '1'
    const decision = decideProviderAllowance('bedrock')
    expect(decision).toBeDefined()
    expect(decision?.refused.some(r => r.provider === 'mantle')).toBe(true)
  })

  test('bedrock + mantle both listed → allowed', () => {
    armManaged({ allowedProviders: ['bedrock', 'mantle'] })
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_USE_MANTLE = '1'
    expect(decideProviderAllowance('bedrock')).toBeUndefined()
  })
})

describe('endpointVerdict — official k over the E host topology', () => {
  test('bedrock own https endpoint → own', () => {
    expect(
      endpointVerdict('bedrock', 'https://bedrock-runtime.us-east-1.amazonaws.com'),
    ).toBe('own')
  })

  test('foreign host → foreign', () => {
    expect(endpointVerdict('bedrock', 'https://evil.example')).toBe('foreign')
  })

  test('own host over http → insecure', () => {
    expect(
      endpointVerdict('bedrock', 'http://bedrock-runtime.us-east-1.amazonaws.com'),
    ).toBe('insecure')
  })

  test('unparsable value → unparsable', () => {
    expect(endpointVerdict('bedrock', 'not a url')).toBe('unparsable')
  })
})

describe('validateProviderAllowed — official nmn gate', () => {
  test('unlisted provider → provider_not_allowed', async () => {
    armManaged({ allowedProviders: ['bedrock'] })
    const result = await validateProviderAllowed()
    expect(result).toBeDefined()
    expect(result?.valid).toBe(false)
    expect(result?.reason).toBe('provider_not_allowed')
    expect(result?.message).toContain("Your organization's managed settings")
  })

  test('no list → undefined (gate dormant)', async () => {
    getSettingsWithErrors()
    expect(await validateProviderAllowed()).toBeUndefined()
  })

  test('unreadable policy file → managed_settings_invalid fail-close (real ELOOP; survives bl() jo() re-read)', async () => {
    // A fabricated setCachedAdminPolicyLoad seed cannot drive this branch:
    // official bl() invalidates + re-reads (jo ≡ resetSettingsCache + fresh
    // load) on the first call outside the 60 s window, which would wipe the
    // seed. Use a real filesystem failure (self-symlink → ELOOP, works under
    // uid 0) so every re-read reproduces the non-OS-denied record.
    symlinkSync('managed-settings.json', join(managedDir, 'managed-settings.json'))
    getSettingsWithErrors()
    const result = await validateProviderAllowed()
    expect(result?.valid).toBe(false)
    expect(result?.reason).toBe('managed_settings_invalid')
    expect(result?.policyUnreadable).toBe(true)
    expect(result?.message).toBe(MANAGED_UNREADABLE_PROVIDER_TEXT)
    // Within the 60 s throttle window the message stays fail-closed without
    // another read (official bl/Vf).
    expect(providerAllowanceMessage()).toBe(MANAGED_UNREADABLE_PROVIDER_TEXT)
  })

  test('OS-denied-only aggregate passes through (285 warn+start fix)', async () => {
    getSettingsWithErrors()
    setCachedAdminPolicyLoad(
      [
        {
          file: '/etc/claude-code/managed-settings.json',
          path: '',
          message: 'Settings file could not be read: permission denied',
          severity: 'error',
          errorClass: 'unreadable',
          errno: 'EACCES',
        },
      ],
      false,
    )
    expect(providerAllowanceMessage()).toBeUndefined()
    expect(await validateProviderAllowed()).toBeUndefined()
  })
})

describe('assertProviderAllowed — official B$t per-request gate', () => {
  test('no list → does not throw', () => {
    getSettingsWithErrors()
    expect(() => assertProviderAllowed()).not.toThrow()
  })

  test('unlisted provider → throws ProviderNotAllowedError with the refusal message', () => {
    armManaged({ allowedProviders: ['bedrock'] })
    let thrown: unknown
    try {
      assertProviderAllowed('firstParty')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderNotAllowedError)
    expect((thrown as Error).message).toContain(
      "Your organization's managed settings allow Claude Code to use: ",
    )
  })

  test('Files API dispatch: firstParty + pinned custom endpoint + customEndpoint listed → passes', () => {
    armManaged({
      allowedProviders: ['customEndpoint'],
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    })
    expect(() =>
      assertProviderAllowed('firstParty', 'https://proxy.example', 'files'),
    ).not.toThrow()
  })

  test('Files API dispatch: unpinned endpoint → throws', () => {
    armManaged({ allowedProviders: ['customEndpoint'] })
    expect(() =>
      assertProviderAllowed('firstParty', 'https://proxy.example', 'files'),
    ).toThrow(ProviderNotAllowedError)
  })
})

describe('validateForceLoginOrg — official JL ordering (nmn runs after the load gate)', () => {
  test('provider refusal surfaces as reason provider_not_allowed', async () => {
    armManaged({ allowedProviders: ['bedrock'] })
    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(false)
    if (result.valid === false) {
      expect(result.reason).toBe('provider_not_allowed')
      expect(result.message).toContain("Your organization's managed settings")
    }
  })

  test('clean machine → unchanged valid path', async () => {
    getSettingsWithErrors()
    const result = await validateForceLoginOrg()
    expect(result.valid).toBe(true)
  })
})

describe('module surface — official Qc/eu vocabulary + Gr hook cell + lk builder', () => {
  test('CUSTOM_ANTHROPIC_PROVIDER_PATTERN (official Qc) matches the anthropicX family only', () => {
    expect(CUSTOM_ANTHROPIC_PROVIDER_PATTERN.test('anthropicAws')).toBe(true)
    expect(CUSTOM_ANTHROPIC_PROVIDER_PATTERN.test('anthropicGoogleCloud')).toBe(true)
    expect(CUSTOM_ANTHROPIC_PROVIDER_PATTERN.test('anthropic')).toBe(false)
    expect(CUSTOM_ANTHROPIC_PROVIDER_PATTERN.test('bedrock')).toBe(false)
  })

  test('hasProviderLabel (official G) covers list names, rejects unknowns', () => {
    expect(hasProviderLabel('bedrock')).toBe(true)
    expect(hasProviderLabel('bogus')).toBe(false)
  })

  test('buildProviderRefusalMessage (official lk) emits the list sentence', () => {
    armManaged({ allowedProviders: ['bedrock'] })
    const decision = decideProviderAllowance('firstParty')
    expect(decision).toBeDefined()
    const message = buildProviderRefusalMessage(decision!.refused, decision!.allowed)
    expect(message).toBe(decision!.message)
    expect(message).toContain("Your organization's managed settings allow Claude Code to use: ")
  })

  test('Gr hook cell (zf/sLo): the WIF hook feeds Gw overrides; the settle hook stays unused when a machine list exists', async () => {
    armManaged({ allowedProviders: ['anthropic'] })
    // No hook registered → firstParty on its own host has no overrides.
    expect(decideProviderAllowance('firstParty')).toBeUndefined()
    // Official Gw @198040xxx consults Gr.wifProfileBaseUrlInUse: a WIF
    // profile base URL becomes an override entry (pin variable
    // ANTHROPIC_BASE_URL) → unpinned → refusal naming the WIF profile.
    setWifProfileBaseUrlInUse(() => 'https://wif.example')
    const decision = decideProviderAllowance('firstParty')
    expect(decision).toBeDefined()
    expect(decision?.message).toContain('WIF profile')
    setWifProfileBaseUrlInUse(undefined)
    expect(decideProviderAllowance('firstParty')).toBeUndefined()
    // Official Yf: machineCarriesList() → early return, the settle hook never
    // fires when a machine source carries the list (divergence 5 stays inert).
    let settleCalls = 0
    setSettleRemotePolicy(async () => {
      settleCalls += 1
    })
    await validateProviderAllowed()
    expect(settleCalls).toBe(0)
    setSettleRemotePolicy(undefined)
  })
})
