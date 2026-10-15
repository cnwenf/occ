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
 * CC 2.1.299 (#070): the claude_cli_profile fetch (Anthropic-owned,
 * hardcoded api.anthropic.com) must never carry a gateway API key.
 *
 * Official key sanitizer `f5` (@~217810900): a key configured for a
 * third-party gateway (custom ANTHROPIC_BASE_URL) fails the shape/host check
 * and is dropped — the request is skipped. Genuine sk-ant-shaped keys still
 * pass. The OAuth-token profile variant is unaffected (official `LZ`
 * attaches Bearer independently of the base URL).
 *
 * Test architecture — the ONLY mock.module is axios (delegated to the real
 * implementation outside this file's window; cross-file rationale in
 * policyLimits/__tests__/envBearerFallback285.test.ts). The real auth stack
 * is driven through env inputs plus a temp CLAUDE_CONFIG_DIR. The
 * oauthAccount gate is seeded via saveGlobalConfig (under NODE_ENV=test
 * getGlobalConfig short-circuits to the shared TEST_GLOBAL_CONFIG_FOR_TESTING
 * object — config-file seeding would never be read), and restored to
 * undefined after every test so the shared object never leaks across files.
 */

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-gw-profile-'))

let intercept = false
const realAxios = { ...(await import('axios')) }
const realAxiosGet = realAxios.default.get.bind(realAxios.default)
const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<unknown> => ({
    data: { accountUuid: 'test-uuid' },
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

const { clearOAuthTokenCache } = await import('src/utils/auth.js')
const { saveGlobalConfig } = await import('../../../utils/config.js')
const { getGlobalClaudeFile } = await import('../../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')
const { getOauthProfileFromApiKey } = await import('../getOauthProfile.js')

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
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
  // Seed the shared test config with an oauthAccount so the API-key branch of
  // getOauthProfileFromApiKey is reachable (it requires accountUuid + key).
  // Under NODE_ENV=test getGlobalConfig returns TEST_GLOBAL_CONFIG_FOR_TESTING
  // (not the on-disk file), so saveGlobalConfig is the only path that mutates
  // what the SUT reads.
  saveGlobalConfig(cfg => ({
    ...cfg,
    oauthAccount: { accountUuid: 'test-uuid' },
  }))
  mockedGet.mockClear()
})

afterEach(() => {
  intercept = false
  clearOAuthTokenCache()
  // Restore the shared test config so oauthAccount never leaks to siblings.
  saveGlobalConfig(cfg => ({ ...cfg, oauthAccount: undefined }))
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  clearConfigPathCaches()
})

afterAll(async () => {
  intercept = false
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('getOauthProfileFromApiKey gateway-key leak (official f5)', () => {
  test('makes no request when a gateway key is configured under a custom base URL', async () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'gw-secret-key'

    // Act
    const result = await getOauthProfileFromApiKey()

    // Assert — no profile request, gateway key never leaves the box
    expect(result).toBeUndefined()
    expect(mockedGet).not.toHaveBeenCalled()
  })

  test('still sends a genuine sk-ant- key under a gateway base URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-genuine'

    await getOauthProfileFromApiKey()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [url, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('https://api.anthropic.com/api/claude_cli_profile')
    expect(config.headers['x-api-key']).toBe('sk-ant-api03-genuine')
  })

  test('sends the key with first-party config (base URL unset)', async () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'console-key'

    await getOauthProfileFromApiKey()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(config.headers['x-api-key']).toBe('console-key')
  })
})
