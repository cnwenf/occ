/**
 * CC 2.1.307 (B15): the browser sign-in SUCCESS page must render before the
 * (slow, failure-prone) profile fetch. Official v307 `PN.startOAuthFlow`
 * order (byte-verified in /tmp/cc-diff-308/new307.txt):
 *
 *   let c=await xWo(...)                       // exchangeCodeForTokens
 *   if(h){...this.authCodeListener?.handleSuccessRedirect(p)...}   // redirect
 *   let u=r?.skipProfileFetch?null:await Wjt(c.access_token)       // profile
 *   ...formatTokens
 *   catch(c){...if(h)this.authCodeListener?.handleErrorRedirect();...}
 *
 * So: exchange → success redirect → fetchProfileInfo → formatTokens. A
 * fetchProfileInfo failure AFTER the success redirect must not replace the
 * success page with the error page. Official achieves that via
 * pendingResponse=null (handleErrorRedirect no-ops once the success redirect
 * consumed it); OCC pins the same observable contract with an explicit
 * `redirectSent` guard in the catch (documented deviation — the official
 * settings-only-grant 302 branch is out of scope).
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Module mocks — registered BEFORE importing the SUT. Restored in afterAll
// (bun's module registry is process-global across test files — OCC-97).
// ---------------------------------------------------------------------------

const realClient = { ...(await import('src/services/oauth/client.js')) }
const realListener = { ...(await import('src/services/oauth/auth-code-listener.js')) }

let calls: string[] = []
let automaticFlow = true
let exchangeImpl: () => Promise<unknown>
let profileImpl: () => Promise<unknown>

const TOKEN_RESPONSE = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
  scope: 'user:inference organization:work',
}

class FakeAuthCodeListener {
  async start(): Promise<number> {
    calls.push('start')
    return 43124
  }
  hasPendingResponse(): boolean {
    return automaticFlow
  }
  async waitForAuthorization(
    _state: string,
    _onReady: () => Promise<void>,
  ): Promise<string> {
    // Resolve immediately; never invokes onReady (no browser open in tests).
    return 'test-auth-code'
  }
  handleSuccessRedirect(_scopes?: string[]): void {
    calls.push('success-redirect')
  }
  handleErrorRedirect(): void {
    calls.push('error-redirect')
  }
  close(): void {
    calls.push('close')
  }
}

mock.module('src/services/oauth/auth-code-listener.js', () => ({
  ...realListener,
  AuthCodeListener: FakeAuthCodeListener,
}))
mock.module('src/services/oauth/client.js', () => ({
  ...realClient,
  buildAuthUrl: () => 'https://claude.ai/oauth/authorize?test=1',
  exchangeCodeForTokens: async () => {
    calls.push('exchange')
    return exchangeImpl()
  },
  fetchProfileInfo: async () => {
    calls.push('profile')
    return profileImpl()
  },
  parseScopes: (scope?: string) => (scope ?? '').split(' ').filter(Boolean),
}))

const { OAuthService } = await import('../index.js')

afterAll(() => {
  mock.module('src/services/oauth/auth-code-listener.js', () => realListener)
  mock.module('src/services/oauth/client.js', () => realClient)
})

beforeEach(() => {
  calls = []
  automaticFlow = true
  exchangeImpl = async () => ({ ...TOKEN_RESPONSE })
  profileImpl = async () => ({
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    rawProfile: {},
  })
})

afterEach(() => {
  calls = []
})

const noopAuthURLHandler = async (): Promise<void> => {}

function orderOf(...names: string[]): number[] {
  return names.map(n => calls.indexOf(n))
}

// ---------------------------------------------------------------------------
// Ordering: exchange → success redirect → profile fetch
// ---------------------------------------------------------------------------

describe('startOAuthFlow success-redirect ordering (CC 2.1.307 B15)', () => {
  test('success redirect fires AFTER token exchange and BEFORE fetchProfileInfo', async () => {
    // Arrange
    const service = new OAuthService()
    let profileStartedBeforeRedirect = false
    profileImpl = async () => {
      profileStartedBeforeRedirect = !calls.includes('success-redirect')
      return { subscriptionType: 'pro', rateLimitTier: 'default', rawProfile: {} }
    }

    // Act
    const tokens = await service.startOAuthFlow(noopAuthURLHandler)

    // Assert — official order: exchange → handleSuccessRedirect → profile
    const [exchange, redirect, profile] = orderOf(
      'exchange',
      'success-redirect',
      'profile',
    )
    expect(exchange).toBeGreaterThanOrEqual(0)
    expect(exchange!).toBeLessThan(redirect!)
    expect(redirect!).toBeLessThan(profile!)
    expect(profileStartedBeforeRedirect).toBe(false)
    expect(tokens.accessToken).toBe('test-access-token')
    expect(tokens.subscriptionType).toBe('pro')
    expect(calls).toContain('close')
  })

  test('profile failure AFTER the success redirect → error still thrown, success page NOT replaced by error page', async () => {
    // Arrange
    const service = new OAuthService()
    profileImpl = async () => {
      throw new Error('profile endpoint down')
    }

    // Act & Assert
    await expect(service.startOAuthFlow(noopAuthURLHandler)).rejects.toThrow(
      'profile endpoint down',
    )
    expect(calls).toContain('success-redirect')
    expect(calls).not.toContain('error-redirect')
    expect(calls).toContain('close')
  })

  test('exchange failure BEFORE any redirect → error redirect fires (unchanged)', async () => {
    // Arrange
    const service = new OAuthService()
    exchangeImpl = async () => {
      throw new Error('invalid grant')
    }

    // Act & Assert
    await expect(service.startOAuthFlow(noopAuthURLHandler)).rejects.toThrow(
      'invalid grant',
    )
    expect(calls).not.toContain('success-redirect')
    expect(calls).not.toContain('profile')
    expect(calls).toContain('error-redirect')
    expect(calls).toContain('close')
  })

  test('manual flow (no pending response) → no redirects on success', async () => {
    // Arrange
    automaticFlow = false
    const service = new OAuthService()

    // Act
    const tokens = await service.startOAuthFlow(noopAuthURLHandler)

    // Assert
    expect(tokens.accessToken).toBe('test-access-token')
    expect(calls).not.toContain('success-redirect')
    expect(calls).not.toContain('error-redirect')
  })

  test('manual flow (no pending response) → no error redirect on failure', async () => {
    // Arrange
    automaticFlow = false
    const service = new OAuthService()
    exchangeImpl = async () => {
      throw new Error('invalid grant')
    }

    // Act & Assert
    await expect(service.startOAuthFlow(noopAuthURLHandler)).rejects.toThrow(
      'invalid grant',
    )
    expect(calls).not.toContain('error-redirect')
    expect(calls).toContain('close')
  })
})

// ---------------------------------------------------------------------------
// Source-level pins
// ---------------------------------------------------------------------------

describe('oauth source structure (CC 2.1.307 B15)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')

  test('success redirect block precedes fetchProfileInfo in source order', () => {
    expect(src.indexOf('handleSuccessRedirect')).toBeLessThan(
      src.indexOf('fetchProfileInfo'),
    )
  })

  test('catch-path error redirect is guarded by redirectSent', () => {
    expect(src).toContain('redirectSent')
  })
})
