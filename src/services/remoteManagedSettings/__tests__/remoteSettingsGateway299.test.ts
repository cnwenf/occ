import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.299 (#052): remote managed settings must never send a gateway API
 * key to the Anthropic-owned settings endpoint.
 *
 * Two layers, both official-faithful:
 * 1. syncCache eligibility (pre-existing OCC gate, unified with official):
 *    custom ANTHROPIC_BASE_URL → not eligible → no fetch at all.
 * 2. Credential resolver defense-in-depth — official `St` (@232349772):
 *      if(f5(s)===null)return t("Remote settings: API key not sent:
 *      ANTHROPIC_BASE_URL is not an Anthropic host"),{headers:{},error:...}
 *    i.e. even when eligibility was cached from an earlier first-party
 *    state, a gateway key is dropped and the fetch is skipped (skipRetry).
 */

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// bun loads every test file's top level before any tests run and a
// mock.module registration can outlive mock.restore() — so the axios
// override DELEGATES to the real implementation whenever this file's tests
// are not in their window (cross-file-safety rationale documented in
// policyLimits/__tests__/envBearerFallback285.test.ts).
let intercept = false

// Materialize the real axios exports BEFORE mock.module — reading the
// namespace lazily inside the factory could resolve back to the mock itself
// and recurse infinitely.
const realAxios = { ...(await import('axios')) }
const realAxiosGet = realAxios.default.get.bind(realAxios.default)
const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<unknown> => ({
    status: 404,
    data: {},
    headers: {},
  }),
)
mock.module('axios', () => ({
  ...realAxios,
  default: {
    ...realAxios.default,
    get: (url: string, config?: unknown) =>
      intercept ? mockedGet(url, config) : realAxiosGet(url, config),
  },
}))

const { refreshRemoteManagedSettings } = await import('../index.js')
const { isRemoteManagedSettingsEligible, resetSyncCache } = await import(
  '../syncCache.js'
)
const { clearOAuthTokenCache } = await import('../../../utils/auth.js')
const { getGlobalClaudeFile } = await import('../../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-gw-rms-'))

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
]
const savedEnv: Record<string, string | undefined> = {}

function clearConfigPathCaches(): void {
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
}

beforeEach(() => {
  intercept = true
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
  clearOAuthTokenCache()
  clearConfigPathCaches()
  mockedGet.mockClear()
  resetSyncCache()
})

afterEach(() => {
  intercept = false
  clearOAuthTokenCache()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearConfigPathCaches()
  resetSyncCache()
})

afterAll(async () => {
  intercept = false
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('remote managed settings gateway-key leak (#052)', () => {
  test('makes no request under a gateway base URL (eligibility gate)', async () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'gw-secret-key'

    // Act
    await refreshRemoteManagedSettings()

    // Assert — ineligible from the start, no settings fetch issued
    expect(isRemoteManagedSettingsEligible()).toBe(false)
    expect(mockedGet).not.toHaveBeenCalled()
  })

  test('drops a gateway key even when eligibility was cached first-party (official St defense-in-depth)', async () => {
    // Arrange — become eligible under first-party config (caches true)
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'test-console-key'
    expect(isRemoteManagedSettingsEligible()).toBe(true)
    // Now the base URL flips to a gateway (stale cached eligibility)
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'

    // Act
    await refreshRemoteManagedSettings()

    // Assert — the f5-style sanitizer refuses the gateway key, so the fetch
    // is skipped (skipRetry) rather than sent keyless or with the key.
    expect(mockedGet).not.toHaveBeenCalled()
  })

  test('sends the key with first-party config', async () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'test-console-key'

    await refreshRemoteManagedSettings()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(config.headers['x-api-key']).toBe('test-console-key')
  })
})
