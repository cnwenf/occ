import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * CC 2.1.299 (#070): fast-mode penguin-status prefetch must never send a
 * gateway API key to api.anthropic.com.
 *
 * Official `TPe` (@~217810900): `let r=VS(),s=f5(r)` — the API key is run
 * through the f5 sanitizer before the request; with no OAuth and no
 * sanitized key the request is skipped and org status falls back to the
 * cache guess. Genuine sk-ant-shaped keys still pass.
 *
 * The provider gate alone cannot catch this: ANTHROPIC_BASE_URL gateway
 * users are still provider 'firstParty'.
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

const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-gw-fastmode-'))

// bun loads every test file's top level before any tests run and a
// mock.module registration can outlive mock.restore() — so the axios
// override DELEGATES to the real implementation whenever this file's tests
// are not in their window. Materialize the real exports BEFORE mock.module
// so the factory can never resolve back to the mock itself.
let intercept = false
const realAxios = { ...(await import('axios')) }
const realAxiosGet = realAxios.default.get.bind(realAxios.default)
const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<unknown> => ({
    data: { enabled: true, disabled_reason: null },
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

const { clearOAuthTokenCache } = await import('../auth.js')
const { getGlobalClaudeFile } = await import('../env.js')
const { getClaudeConfigHomeDir } = await import('../envUtils.js')
const { prefetchFastModeStatus } = await import('../fastMode.js')

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'USER_TYPE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_FAST_MODE',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
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

// Module-level 30s throttle (lastPrefetchAt) has no reset export — advance a
// fake clock past the window before each prefetch.
let fakeNow = Date.now()

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
  fakeNow += 60_000
  setSystemTime(new Date(fakeNow))
})

afterEach(() => {
  intercept = false
  setSystemTime()
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

describe('prefetchFastModeStatus gateway-key leak (official TPe/f5)', () => {
  test('makes no request when a gateway key is configured under a custom base URL', async () => {
    // Arrange
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'gw-secret-key'

    // Act
    await prefetchFastModeStatus()

    // Assert — nothing sent to api.anthropic.com, key never leaves the box
    expect(mockedGet).not.toHaveBeenCalled()
  })

  test('still sends a genuine sk-ant- key under a gateway base URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-genuine'

    await prefetchFastModeStatus()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [url, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('https://api.anthropic.com/api/claude_code_penguin_mode')
    expect(config.headers['x-api-key']).toBe('sk-ant-api03-genuine')
  })

  test('sends the key with first-party config (base URL unset)', async () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_API_KEY = 'console-key'

    await prefetchFastModeStatus()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [, config] = mockedGet.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ]
    expect(config.headers['x-api-key']).toBe('console-key')
  })
})
