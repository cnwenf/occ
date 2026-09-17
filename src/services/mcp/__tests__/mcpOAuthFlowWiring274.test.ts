/**
 * CC 2.1.274 review P2-3 (docs/upstream-version-gap-occ128.md): the core
 * submitter-registry contract — unconditional registration, state-matched
 * redemption, identity-checked deregistration — exercised through the REAL
 * production wiring. The other 274 test files stub parts of this path
 * (hand-pulled hooks / mocked registry readers / mocked performMCPOAuthFlow);
 * this file runs the complete `performMCPOAuthFlow` against a minimal local
 * OAuth authorization-server fixture (fake tokens only — nothing here is a
 * real credential) so a mutation at the registration site (auth.ts) cannot
 * keep the suite green.
 *
 * Also covers:
 * - review P3-1: two-generation same-server flows — the superseded flow is
 *   cancelled fast (AuthenticationCancelledError, not the 5-minute timeout)
 *   and its identity-checked cleanup does NOT drop the new flow's submitter.
 * - review P3-2: a synchronous throw from `onWaitingForCallback` must not
 *   leak the module-level registrations.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type ServerResponse } from 'http'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { McpHTTPServerConfig } from '../types.js'
import {
  AuthenticationCancelledError,
  getOAuthCallbackSubmitter,
  getOAuthFlowEpoch,
  performMCPOAuthFlow,
} from '../auth.js'

// ---------------------------------------------------------------------------
// Minimal local OAuth authorization server (mock AS). Serves just enough of
// RFC 8414 discovery + RFC 7591 dynamic registration + RFC 6749 token
// exchange for the MCP SDK's auth() to reach REDIRECT and then AUTHORIZED.
// ---------------------------------------------------------------------------

interface MockAuthServer {
  readonly origin: string
  readonly tokenRequests: number
  close(): Promise<void>
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startMockAuthServer(): Promise<MockAuthServer> {
  let tokenRequests = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        scopes_supported: ['mcp:tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (req.method === 'POST' && path === '/register') {
      json(res, {
        client_id: 'mock-client-id',
        redirect_uris: ['http://localhost/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      })
      return
    }
    if (req.method === 'POST' && path === '/token') {
      tokenRequests += 1
      json(res, {
        access_token: 'mock-access-token-FIXTURE-ONLY',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token-FIXTURE-ONLY',
        scope: 'mcp:tools',
      })
      return
    }
    // Everything else (protected-resource metadata, OIDC discovery, the
    // authorization endpoint itself) is intentionally not served.
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('mock auth server failed to bind')
  }
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    get tokenRequests() {
      return tokenRequests
    },
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const serverConfigFor = (origin: string): McpHTTPServerConfig =>
  ({ type: 'http', url: origin }) as McpHTTPServerConfig

interface StartedFlow {
  readonly flow: Promise<void>
  readonly authUrl: Promise<string>
  readonly controller: AbortController
}

const liveControllers: AbortController[] = []

function startFlow(
  serverName: string,
  origin: string,
  options?: {
    onWaitingForCallback?: (submit: (callbackUrl: string) => boolean) => void
  },
): StartedFlow {
  const controller = new AbortController()
  liveControllers.push(controller)
  let resolveAuthUrl!: (url: string) => void
  const authUrl = new Promise<string>(resolve => {
    resolveAuthUrl = resolve
  })
  const flow = performMCPOAuthFlow(
    serverName,
    serverConfigFor(origin),
    url => resolveAuthUrl(url),
    controller.signal,
    { skipBrowserOpen: true, ...options },
  )
  // Attach a noop handler up-front: several tests intentionally reject the
  // flow (supersede-cancel, sync-throw) and bun reports unhandled
  // rejections even when the test later asserts on them.
  flow.catch(() => {})
  return { flow, authUrl, controller }
}

let mock: MockAuthServer
let savedConfigDir: string | undefined
let fixtureConfigDir: string

beforeAll(async () => {
  // Isolate plaintext credential storage (.credentials.json) per test run —
  // the flow really saves tokens through getSecureStorage().
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  fixtureConfigDir = await mkdtemp(join(tmpdir(), 'occ-oauth-wiring-'))
  process.env.CLAUDE_CONFIG_DIR = fixtureConfigDir
  mock = await startMockAuthServer()
})

afterAll(async () => {
  await mock?.close()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (fixtureConfigDir) {
    await rm(fixtureConfigDir, { recursive: true, force: true })
  }
})

afterEach(() => {
  // Abort any flow still waiting so no test leaks a pending 5-minute timer
  // or a registry entry into the next test.
  while (liveControllers.length > 0) {
    liveControllers.pop()?.abort()
  }
})

// ---------------------------------------------------------------------------
// P2-3: the real-wiring contract
// ---------------------------------------------------------------------------

describe('2.1.274 performMCPOAuthFlow real-wiring submitter contract', () => {
  test('registers the submitter unconditionally — no onWaitingForCallback consumer', async () => {
    // Arrange: tool-path-style flow — the caller only captures the auth URL.
    const started = startFlow('wiring-srv', mock.origin)

    // Act: wait until the SDK auth reached redirectToAuthorization.
    const authUrl = await started.authUrl

    // Assert: the registry entry exists even though NO onWaitingForCallback
    // was passed (mutation gate: gating the registration on the callback
    // option makes this undefined and the test fail).
    const submitter = getOAuthCallbackSubmitter('wiring-srv')
    expect(submitter).toBeDefined()
    expect(getOAuthFlowEpoch('wiring-srv')).toBeNumber()

    started.controller.abort()
    await expect(started.flow).rejects.toBeInstanceOf(
      AuthenticationCancelledError,
    )
    expect(authUrl).toContain('state=')
  }, 20_000)

  test('redeems a state-matched callback URL through the real token exchange', async () => {
    // Arrange
    const started = startFlow('redeem-srv', mock.origin)
    const authUrl = await started.authUrl
    const parsed = new URL(authUrl)
    const state = parsed.searchParams.get('state')
    const redirectUri = parsed.searchParams.get('redirect_uri')
    expect(state).toBeTruthy()
    expect(redirectUri).toBeTruthy()
    const submitter = getOAuthCallbackSubmitter('redeem-srv')
    expect(submitter).toBeDefined()
    const tokensBefore = mock.tokenRequests

    // Act: wrong-state paste first — rejected, flow keeps waiting.
    const wrongStateAccepted = submitter?.(
      `${redirectUri}?code=bogus-code&state=definitely-not-the-flow-state`,
    )

    // Assert: not consumed, submitter still registered.
    expect(wrongStateAccepted).toBe(false)
    expect(getOAuthCallbackSubmitter('redeem-srv')).toBeDefined()

    // Act: matching-state paste — consumed, real exchange against the mock AS.
    const accepted = submitter?.(
      `${redirectUri}?code=mock-auth-code&state=${state}`,
    )
    await started.flow

    // Assert
    expect(accepted).toBe(true)
    expect(mock.tokenRequests).toBe(tokensBefore + 1)
    // Identity-checked deregistration after settle.
    expect(getOAuthCallbackSubmitter('redeem-srv')).toBeUndefined()
    expect(getOAuthFlowEpoch('redeem-srv')).toBeUndefined()
  }, 20_000)

  test('two-generation flows: superseded flow cancels fast and its cleanup keeps the new submitter', async () => {
    // Arrange: generation A registered and waiting.
    const genA = startFlow('gen-srv', mock.origin)
    await genA.authUrl
    const submitterA = getOAuthCallbackSubmitter('gen-srv')
    const epochA = getOAuthFlowEpoch('gen-srv')
    expect(submitterA).toBeDefined()
    expect(epochA).toBeNumber()

    // Act: generation B starts for the SAME server while A is waiting.
    const genB = startFlow('gen-srv', mock.origin)
    const authUrlB = await genB.authUrl

    // Assert P3-1: A is cancelled immediately with a distinct error — it no
    // longer lingers unidentified until the 5-minute timeout.
    await expect(genA.flow).rejects.toBeInstanceOf(AuthenticationCancelledError)

    // Assert P2-3: A's identity-checked cleanup did NOT drop B's submitter —
    // the pre-fix single-slot shadowing regression is gone.
    const submitterB = getOAuthCallbackSubmitter('gen-srv')
    expect(submitterB).toBeDefined()
    expect(submitterB).not.toBe(submitterA)
    expect(getOAuthFlowEpoch('gen-srv')).toBeGreaterThan(epochA ?? 0)

    // B's channel still works end-to-end with B's own state.
    const parsedB = new URL(authUrlB)
    const accepted = submitterB?.(
      `${parsedB.searchParams.get('redirect_uri')}?code=mock-auth-code&state=${parsedB.searchParams.get('state')}`,
    )
    await genB.flow
    expect(accepted).toBe(true)
    expect(getOAuthCallbackSubmitter('gen-srv')).toBeUndefined()
    expect(getOAuthFlowEpoch('gen-srv')).toBeUndefined()
  }, 20_000)

  test('synchronous throw from onWaitingForCallback does not leak registry entries', async () => {
    // Arrange: host callback explodes synchronously — pre-fix, registration
    // happened before the executor's terminal handlers were wired, so the
    // module-level entry survived until process exit.
    const started = startFlow('leak-srv', mock.origin, {
      onWaitingForCallback: () => {
        throw new Error('host callback exploded (fixture)')
      },
    })

    // Act + Assert: the flow rejects with the callback's error...
    await expect(started.flow).rejects.toThrow('host callback exploded')

    // ...and BOTH module-level registries are clean (mutation gate: removing
    // the try/catch deregistration around onWaitingForCallback makes these
    // defined and the test fail).
    expect(getOAuthCallbackSubmitter('leak-srv')).toBeUndefined()
    expect(getOAuthFlowEpoch('leak-srv')).toBeUndefined()
  }, 20_000)
})
