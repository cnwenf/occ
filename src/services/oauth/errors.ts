import axios from 'axios'

/**
 * CC 2.1.311 (WP-U / triage item 62): dedicated error for a MANUALLY PASTED
 * OAuth code that the server refuses with `invalid_grant` during the token
 * exchange. Byte-verified in /tmp/cc-diff-311/v311/package/claude @243338164
 * (string pool @123203984; 0 hits in v310):
 *
 *   class GRe extends Error{constructor(){
 *     super("That code wasn't accepted. It may be incomplete, expired,
 *            already used, or from an earlier sign-in attempt. Sign in
 *            again to get a new code.");
 *     this.name="AuthCodeRefusedError"}}
 *
 * The message is a FIXED, safe string — it never interpolates the pasted
 * code, tokens, or response bodies, so it is safe to display and log.
 */
const AUTH_CODE_REFUSED_MESSAGE =
  "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."

export class AuthCodeRefusedError extends Error {
  constructor() {
    super(AUTH_CODE_REFUSED_MESSAGE)
    this.name = 'AuthCodeRefusedError'
  }
}

/**
 * Safely read the OAuth `code` field off an untrusted token-endpoint
 * response body (≡ the binary's `Ha(data).code` normalization for the
 * shapes OCC's axios client can produce).
 */
function extractResponseCode(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const code = (data as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * ≡ binary `_q` (v311 @242114734, byte-verified):
 *
 *   function _q(e){if(!It.isAxiosError(e)||!e.response)return!1;
 *     let n=e.response.status;if(n!==400&&n!==401)return!1;
 *     return Ha(e.response.data).code==="invalid_grant"&&mCn(e.response.data)===null}
 *
 * ADAPTATION — the `mCn(data)===null` sub-guard is omitted: `mCn`
 * (v311 @241625620) extracts an `account_on_hold` OAuth error detail
 * (`error_uri` → hold URL) behind a statsig gate (`u6t()`), routing those
 * responses to the dedicated OAuthAccountOnHoldError surface instead. OCC
 * ships no account-on-hold / error_uri OAuth surface, so `mCn(data)` is
 * always null within OCC's domain and the sub-guard is behaviorally a
 * no-op here. The essential checks (axios error + status 400/401 +
 * `data.code === 'invalid_grant'`) are kept verbatim.
 *
 * axios's default validateStatus rejects HTTP >= 400, so a refused token
 * exchange arrives in the caller's catch as an AxiosError carrying the
 * response — exactly what this predicate inspects.
 */
export function isInvalidGrantError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) {
    return false
  }
  const status = error.response.status
  if (status !== 400 && status !== 401) {
    return false
  }
  return extractResponseCode(error.response.data) === 'invalid_grant'
}

/**
 * ≡ binary `let u=!h&&_q(c)` in the startOAuthFlow catch (v311 @243340550):
 * a pasted-code refusal is thrown as `AuthCodeRefusedError` only when the
 * code was MANUALLY PASTED (`!isAutomaticFlow`, i.e. the auth-code listener
 * has no pending browser response) AND the exchange failed with
 * `invalid_grant`. Browser-redirect failures keep the existing
 * error-redirect handling and rethrow the original error.
 *
 * Pure — extracted so the classification decision is unit-testable without
 * mocking the whole OAuth flow.
 */
export function shouldThrowAuthCodeRefused(params: {
  isAutomaticFlow: boolean
  error: unknown
}): boolean {
  return !params.isAutomaticFlow && isInvalidGrantError(params.error)
}
