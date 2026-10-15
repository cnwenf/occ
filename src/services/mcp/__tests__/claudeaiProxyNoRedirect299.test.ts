/**
 * CC 2.1.299 #152 (SECURITY) — no HTTP redirect following for
 * Anthropic-hosted MCP surfaces ONLY.
 *
 * Official changelog (2.1.299):
 *   "Changed requests to claude.ai's connector proxy and to Anthropic-hosted
 *    MCP servers to no longer follow HTTP redirects; redirects by a
 *    connector's own server are unaffected."
 *   "Changed MCP requests in cloud and self-hosted runner sessions to no
 *    longer follow HTTP redirects from the session's MCP proxy."
 *
 * Binary forensics (v299 vs v296): NEW chunk exports {fle,qbn,Ybn}
 * (@~252581900). `fle` = header-applying fetch wrapper that forces
 * `redirect:"manual"` and manually follows ≤5 same-rule hops; `Ybn(origin)`
 * returns `(response) => { if (originMismatch) throw Error("Refused a
 * redirect to another origin") }` (string: 2 hits v299, 0 in v296) and is
 * used as the axios `beforeRedirect` hook in OAuth token revocation
 * (@252822912: `{beforeRedirect:Ybn(t)}`). The claudeai-proxy transport
 * fetch is wrapped (`nn(ft(globalThis.fetch),h)`) and its requestInit does
 * NOT gain a redirect key — the refusal lives in the fetch wrapper.
 *
 * OCC implementation (spec-approved equivalent): the MCP SDK's
 * StreamableHTTPClientTransport spreads `requestInit` into every fetch
 * (streamableHttp.js createFetchWithInit + call sites :300/:438), so
 * `redirect: 'manual'` in the claudeai-proxy transportOptions.requestInit
 * achieves the same no-follow guarantee; `maxRedirects: 0` on the claudeai.ts
 * axios.get is the axios equivalent of the official `Ybn` refuser. Plain
 * user http/sse servers MUST keep following redirects (official parity:
 * "redirects by a connector's own server are unaffected") — pinned below.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// --- behavioral test of claudeai.ts axios config ---------------------------

const actualAxios = await import('axios')
const actualAuth = await import('src/utils/auth.js')
const actualOauth = await import('src/constants/oauth.js')

let capturedGet: { url: string; config: Record<string, unknown> } | null = null

const axiosDefault = actualAxios.default as unknown as Record<string, unknown>

mock.module('axios', () => ({
  ...actualAxios,
  default: {
    ...axiosDefault,
    get: async (url: string, config: Record<string, unknown>) => {
      capturedGet = { url, config }
      return { data: { data: [], has_more: false, next_page: null } }
    },
  },
}))

mock.module('src/utils/auth.js', () => ({
  ...actualAuth,
  getClaudeAIOAuthTokens: () => ({
    accessToken: 'fixture-token-NOT-REAL',
    scopes: ['user:mcp_servers'],
  }),
}))

mock.module('src/constants/oauth.js', () => ({
  ...actualOauth,
  getOauthConfig: () => ({
    BASE_API_URL: 'https://api.fixture.example',
    MCP_PROXY_URL: 'https://proxy.fixture.example',
    MCP_PROXY_PATH: '/mcp/{server_id}',
  }),
}))

// Cache-buster: fresh module evaluation AFTER the mocks are installed (bun's
// mock.module registry is process-global; a sibling file may have evaluated
// these modules first).
const { fetchClaudeAIMcpConfigsIfEligible } = await import(
  '../claudeai.js?noredirect=1'
)

afterAll(() => {
  mock.module('axios', () => actualAxios)
  mock.module('src/utils/auth.js', () => actualAuth)
  mock.module('src/constants/oauth.js', () => actualOauth)
})

describe('CC 2.1.299 #152 — claudeai.ts server-list fetch never follows redirects', () => {
  test('axios.get carries maxRedirects: 0 with the Bearer token request', async () => {
    delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS
    capturedGet = null

    const configs = await fetchClaudeAIMcpConfigsIfEligible()

    expect(capturedGet).not.toBeNull()
    expect(capturedGet?.url).toBe(
      'https://api.fixture.example/v1/mcp_servers?limit=1000',
    )
    // The security invariant: the Bearer-token request must not ride a
    // redirect to an attacker-influenced Location.
    expect(capturedGet?.config.maxRedirects).toBe(0)
    expect(capturedGet?.config.headers).toMatchObject({
      Authorization: 'Bearer fixture-token-NOT-REAL',
    })
    expect(configs).toEqual({})
  })
})

// --- wiring tests (scoped source assertions, redialOwnPropLookup299 precedent)
// connectToServer mutates global MCP client state and needs the full Client +
// auth stack; the transport-option wiring is pinned structurally instead.

function branchWindow(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('CC 2.1.299 #152 — client.ts redirect wiring is scoped to claudeai-proxy', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'client.ts'), 'utf8')

  test("claudeai-proxy transportOptions.requestInit sets redirect: 'manual'", () => {
    const proxyBranch = branchWindow(
      source,
      "} else if (serverRef.type === 'claudeai-proxy') {",
      'logMCPDebug(name, `claude.ai proxy transport created successfully`)',
    )
    expect(proxyBranch).toContain("redirect: 'manual'")
    expect(proxyBranch).toContain('X-Mcp-Client-Session-Id')
  })

  test('user http/sse transport requestInit does NOT set redirect (keeps following)', () => {
    // The user-server http branch ends at its own success log; its
    // transportOptions must remain redirect-free so a connector's own server
    // keeps following redirects (official: "redirects by a connector's own
    // server are unaffected").
    const httpBranch = branchWindow(
      source,
      'const transportOptions: StreamableHTTPClientTransportOptions = {',
      'logMCPDebug(name, `HTTP transport created successfully`)',
    )
    expect(httpBranch).not.toContain('redirect:')
  })

  test("redirect: 'manual' appears exactly once in client.ts (proxy branch only)", () => {
    const occurrences = source.split("redirect: 'manual'").length - 1
    expect(occurrences).toBe(1)
  })
})
