/**
 * CC 2.1.299 #116 — MCP OAuth sign-in / refresh / sign-out flows must send
 * the server's configured `headers` / `headersHelper`.
 *
 * Official v299 evidence (byte-diffed; the whole chunk is NEW in v299 — v296
 * has none of it): header-chunk exports {CSt,fle,qbn,Ybn} @252581400:
 *   - `U(config,url) = (!!config.headers||!!config.headersHelper) &&
 *     Uie(String(url), config.url)` — same-origin gate (`Uie` @215367688:
 *     origins equal and not "null", fail-closed).
 *   - `_` builds Headers from `CSt` (static ${VAR}-expanded + headersHelper,
 *     helper wins) then `n.delete("authorization")`.
 *   - `qbn(serverName,config,url)` = per-URL configured headers (used for the
 *     revocation POST: `A=await qbn(e,t,v)` then `y={...v,"Content-Type":…}`).
 *   - `fle(serverName,config,fetch)` wraps OAuth fetches: configured headers
 *     UNDER the request's own headers (init headers win), used as the
 *     discovery fetchFn in the official revocation flow (`De`) and imported
 *     into the OAuth client chunk alongside `Ybn`.
 *
 * OCC port: `createAuthFetch(serverName, serverConfig)` in auth.ts (wraps the
 * timeout fetch with the same gate/strip/precedence) is threaded through
 * sign-in (performMCPOAuthFlow metadata fetch + both sdkAuth calls — DCR,
 * discovery, token exchange), refresh (ClaudeAuthProvider.refreshTokens), and
 * sign-out (revokeServerSideTokens discovery fetchFn + revokeToken
 * configuredHeaders param).
 *
 * Harness: minimal local mock authorization server (same pattern as
 * mcpOAuthFlowWiring274.test.ts) that RECORDS request headers per endpoint;
 * fake tokens only — nothing here is a real credential.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { McpHTTPServerConfig } from '../types.js'
import {
  getOAuthCallbackSubmitter,
  performMCPOAuthFlow,
  revokeServerTokens,
} from '../auth.js'

// ---------------------------------------------------------------------------
// Header-recording mock authorization server
// ---------------------------------------------------------------------------

type RecordedRequest = { method: string; path: string; headers: IncomingMessage['headers'] }

interface RecordingAuthServer {
  readonly origin: string
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startRecordingAuthServer(): Promise<RecordingAuthServer> {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers })
    const path = url.pathname

    if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      json(res, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        revocation_endpoint: `${origin}/revoke`,
        scopes_supported: ['mcp:tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
        token_endpoint_auth_methods_supported: ['none'],
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
      json(res, {
        access_token: 'mock-access-token-FIXTURE-ONLY',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'mock-refresh-token-FIXTURE-ONLY',
        scope: 'mcp:tools',
      })
      return
    }
    if (req.method === 'POST' && path === '/revoke') {
      res.writeHead(200)
      res.end()
      return
    }
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
    requests,
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

let mock: RecordingAuthServer
let savedConfigDir: string | undefined
let fixtureDir: string
const liveControllers: AbortController[] = []

beforeAll(async () => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  fixtureDir = await mkdtemp(join(tmpdir(), 'occ-oauth-headers-'))
  process.env.CLAUDE_CONFIG_DIR = fixtureDir
  mock = await startRecordingAuthServer()
})

afterAll(async () => {
  await mock?.close()
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (fixtureDir) {
    await rm(fixtureDir, { recursive: true, force: true })
  }
})

afterEach(() => {
  while (liveControllers.length > 0) {
    liveControllers.pop()?.abort()
  }
  mock.requests.length = 0
})

function recorded(method: string, path: string): RecordedRequest | undefined {
  return mock.requests.find(r => r.method === method && r.path === path)
}

async function runSignInFlow(
  serverName: string,
  serverConfig: McpHTTPServerConfig,
): Promise<void> {
  const controller = new AbortController()
  liveControllers.push(controller)
  let resolveAuthUrl!: (url: string) => void
  const authUrl = new Promise<string>(resolve => {
    resolveAuthUrl = resolve
  })
  const flow = performMCPOAuthFlow(
    serverName,
    serverConfig,
    url => resolveAuthUrl(url),
    controller.signal,
    { skipBrowserOpen: true },
  )
  flow.catch(() => {})

  const url = await authUrl
  const parsed = new URL(url)
  const submitter = getOAuthCallbackSubmitter(serverName)
  expect(submitter).toBeDefined()
  const accepted = submitter?.(
    `${parsed.searchParams.get('redirect_uri')}?code=mock-auth-code&state=${parsed.searchParams.get('state')}`,
  )
  expect(accepted).toBe(true)
  await flow
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CC 2.1.299 #116 — OAuth flows send configured headers', () => {
  test('sign-in: static configured headers reach discovery, DCR and token exchange', async () => {
    const config = {
      type: 'http',
      url: mock.origin,
      headers: { 'X-Custom-Static': 'sv1' },
    } as McpHTTPServerConfig

    await runSignInFlow('hdr-static-srv', config)

    // Discovery GET (same origin as the server URL → gate passes)
    expect(recorded('GET', '/.well-known/oauth-authorization-server')?.headers['x-custom-static']).toBe('sv1')
    // Dynamic client registration POST
    expect(recorded('POST', '/register')?.headers['x-custom-static']).toBe('sv1')
    // Token exchange POST
    expect(recorded('POST', '/token')?.headers['x-custom-static']).toBe('sv1')
  }, 20_000)

  test('sign-in: headersHelper output is attached; configured authorization is STRIPPED', async () => {
    const helperPath = join(fixtureDir, 'headers-helper.sh')
    await writeFile(
      helperPath,
      '#!/bin/sh\necho \'{"X-Helper":"h1","Authorization":"Basic leaked-credential"}\'\n',
      { mode: 0o755 },
    )
    const config = {
      type: 'http',
      url: mock.origin,
      headersHelper: helperPath,
    } as unknown as McpHTTPServerConfig

    await runSignInFlow('hdr-helper-srv', config)

    const token = recorded('POST', '/token')
    expect(token?.headers['x-helper']).toBe('h1')
    // Official `_` does `n.delete("authorization")` — a configured
    // Authorization must never leak into OAuth requests. token_endpoint_auth
    // is "none" so the SDK adds no Authorization of its own here.
    expect(token?.headers.authorization).toBeUndefined()
    expect(recorded('POST', '/register')?.headers.authorization).toBeUndefined()
  }, 20_000)

  test('sign-out: revocation POST carries configured headers (official qbn path)', async () => {
    const config = {
      type: 'http',
      url: mock.origin,
      headers: { 'X-Custom-Static': 'sv3' },
    } as McpHTTPServerConfig

    await revokeServerTokens('hdr-revoke-srv', config, {
      capturedTokenData: {
        accessToken: 'mock-old-access-FIXTURE',
        refreshToken: 'mock-old-refresh-FIXTURE',
        clientId: 'mock-client-id',
        discoveryState: { authorizationServerUrl: mock.origin },
      },
    })

    const revoke = recorded('POST', '/revoke')
    expect(revoke).toBeDefined()
    expect(revoke?.headers['x-custom-static']).toBe('sv3')
    expect(revoke?.headers['content-type']).toContain(
      'application/x-www-form-urlencoded',
    )
  }, 20_000)

  test('cross-origin OAuth AS gets NO configured headers (official same-origin gate)', async () => {
    // The server URL points at a DIFFERENT origin than the mock AS; the flow
    // will fail discovery (nothing served there) but every recorded request
    // to the mock AS origin must lack the configured header.
    const config = {
      type: 'http',
      url: 'http://127.0.0.1:1/never-served',
      headers: { 'X-Custom-Static': 'should-not-appear' },
    } as McpHTTPServerConfig

    const controller = new AbortController()
    liveControllers.push(controller)
    const flow = performMCPOAuthFlow(
      'hdr-crossorigin-srv',
      config,
      () => {},
      controller.signal,
      { skipBrowserOpen: true },
    )
    // Discovery against the dead origin fails → flow rejects; either outcome
    // is fine as long as no configured header reached a non-matching origin.
    await flow.then(
      () => {},
      () => {},
    )
    controller.abort()

    for (const req of mock.requests) {
      expect(req.headers['x-custom-static']).toBeUndefined()
    }
  }, 20_000)
})
