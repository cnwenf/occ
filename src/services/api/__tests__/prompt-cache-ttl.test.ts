import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setPromptCache1hAllowlist } from 'src/bootstrap/state.js'
import { emitStatusChange } from 'src/services/claudeAiLimits.js'
import {
  clearOAuthTokenCache,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import { getClaudeConfigHomeDir } from 'src/utils/envUtils.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import {
  getCacheControl,
  isMainThreadQuerySource,
  resolvePromptCacheTtl,
  resolvePromptCacheTtlOverride,
  should1hCacheTTL,
} from '../claude'

/**
 * Prompt cache TTL resolution — official 2.1.245 hierarchy (subsystem
 * introduced in 2.1.243; agent-frontmatter layer added in 2.1.248). Layers,
 * highest priority first (official uFr/qTt + HUr/Tvt):
 *   1. FORCE_PROMPT_CACHING_5M            -> {ttl:"5m",reason:"force_5m_env"}
 *   2. CLAUDE_CODE_PROMPT_CACHE_TTL /     -> {ttl,reason:"env"}
 *      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL (per-thread, enum 5m|1h,
 *      invalid values silently fall through — zod .catch(undefined))
 *   3. promptCacheTtl / subagentPromptCacheTtl settings (per-thread)
 *                                           -> {ttl,reason:"setting"}
 *   3.5 agent frontmatter experimental.cacheTtl (2.1.248, Gap-108b)
 *                                           -> {ttl,reason:"agent_frontmatter"}
 *       a requested "1h" is ignored while the subscription is in overage
 *   4. ENABLE_PROMPT_CACHING_1H (+ bedrock-only ENABLE_PROMPT_CACHING_1H_BEDROCK)
 *                                           -> {ttl:"1h",reason:"enable_1h_env"}
 *   5. Subscriber gate (claude.ai subscription within usage limits) AND
 *      allowlisted query source            -> {ttl:"1h",reason:"subscriber"}
 *   6. Otherwise                            -> {ttl:"5m",reason:"default"}
 * The baked default GrowthBook allowlist is
 * ["repl_main_thread*","sdk","auto_mode","memdir_relevance"] (official kzt).
 * Wire shape: only "1h" ever reaches cache_control; 5m stays implicit.
 */

// --- Test fixture: subscriber state is driven through the REAL auth path —
// no module mocks. Under bun test (NODE_ENV=test), getAnthropicApiKeyWithSource
// requires SOME credential to be present, so:
//   subscriber=false → ANTHROPIC_API_KEY set (external key →
//     isAnthropicAuthEnabled() false → isClaudeAISubscriber() false)
//   subscriber=true  → CLAUDE_CODE_OAUTH_TOKEN set (env OAuth token carries
//     scopes ['user:inference'] = CLAUDE_AI_INFERENCE_SCOPE →
//     isClaudeAISubscriber() true)
// A tmp CLAUDE_CONFIG_DIR keeps settings reads isolated. ---
let tmpConfigDir: string
const PREV_ENV: Record<string, string | undefined> = {}
const ENV_TO_CLEAR = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'FORCE_PROMPT_CACHING_5M',
  'ENABLE_PROMPT_CACHING_1H',
  'ENABLE_PROMPT_CACHING_1H_BEDROCK',
  'CLAUDE_CODE_PROMPT_CACHE_TTL',
  'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
]

function setSubscriber(isSubscriber: boolean): void {
  if (isSubscriber) {
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-oauth-token'
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-dummy'
  }
  clearOAuthTokenCache()
}

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(
    join(tmpConfigDir, 'settings.json'),
    JSON.stringify(settings),
  )
  resetSettingsCache()
}

function clearAllCaches(): void {
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  resetSettingsCache()
  setPromptCache1hAllowlist(null) // clear the allowlist session latch
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-pcache-ttl-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  for (const key of ENV_TO_CLEAR) {
    PREV_ENV[key] = process.env[key]
    delete process.env[key]
  }
  clearAllCaches()
})

afterAll(() => {
  const savedConfigDir = PREV_ENV.CLAUDE_CONFIG_DIR
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  for (const key of ENV_TO_CLEAR) {
    if (PREV_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = PREV_ENV[key]
  }
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Non-subscriber baseline: API-key auth, no settings, no overage, no latches.
  setSubscriber(false)
  rmSync(join(tmpConfigDir, 'settings.json'), { force: true })
  emitStatusChange({
    status: 'allowed',
    unifiedRateLimitFallbackAvailable: false,
    isUsingOverage: false,
  } as never)
  clearAllCaches()
})

afterEach(() => {
  for (const key of ENV_TO_CLEAR) {
    if (key === 'CLAUDE_CONFIG_DIR') continue
    delete process.env[key]
  }
})

describe('2.1.108 prompt-cache TTL env vars (regression)', () => {
  test('FORCE_PROMPT_CACHING_5M forces 5m TTL (returns false)', () => {
    process.env.FORCE_PROMPT_CACHING_5M = '1'
    expect(should1hCacheTTL('repl_main_thread' as never)).toBe(false)
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'force_5m_env',
    })
  })

  test('FORCE_PROMPT_CACHING_5M wins over ENABLE_PROMPT_CACHING_1H', () => {
    process.env.FORCE_PROMPT_CACHING_5M = '1'
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(should1hCacheTTL('repl_main_thread' as never)).toBe(false)
  })

  test('ENABLE_PROMPT_CACHING_1H opts into 1h TTL (returns true)', () => {
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(should1hCacheTTL('repl_main_thread' as never)).toBe(true)
    expect(resolvePromptCacheTtl('repl_main_thread' as never).reason).toBe(
      'enable_1h_env',
    )
  })

  test('ENABLE_PROMPT_CACHING_1H_BEDROCK honored on bedrock only', () => {
    process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK = '1'
    // firstParty provider: not honored
    expect(should1hCacheTTL('repl_main_thread' as never)).toBe(false)
    // bedrock provider: honored
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(should1hCacheTTL('repl_main_thread' as never)).toBe(true)
  })
})

describe('2.1.243 main-thread query source patterns (official kzt/NMs)', () => {
  test('matches the four baked patterns', () => {
    expect(isMainThreadQuerySource('repl_main_thread' as never)).toBe(true)
    expect(isMainThreadQuerySource('repl_main_thread:abc' as never)).toBe(true)
    expect(isMainThreadQuerySource('sdk' as never)).toBe(true)
    expect(isMainThreadQuerySource('auto_mode' as never)).toBe(true)
    expect(isMainThreadQuerySource('memdir_relevance' as never)).toBe(true)
  })

  test('rejects non-main-thread sources', () => {
    expect(isMainThreadQuerySource('agent:general-purpose' as never)).toBe(
      false,
    )
    expect(isMainThreadQuerySource('compact' as never)).toBe(false)
    expect(isMainThreadQuerySource(undefined)).toBe(false)
  })
})

describe('2.1.243 per-thread env vars (official uFr env layer)', () => {
  test('CLAUDE_CODE_PROMPT_CACHE_TTL=1h applies to main-thread sources', () => {
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h'
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '1h',
      reason: 'env',
    })
    // subagent sources read the OTHER env var, which is unset → falls
    // through to the subscriber gate (non-subscriber here → 5m default)
    expect(resolvePromptCacheTtl('agent:x' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL applies to non-main sources', () => {
    process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = '1h'
    expect(resolvePromptCacheTtl('agent:x' as never)).toEqual({
      ttl: '1h',
      reason: 'env',
    })
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('invalid env values fall through (official .catch(undefined))', () => {
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '2h'
    expect(resolvePromptCacheTtlOverride('repl_main_thread' as never)).toBeUndefined()
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1H'
    expect(resolvePromptCacheTtlOverride('repl_main_thread' as never)).toBeUndefined()
  })

  test('env var takes precedence over the settings key', () => {
    writeSettings({ promptCacheTtl: '5m' })
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '1h'
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '1h',
      reason: 'env',
    })
  })
})

describe('2.1.243 settings keys (official uFr setting layer)', () => {
  test('promptCacheTtl applies to main-thread sources', () => {
    writeSettings({ promptCacheTtl: '1h' })
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '1h',
      reason: 'setting',
    })
    expect(resolvePromptCacheTtl('sdk' as never)).toEqual({
      ttl: '1h',
      reason: 'setting',
    })
    // non-main-thread source reads subagentPromptCacheTtl instead (unset)
    expect(resolvePromptCacheTtl('agent:x' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('subagentPromptCacheTtl applies to non-main sources', () => {
    writeSettings({ subagentPromptCacheTtl: '1h' })
    expect(resolvePromptCacheTtl('agent:x' as never)).toEqual({
      ttl: '1h',
      reason: 'setting',
    })
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('invalid settings values are dropped by the schema (.catch(undefined))', () => {
    writeSettings({ promptCacheTtl: '2h' })
    // Zod .enum(["5m","1h"]).catch(undefined) coerces the invalid value to
    // undefined at parse time, so no override is produced.
    expect(
      resolvePromptCacheTtlOverride('repl_main_thread' as never),
    ).toBeUndefined()
  })
})

describe('2.1.243 subscriber gate (official HUr)', () => {
  test('non-subscriber gets 5m default even for allowlisted sources', () => {
    expect(isClaudeAISubscriber()).toBe(false)
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('subscriber over usage limits gets 5m default (live read)', () => {
    setSubscriber(true)
    clearAllCaches()
    expect(isClaudeAISubscriber()).toBe(true)
    emitStatusChange({
      status: 'allowed',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: true,
    } as never)
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
  })

  test('subscriber within limits gets 1h for baked-default allowlist sources', () => {
    setSubscriber(true)
    clearAllCaches()
    expect(isClaudeAISubscriber()).toBe(true)
    // OCC's GrowthBook is stubbed → getFeatureValue_CACHED_MAY_BE_STALE
    // returns the baked default {allowlist:[...kzt]}, matching the official.
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '1h',
      reason: 'subscriber',
    })
    expect(resolvePromptCacheTtl('sdk' as never).ttl).toBe('1h')
    expect(resolvePromptCacheTtl('auto_mode' as never).ttl).toBe('1h')
    expect(resolvePromptCacheTtl('memdir_relevance' as never).ttl).toBe('1h')
    // not in the default allowlist
    expect(resolvePromptCacheTtl('agent:x' as never)).toEqual({
      ttl: '5m',
      reason: 'default',
    })
    expect(resolvePromptCacheTtl('compact' as never).ttl).toBe('5m')
  })

  test('latched allowlist wins over a later GrowthBook change', () => {
    setSubscriber(true)
    clearAllCaches()
    setPromptCache1hAllowlist(['*'])
    expect(resolvePromptCacheTtl('anything' as never)).toEqual({
      ttl: '1h',
      reason: 'subscriber',
    })
    setPromptCache1hAllowlist([])
    expect(resolvePromptCacheTtl('repl_main_thread' as never).ttl).toBe('5m')
  })

  test('explicit env override beats the subscriber gate', () => {
    setSubscriber(true)
    clearAllCaches()
    process.env.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m'
    expect(resolvePromptCacheTtl('repl_main_thread' as never)).toEqual({
      ttl: '5m',
      reason: 'env',
    })
  })
})

describe('2.1.248 agent frontmatter cacheTtl (Gap-108b, official qTt/Tvt)', () => {
  test('agentCacheTtlOverride resolves with reason agent_frontmatter', () => {
    expect(
      resolvePromptCacheTtlOverride('agent:x' as never, '5m'),
    ).toEqual({ ttl: '5m', reason: 'agent_frontmatter' })
    expect(
      resolvePromptCacheTtlOverride('agent:x' as never, '1h'),
    ).toEqual({ ttl: '1h', reason: 'agent_frontmatter' })
  })

  test('requested "1h" is dropped while the subscription is in overage', () => {
    // Official qTt: `if(t!==void 0&&!(t==="1h"&&r))` — with overage (r) the
    // 1h request falls through to the remaining gates.
    expect(
      resolvePromptCacheTtlOverride('agent:x' as never, '1h', true),
    ).toBeUndefined()
    // ...and the fall-through reaches the 1h opt-in env when set.
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(
      resolvePromptCacheTtlOverride('agent:x' as never, '1h', true),
    ).toEqual({ ttl: '1h', reason: 'enable_1h_env' })
    // "5m" is unaffected by the overage guard.
    expect(
      resolvePromptCacheTtlOverride('agent:x' as never, '5m', true),
    ).toEqual({ ttl: '5m', reason: 'agent_frontmatter' })
  })

  test('frontmatter "1h" applies even without a subscription', () => {
    // Official Tvt returns the qTt override BEFORE the subscriber gate, so
    // an agent frontmatter 1h wins on a plain API key too.
    expect(isClaudeAISubscriber()).toBe(false)
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '1h',
      }),
    ).toEqual({ ttl: '1h', reason: 'agent_frontmatter' })
    expect(should1hCacheTTL('agent:x' as never, '1h')).toBe(true)
  })

  test('frontmatter "5m" beats the subscriber allowlist 1h', () => {
    setSubscriber(true)
    clearAllCaches()
    expect(
      resolvePromptCacheTtl('repl_main_thread' as never, {
        agentCacheTtlOverride: '5m',
      }),
    ).toEqual({ ttl: '5m', reason: 'agent_frontmatter' })
    expect(should1hCacheTTL('repl_main_thread' as never, '5m')).toBe(false)
  })

  test('subscriber in overage: "1h" ignored, gate falls back to 5m default', () => {
    setSubscriber(true)
    clearAllCaches()
    emitStatusChange({
      status: 'allowed',
      unifiedRateLimitFallbackAvailable: false,
      isUsingOverage: true,
    } as never)
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '1h',
      }),
    ).toEqual({ ttl: '5m', reason: 'default' })
    // Same overage, but "5m" still resolves via the frontmatter branch.
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '5m',
      }),
    ).toEqual({ ttl: '5m', reason: 'agent_frontmatter' })
  })

  test('ladder order: FORCE_5M > env > setting > frontmatter', () => {
    // setting beats frontmatter (frontmatter sits AFTER the settings key)
    writeSettings({ subagentPromptCacheTtl: '5m' })
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '1h',
      }),
    ).toEqual({ ttl: '5m', reason: 'setting' })
    // env beats setting + frontmatter (subagent thread env var)
    process.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = '1h'
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '5m',
      }),
    ).toEqual({ ttl: '1h', reason: 'env' })
    // FORCE_5M beats everything
    process.env.FORCE_PROMPT_CACHING_5M = '1'
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: '1h',
      }),
    ).toEqual({ ttl: '5m', reason: 'force_5m_env' })
  })

  test('undefined override leaves resolution unchanged', () => {
    expect(
      resolvePromptCacheTtl('agent:x' as never, {
        agentCacheTtlOverride: undefined,
      }),
    ).toEqual({ ttl: '5m', reason: 'default' })
    expect(should1hCacheTTL('agent:x' as never, undefined)).toBe(false)
  })

  test('wire shape: frontmatter 1h reaches cache_control, 5m stays implicit', () => {
    expect(
      getCacheControl({
        querySource: 'agent:x' as never,
        agentCacheTtlOverride: '1h',
      }),
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(
      getCacheControl({
        querySource: 'agent:x' as never,
        agentCacheTtlOverride: '5m',
      }),
    ).toEqual({ type: 'ephemeral' })
  })
})

describe('wire shape (official: only "1h" reaches cache_control)', () => {
  test('no ttl key when resolved ttl is 5m', () => {
    const control = getCacheControl({
      querySource: 'repl_main_thread' as never,
    })
    expect(control).toEqual({ type: 'ephemeral' })
    expect('ttl' in control).toBe(false)
  })

  test('ttl "1h" present when enabled via env opt-in', () => {
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(
      getCacheControl({ querySource: 'repl_main_thread' as never }),
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('global scope propagates alongside ttl', () => {
    process.env.ENABLE_PROMPT_CACHING_1H = '1'
    expect(
      getCacheControl({
        scope: 'global' as never,
        querySource: 'repl_main_thread' as never,
      }),
    ).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
  })
})
