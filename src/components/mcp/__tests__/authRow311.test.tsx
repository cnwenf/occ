/**
 * WP-M (2.1.311 triage items 41 + 42) — pure-deriver unit tests.
 *
 * Byte-level forensics on the official 2.1.311 linux-x64 ELF
 * (/tmp/cc-diff-311/v311/package/claude):
 *
 * - Three-state auth row @283701600 (`_n`/`Mn` branches):
 *     _n ? <success/>+"authenticated"
 *        : Mn ? <dimColor/>+"not signed in"
 *             : <error/>+"not authenticated"
 * - Derivations @283699050:
 *     Mn = Li(i.client) && h>0          // Li = connectable-no-cred
 *     _n = gn || (Mn && config.type!=="claudeai-proxy" && (mee(config)||cn||…))
 * - Helpers @242617486+:
 *     function Li(e){return e.type==="connected"||e.type==="cached"}
 *     function lEn(e){return Object.keys(e).some(n=>n.toLowerCase()==="authorization")}
 *     function G0(e){return lEn(e.headers??{})}
 *     function mee(e){if(nW()&&e.oauth?.xaa)return!0;
 *                     if(e.headersHelper||e.headers&&Object.keys(e.headers).length>0)return!0;
 *                     if(oF(e.url)&&Un())return!0; return!1}
 * - v310 → v311 literal deltas (grep -aboF counts):
 *     "was not cleared: sign-in data is still stored" 0 → 2 (@283694727)
 *     "did not reconnect to"                          0 → 2 (@276082807)
 *     "sign-in data for the config"                   0 → 2 (@276082807 region)
 *     "not signed in"                                 22 → 24 (new hit in the menu chunk)
 *
 * The v310 bug (item 42): the row was two-state and showed "authenticated"
 * whenever the client was connected with tools — even with NO credentials.
 * v311 renders "not signed in" (dimColor, no error icon) for that case.
 */
import { describe, expect, test } from 'bun:test'

import {
  type AuthRowState,
  configCarriesCredentials,
  deriveAuthRowState,
  hasAuthorizationHeader,
  hasNonEmptyHeaders,
  isConnectableClientType,
  shouldAttemptReconnectAfterClear,
} from '../MCPRemoteServerMenu.js'
import { computeIsAuthenticated } from '../MCPSettings.js'

const HTTP = { type: 'http', url: 'https://srv.test/mcp' } as const

describe('hasAuthorizationHeader (binary lEn @242617486)', () => {
  test('true when an Authorization header exists (case-insensitive key)', () => {
    // Act / Assert
    expect(hasAuthorizationHeader({ authorization: 'Bearer x' })).toBe(true)
    expect(hasAuthorizationHeader({ Authorization: 'Bearer x' })).toBe(true)
    expect(hasAuthorizationHeader({ AUTHORIZATION: 'Bearer x' })).toBe(true)
  })

  test('false when no Authorization key exists or headers empty', () => {
    expect(hasAuthorizationHeader({ 'x-api-key': 'k' })).toBe(false)
    expect(hasAuthorizationHeader({})).toBe(false)
  })
})

describe('hasNonEmptyHeaders (binary mee 2nd disjunct)', () => {
  test('true iff the headers record has at least one key', () => {
    expect(hasNonEmptyHeaders({ a: 'b' })).toBe(true)
    expect(hasNonEmptyHeaders({})).toBe(false)
  })
})

describe('isConnectableClientType (binary Li @242617800 region)', () => {
  test('connected and cached are connectable', () => {
    expect(isConnectableClientType('connected')).toBe(true)
    expect(isConnectableClientType('cached')).toBe(true)
  })

  test('every other client type is not connectable', () => {
    for (const t of ['failed', 'needs-auth', 'pending', 'disabled', 'unconfigured', 'needs-approval']) {
      expect(isConnectableClientType(t)).toBe(false)
    }
  })
})

describe('configCarriesCredentials (binary mee/Zot @242617800 region)', () => {
  test('headersHelper present → credentials', () => {
    expect(configCarriesCredentials({ ...HTTP, headersHelper: './h.sh' })).toBe(true)
  })

  test('non-empty headers → credentials', () => {
    expect(configCarriesCredentials({ ...HTTP, headers: { 'x-k': 'v' } })).toBe(true)
  })

  test('empty headers and no helper → no credentials', () => {
    expect(configCarriesCredentials({ ...HTTP, headers: {} })).toBe(false)
    expect(configCarriesCredentials(HTTP)).toBe(false)
  })

  test('xaa proxy case: only when xaa is enabled (binary nW() gate)', () => {
    const cfg = { ...HTTP, oauth: { xaa: true } }
    expect(configCarriesCredentials(cfg, { xaaEnabled: false })).toBe(false)
    expect(configCarriesCredentials(cfg, { xaaEnabled: true })).toBe(true)
  })

  test('first-party anthropic-hosted url: only with a session token (binary oF&&Un&&vd)', () => {
    const hosted = { type: 'http', url: 'https://api.anthropic.com/v1/design/foo' }
    expect(configCarriesCredentials(hosted, { hasSessionToken: false })).toBe(false)
    expect(configCarriesCredentials(hosted, { hasSessionToken: true })).toBe(true)
  })

  test('anthropic-hosted path gate: non-listed path → no credentials', () => {
    const other = { type: 'http', url: 'https://api.anthropic.com/v1/messages' }
    expect(configCarriesCredentials(other, { hasSessionToken: true })).toBe(false)
  })
})

describe('deriveAuthRowState (three-state row, binary @283701600)', () => {
  const base = { clientType: 'connected', toolCount: 3, configType: 'http' } as const

  test('real credentials → authenticated', () => {
    const state: AuthRowState = deriveAuthRowState({ ...base, isAuthenticated: true })
    expect(state).toBe('authenticated')
  })

  test('THE v310 BUG: connected-with-tools but NO credentials → not-signed-in (never authenticated)', () => {
    const state = deriveAuthRowState({ ...base, isAuthenticated: false })
    expect(state).toBe('not-signed-in')
    expect(state).not.toBe('authenticated')
  })

  test('claudeai-proxy is excluded from the middle state', () => {
    const state = deriveAuthRowState({ ...base, isAuthenticated: false, configType: 'claudeai-proxy' })
    expect(state).toBe('not-authenticated')
  })

  test('connectable but zero tools → not-authenticated', () => {
    expect(deriveAuthRowState({ ...base, isAuthenticated: false, toolCount: 0 })).toBe('not-authenticated')
  })

  test('tools but client failed / needs-auth / disabled → not-authenticated', () => {
    for (const clientType of ['failed', 'needs-auth', 'disabled', 'pending', 'unconfigured']) {
      expect(deriveAuthRowState({ ...base, isAuthenticated: false, clientType })).toBe('not-authenticated')
    }
  })

  test('cached client with tools and no credentials → not-signed-in', () => {
    expect(deriveAuthRowState({ ...base, isAuthenticated: false, clientType: 'cached' })).toBe('not-signed-in')
  })

  test('credentials win even when disconnected (gn || … ordering)', () => {
    expect(deriveAuthRowState({ ...base, isAuthenticated: true, clientType: 'failed', toolCount: 0 })).toBe('authenticated')
  })
})

describe('shouldAttemptReconnectAfterClear (binary hn reconnect gate @283694400)', () => {
  const base = {
    priorClientType: 'connected',
    isServerDisabled: false,
    isAllowedByPolicy: true,
    hasStoredConfig: true,
  } as const

  test('healthy connected server → reconnect', () => {
    expect(shouldAttemptReconnectAfterClear(base)).toBe(true)
  })

  test('prior client failed → do NOT reconnect (leave failed)', () => {
    expect(shouldAttemptReconnectAfterClear({ ...base, priorClientType: 'failed' })).toBe(false)
  })

  test('prior client disabled → do NOT reconnect', () => {
    expect(shouldAttemptReconnectAfterClear({ ...base, priorClientType: 'disabled' })).toBe(false)
  })

  test('server disabled by user → do NOT reconnect', () => {
    expect(shouldAttemptReconnectAfterClear({ ...base, isServerDisabled: true })).toBe(false)
  })

  test('policy-blocked server → do NOT reconnect', () => {
    expect(shouldAttemptReconnectAfterClear({ ...base, isAllowedByPolicy: false })).toBe(false)
  })

  test('config no longer stored → do NOT reconnect', () => {
    expect(shouldAttemptReconnectAfterClear({ ...base, hasStoredConfig: false })).toBe(false)
  })
})

describe('computeIsAuthenticated (MCPSettings, item 42 — credential-based only)', () => {
  test('stored OAuth tokens → true', () => {
    expect(computeIsAuthenticated({ hasTokens: true, hasSessionAuth: false, config: HTTP })).toBe(true)
  })

  test('session auth → true', () => {
    expect(computeIsAuthenticated({ hasTokens: false, hasSessionAuth: true, config: HTTP })).toBe(true)
  })

  test('credential-in-config (headersHelper) → true', () => {
    expect(
      computeIsAuthenticated({ hasTokens: false, hasSessionAuth: false, config: { ...HTTP, headersHelper: './h.sh' } }),
    ).toBe(true)
  })

  test('credential-in-config (Authorization header) → true', () => {
    expect(
      computeIsAuthenticated({
        hasTokens: false,
        hasSessionAuth: false,
        config: { ...HTTP, headers: { Authorization: 'Bearer t' } },
      }),
    ).toBe(true)
  })

  test('THE v310 BUG: no credentials at all → false (tool-connectivity must NOT imply authenticated)', () => {
    expect(computeIsAuthenticated({ hasTokens: false, hasSessionAuth: false, config: HTTP })).toBe(false)
  })
})
