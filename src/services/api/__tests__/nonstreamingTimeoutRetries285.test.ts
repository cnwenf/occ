// The real query path computes a message fingerprint reading MACRO.VERSION
// (build-time constant polyfilled in cli.tsx). Mirror the repo-convention
// polyfill for test execution (streamIntegrity281 discipline) — it must run
// before claude.ts is required at the bottom of the header block.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * CC 2.1.285 (item-B2): CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES + the shared
 * retry budget for the non-streaming fallback.
 *
 * Changelog: "Fixed a failing API request being retried up to 21 times when
 * streaming kept failing … the non-streaming fallback now shares the request's
 * retry budget instead of getting a fresh set of retries."
 *
 * Official v285 retry-loop catch (evidence
 * /tmp/cc-diff-285/evidence/nonstreaming_retries.txt):
 *   `let Xn,vn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES;
 *    if(vn!==void 0&&r.nonStreamingTimeoutMs!==void 0&&Ft instanceof gI&&
 *       Date.now()-Et>=r.nonStreamingTimeoutMs*bIo&&!XW()){
 *      if(K>=vn)throw m("api_request","api_request_nonstreaming_timeout_exhausted"),
 *        new ic(Ft,h);
 *      K++,Xn=vn-K}`
 *
 * Mapping: gI ≡ APIConnectionTimeoutError (SDK "Request timed out."), Et ≡
 * per-attempt start time, bIo ≡ 0.9 elapsed ratio, XW() ≡ retry watchdog, K ≡
 * counter, ic ≡ CannotRetryError. The official `I0t` fallback dispatcher
 * (@204942557) passes BOTH `maxRetries:n.maxRetries` (shared budget) and
 * `nonStreamingTimeoutMs:S` into the loop options; v284's `uOt` passed neither.
 *
 * Without the cap, a fallback that keeps timing out re-sends up to maxRetries
 * times, each burning the full nonStreamingTimeoutMs — minutes of silent
 * retries. The cap stops after CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES.
 *
 * UPDATED BY CC 2.1.288 (#34): the trailing `&&!XW()` guard was REMOVED and the
 * cap gained a watchdog default — v288 @209253534:
 *   `let an,fn=a.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES??
 *       (dY()&&r.failedStreamOutlastedTimeout?Vjo:void 0);`
 * with `dY()` ≡ isRetryWatchdogEnabled (@209248012, v287 `C6()` @208132898) and
 * `Vjo=2` @209247927. So under the watchdog the cap now FIRES (env value
 * honored, else 2 when the failed stream outlasted the timeout) instead of
 * being suppressed — changelog: "Fixed unattended sessions
 * (CLAUDE_CODE_RETRY_WATCHDOG) retrying for hours after a very long response
 * stream failed; Claude Code now streams again, and gives up after three
 * timeouts." The watchdog assertions below are the v288 semantics; the
 * v288-specific matrix lives in retryTimeoutEngine288.test.ts.
 */

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

// Production-entry harness (bottom describe) drives the REAL
// executeNonStreamingRequest through withRetry with an HTTP-layer fetch mock.
// executeNonStreamingRequest never touches the VCR layer (that wraps
// queryModelWithStreaming), so no VCR mock is needed here.
const { executeNonStreamingRequest } = require('../claude.js') as typeof import(
  '../claude.js'
)
const { resetSettingsCache } = require('../../../utils/settings/settingsCache.js') as {
  resetSettingsCache: () => void
}
const { getClaudeConfigHomeDir } = require('../../../utils/envUtils.js') as {
  getClaudeConfigHomeDir: (() => string) & { cache?: Map<unknown, string> }
}
const { getGlobalClaudeFile } = require('../../../utils/env.js') as {
  getGlobalClaudeFile: (() => string) & { cache?: Map<unknown, string> }
}

const ENV_KEYS = [
  'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES',
  'CLAUDE_CODE_RETRY_WATCHDOG',
  'CLAUDE_CODE_MAX_RETRIES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  // Production-entry harness env isolation.
  'API_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'USER_TYPE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

/**
 * Drain the withRetry generator against an operation that always throws a
 * request timeout. `nonStreamingTimeoutMs` mirrors the official fallback
 * dispatcher's loop option; leaving it undefined models the streaming path
 * (where the cap must never fire).
 */
async function drainTimeoutRetries(
  opts: { maxRetries: number; nonStreamingTimeoutMs?: number },
  failWith: () => Error = () => new APIConnectionTimeoutError(),
): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation throws before use
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries: opts.maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
      nonStreamingTimeoutMs: opts.nonStreamingTimeoutMs,
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    return { attempts, threw: null }
  } catch (e) {
    return { attempts, threw: e }
  }
}

describe('CC 2.1.285 item-B2: CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES cap', () => {
  test(
    'cap=2 + nonStreamingTimeoutMs=0: stops re-sending a timing-out fallback on the 3rd attempt',
    async () => {
      // nonStreamingTimeoutMs=0 → elapsed gate `>= 0*0.9` always passes, so the
      // cap counts every timeout. K reaches 2 on the 3rd attempt → throws.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '2'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 10,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'cap=0: the very first qualifying timeout is fatal',
    async () => {
      // K=0 >= cap=0 on attempt 1 → immediate throw (no timeout retries).
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 10,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(1)
    },
    30000,
  )

  test(
    'env unset: cap disabled, timeout retries to the normal maxRetries budget',
    async () => {
      // No CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES → the cap block is skipped;
      // APIConnectionTimeoutError is retryable, so the loop exhausts
      // maxRetries+1 = 4 attempts and throws generic exhaustion.
      delete process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 3,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(4)
    },
    30000,
  )

  test(
    'cap set but nonStreamingTimeoutMs absent (streaming path): cap never fires',
    async () => {
      // The official gate requires r.nonStreamingTimeoutMs !== void 0; the
      // streaming path never sets it, so the cap is inert there.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        // nonStreamingTimeoutMs omitted
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'elapsed ratio gate: a fast failure (< 90% of timeout) does not count toward the cap',
    async () => {
      // cap=0 would throw on attempt 1 IF the attempt ran ~the full timeout.
      // Here nonStreamingTimeoutMs=100000 but the operation throws immediately
      // (elapsed ≈ 0 < 90000), so `Date.now()-Et >= timeout*0.9` is false and
      // the cap is skipped → the loop retries to maxRetries+1 = 2.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 100000,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(2)
    },
    30000,
  )

  test(
    'retry watchdog ON: the env cap now FIRES (v288 removed the !XW() guard)',
    async () => {
      // CC 2.1.288 (#34): v287's gate ended in `&&!XW()`, so with the watchdog
      // on the cap never fired and the loop burned its whole budget — the
      // "retrying for hours" bug. v288 @209253534 dropped the guard: cap=0 makes
      // the first qualifying timeout fatal even under the watchdog.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      process.env.CLAUDE_CODE_RETRY_WATCHDOG = '1'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 1,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(1)
    },
    30000,
  )

  test(
    'invalid env value (non-integer): cap disabled, normal budget applies',
    async () => {
      // parseEnvInt("abc") → undefined → cap disabled.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = 'abc'
      const { attempts, threw } = await drainTimeoutRetries({
        maxRetries: 2,
        nonStreamingTimeoutMs: 0,
      })
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )

  test(
    'cap does not affect non-timeout retryable errors (500 keeps full budget)',
    async () => {
      // The cap only matches APIConnectionTimeoutError; a 500 must still run
      // the full maxRetries+1 budget even when the env cap is 0.
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const { APIError } = await import('@anthropic-ai/sdk')
      const { attempts, threw } = await drainTimeoutRetries(
        { maxRetries: 2, nonStreamingTimeoutMs: 0 },
        () =>
          new APIError(
            500,
            { message: 'Internal server error' },
            'boom',
            undefined,
          ),
      )
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(3)
    },
    30000,
  )
})

// ---------------------------------------------------------------------------
// PRODUCTION ENTRY — the tests above drain withRetry with a DUMMY operation,
// so they pin the cap GATE logic but NOT the wiring that feeds it from the real
// non-streaming fallback: `nonStreamingTimeoutMs: fallbackTimeoutMs`
// (claude.ts:1216), `maxRetries: retryOptions.maxRetries` (:1209), and the
// getNonstreamingFallbackTimeoutMs() / MAX_TIMER_MS clamp (:1039-1044).
// Reviewer mutation-test-02 proved this gap: setting `nonStreamingTimeoutMs:
// undefined` at :1216 kept every dummy-drain test green while the kill-switch
// regressed attempts 1→4. This describe drives the REAL executeNonStreamingRequest
// through withRetry against an HTTP-layer fetch mock (streamIntegrity281
// discipline — NOT by replacing withRetry), asserting attempts/fetchCount/error.
// ---------------------------------------------------------------------------
const ENTRY_MODEL = 'claude-sonnet-4-6'

let entryFetchCount = 0
let savedEntryFetch: typeof globalThis.fetch
let entryTmpConfigDir: string
let entryPrevConfigDir: string | undefined

/** A fetch that NEVER resolves on its own; it rejects with an AbortError the
 *  instant the request signal aborts — exactly like a real stalled fetch. This
 *  lets the SDK's own per-request `timeout` option (fallbackTimeoutMs) own the
 *  abort, so a timeout produces a genuine APIConnectionTimeoutError after the
 *  real elapsed time (feeding the cap's `>= nonStreamingTimeoutMs*0.9` gate),
 *  while an EXTERNAL user abort produces an APIUserAbortError. */
function installStalledFetchMock(): void {
  entryFetchCount = 0
  globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal | null }) => {
    entryFetchCount++
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })
  }) as typeof fetch
}

/** Drive the REAL executeNonStreamingRequest to completion; capture the last
 *  attempt index handed to onAttempt and whatever it threw. */
async function runEntry(opts: {
  maxRetries: number
  signal: AbortSignal
}): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = executeNonStreamingRequest(
    { model: ENTRY_MODEL, source: 'repl_main_thread' },
    {
      model: ENTRY_MODEL,
      thinkingConfig: { type: 'disabled' },
      signal: opts.signal,
      maxRetries: opts.maxRetries,
      querySource: 'repl_main_thread',
    },
    () =>
      ({
        model: ENTRY_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: 'PING' }],
      }) as never,
    (attempt: number) => {
      attempts = attempt
    },
    () => {},
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    return { attempts, threw: null }
  } catch (e) {
    return { attempts, threw: e }
  }
}

describe('CC 2.1.285 item-B2 PRODUCTION ENTRY: executeNonStreamingRequest threads the cap + timeout', () => {
  beforeEach(() => {
    // The file-level beforeEach already cleared ENV_KEYS; set the auth/config
    // the real client-construction path needs.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = '1'

    entryTmpConfigDir = mkdtempSync(join(tmpdir(), 'occ-nonstream-entry-'))
    entryPrevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = entryTmpConfigDir
    getClaudeConfigHomeDir.cache?.clear?.()
    getGlobalClaudeFile.cache?.clear?.()
    resetSettingsCache()

    savedEntryFetch = globalThis.fetch
    installStalledFetchMock()
  })

  afterEach(() => {
    globalThis.fetch = savedEntryFetch
    if (entryPrevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = entryPrevConfigDir
    getClaudeConfigHomeDir.cache?.clear?.()
    getGlobalClaudeFile.cache?.clear?.()
    resetSettingsCache()
    rmSync(entryTmpConfigDir, { recursive: true, force: true })
  })

  test(
    'kill-switch: API_TIMEOUT_MS=50 + cap=0 → the real entry caps on attempt 1 (attempts===1, fetchCount===1, CannotRetryError)',
    async () => {
      // fallbackTimeoutMs = min(50, MAX_TIMER_MS) = 50. The stalled fetch is
      // aborted by the SDK's 50ms timer → APIConnectionTimeoutError after ~50ms
      // (>= 50*0.9=45ms elapsed gate). cap=0 → K(0)>=0 on attempt 1 → fatal.
      // This is the assertion that mutation-test-02 (nonStreamingTimeoutMs→
      // undefined) regresses from attempts 1→4: without the wired option the
      // cap gate never sees a timeout budget and the loop retries to maxRetries.
      process.env.API_TIMEOUT_MS = '50'
      process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = '0'
      const controller = new AbortController()

      const { attempts, threw } = await runEntry({
        maxRetries: 3,
        signal: controller.signal,
      })

      expect(threw).toBeInstanceOf(CannotRetryError)
      const cre = threw as InstanceType<typeof CannotRetryError>
      expect(cre.originalError).toBeInstanceOf(APIConnectionTimeoutError)
      expect(attempts).toBe(1)
      expect(entryFetchCount).toBe(1)
    },
    30000,
  )

  test(
    'control: cap env unset → the real entry burns the shared maxRetries budget (attempts===4, fetchCount===4)',
    async () => {
      // No CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES → cap disabled; the timed-out
      // fallback re-sends through the shared budget (maxRetries+1 = 4). Proves
      // the kill-switch above is the cap firing, not a broken harness.
      process.env.API_TIMEOUT_MS = '50'
      delete process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES
      const controller = new AbortController()

      const { attempts, threw } = await runEntry({
        maxRetries: 3,
        signal: controller.signal,
      })

      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(4)
      expect(entryFetchCount).toBe(4)
    },
    30000,
  )

  test(
    'MAX_TIMER_MS clamp: API_TIMEOUT_MS above 2^31-1 does NOT overflow the abort timer into an instant timeout',
    async () => {
      // getNonstreamingFallbackTimeoutMs() = min(2_200_000_000, 2_147_483_647)
      // = 2_147_483_647 (~24.8 days) — a timer that can NEVER fire inside the
      // test. Removing the clamp (mutation-test-02b: `return override`) would
      // overflow setTimeout's signed-32-bit delay to ~immediate, firing a
      // spurious APIConnectionTimeoutError and re-sending (attempts climbing to
      // 4). Here we abort externally at 250ms and assert the request was still
      // healthy/in-flight on attempt 1 (a clean user abort, not a timeout).
      process.env.API_TIMEOUT_MS = '2200000000' // > MAX_TIMER_MS
      delete process.env.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES
      const controller = new AbortController()
      const abortTimer = setTimeout(() => controller.abort(), 250)
      try {
        const { attempts, threw } = await runEntry({
          maxRetries: 3,
          signal: controller.signal,
        })

        expect(threw).toBeInstanceOf(CannotRetryError)
        const cre = threw as InstanceType<typeof CannotRetryError>
        // External abort → APIUserAbortError, NOT a timeout: the clamped timer
        // never fired. An unclamped overflow would have surfaced a timeout here.
        expect(cre.originalError).toBeInstanceOf(APIUserAbortError)
        expect(attempts).toBe(1)
        expect(entryFetchCount).toBe(1)
      } finally {
        clearTimeout(abortTimer)
      }
    },
    30000,
  )
})
