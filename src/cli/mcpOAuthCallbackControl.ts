/**
 * CC 2.1.274 review P2-2 (docs/upstream-version-gap-occ128.md): the
 * headless control-channel (`mcp_oauth_callback_url`) submission decision,
 * extracted from `src/cli/print.ts` with injected dependencies so the
 * gating is unit-testable.
 *
 * 274 submitter semantics: a wrong-state URL returns false and the flow
 * KEEPS WAITING. Only an ACCEPTED submit may await the auth promise —
 * awaiting after a rejected paste would block the single-threaded
 * control-message loop for up to the 5-minute flow timeout (CWE-400), and
 * pre-274 the same paste failed immediately with a CSRF error.
 */

export interface OAuthCallbackControlDeps {
  /** Registry reader for the flow's manual-callback submitter. */
  getSubmitter(serverName: string): ((callbackUrl: string) => boolean) | undefined
  /** Registry reader for the flow's token-exchange promise. */
  getAuthPromise(serverName: string): Promise<void> | undefined
  /** Record that the manual paste path was used for this server. */
  markManualCallbackUsed(serverName: string): void
  /** Fail the control request with a message. */
  respondError(message: string): void
  /** Succeed the control request. */
  respondSuccess(): void
}

/** Error copy for a URL the submitter rejected (wrong state / no code). */
export const CALLBACK_NOT_ACCEPTED_MESSAGE =
  'Callback URL was not accepted: its state does not match the flow in progress (or it carries no authorization code). The OAuth flow is still waiting — send the redirect URL from the authorization page this flow opened.'

/** Error copy for a URL missing the `code`/`error` query param. */
export const CALLBACK_MISSING_CODE_MESSAGE =
  'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.'

/**
 * Handles one `mcp_oauth_callback_url` control request.
 *
 * Decision order (identical to the pre-extraction inline logic):
 * 1. no registered submitter → error, no state changes;
 * 2. URL without `code`/`error` param (or unparseable) → error, submitter
 *    untouched (auth.ts silently ignores such URLs, which would wedge the
 *    control loop until timeout);
 * 3. submitter returns false → IMMEDIATE error (never awaits the auth
 *    promise) and `markManualCallbackUsed` is NOT recorded — a rejected
 *    paste must not suppress the background reconnect;
 * 4. submitter returns true → mark used, then await the token exchange (if
 *    tracked) and map its outcome to the control response.
 */
export async function handleOAuthCallbackUrlControl(
  serverName: string,
  callbackUrl: string,
  deps: OAuthCallbackControlDeps,
): Promise<void> {
  const submit = deps.getSubmitter(serverName)
  if (!submit) {
    deps.respondError(`No active OAuth flow for server: ${serverName}`)
    return
  }

  let hasCodeOrError = false
  try {
    const parsed = new URL(callbackUrl)
    hasCodeOrError =
      parsed.searchParams.has('code') || parsed.searchParams.has('error')
  } catch {
    // Invalid URL — treated as "missing code" below.
  }
  if (!hasCodeOrError) {
    deps.respondError(CALLBACK_MISSING_CODE_MESSAGE)
    return
  }

  const accepted = submit(callbackUrl)
  if (!accepted) {
    deps.respondError(CALLBACK_NOT_ACCEPTED_MESSAGE)
    return
  }

  deps.markManualCallbackUsed(serverName)
  // Wait for auth (token exchange) to complete before responding.
  // Reconnect is handled by the extension via handleAuthDone →
  // mcp_reconnect (which updates dynamicMcpState for tools).
  const authPromise = deps.getAuthPromise(serverName)
  if (!authPromise) {
    deps.respondSuccess()
    return
  }
  try {
    await authPromise
    deps.respondSuccess()
  } catch (error) {
    deps.respondError(
      error instanceof Error ? error.message : 'OAuth authentication failed',
    )
  }
}
