import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearAwsCredentialsCache,
  clearAwsHelperCredentialsCache,
  getDefaultAwsCredentialProvider,
  invalidateAwsCredentialProvider,
} from '../auth.js'
import { getDefaultOpusModel } from '../model/model.js'
import { getAPIProvider } from '../model/providers.js'
import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'

/**
 * 2.1.207 #19: Bedrock/Vertex/Claude Platform AWS/Mantle/Foundry default
 * changed to Claude Opus 4.8 (was Opus 4.7 in 2.1.206). Only the gateway
 * provider retained the Opus 4.7 default.
 *
 * 2.1.219 # OCC-36: default Opus advanced to Claude Opus 5 for all non-gateway
 * providers (gateway stays Opus 4.7). Official 2.1.220 linux-x64 ELF strings:
 * `DEFAULT_OPUS_MODEL ?? Km().opus5`; `aliases.opus.default = "claude-opus-5"`
 * with `per_provider.gateway = "claude-opus-4-7"`. This file now asserts the
 * 2.1.219 default (opus-5) for every non-gateway provider.
 *
 * 2.1.207 #16: Fixed Bedrock repeatedly requesting fresh AWS SSO credentials
 * every API request — the SDK's fromNodeProviderChain is now cached per region.
 */

// Bedrock env vars to set per test
const BEDROCK_ENV = { CLAUDE_CODE_USE_BEDROCK: '1' }
const VERTEX_ENV = { CLAUDE_CODE_USE_VERTEX: '1' }
const FOUNDRY_ENV = { CLAUDE_CODE_USE_FOUNDRY: '1' }
const ANTHROPIC_AWS_ENV = { CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }
const MANTLE_ENV = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_MANTLE: '1' }

function withEnv(env: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('2.1.219 # OCC-36: non-gateway default → Opus 5 (was Opus 4.8 in 2.1.207)', () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  })

  // `getDefaultOpusModel()` → `getModelStrings()` runs `initModelStrings()`,
  // which for the bedrock provider fires an async `updateBedrockModelStrings`
  // that caches Bedrock builtin strings (incl. `us.anthropic.claude-sonnet-5`)
  // in the session-global bootstrap/state singleton. That cache survives
  // withEnv's env restore (state ≠ env) and leaks into later tests
  // (e.g. yoloClassifierSonnet5 — C-auto-mode cluster — would resolve the
  // classifier default from stale Bedrock state). Reset it after each test
  // so the next caller re-resolves from the (restored) firstParty env.
  // Same isolation-seam pattern as vimInsertModeRemaps (mock.module leak).
  afterEach(() => {
    resetModelStringsForTestingOnly()
  })

  test('bedrock provider defaults to opus-5', () => {
    withEnv(BEDROCK_ENV, () => {
      expect(getAPIProvider()).toBe('bedrock')
      const model = getDefaultOpusModel()
      expect(model).toContain('claude-opus-5')
    })
  })

  test('vertex provider defaults to opus-5', () => {
    withEnv(VERTEX_ENV, () => {
      expect(getAPIProvider()).toBe('vertex')
      const model = getDefaultOpusModel()
      expect(model).toContain('claude-opus-5')
    })
  })

  test('foundry provider lags at opus-4-6 (binary per_provider table, Gap-1)', () => {
    withEnv(FOUNDRY_ENV, () => {
      expect(getAPIProvider()).toBe('foundry')
      const model = getDefaultOpusModel()
      // OCC-37 Gap-1: the official 2.1.220 binary's per_provider alias table
      // resolves foundry opus to claude-opus-4-6 (foundry lags one
      // generation), NOT claude-opus-5 — see getDefaultOpusModel.
      expect(model).toContain('claude-opus-4-6')
    })
  })

  test('anthropic_aws provider defaults to opus-5', () => {
    withEnv(ANTHROPIC_AWS_ENV, () => {
      expect(getAPIProvider()).toBe('anthropic_aws')
      const model = getDefaultOpusModel()
      expect(model).toContain('claude-opus-5')
    })
  })

  test('mantle provider defaults to opus-5', () => {
    withEnv(MANTLE_ENV, () => {
      // getAPIProvider() returns 'bedrock' even with CLAUDE_CODE_USE_MANTLE set;
      // the bedrock→mantle promotion only happens in getEffectiveAPIProvider().
      // Since getDefaultOpusModel() uses getAPIProvider(), mantle users resolve
      // via the 'bedrock' branch → opus5 (bedrock id `us.anthropic.claude-opus-5`).
      // The official binary's mantle case also returns opus5, so behavior matches.
      expect(getAPIProvider()).toBe('bedrock')
      const model = getDefaultOpusModel()
      expect(model).toContain('claude-opus-5')
    })
  })

  test('firstParty provider defaults to opus-5', () => {
    const model = getDefaultOpusModel()
    expect(model).toContain('claude-opus-5')
  })

  test('ANTHROPIC_DEFAULT_OPUS_MODEL override still wins', () => {
    withEnv(BEDROCK_ENV, () => {
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'custom-opus-model'
      expect(getDefaultOpusModel()).toBe('custom-opus-model')
    })
  })
})

// AWS SSO credential-provider cache tests. Previously gated with
// skipIf(CI) because cross-test module-state leaks (AWS SDK provider-chain
// cache / mock state from other files) broke these in the full-suite run.
// Fixed by ci.yml per-file process isolation (scripts/ci-test.sh) — each
// file gets its own bun process, so no module-state leak.
describe(
  '2.1.207 #16: AWS SSO credential provider cache',
  () => {
  afterEach(() => {
    clearAwsCredentialsCache()
  })

  test('getDefaultAwsCredentialProvider returns same provider for same region', () => {
    const p1 = getDefaultAwsCredentialProvider('us-east-1')
    const p2 = getDefaultAwsCredentialProvider('us-east-1')
    expect(p1).toBe(p2) // same reference — cached
  })

  test('getDefaultAwsCredentialProvider returns different providers for different regions', () => {
    const p1 = getDefaultAwsCredentialProvider('us-east-1')
    const p2 = getDefaultAwsCredentialProvider('eu-west-1')
    expect(p1).not.toBe(p2) // different regions → different providers
  })

  test('clearAwsCredentialsCache clears the provider cache', () => {
    const p1 = getDefaultAwsCredentialProvider('us-east-1')
    clearAwsCredentialsCache()
    const p2 = getDefaultAwsCredentialProvider('us-east-1')
    expect(p1).not.toBe(p2) // cache cleared → new provider
  })

  test('clearAwsHelperCredentialsCache does NOT clear the provider chain cache', () => {
    const p1 = getDefaultAwsCredentialProvider('us-east-1')
    clearAwsHelperCredentialsCache()
    const p2 = getDefaultAwsCredentialProvider('us-east-1')
    expect(p1).toBe(p2) // provider chain cache NOT cleared by helper cache clear
  })

  test('invalidateAwsCredentialProvider clears per-region cache (rate-limited)', () => {
    const p1 = getDefaultAwsCredentialProvider('ap-southeast-2')
    const invalidated = invalidateAwsCredentialProvider('ap-southeast-2')
    expect(invalidated).toBe(true)
    const p2 = getDefaultAwsCredentialProvider('ap-southeast-2')
    expect(p1).not.toBe(p2) // invalidated → new provider
  })

  test('invalidateAwsCredentialProvider is rate-limited', () => {
    getDefaultAwsCredentialProvider('us-west-2')
    const first = invalidateAwsCredentialProvider('us-west-2')
    expect(first).toBe(true)
    // Second call within the rate-limit window should be denied
    const second = invalidateAwsCredentialProvider('us-west-2')
    expect(second).toBe(false)
  })
})
