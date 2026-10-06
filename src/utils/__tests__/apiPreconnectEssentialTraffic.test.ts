import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// CC 2.1.291 (G#7): CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC must ALSO skip the
// startup API preconnect/warm-up. Official 291 (@218728135, function `P`)
// inserts `if(Rt())return;` after the gateway/provider check and before the
// proxy check, where `Rt(){return HCt()==="essential-traffic"}` — i.e. the
// privacy-level gate. The startup HEAD preconnect is a warm-up, not essential
// traffic, so it must be suppressed at the essential-traffic level.
//
// OCC maps `Rt` -> isEssentialTrafficOnly() (src/utils/privacyLevel.ts), which
// is true exactly when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set.
//
// apiPreconnect has a module-level `fired` once-latch, so each case imports a
// FRESH module instance via a distinct query string (standard ESM module-key
// semantics) to observe the fetch side-effect independently.

let fetchSpy: ReturnType<typeof mock>

const BASE = 'https://preconnect-test.example.invalid'

function clearRelevantEnv() {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.HTTPS_PROXY
  delete process.env.https_proxy
  delete process.env.HTTP_PROXY
  delete process.env.http_proxy
  delete process.env.ANTHROPIC_UNIX_SOCKET
  delete process.env.CLAUDE_CODE_CLIENT_CERT
  delete process.env.CLAUDE_CODE_CLIENT_KEY
}

beforeEach(() => {
  clearRelevantEnv()
  // Pin the base URL so the test does not depend on getOauthConfig() init.
  process.env.ANTHROPIC_BASE_URL = BASE
  fetchSpy = mock(() => Promise.resolve(new Response(null, { status: 200 })))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
})

afterEach(() => {
  clearRelevantEnv()
  delete process.env.ANTHROPIC_BASE_URL
  mock.restore()
})

describe('preconnectAnthropicApi essential-traffic gate (CC 2.1.291 G#7)', () => {
  test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 -> zero fetch (preconnect skipped)', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const mod = await import('../apiPreconnect.js?case=essential')
    mod.preconnectAnthropicApi()
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })

  test('unset -> exactly one HEAD preconnect to the base URL (existing behavior regression)', async () => {
    const mod = await import('../apiPreconnect.js?case=default')
    mod.preconnectAnthropicApi()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe(BASE)
    expect(init?.method).toBe('HEAD')
  })
})
