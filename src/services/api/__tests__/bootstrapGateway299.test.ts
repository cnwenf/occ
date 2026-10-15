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
 * CC 2.1.299 (#070): startup bootstrap fetch must never send a gateway API
 * key to api.anthropic.com.
 *
 * Official anthropic-owned client `yr` (@218212358): the x-api-key header is
 * run through `f5`; when it fails (gateway key under a custom
 * ANTHROPIC_BASE_URL) the request is skipped as "no-auth" —
 * "API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host". Genuine
 * sk-ant-shaped keys still pass; the OAuth branch is unaffected (official
 * `LZ` attaches Bearer independently of the base URL).
 *
 * Test architecture — the ONLY mock.module is axios (the repo-accepted
 * network-boundary pattern, delegated to the real implementation outside
 * this file's window; see the cross-file rationale in
 * policyLimits/__tests__/envBearerFallback285.test.ts). The real auth stack
 * is driven through its public inputs: ANTHROPIC_API_KEY /
 * ANTHROPIC_BASE_URL env plus a temp CLAUDE_CONFIG_DIR (no stored
 * credentials, no real-config writes).
 */

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-gw-bootstrap-'))

// Materialize the real axios exports BEFORE mock.module so the delegating
// factory can never resolve back to the mock itself.
let intercept = false
const realAxios = { ...(await import('axios')) }
const realAxiosGet = realAxios.default.get.bind(realAxios.default)
const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<unknown> => ({
    data: { client_data: null, additional_model_options: [] },
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
const { getGlobalClaudeFile } = await import('../../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')
const { fetchBootstrapData } = await import('../bootstrap.js')

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
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
})

afterEach(() => {
  intercept = false
  clearOAuthTokenCache()
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

describe('fetchBootstrapData gateway-key leak (official yr/f5)', () => {
  test('makes no request when a gateway key is configured under a custom base URL', async () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'gw-secret-key'

    // Act
    await fetchBootstrapData()

    // Assert — no bootstrap request, gateway key never leaves the box
    expect(mockedGet).not.toHaveBeenCalled()
  })

  test('still sends a genuine sk-ant- key under a gateway base URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-genuine'

    await fetchBootstrapData()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [url, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('https://api.anthropic.com/api/claude_cli/bootstrap')
    expect(config.headers['x-api-key']).toBe('sk-ant-api03-genuine')
  })

  test('sends the key with first-party config (base URL unset)', async () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'console-key'

    await fetchBootstrapData()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(config.headers['x-api-key']).toBe('console-key')
  })

  test('makes no request with no usable credential', async () => {
    // No API key, no OAuth token: fetchBootstrapAPI resolves no auth (under
    // NODE_ENV=test the CI guard throw is swallowed by fetchBootstrapData's
    // catch) — either way, no request reaches api.anthropic.com.
    await fetchBootstrapData()

    expect(mockedGet).not.toHaveBeenCalled()
  })
})
