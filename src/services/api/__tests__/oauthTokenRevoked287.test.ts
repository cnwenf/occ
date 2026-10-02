import { afterEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { setIsInteractive } from '../../../bootstrap/state.js'
import {
  TOKEN_REVOKED_ERROR_MESSAGE,
  getTokenRevokedErrorMessage,
  isOAuthTokenRevokedAPIError,
} from '../errors.js'

/**
 * CC 2.1.287 PORT — revoked-OAuth-token predicate widened to cover the 401
 * "OAuth access token has been revoked" form, and the print-mode message
 * changed to the explicit revoked-token wording.
 *
 * Official 2.1.287 linux binary:
 *   PZ @200866142 (predicate):
 *     function PZ(e){if(!(e instanceof xt))return!1;let r=e.message??"";
 *       return e.status===403&&r.includes("OAuth token has been revoked")||
 *         e.status===401&&r.includes("OAuth access token has been revoked")}
 *   Q3n @207163766 (message):
 *     function Q3n(){return ke()?"Failed to authenticate: OAuth token revoked.
 *       Please log in again or contact your administrator.":Elt}
 *
 * v286 was 403-only (X7) with the generic "Your account does not have access
 * to Claude..." print-mode message. The 401 branch is the delta.
 */
function apiError(status: number, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

const REVOKED_403 = 'OAuth token has been revoked'
const REVOKED_401 = 'OAuth access token has been revoked'

afterEach(() => {
  // Restore default interactive state so tests stay isolated.
  setIsInteractive(true)
})

describe('isOAuthTokenRevokedAPIError (2.1.287 PZ predicate)', () => {
  test('matches 403 with "OAuth token has been revoked" (pre-existing form)', () => {
    expect(isOAuthTokenRevokedAPIError(apiError(403, REVOKED_403))).toBe(true)
  })

  test('matches 401 with "OAuth access token has been revoked" (NEW 2.1.287 form)', () => {
    expect(isOAuthTokenRevokedAPIError(apiError(401, REVOKED_401))).toBe(true)
  })

  test('matches when the revoked text is embedded in a longer message', () => {
    expect(
      isOAuthTokenRevokedAPIError(apiError(401, `Error: ${REVOKED_401}. Retry`)),
    ).toBe(true)
  })

  test('does NOT match 401 with the 403-only wording (statuses are not interchangeable)', () => {
    expect(isOAuthTokenRevokedAPIError(apiError(401, REVOKED_403))).toBe(false)
  })

  test('does NOT match 403 with the 401-only wording', () => {
    expect(isOAuthTokenRevokedAPIError(apiError(403, REVOKED_401))).toBe(false)
  })

  test('does NOT match an unrelated 403', () => {
    expect(
      isOAuthTokenRevokedAPIError(apiError(403, 'Permission denied')),
    ).toBe(false)
  })

  test('does NOT match a non-APIError even with the revoked message', () => {
    expect(isOAuthTokenRevokedAPIError(new Error(REVOKED_403))).toBe(false)
    expect(isOAuthTokenRevokedAPIError(undefined)).toBe(false)
    expect(isOAuthTokenRevokedAPIError(null)).toBe(false)
  })
})

describe('getTokenRevokedErrorMessage (2.1.287 Q3n message)', () => {
  test('non-interactive (print mode) returns the explicit revoked-token wording', () => {
    setIsInteractive(false)
    expect(getTokenRevokedErrorMessage()).toBe(
      'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.',
    )
  })

  test('non-interactive message is NOT the old generic v286 wording', () => {
    setIsInteractive(false)
    expect(getTokenRevokedErrorMessage()).not.toBe(
      'Your account does not have access to Claude. Please login again or contact your administrator.',
    )
  })

  test('interactive returns the short run-/login prompt (unchanged)', () => {
    setIsInteractive(true)
    expect(getTokenRevokedErrorMessage()).toBe(TOKEN_REVOKED_ERROR_MESSAGE)
    expect(getTokenRevokedErrorMessage()).toBe(
      'OAuth token revoked · Please run /login',
    )
  })
})
