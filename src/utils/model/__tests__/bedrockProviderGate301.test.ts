// CC 2.1.301 PORT #17 — defensive provider gate on getInferenceProfileBackingModel.
//
// Official v301 (linux-x64 ELF, byte-verified @219458692, grep+dd — binary
// NEVER executed):
//   `if(xe()!=="bedrock")return Promise.resolve(null)`
// as the FIRST statement inside the memoized backing-model resolver (xe ≡
// getAPIProvider). Defense-in-depth: the cost-calculation path must never
// construct a Bedrock client or hit the AWS GetInferenceProfile API when the
// session's provider is not bedrock, even if a caller forgets its own guard.
// Behavior-neutral for bedrock sessions.
//
// OCC port: src/utils/model/bedrock.ts getInferenceProfileBackingModel gains
//   `if (getAPIProvider() !== 'bedrock') return null`
// inside the memoized function (per-profileId memoize cache unchanged).

import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// --- mocks: install BEFORE requiring bedrock.js -----------------------------
// Passthrough-flag pattern (bun mock.module is process-global): snapshots are
// spread copies of the REAL namespaces taken before mocking, so the afterAll
// re-mock restores genuine behavior for later files in the shared process.

const actualProviders = { ...require('../providers.js') } as typeof import('../providers.js')
let providersMockActive = true
let providerMock = 'firstParty'
mock.module('../providers.js', () => ({
  ...actualProviders,
  getAPIProvider: () =>
    providersMockActive
      ? (providerMock as ReturnType<typeof actualProviders.getAPIProvider>)
      : actualProviders.getAPIProvider(),
}))

const actualBedrockSdk = { ...require('@aws-sdk/client-bedrock') }
let bedrockSdkMockActive = true
let bedrockClientConstructs = 0
const BACKING_MODEL_ARN =
  'arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude-sonnet-4-5'
mock.module('@aws-sdk/client-bedrock', () => ({
  ...actualBedrockSdk,
  BedrockClient: class MockBedrockClient {
    constructor(_config?: unknown) {
      bedrockClientConstructs++
    }
    async send(_command: unknown): Promise<unknown> {
      return { models: [{ modelArn: BACKING_MODEL_ARN }] }
    }
  },
  GetInferenceProfileCommand: class MockGetInferenceProfileCommand {
    constructor(_input?: unknown) {}
  },
  ListInferenceProfilesCommand: class MockListInferenceProfilesCommand {
    constructor(_input?: unknown) {}
  },
}))

// Require AFTER mocks are registered so bedrock.js binds the mocked
// getAPIProvider (it imports './providers.js' after the #17 port).
const { getInferenceProfileBackingModel } =
  require('../bedrock.js') as typeof import('../bedrock.js')

// --- env hygiene -------------------------------------------------------------

const ENV_KEYS = [
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Skip AWS credential refresh inside createBedrockClient (getAWSClientProxyConfig
  // and the BedrockClient constructor still run — the constructor is the spy).
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  bedrockClientConstructs = 0
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

afterAll(() => {
  providersMockActive = false
  bedrockSdkMockActive = false
  // Heal the process-global seams: point both modules back at the real
  // (pre-mock snapshot) implementations for any later file in the run.
  mock.module('../providers.js', () => actualProviders)
  mock.module('@aws-sdk/client-bedrock', () => actualBedrockSdk)
})

// --- tests --------------------------------------------------------------------
// NOTE: getInferenceProfileBackingModel is memoized by profileId — every test
// MUST use a distinct profileId so no case inherits a cached result.

test('provider gate: firstParty session → null, no Bedrock client constructed', async () => {
  // Arrange
  providerMock = 'firstParty'

  // Act
  const result = await getInferenceProfileBackingModel('gate-301-firstparty')

  // Assert — early return before createBedrockClient()/GetInferenceProfile.
  expect(result).toBeNull()
  expect(bedrockClientConstructs).toBe(0)
})

test('provider gate: vertex session → null, no Bedrock client constructed', async () => {
  // Arrange
  providerMock = 'vertex'

  // Act
  const result = await getInferenceProfileBackingModel('gate-301-vertex')

  // Assert
  expect(result).toBeNull()
  expect(bedrockClientConstructs).toBe(0)
})

test('provider gate: bedrock session → resolves the backing model as before', async () => {
  // Arrange
  providerMock = 'bedrock'

  // Act
  const result = await getInferenceProfileBackingModel('gate-301-bedrock')

  // Assert — behavior-neutral for bedrock: one client, model extracted from ARN.
  expect(result).toBe('anthropic.claude-sonnet-4-5')
  expect(bedrockClientConstructs).toBe(1)
})
