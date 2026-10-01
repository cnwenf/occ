import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill — the auth/config import graph reads MACRO.VERSION.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * PORT (CC 2.1.286) — connectedBridgePolicyRefusal (official `WAe`
 * @202356353 in the v286 linux-x64 binary; v285 has ZERO hits for the notice
 * strings, the per-policy verdict fn `Lb` @200084227, or the
 * tengu_bridge_policy_teardown event).
 *
 * Contract under test:
 * - policies = outboundOnly ? ['allow_remote_control','allow_remote_sessions']
 *                          : ['allow_remote_control']  (byte-verified order)
 * - unknown/not-loaded (undefined='cache_miss', null='route_missing') and
 *   {allowed:true} → null refusal — NEVER disconnect on unknown
 * - {allowed:false} → {policy, kind:'org_denied', detail} with the official
 *   byte-exact notice strings
 * - auth-mode gate (official jne/I3n/T @200064675–200064850, scope set
 *   {prosumer_oauth, third_party_provider, custom_base_url})
 * - appendBridgePolicyNotice: official REPL transcript dedup rule (skip when
 *   the LAST entry is an informational system message with identical content)
 *
 * HERMETIC DESIGN — no mock.module on policyLimits/auth/providers: bun
 * 1.3.14 mock.module restores do NOT propagate across test files (a
 * re-registered "actual" module is ignored by later files' imports —
 * empirically verified), so mocking those shared paths here would poison
 * later test files' real eligibility checks. Instead every arm drives the
 * REAL modules via env vars, a temp CLAUDE_CONFIG_DIR (.credentials.json /
 * settings.json) and an axios-level mock feeding refreshPolicyLimits.
 *
 * NOT COVERED here: the outer `catch{return null}` of WAe (defensive parity
 * arm). OCC's real getPolicyRestrictionFromCache cannot be made to throw
 * without a cross-file-poisoning module mock, so the arm stays structurally
 * ported but behaviorally uncovered — documented divergence.
 */

// --- hermetic env: temp config dir; per-test env manipulation
const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-bpr-286-'))
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const
const savedEnv: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key]
}
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR

// --- axios mock: single module-scope registration, closure-controlled
// (mid-test mock.module re-registration does not propagate reliably in bun).
const actualAxios = await import('axios')

type Restrictions = Record<string, { allowed: boolean }>
let nextRestrictions: Restrictions = {}
let failNextGet = false
let axiosGetCallCount = 0

const mockedGet = mock(async (): Promise<{ status: number; data: unknown }> => {
  axiosGetCallCount += 1
  if (failNextGet) {
    throw Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: {}, headers: {} },
    })
  }
  return { status: 200, data: { restrictions: nextRestrictions } }
})

mock.module('axios', () => ({
  ...actualAxios,
  default: { ...actualAxios.default, get: mockedGet },
}))

// --- SUT + real collaborators (imported AFTER the axios mock registration)
const {
  BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
  BRIDGE_POLICY_SESSIONS_NOTICE,
  connectedBridgePolicyRefusal,
  getBridgePolicyAuthMode,
  isBridgePolicyAuthModeInScope,
  appendBridgePolicyNotice,
} = await import('../bridgePolicyRefusal.js')

const { refreshPolicyLimits, _resetPolicyLimitsForTesting } = await import(
  '../../services/policyLimits/index.js'
)
const { getClaudeAIOAuthTokens } = await import('../../utils/auth.js')
const { getGlobalClaudeFile } = await import('../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../utils/envUtils.js')
const { resetSettingsCache } = await import(
  '../../utils/settings/settingsCache.js'
)

const clearOAuthCache = (): void => {
  ;(getClaudeAIOAuthTokens as unknown as { cache?: { clear(): void } }).cache?.clear?.()
}

const clearAllCaches = (): void => {
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
  resetSettingsCache()
  clearOAuthCache()
  _resetPolicyLimitsForTesting()
}

/** Wipe the temp config dir (disk policy cache + credentials + settings). */
const wipeConfigDir = (): void => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
}

/** Env for an eligible Console-API-key user on the first-party URL. */
const setEligibleEnv = (): void => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-port286'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_UNIX_SOCKET
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
}

const writeCredentials = async (
  tokens: Record<string, unknown>,
): Promise<void> => {
  await writeFile(
    join(TEST_CONFIG_DIR, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: tokens }),
  )
}

const RC_DENIED: Restrictions = { allow_remote_control: { allowed: false } }
const RC_ALLOWED: Restrictions = { allow_remote_control: { allowed: true } }
const SESSIONS_DENIED: Restrictions = {
  allow_remote_sessions: { allowed: false },
}

beforeEach(() => {
  nextRestrictions = {}
  failNextGet = false
  axiosGetCallCount = 0
  wipeConfigDir()
  clearAllCaches()
  setEligibleEnv()
})

afterAll(async () => {
  _resetPolicyLimitsForTesting()
  mock.module('axios', () => ({
    ...actualAxios,
    default: actualAxios.default,
  }))
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('notice strings — byte-verified against the v286 binary', () => {
  test('Remote Control notice matches official JDr exactly', () => {
    expect(BRIDGE_POLICY_REMOTE_CONTROL_NOTICE).toBe(
      "Remote Control was turned off by your organization's policy.",
    )
  })

  test('session-mirroring notice matches official exactly', () => {
    expect(BRIDGE_POLICY_SESSIONS_NOTICE).toBe(
      "Session mirroring was turned off by your organization's policy (allow_remote_sessions).",
    )
  })
})

describe('connectedBridgePolicyRefusal — WAe port (real cache via axios)', () => {
  test('null when the cache is unavailable (cache_miss) — never disconnect on unknown', () => {
    // Fresh state: no load has run; session cache AND disk cache are empty
    // (config dir wiped in beforeEach).
    expect(connectedBridgePolicyRefusal(false)).toBeNull()
    expect(connectedBridgePolicyRefusal(true)).toBeNull()
  })

  test('null when the policy key is absent from a loaded cache (route_missing)', async () => {
    nextRestrictions = RC_ALLOWED
    await refreshPolicyLimits()
    expect(axiosGetCallCount).toBeGreaterThan(0)
    expect(connectedBridgePolicyRefusal(false)).toBeNull()
    // outboundOnly=true also probes allow_remote_sessions → absent → null arm.
    expect(connectedBridgePolicyRefusal(true)).toBeNull()
  })

  test('null when allow_remote_control is explicitly allowed', async () => {
    nextRestrictions = { ...RC_ALLOWED, ...SESSIONS_DENIED }
    await refreshPolicyLimits()
    expect(connectedBridgePolicyRefusal(false)).toBeNull()
    // outboundOnly=true would see the sessions denial → assert false-lane only.
  })

  test('org_denied refusal with the RC notice when allow_remote_control is denied', async () => {
    nextRestrictions = RC_DENIED
    await refreshPolicyLimits()
    for (const outboundOnly of [false, true]) {
      expect(connectedBridgePolicyRefusal(outboundOnly)).toEqual({
        policy: 'allow_remote_control',
        kind: 'org_denied',
        detail: BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
      })
    }
  })

  test('outboundOnly=false ignores a denied allow_remote_sessions', async () => {
    nextRestrictions = { ...RC_ALLOWED, ...SESSIONS_DENIED }
    await refreshPolicyLimits()
    expect(connectedBridgePolicyRefusal(false)).toBeNull()
  })

  test('outboundOnly=true returns the sessions notice when only sessions is denied', async () => {
    nextRestrictions = { ...RC_ALLOWED, ...SESSIONS_DENIED }
    await refreshPolicyLimits()
    expect(connectedBridgePolicyRefusal(true)).toEqual({
      policy: 'allow_remote_sessions',
      kind: 'org_denied',
      detail: BRIDGE_POLICY_SESSIONS_NOTICE,
    })
  })

  test('outboundOnly=true prefers allow_remote_control when both are denied (official order)', async () => {
    nextRestrictions = { ...RC_DENIED, ...SESSIONS_DENIED }
    await refreshPolicyLimits()
    expect(connectedBridgePolicyRefusal(true)).toEqual({
      policy: 'allow_remote_control',
      kind: 'org_denied',
      detail: BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    })
  })

  test('a failed fetch leaves the cache unavailable → null (fail-open)', async () => {
    failNextGet = true
    await refreshPolicyLimits()
    expect(connectedBridgePolicyRefusal(false)).toBeNull()
    expect(connectedBridgePolicyRefusal(true)).toBeNull()
  })
})

describe('getBridgePolicyAuthMode / isBridgePolicyAuthModeInScope — jne+I3n+T port', () => {
  test('non-first-party provider → third_party_provider (in scope)', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(getBridgePolicyAuthMode()).toBe('third_party_provider')
    expect(isBridgePolicyAuthModeInScope()).toBe(true)
  })

  test('first-party behind a custom base URL → custom_base_url (in scope)', () => {
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
    expect(getBridgePolicyAuthMode()).toBe('custom_base_url')
    expect(isBridgePolicyAuthModeInScope()).toBe(true)
  })

  test('tunnel socket short-circuits to no mode (official L0 arm)', () => {
    delete process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/anthropic.sock'
    expect(getBridgePolicyAuthMode()).toBeUndefined()
    expect(isBridgePolicyAuthModeInScope()).toBe(false)
  })

  test('raw API key (skipping apiKeyHelper) → no mode', () => {
    // setEligibleEnv already set ANTHROPIC_API_KEY.
    expect(getBridgePolicyAuthMode()).toBeUndefined()
    expect(isBridgePolicyAuthModeInScope()).toBe(false)
  })

  test('configured apiKeyHelper → no mode (official Wc arm)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await writeFile(
      join(TEST_CONFIG_DIR, 'settings.json'),
      JSON.stringify({ apiKeyHelper: '/usr/local/bin/key-helper' }),
    )
    resetSettingsCache()
    expect(getBridgePolicyAuthMode()).toBeUndefined()
  })

  test('no auth at all → no_auth (out of scope)', () => {
    delete process.env.ANTHROPIC_API_KEY
    // NODE_ENV=test → the real key lookup throws its CI guard → official
    // try/catch fallthrough → no helper, no credentials → 'no_auth'.
    expect(getBridgePolicyAuthMode()).toBe('no_auth')
    expect(isBridgePolicyAuthModeInScope()).toBe(false)
  })

  test('OAuth without the inference scope → oauth_no_inference_scope', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await writeCredentials({
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:profile'],
      subscriptionType: 'max',
      rateLimitTier: null,
    })
    clearOAuthCache()
    expect(getBridgePolicyAuthMode()).toBe('oauth_no_inference_scope')
    expect(isBridgePolicyAuthModeInScope()).toBe(false)
  })

  test('prosumer OAuth (max) → prosumer_oauth (in scope)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await writeCredentials({
      accessToken: 'tok',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: null,
    })
    clearOAuthCache()
    expect(getBridgePolicyAuthMode()).toBe('prosumer_oauth')
    expect(isBridgePolicyAuthModeInScope()).toBe(true)
  })

  test('team/enterprise OAuth → no mode (org-managed, out of gate scope)', async () => {
    delete process.env.ANTHROPIC_API_KEY
    for (const subscriptionType of ['team', 'enterprise']) {
      await writeCredentials({
        accessToken: 'tok',
        refreshToken: null,
        expiresAt: null,
        scopes: ['user:inference'],
        subscriptionType,
        rateLimitTier: null,
      })
      clearOAuthCache()
      expect(getBridgePolicyAuthMode()).toBeUndefined()
      expect(isBridgePolicyAuthModeInScope()).toBe(false)
    }
  })

  test('null subscriptionType → no mode', () => {
    delete process.env.ANTHROPIC_API_KEY
    // CLAUDE_CODE_OAUTH_TOKEN env arm returns subscriptionType: null.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok'
    clearOAuthCache()
    expect(getBridgePolicyAuthMode()).toBeUndefined()
  })
})

describe('appendBridgePolicyNotice — official REPL transcript dedup rule', () => {
  test('appends an informational system notice at level "notice"', () => {
    const result = appendBridgePolicyNotice(
      [],
      BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    )
    expect(result).toHaveLength(1)
    const entry = result[0] as unknown as {
      type: string
      subtype: string
      content: string
      level: string
    }
    expect(entry.type).toBe('system')
    expect(entry.subtype).toBe('informational')
    expect(entry.content).toBe(BRIDGE_POLICY_REMOTE_CONTROL_NOTICE)
    expect(entry.level).toBe('notice')
  })

  test('returns the SAME array when the last entry is the identical notice', () => {
    const once = appendBridgePolicyNotice(
      [],
      BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    )
    const twice = appendBridgePolicyNotice(
      once,
      BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    )
    expect(twice).toBe(once)
  })

  test('appends when the last entry differs (even if an earlier one matches)', () => {
    const first = appendBridgePolicyNotice(
      [],
      BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    )
    // A different informational entry sits between the two identical notices —
    // the official rule only inspects messages.at(-1).
    const interleaved = appendBridgePolicyNotice(
      first,
      BRIDGE_POLICY_SESSIONS_NOTICE,
    )
    expect(interleaved).toHaveLength(2)
    const result = appendBridgePolicyNotice(
      interleaved,
      BRIDGE_POLICY_REMOTE_CONTROL_NOTICE,
    )
    expect(result).toHaveLength(3)
    expect(result).not.toBe(interleaved)
  })
})
