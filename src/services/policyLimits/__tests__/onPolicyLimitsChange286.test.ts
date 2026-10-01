import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO polyfill — getClaudeCodeUserAgent() reads MACRO.VERSION (same pattern
// as nonRetryableClientError281.test.ts in this directory).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

/**
 * PORT (CC 2.1.286) — onPolicyLimitsChange subscription semantics.
 *
 * Official equivalent: the policy store's verdictChanged stream
 * `D0(e){return f().verdictChanged.subscribe(e)}` @200064192 in the v286
 * linux-x64 binary (v285 has no such stream). The subscription feeds the
 * connected-bridge policy watchers (standalone @219444200+, repl @225854200+,
 * sdk_host @222650000+).
 *
 * Contract under test (2.1.286 changelog "Remote Control sessions ... now
 * disconnect with a notice" infrastructure):
 * - fires ONLY when jsonStringify(sessionCache) actually changes across a
 *   background poll (pollPolicyLimits diff)
 * - fires after a successful cache-changing load (refresh/load)
 * - never fires on a no-op poll
 * - unsubscribe stops delivery; a throwing listener never blocks the others
 * - getPolicyRestrictionFromCache tri-state: undefined (cache unavailable /
 *   'cache_miss'), null (key absent / 'route_missing'), {allowed} (verdict).
 */

// --- hermetic env: eligible Console API-key user, first-party URL, temp dir
const TEST_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'occ-pl-286-'))
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
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-port286'
process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'
process.env.CLAUDE_CONFIG_DIR = TEST_CONFIG_DIR
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_UNIX_SOCKET
delete process.env.CLAUDE_CODE_USE_BEDROCK
delete process.env.CLAUDE_CODE_OAUTH_TOKEN

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

// --- setInterval capture: drive pollPolicyLimits deterministically instead
// of waiting the real 1h POLLING_INTERVAL_MS. Only capture the policy-limits
// interval (ms === 3_600_000) so unrelated timers stay real.
const POLLING_INTERVAL_MS = 60 * 60 * 1000
const actualSetInterval = globalThis.setInterval
const actualClearInterval = globalThis.clearInterval
let capturedPollCallback: (() => void) | null = null
const liveFakeHandles = new Set<object>()

const globalAny = globalThis as unknown as {
  setInterval: unknown
  clearInterval: unknown
}
globalAny.setInterval = (cb: () => void, ms?: number) => {
  if (ms === POLLING_INTERVAL_MS) {
    capturedPollCallback = cb
    const handle = { unref: () => {} }
    liveFakeHandles.add(handle)
    return handle
  }
  return actualSetInterval(cb, ms as number)
}
globalAny.clearInterval = (handle: unknown) => {
  if (typeof handle === 'object' && handle !== null) {
    liveFakeHandles.delete(handle)
    if (liveFakeHandles.size === 0) {
      capturedPollCallback = null
    }
    return
  }
  actualClearInterval(handle as Parameters<typeof actualClearInterval>[0])
}

const {
  refreshPolicyLimits,
  startBackgroundPolling,
  onPolicyLimitsChange,
  getPolicyRestrictionFromCache,
  _resetPolicyLimitsForTesting,
} = await import('../index.js')

// Zero-arg memoized config-path caches (see nonRetryableClientError281.test.ts
// for the full rationale).
const { getGlobalClaudeFile } = await import('../../../utils/env.js')
const { getClaudeConfigHomeDir } = await import('../../../utils/envUtils.js')
const clearConfigPathCaches = (): void => {
  getGlobalClaudeFile.cache.clear()
  getClaudeConfigHomeDir.cache.clear()
}

/** Wipe the temp config dir (disk policy cache from earlier tests). */
const wipeConfigDir = (): void => {
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CONFIG_DIR, { recursive: true })
}

/** Flush the fire-and-forget poll chain (axios + writeFile awaits). */
const flushAsync = async (): Promise<void> => {
  await new Promise(resolve => actualSetInterval(resolve, 10))
  await new Promise(resolve => actualSetInterval(resolve, 10))
}

const RESTRICTIONS_A: Restrictions = { allow_remote_control: { allowed: true } }
const RESTRICTIONS_B: Restrictions = {
  allow_remote_control: { allowed: false },
}

beforeEach(() => {
  axiosGetCallCount = 0
  nextRestrictions = {}
  failNextGet = false
  capturedPollCallback = null
  liveFakeHandles.clear()
  wipeConfigDir()
  clearConfigPathCaches()
  _resetPolicyLimitsForTesting()
})

afterAll(async () => {
  _resetPolicyLimitsForTesting()
  globalAny.setInterval = actualSetInterval
  globalAny.clearInterval = actualClearInterval
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
  clearConfigPathCaches()
  await rm(TEST_CONFIG_DIR, { recursive: true, force: true })
})

describe('getPolicyRestrictionFromCache — 2.1.286 tri-state verdict surface', () => {
  test('returns undefined when the cache is unavailable (official cache_miss)', () => {
    // Fresh module state: no load has run; session cache AND disk cache are
    // empty (config dir wiped in beforeEach).
    expect(getPolicyRestrictionFromCache('allow_remote_control')).toBeUndefined()
  })

  test('returns null when the cache is loaded but the key is absent (route_missing)', async () => {
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()
    expect(getPolicyRestrictionFromCache('allow_remote_sessions')).toBeNull()
  })

  test('returns the restriction object when the policy is present', async () => {
    nextRestrictions = { allow_remote_control: { allowed: false } }
    await refreshPolicyLimits()
    expect(getPolicyRestrictionFromCache('allow_remote_control')).toEqual({
      allowed: false,
    })
  })
})

describe('onPolicyLimitsChange — 2.1.286 verdictChanged subscription', () => {
  test('fires after a successful cache-changing load (refresh)', async () => {
    let fired = 0
    onPolicyLimitsChange(() => {
      fired += 1
    })
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()
    expect(fired).toBe(1)
  })

  test('does NOT fire when a background poll returns identical restrictions', async () => {
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()

    let fired = 0
    onPolicyLimitsChange(() => {
      fired += 1
    })
    startBackgroundPolling()
    expect(capturedPollCallback).not.toBeNull()

    // Same payload → jsonStringify(sessionCache) unchanged → no notification.
    capturedPollCallback?.()
    await flushAsync()
    expect(fired).toBe(0)
    expect(axiosGetCallCount).toBeGreaterThan(0)
  })

  test('fires exactly once when a background poll changes restrictions', async () => {
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()

    let fired = 0
    onPolicyLimitsChange(() => {
      fired += 1
    })
    startBackgroundPolling()

    // Org turns Remote Control off mid-session — the 2.1.286 changelog bug.
    nextRestrictions = RESTRICTIONS_B
    capturedPollCallback?.()
    await flushAsync()
    expect(fired).toBe(1)
    expect(getPolicyRestrictionFromCache('allow_remote_control')).toEqual({
      allowed: false,
    })
  })

  test('unsubscribe stops delivery', async () => {
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()

    let fired = 0
    const unsubscribe = onPolicyLimitsChange(() => {
      fired += 1
    })
    unsubscribe()
    startBackgroundPolling()

    nextRestrictions = RESTRICTIONS_B
    capturedPollCallback?.()
    await flushAsync()
    expect(fired).toBe(0)
  })

  test('a throwing listener never blocks the other listeners', async () => {
    let secondFired = 0
    onPolicyLimitsChange(() => {
      throw new Error('listener boom')
    })
    onPolicyLimitsChange(() => {
      secondFired += 1
    })
    nextRestrictions = RESTRICTIONS_A
    await refreshPolicyLimits()
    expect(secondFired).toBe(1)
  })

  test('does NOT fire when a refresh loads nothing (fetch failure stays null)', async () => {
    // _resetPolicyLimitsForTesting + axios failure path: cache stays null.
    let fired = 0
    onPolicyLimitsChange(() => {
      fired += 1
    })
    failNextGet = true
    await refreshPolicyLimits()
    expect(fired).toBe(0)
    expect(axiosGetCallCount).toBeGreaterThan(0)
  })
})
