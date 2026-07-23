// 2.1.216 #19 — MCP re-authenticate must not revoke working credentials
// before the new sign-in succeeds.
//
// Previously, `MCPRemoteServerMenu.handleAuthenticate` called
// `revokeServerTokens` (irreversible server-side RFC 7009 revocation +
// local clear) BEFORE `performMCPOAuthFlow`. If the new sign-in failed,
// was cancelled, or timed out, the user's previously-working credentials
// were already destroyed — leaving them credentialless.
//
// This helper enforces the correct ordering: perform the new sign-in
// first, and only revoke old tokens after it succeeds. If the sign-in
// throws, old credentials remain intact (the caller's `revokeOldTokens`
// is never invoked).
//
// The `wasAuthenticated` flag gates whether revocation is attempted at
// all — a first-time auth (no existing tokens) has nothing to revoke.

export interface ReauthSteps {
  /** Whether the server was already authenticated (has existing tokens). */
  wasAuthenticated: boolean
  /** Perform the new OAuth sign-in flow. Must succeed before revocation. */
  performNewSignIn: () => Promise<void>
  /** Revoke the old (pre-re-auth) server-side tokens. Only called on success. */
  revokeOldTokens: () => Promise<void>
}

/**
 * Re-authenticate an MCP server with safe credential ordering.
 *
 * Completes the new sign-in BEFORE revoking old tokens, so a failed or
 * cancelled re-auth never leaves the user credentialless.
 */
export async function reauthenticateWithSafeOrdering(
  steps: ReauthSteps,
): Promise<void> {
  // Complete the new sign-in FIRST. If this throws, we return without
  // touching the old credentials — they remain valid and usable.
  await steps.performNewSignIn()

  // Only revoke old tokens after the new sign-in has succeeded.
  if (steps.wasAuthenticated) {
    await steps.revokeOldTokens()
  }
}
