import { describe, expect, test } from 'bun:test'
import { getAuthHeaders } from '@anthropic-ai/bedrock-sdk/core/auth.mjs'

/**
 * SECURITY port — Claude Code 2.1.285 changelog bullet #92:
 *   "Changed Bedrock, Mantle and Claude Platform on AWS requests to a base URL
 *    with a non-default port to include the port in the SigV4-signed Host
 *    header."
 *
 * Byte evidence (official linux-x64 ELF, `strings` dump) — the SigV4 signer
 * bundled from `@anthropic-ai/bedrock-sdk` (`getAuthHeaders`, marker
 * `service:"bedrock"` + `new SignatureV4(...)`):
 * - gone284 (2.1.284 baseline) @23548950:
 *     ...delete n.connection,n.host=s.hostname;let a={};...new K.HttpRequest({method:...,protocol:s.protocol,path:s.pathname,query:a,headers:n,body:e.body});return(await o.sign(i)).headers
 *   → the signed Host header is built from `URL.hostname`, which NEVER carries a
 *     port. A request to a base URL on a non-default port (e.g. an internal
 *     gateway `:8443`) signs `host: <name>` while the wire request line targets
 *     `<name>:8443`, so the canonical Host header mismatches the delivered one
 *     → SigV4 SignatureDoesNotMatch (or, worse, a proxy that rewrites Host).
 * - new285 (2.1.285) @23453100:
 *     ...delete o.connection,o.host=s.host;let i=Object.fromEntries(...);...new K.HttpRequest({method:...,protocol:s.protocol,path:s.pathname,query:i,headers:o,body:e.body});return(await n.sign(a)).headers
 *   → `s.hostname` becomes `s.host`. `URL.host` is `hostname[:port]` and omits
 *     the default port automatically (443 for https, 80 for http), so only
 *     non-default-port base URLs change behavior. (The `query:` rewrite in the
 *     same hunk is a separate multi-value-param signing fix, NOT bullet #92.)
 *
 * OCC has NO SigV4 signer of its own — `src/services/api/client.ts` constructs
 * `new AnthropicBedrock(...)` and delegates all signing to the third-party SDK.
 * The counterpart line lives in the dependency
 * `@anthropic-ai/bedrock-sdk@0.26.4/core/auth.mjs:54` (ESM) and `core/auth.js:93`
 * (CJS), both reading `headers['host'] = url.hostname;`. It is fixed here via
 * OCC's sanctioned dependency-patch mechanism:
 *   patches/@anthropic-ai%2Fbedrock-sdk@0.26.4.patch  (url.hostname → url.host)
 * registered in package.json `patchedDependencies` + bun.lock.
 *
 * Scope note: in OCC only the **Bedrock** provider signs with SigV4. "Claude
 * Platform on AWS" (client.ts) uses the plain `Anthropic` SDK with an API key
 * (`ANTHROPIC_AWS_API_KEY`) — no SigV4 — and there is no Mantle request path in
 * client.ts/query.ts, so #92's Mantle/Claude-Platform-on-AWS clauses are NO-OP
 * here. The Bedrock clause is the live one and is what these pins cover.
 *
 * These pins are mutation-verifiable: reverting the patch (`url.host` back to
 * `url.hostname`) makes the two non-default-port cases fail (host loses `:port`)
 * while the default-port cases still pass, so the fix is independently pinned.
 * `getAuthHeaders` is fully offline/deterministic here — passing `awsAccessKey`
 * + `awsSecretKey` skips the credential-provider chain (no IMDS/network) and
 * SigV4 uses the pure-JS `@aws-crypto/sha256-js`.
 */

const FAKE_CREDS = {
  awsAccessKey: 'AKIAIOSFODNN7EXAMPLE',
  awsSecretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  awsSessionToken: undefined,
  regionName: 'us-east-1',
} as const

const HOST = 'bedrock-runtime.us-east-1.amazonaws.com'
const PATH = '/model/anthropic.claude-3-5-sonnet/invoke-model'

async function signHost(url: string): Promise<Record<string, string>> {
  return getAuthHeaders(
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    { ...FAKE_CREDS, url },
  )
}

function hostOf(headers: Record<string, string>): string {
  return headers['host'] ?? headers['Host'] ?? ''
}

describe('2.1.285 #92 — SigV4-signed Host header carries a non-default port', () => {
  test('non-default port (https :8443): host header is name:port', async () => {
    // Arrange
    const url = `https://${HOST}:8443${PATH}`

    // Act
    const host = hostOf(await signHost(url))

    // Assert — the whole point of #92: the port is INSIDE the signed Host.
    expect(host).toBe(`${HOST}:8443`)
  })

  test('non-default port (http :8080): host header is name:port', async () => {
    // Arrange
    const url = `http://localhost:8080${PATH}`

    // Act
    const host = hostOf(await signHost(url))

    // Assert
    expect(host).toBe('localhost:8080')
  })

  test('default https port (implicit): host header has NO port', async () => {
    // Arrange
    const url = `https://${HOST}${PATH}`

    // Act
    const host = hostOf(await signHost(url))

    // Assert — URL.host drops the default 443 for https, so this is unchanged
    // from the pre-#92 behavior (regression guard).
    expect(host).toBe(HOST)
    expect(host).not.toContain(':443')
  })

  test('explicit :443 on https normalizes away (URL.host drops the default)', async () => {
    // Arrange
    const url = `https://${HOST}:443${PATH}`

    // Act
    const host = hostOf(await signHost(url))

    // Assert
    expect(host).toBe(HOST)
  })

  test('the signed Authorization SignedHeaders list still covers host', async () => {
    // Arrange
    const url = `https://${HOST}:8443${PATH}`

    // Act
    const headers = await signHost(url)
    const authz = headers['authorization'] ?? headers['Authorization'] ?? ''

    // Assert — host must be a signed header, else the port fix is moot.
    expect(authz).toContain('SignedHeaders=')
    const signedHeaders = authz
      .slice(authz.indexOf('SignedHeaders=') + 'SignedHeaders='.length)
      .split(/[,/\s]/)[0]
      .toLowerCase()
    expect(signedHeaders.split(';')).toContain('host')
  })
})
