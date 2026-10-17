// CC 2.1.302 (#19): per-turn recording of `queryTracking.billedToUsageCredits`
// at BOTH response sites.
//
// Official producers (binary evidence, /tmp/cc-diff-302/v302/package/claude):
//   non-streaming @246082900-region (dd skip=246082900):
//     `let ft=ePo(Et,n.model,…);if(ft&&e.queryTracking)
//        e.queryTracking.billedToUsageCredits=ft.overageInUse===!0`
//   streaming @246195751 — same shape (plus pre-existing answeredQuerySource).
//   ePo @238522075 = `se.extractQuotaStatusFromHeaders(...)` — the producer is
//   the limits-store extraction itself, so recording piggybacks on OCC's
//   extractQuotaStatusFromHeaders return value.
//
// Seam discipline follows nonstreamingTimeoutRetries285.test.ts: drive the
// REAL executeNonStreamingRequest through withRetry against an HTTP-layer
// fetch mock (no VCR involvement on this path). The streaming-site recorder is
// the same shared helper (recordBilledToUsageCredits), unit-tested directly.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const actualRateLimitMocking = await import('../../rateLimitMocking.js')

// extractQuotaStatusFromHeaders gates on shouldProcessRateLimits(
// isClaudeAISubscriber()). Mock the gate TRUE (usage-credits billing only
// exists for claude.ai subscribers) rather than mocking isClaudeAISubscriber
// itself — client.ts builds `apiKey: isClaudeAISubscriber() ? null : …` and
// would demand an OAuth token that this harness does not have.
mock.module('../../rateLimitMocking.js', () => ({
  ...actualRateLimitMocking,
  shouldProcessRateLimits: () => true,
  processRateLimitHeaders: (headers: globalThis.Headers) => headers,
}))

const { executeNonStreamingRequest, recordBilledToUsageCredits } =
  require('../claude.js') as typeof import('../claude.js')
const { resetSettingsCache } = require('../../../utils/settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../../../utils/envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}
const { getGlobalClaudeFile } = require('../../../utils/env.js') as {
  getGlobalClaudeFile: (() => string) & { cache?: Map<unknown, string> }
}

afterAll(() => {
  mock.module('../../rateLimitMocking.js', () => ({
    ...actualRateLimitMocking,
  }))
  mock.restore()
})

const ENTRY_MODEL = 'claude-sonnet-4-6'

const ENV_KEYS = [
  'API_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_MAX_RETRIES',
]
const savedEnv: Record<string, string | undefined> = {}

let savedFetch: typeof globalThis.fetch
let tmpConfigDir: string
let prevConfigDir: string | undefined

/** A fetch that resolves every request with a minimal assistant message and
 *  the given extra response headers. */
function installSuccessFetchMock(extraHeaders: Record<string, string>): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        id: 'msg_usage_credits_302',
        type: 'message',
        role: 'assistant',
        model: ENTRY_MODEL,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          ...extraHeaders,
        },
      },
    )) as unknown as typeof fetch
}

async function runNonStreamingEntry(queryTracking: {
  chainId: string
  depth: number
  billedToUsageCredits?: boolean
}): Promise<void> {
  const gen = executeNonStreamingRequest(
    {
      model: ENTRY_MODEL,
      source: 'repl_main_thread',
      queryTracking,
    },
    {
      model: ENTRY_MODEL,
      thinkingConfig: { type: 'disabled' },
      signal: new AbortController().signal,
      querySource: 'repl_main_thread',
    },
    () =>
      ({
        model: ENTRY_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'PING' }],
      }) as never,
    () => {},
    () => {},
  )
  while (true) {
    const next = await gen.next()
    if (next.done) break
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
  process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-usage-credits-302-'))
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()

  savedFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  getClaudeConfigHomeDir.cache?.clear?.()
  getGlobalClaudeFile.cache?.clear?.()
  resetSettingsCache()
  rmSync(tmpConfigDir, { recursive: true, force: true })
})

describe('CC 2.1.302 (#19): non-streaming response site records billedToUsageCredits', () => {
  test(
    'overage-in-use: true header → queryTracking.billedToUsageCredits === true',
    async () => {
      installSuccessFetchMock({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      })
      const queryTracking = { chainId: 'chain-302', depth: 0 }
      await runNonStreamingEntry(queryTracking)
      expect(queryTracking.billedToUsageCredits).toBe(true)
    },
    30000,
  )

  test(
    'overage-in-use: false header → queryTracking.billedToUsageCredits === false (official `=ft.overageInUse===!0`)',
    async () => {
      installSuccessFetchMock({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'false',
      })
      const queryTracking = { chainId: 'chain-302', depth: 0 }
      await runNonStreamingEntry(queryTracking)
      expect(queryTracking.billedToUsageCredits).toBe(false)
    },
    30000,
  )

  test(
    'header absent → queryTracking.billedToUsageCredits === false, not undefined (flag is always boolean once extraction ran)',
    async () => {
      installSuccessFetchMock({
        'anthropic-ratelimit-unified-status': 'allowed',
      })
      const queryTracking = { chainId: 'chain-302', depth: 0 }
      await runNonStreamingEntry(queryTracking)
      expect(queryTracking.billedToUsageCredits).toBe(false)
    },
    30000,
  )
})

describe('CC 2.1.302 (#19): shared recorder (streaming-site seam)', () => {
  test('records true from an overage-in-use response', () => {
    const queryTracking = { chainId: 'chain-stream', depth: 2 }
    recordBilledToUsageCredits(
      new globalThis.Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      }),
      queryTracking,
    )
    expect(queryTracking.billedToUsageCredits).toBe(true)
  })

  test('no queryTracking → recorder is a no-op (official `if(ft&&e.queryTracking)`)', () => {
    expect(() =>
      recordBilledToUsageCredits(
        new globalThis.Headers({
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-overage-in-use': 'true',
        }),
        undefined,
      ),
    ).not.toThrow()
  })
})
