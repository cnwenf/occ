// CC 2.1.286 (changelog #1): `claude auth status` managed-key label fix.
//
// Byte-verified delta (2.1.285 vs 2.1.286 linux-x64 ELFs):
//   v285 @219111981:
//     else if(d==="ANTHROPIC_API_KEY"||h||C)p="api_key";
//     else if(d==="apiKeyHelper"&&E)p="api_key_helper";
//     else if(d==="/login managed key")p="claude.ai";
//   v286 @220312704:
//     else if(c==="ANTHROPIC_API_KEY"||h||c==="/login managed key")p="api_key";
//     else if(c==="apiKeyHelper"&&E)p="api_key_helper";
// The managed-key branch was folded into the api_key condition and the
// claude.ai branch deleted — managed-key sessions now report `api_key` and
// omit the claude.ai-only JSON fields (email/orgId/orgName/subscriptionType).
// (v285's extra `||C` Console-profile term has no OCC analog.)

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { authStatus } from '../handlers/auth.js'
import {
  clearOAuthTokenCache,
  getApiKeyFromConfigOrMacOSKeychain,
} from '../../utils/auth.js'
import { enableConfigs } from '../../utils/config.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const MANAGED_KEY = 'sk-ant-managed-286-fixture'
const ENV_TO_CLEAR = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
]

let tmpConfigDir: string
let captured = ''
let exitCode: number | string | undefined
let writeSpy: { mockRestore(): void }
let exitSpy: { mockRestore(): void }

const savedEnv: Record<string, string | undefined> = {}
let savedNodeEnv: string | undefined
let savedCi: string | undefined
let savedConfigDir: string | undefined

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-286-managed-key-'))

  // bun test defaults NODE_ENV to 'test', which routes getGlobalConfig to an
  // in-memory fixture AND makes getAnthropicApiKeyWithSource throw without
  // env credentials — the config-file managed-key path is unreachable. Run
  // these tests in 'development' mode against a real tmp config dir.
  savedNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'

  // Same throw guard has a second arm: `isEnvTruthy(process.env.CI)`
  // (src/utils/auth.ts). GitHub Actions always sets CI=true, so neutralizing
  // NODE_ENV alone still made the config-file managed-key path unreachable
  // there (CI run 36969528273 red). Clear CI for the duration of this suite
  // so the guard cannot fire regardless of the runner environment.
  savedCi = process.env.CI
  delete process.env.CI

  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  for (const k of ENV_TO_CLEAR) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }

  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  // Global config carrying a /login-managed primaryApiKey (the Linux
  // managed-key shape getApiKeyFromConfigOrMacOSKeychain reads).
  writeFileSync(
    getGlobalClaudeFile(),
    JSON.stringify({ primaryApiKey: MANAGED_KEY }),
  )
  // Outside NODE_ENV=test, config reads are gated until bootstrap calls
  // enableConfigs() — mirror that here (fixture file is already in place).
  enableConfigs()
})

afterAll(() => {
  if (savedNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = savedNodeEnv
  if (savedCi === undefined) delete process.env.CI
  else process.env.CI = savedCi
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  for (const k of ENV_TO_CLEAR) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  clearOAuthTokenCache()
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the tmp fixture
  }
})

beforeEach(() => {
  captured = ''
  exitCode = undefined
  writeSpy = spyOn(process.stdout, 'write').mockImplementation(
    (chunk: unknown) => {
      captured += String(chunk)
      return true
    },
  )
  exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    return undefined
  }) as never)
  // Each test starts from the managed-key config with no stored OAuth login.
  rmSync(join(tmpConfigDir, '.credentials.json'), { force: true })
  clearOAuthTokenCache()
  getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
})

afterEach(() => {
  writeSpy.mockRestore()
  exitSpy.mockRestore()
})

test('managed-key session reports api_key and omits claude.ai fields (2.1.286)', async () => {
  // Act
  await authStatus({ json: true })

  // Assert — v285 labeled this 'claude.ai'; v286 folds it into api_key.
  const parsed = JSON.parse(captured) as Record<string, unknown>
  expect(parsed.authMethod).toBe('api_key')
  expect(parsed.apiKeySource).toBe('/login managed key')
  expect(parsed.loggedIn).toBe(true)
  // The claude.ai-only account block must NOT be emitted for managed keys.
  expect('email' in parsed).toBe(false)
  expect('orgId' in parsed).toBe(false)
  expect('orgName' in parsed).toBe(false)
  expect('subscriptionType' in parsed).toBe(false)
  expect(exitCode).toBe(0)
})

test('ANTHROPIC_API_KEY env session still reports api_key (merged-condition regression)', async () => {
  // Arrange
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env-286-regression'
  try {
    // Act
    await authStatus({ json: true })
  } finally {
    delete process.env.ANTHROPIC_API_KEY
  }

  // Assert — the pre-existing env-key arm of the merged condition is intact.
  const parsed = JSON.parse(captured) as Record<string, unknown>
  expect(parsed.authMethod).toBe('api_key')
  expect(parsed.loggedIn).toBe(true)
  expect(exitCode).toBe(0)
})

test('stored claude.ai login still reports claude.ai with account fields', async () => {
  // Arrange — a genuine claude.ai OAuth login on disk (token-source branch,
  // which v286 did NOT touch).
  writeFileSync(
    join(tmpConfigDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at-286-control',
        refreshToken: 'rt-286-control',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
      },
    }),
  )
  clearOAuthTokenCache()

  // Act
  await authStatus({ json: true })

  // Assert
  const parsed = JSON.parse(captured) as Record<string, unknown>
  expect(parsed.authMethod).toBe('claude.ai')
  expect(parsed.loggedIn).toBe(true)
  // claude.ai sessions keep the account block (nulls without oauthAccount).
  expect('email' in parsed).toBe(true)
  expect(parsed.email).toBeNull()
  expect('orgId' in parsed).toBe(true)
  expect('orgName' in parsed).toBe(true)
  expect('subscriptionType' in parsed).toBe(true)
  expect(exitCode).toBe(0)
})
