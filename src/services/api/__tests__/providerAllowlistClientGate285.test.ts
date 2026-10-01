import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill (foundryResourceGuard284) for
// test execution — must run BEFORE the dynamic client.js import below.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { getAnthropicClient } = await import('../client.js')
const { getManagedFilePath, getManagedSettingsDropInDir } = await import(
  '../../../utils/settings/managedPath.js'
)
const { resetSettingsCache } = await import(
  '../../../utils/settings/settingsCache.js'
)
const { getSettingsWithErrors } = await import(
  '../../../utils/settings/settings.js'
)
const { resetAllowedProvidersCaches } = await import(
  '../../../utils/settings/allowedProvidersEnforcement.js'
)
const { ProviderNotAllowedError } = await import(
  '../../../utils/settings/allowedProviders.js'
)
const { enableConfigs } = await import('../../../utils/config.js')

/**
 * CC 2.1.285 `allowedProviders` — CLIENT-CONSTRUCTION entry wiring (official
 * `B$t` site @201969594: `Oe=sc(r);if(B$t(Oe),...)`).
 *
 * src/services/api/client.ts calls assertProviderAllowed() at the very top of
 * getAnthropicClient — BEFORE any request/SDK-client is built. The enforcement
 * logic itself is covered by src/utils/settings/__tests__/allowedProviders285
 * .test.ts, and the Files API dispatch is covered there too, but every
 * pre-existing getAnthropicClient test (foundryResourceGuard284,
 * advisorRetryWiring276, promptIdHeader283) runs with NO managed allowlist —
 * gate dormant → no-op. Reviewer mutation probe (static-findings-tests:
 * test-07) machine-confirmed that deleting the construction-site call leaves
 * the whole src/services/api suite 317/318 green. This file closes that
 * residual entry-wiring gap: it exercises the SDK-client construction entry
 * with an ARMED managed allowlist, via a REAL temp managed-settings file
 * (same convention as allowedProviders285: zero mock.module, zero mocking of
 * the enforcement function or the loader).
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

const REFUSAL_PREFIX =
  "Your organization's managed settings allow Claude Code to use: "

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
  writeFileSync(
    join(managedDir, 'managed-settings.json'),
    JSON.stringify(doc),
    'utf8',
  )
  resetAll()
  getSettingsWithErrors()
}

/** Capture whatever getAnthropicClient({maxRetries:0}) throws (or undefined). */
const captureConstructionError = async (): Promise<unknown> => {
  try {
    await getAnthropicClient({ maxRetries: 0 })
    return undefined
  } catch (error) {
    return error
  }
}

beforeAll(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
  }
  testRoot = mkdtempSync(join(tmpdir(), 'occ-apcg-285-'))
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
  // Keep the post-gate auth path offline: a dummy key lets the default
  // firstParty Anthropic SDK construction resolve without network/creds.
  process.env.ANTHROPIC_API_KEY = 'test-dummy-key'
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

describe('CC 2.1.285 — getAnthropicClient construction gate (B$t site) with an ARMED managed allowlist', () => {
  test('armed pin-mismatch: allowlist excludes the current provider (vertex-only vs default firstParty) → construction throws ProviderNotAllowedError before any request is built', async () => {
    // Arrange — real managed file arms the gate; the machine's provider is
    // firstParty (no CLAUDE_CODE_USE_* overrides) whose entry name is
    // 'anthropic' — absent from the ['vertex'] allowlist → not_listed.
    armManaged({ allowedProviders: ['vertex'] })

    // Act
    const thrown = await captureConstructionError()

    // Assert — the exact error class + refusal message from assertProviderAllowed
    expect(thrown).toBeInstanceOf(ProviderNotAllowedError)
    expect((thrown as Error).message).toContain(REFUSAL_PREFIX)
    expect((thrown as Error).message).toContain('vertex')
  })

  test('armed endpoint-refusal: customEndpoint listed but the live ANTHROPIC_BASE_URL is NOT pinned → construction throws ProviderNotAllowedError ("not pinned")', async () => {
    // Arrange — the reviewer probe's MAIN shape: the machine-tier env block
    // pins https://proxy.example, but the live env points at an unpinned host.
    armManaged({
      allowedProviders: ['customEndpoint'],
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://unpinned.example'

    // Act
    const thrown = await captureConstructionError()

    // Assert
    expect(thrown).toBeInstanceOf(ProviderNotAllowedError)
    expect((thrown as Error).message).toContain('not pinned')
  })

  test('armed pass-through: allowlist includes the current provider (anthropic) → construction succeeds', async () => {
    // Arrange
    armManaged({ allowedProviders: ['anthropic'] })

    // Act — no throw: the gate is armed AND consulted, and it allows.
    const client = await getAnthropicClient({ maxRetries: 0 })

    // Assert
    expect(client).toBeDefined()
  })

  test('armed pass-through with a pinned custom endpoint: customEndpoint listed + ANTHROPIC_BASE_URL pinned by the machine env → construction succeeds', async () => {
    // Arrange
    armManaged({
      allowedProviders: ['customEndpoint'],
      env: { ANTHROPIC_BASE_URL: 'https://proxy.example' },
    })
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'

    // Act
    const client = await getAnthropicClient({ maxRetries: 0 })

    // Assert
    expect(client).toBeDefined()
  })

  test('dormant control: no managed allowlist → construction succeeds (gate no-op), matching pre-existing getAnthropicClient test behavior', async () => {
    // Arrange — managed file exists but carries no allowedProviders list.
    armManaged({})

    // Act
    const client = await getAnthropicClient({ maxRetries: 0 })

    // Assert
    expect(client).toBeDefined()
  })

  test('re-arming between constructions is honored: allowed → denied without process restart (no stale effective-list at the construction entry)', async () => {
    // Arrange — first construction passes under an anthropic allowlist.
    armManaged({ allowedProviders: ['anthropic'] })
    expect(await getAnthropicClient({ maxRetries: 0 })).toBeDefined()

    // Act — re-seed the SAME managed path with a bedrock-only list and reset
    // the caches exactly like beforeEach does between tests.
    armManaged({ allowedProviders: ['bedrock'] })
    const thrown = await captureConstructionError()

    // Assert — the construction entry resolved the FRESH effective list.
    expect(thrown).toBeInstanceOf(ProviderNotAllowedError)
    expect((thrown as Error).message).toContain(REFUSAL_PREFIX)
    expect((thrown as Error).message).toContain('bedrock')
  })
})
