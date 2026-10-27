/**
 * CC 2.1.311 (WP-U / triage item 62): a MANUALLY PASTED OAuth code that the
 * server refuses with `invalid_grant` must throw the dedicated
 * `AuthCodeRefusedError` (clear, fixed, safe message) and emit the
 * `oauth_pasted_code_refused` telemetry outcome — instead of surfacing the
 * raw axios error under the generic `oauth_login_failed` outcome.
 *
 * Byte-verified in /tmp/cc-diff-311/v311/package/claude (0 hits in v310):
 *
 *   class GRe extends Error{constructor(){
 *     super("That code wasn't accepted. It may be incomplete, expired,
 *            already used, or from an earlier sign-in attempt. Sign in
 *            again to get a new code.");
 *     this.name="AuthCodeRefusedError"}}                     @243338164
 *
 *   }catch(c){
 *     let u=!h&&_q(c);
 *     if(m("oauth_login",u?"oauth_pasted_code_refused":"oauth_login_failed"),h)
 *       this.authCodeListener?.handleErrorRedirect();
 *     ...
 *     throw u?new GRe:c
 *   }finally{this.authCodeListener?.close()}                 @243340550
 *
 *   function _q(e){if(!It.isAxiosError(e)||!e.response)return!1;
 *     let n=e.response.status;if(n!==400&&n!==401)return!1;
 *     return Ha(e.response.data).code==="invalid_grant"&&mCn(e.response.data)===null}
 *                                                            @242114734
 *
 * where `h = this.authCodeListener?.hasPendingResponse() ?? false`
 * (h=false ⇒ the code was MANUALLY PASTED).
 *
 * ADAPTATION (`mCn` sub-guard): mCn extracts an `account_on_hold` OAuth
 * error detail (gated by statsig `u6t()`, @241625620); OCC ships no
 * account-on-hold / error_uri OAuth surface, so mCn(data) is always null
 * in OCC's domain and the sub-guard is behaviorally a no-op — omitted with
 * this rationale (essential status + code checks kept).
 *
 * h=true (browser redirect pending) keeps the existing error-redirect
 * handling and rethrows the ORIGINAL error.
 */

import { AxiosError, AxiosHeaders } from 'axios'
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

// ---------------------------------------------------------------------------
// Pure-unit section — import the SUT directly (errors.ts is side-effect free).
// ---------------------------------------------------------------------------

import {
  AuthCodeRefusedError,
  isInvalidGrantError,
  shouldThrowAuthCodeRefused,
} from '../errors.js'

/** EXACT v311 message — byte-verbatim (dd @243338164, string pool @123203984). */
const V311_MESSAGE =
  "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."

/** Build a real axios-shaped error the way axios rejects on HTTP >= 400. */
function axiosErrorWith(status: number, data: unknown): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    undefined,
    {},
    {
      data,
      status,
      statusText: 'Error',
      headers: {},
      config: { headers: new AxiosHeaders() },
    },
  )
}

const invalidGrant400 = (): AxiosError =>
  axiosErrorWith(400, { code: 'invalid_grant' })
const invalidGrant401 = (): AxiosError =>
  axiosErrorWith(401, { code: 'invalid_grant' })

describe('AuthCodeRefusedError (CC 2.1.311 item 62)', () => {
  test('carries the byte-verbatim v311 message', () => {
    expect(new AuthCodeRefusedError().message).toBe(V311_MESSAGE)
  })

  test('is named AuthCodeRefusedError and extends Error', () => {
    const error = new AuthCodeRefusedError()
    expect(error.name).toBe('AuthCodeRefusedError')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(AuthCodeRefusedError)
  })

  test('message is a fixed safe string (never leaks codes or tokens)', () => {
    // Two independently constructed instances are identical — the message
    // carries no interpolated request/response material.
    expect(new AuthCodeRefusedError().message).toBe(
      new AuthCodeRefusedError().message,
    )
  })
})

describe('isInvalidGrantError (≡ binary _q, CC 2.1.311 item 62)', () => {
  test('true for an axios 400 with data.code === invalid_grant', () => {
    expect(isInvalidGrantError(invalidGrant400())).toBe(true)
  })

  test('true for an axios 401 with data.code === invalid_grant', () => {
    expect(isInvalidGrantError(invalidGrant401())).toBe(true)
  })

  test('false for status 400 with a different error code', () => {
    expect(isInvalidGrantError(axiosErrorWith(400, { code: 'invalid_request' }))).toBe(false)
  })

  test('false for status 403 even with invalid_grant', () => {
    expect(isInvalidGrantError(axiosErrorWith(403, { code: 'invalid_grant' }))).toBe(false)
  })

  test('false for an axios error with no response (network failure)', () => {
    const noResponse = new AxiosError('socket hang up', AxiosError.ERR_NETWORK)
    expect(noResponse.response).toBeUndefined()
    expect(isInvalidGrantError(noResponse)).toBe(false)
  })

  test('false for a plain non-axios Error with the same shape hints', () => {
    const plain = Object.assign(new Error('invalid_grant'), {
      response: { status: 400, data: { code: 'invalid_grant' } },
    })
    expect(isInvalidGrantError(plain)).toBe(false)
  })

  test('false for null, undefined, and non-object values', () => {
    expect(isInvalidGrantError(null)).toBe(false)
    expect(isInvalidGrantError(undefined)).toBe(false)
    expect(isInvalidGrantError('invalid_grant')).toBe(false)
    expect(isInvalidGrantError(400)).toBe(false)
  })

  test('false when response.data is missing or malformed', () => {
    expect(isInvalidGrantError(axiosErrorWith(400, undefined))).toBe(false)
    expect(isInvalidGrantError(axiosErrorWith(400, 'invalid_grant'))).toBe(false)
    expect(isInvalidGrantError(axiosErrorWith(400, { code: 42 }))).toBe(false)
  })
})

describe('shouldThrowAuthCodeRefused (≡ binary `u=!h&&_q(c)`)', () => {
  test('true: manually pasted code (!isAutomaticFlow) + invalid_grant', () => {
    expect(
      shouldThrowAuthCodeRefused({
        isAutomaticFlow: false,
        error: invalidGrant400(),
      }),
    ).toBe(true)
  })

  test('false: automatic browser flow + invalid_grant (error-redirect path keeps original)', () => {
    expect(
      shouldThrowAuthCodeRefused({
        isAutomaticFlow: true,
        error: invalidGrant401(),
      }),
    ).toBe(false)
  })

  test('false: manually pasted code + a non-invalid-grant failure', () => {
    expect(
      shouldThrowAuthCodeRefused({
        isAutomaticFlow: false,
        error: new Error('Token exchange failed (500): Internal Server Error'),
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Integration section — startOAuthFlow catch wiring, on the same mock harness
// as successRedirectOrder307.test.ts (mocks registered BEFORE importing the
// SUT; restored in afterAll — bun's module registry is process-global).
// ---------------------------------------------------------------------------

const realClient = { ...(await import('src/services/oauth/client.js')) }
const realListener = { ...(await import('src/services/oauth/auth-code-listener.js')) }
const realAnalytics = { ...(await import('src/services/analytics/index.js')) }

let calls: string[] = []
let automaticFlow = true
let exchangeImpl: () => Promise<unknown>
let events: Array<{ eventName: string; metadata: Record<string, unknown> }> = []

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
  fetchProfileInfo: async () => ({
    subscriptionType: 'pro',
    rateLimitTier: 'default',
    rawProfile: {},
  }),
  parseScopes: (scope?: string) => (scope ?? '').split(' ').filter(Boolean),
}))
mock.module('src/services/analytics/index.js', () => ({
  ...realAnalytics,
  logEvent: (eventName: string, metadata: Record<string, unknown>) => {
    events.push({ eventName, metadata })
  },
}))

const { OAuthService } = await import('../index.js')

afterAll(() => {
  mock.module('src/services/oauth/auth-code-listener.js', () => realListener)
  mock.module('src/services/oauth/client.js', () => realClient)
  mock.module('src/services/analytics/index.js', () => realAnalytics)
})

beforeEach(() => {
  calls = []
  events = []
  automaticFlow = true
  exchangeImpl = async () => {
    throw new Error('unused default')
  }
})

const noopAuthURLHandler = async (): Promise<void> => {}

function oauthLoginEvents(): Array<{ eventName: string; metadata: Record<string, unknown> }> {
  return events.filter(e => e.eventName === 'tengu_oauth_login')
}

describe('startOAuthFlow catch wiring (CC 2.1.311 item 62)', () => {
  test('pasted code + invalid_grant → throws AuthCodeRefusedError, no error redirect, pasted-refusal telemetry', async () => {
    // Arrange — manual paste: listener has NO pending browser response
    automaticFlow = false
    exchangeImpl = async () => {
      throw invalidGrant400()
    }
    const service = new OAuthService()

    // Act & Assert
    const thrown = await service
      .startOAuthFlow(noopAuthURLHandler)
      .then(() => null)
      .catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(AuthCodeRefusedError)
    expect((thrown as Error).message).toBe(V311_MESSAGE)
    // h=false in the binary ⇒ handleErrorRedirect must NOT fire
    expect(calls).not.toContain('error-redirect')
    expect(calls).toContain('close')
    // Telemetry: the v311 marker string must be emitted
    const loginEvents = oauthLoginEvents()
    expect(loginEvents.length).toBe(1)
    expect(loginEvents[0]!.metadata.outcome).toBe('oauth_pasted_code_refused')
  })

  test('automatic flow + invalid_grant → rethrows ORIGINAL error, error redirect fires, generic telemetry', async () => {
    // Arrange — browser redirect pending
    automaticFlow = true
    const original = invalidGrant401()
    exchangeImpl = async () => {
      throw original
    }
    const service = new OAuthService()

    // Act & Assert
    const thrown = await service
      .startOAuthFlow(noopAuthURLHandler)
      .then(() => null)
      .catch((error: unknown) => error)
    expect(thrown).toBe(original)
    expect(thrown).not.toBeInstanceOf(AuthCodeRefusedError)
    expect(calls).toContain('error-redirect')
    expect(calls).toContain('close')
    const loginEvents = oauthLoginEvents()
    expect(loginEvents.length).toBe(1)
    expect(loginEvents[0]!.metadata.outcome).toBe('oauth_login_failed')
  })

  test('pasted code + non-invalid-grant failure → rethrows ORIGINAL error, generic telemetry', async () => {
    // Arrange
    automaticFlow = false
    const original = new Error('Token exchange failed (500): Internal Server Error')
    exchangeImpl = async () => {
      throw original
    }
    const service = new OAuthService()

    // Act & Assert
    const thrown = await service
      .startOAuthFlow(noopAuthURLHandler)
      .then(() => null)
      .catch((error: unknown) => error)
    expect(thrown).toBe(original)
    expect(thrown).not.toBeInstanceOf(AuthCodeRefusedError)
    expect(calls).not.toContain('error-redirect')
    expect(calls).toContain('close')
    const loginEvents = oauthLoginEvents()
    expect(loginEvents.length).toBe(1)
    expect(loginEvents[0]!.metadata.outcome).toBe('oauth_login_failed')
  })

  test('success path emits NO tengu_oauth_login failure telemetry', async () => {
    // Arrange
    automaticFlow = false
    exchangeImpl = async () => ({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      scope: 'user:inference',
    })
    const service = new OAuthService()

    // Act
    const tokens = await service.startOAuthFlow(noopAuthURLHandler)

    // Assert
    expect(tokens.accessToken).toBe('test-access-token')
    expect(oauthLoginEvents().length).toBe(0)
  })
})
