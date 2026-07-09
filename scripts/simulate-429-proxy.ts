#!/usr/bin/env bun
/**
 * Local 429-injection proxy — verifies OCC auto-retries after the
 * errorUtils.ts `APIError is not defined` fix.
 *
 * Before the fix: the first APIError in withRetry's loop called
 *   isImageUnprocessableError() → `error instanceof APIError` →
 *   ReferenceError: APIError is not defined (type-only import).
 *   So a 429 surfaced as "API Error: APIError is not defined" with NO retry.
 *
 * After the fix: a 429 is categorized as a transient capacity error and
 * retried up to DEFAULT_MAX_RETRIES (10). This proxy injects N 429s then
 * forwards to the real Anthropic API so the (N+1)th attempt succeeds.
 *
 * Usage:
 *   # terminal 1 — start the proxy (forwards to api.anthropic.com)
 *   bun run scripts/simulate-429-proxy.ts
 *   # or: PROXY_FAIL_COUNT=3 PROXY_PORT=8899 bun run scripts/simulate-429-proxy.ts
 *
 *   # terminal 2 — run OCC through the proxy
 *   ANTHROPIC_BASE_URL=http://localhost:8899 bun run src/entrypoints/cli.tsx -p "say hi"
 *
 * Expected: proxy logs N injected 429s, then a FORWARD with upstream 200;
 * OCC prints the model's reply (no "APIError is not defined").
 */
const PORT = parseInt(process.env.PROXY_PORT || '8899', 10)
const FAIL_COUNT = parseInt(process.env.PROXY_FAIL_COUNT || '3', 10)
const UPSTREAM = process.env.PROXY_UPSTREAM || 'https://api.anthropic.com'

let requestCount = 0
const startTime = Date.now()
const ts = () => `+${((Date.now() - startTime) / 1000).toFixed(2)}s`

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    requestCount++
    const n = requestCount
    const url = new URL(req.url)
    const isMessages =
      req.method === 'POST' && url.pathname.startsWith('/v1/messages')
    console.error(
      `[proxy ${ts()}] #${n} ${req.method} ${url.pathname}${url.search}`,
    )

    if (isMessages && n <= FAIL_COUNT) {
      console.error(
        `[proxy ${ts()}] #${n} <- INJECT 429 rate_limit_error  (${n}/${FAIL_COUNT})`,
      )
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `Simulated rate limit (proxy injection #${n})`,
          },
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      )
    }

    // Forward to the real API, streaming the response back unchanged.
    const upstreamUrl = UPSTREAM + url.pathname + url.search
    const headers = new Headers(req.headers)
    headers.delete('host')
    let upstream: Response
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.body ?? undefined,
        // @ts-expect-error duplex is needed for streaming request bodies
        duplex: 'half',
      })
    } catch (err) {
      console.error(
        `[proxy ${ts()}] #${n} X upstream forward failed: ${String(err)}`,
      )
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `proxy upstream error: ${String(err)}`,
          },
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
    console.error(
      `[proxy ${ts()}] #${n} -> FORWARD to upstream (status ${upstream.status})`,
    )
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  },
})

console.error(
  `[proxy] 429-simulator listening on http://localhost:${server.port}`,
)
console.error(
  `[proxy] Injecting 429 for first ${FAIL_COUNT} /v1/messages requests, then forwarding to ${UPSTREAM}`,
)
console.error(
  `[proxy] Test: ANTHROPIC_BASE_URL=http://localhost:${server.port} bun run src/entrypoints/cli.tsx -p "say hi"`,
)
