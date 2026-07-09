// 2.1.203: "Added a warning when your login is about to expire, so you can
// re-authenticate before background sessions are interrupted."
//
// Faithful port of the official `slr()` login-expiry logic (decompiled from the
// 2.1.204 linux-x64 binary). The warning is about the *refresh token* expiry —
// the moment the login itself can no longer be refreshed and the user must
// re-authenticate. The short-lived access token (`expiresAt`) auto-refreshes,
// so it is not a useful "login is dying" signal.
//
// Official thresholds (verbatim from the binary):
//   NYd = 86_400_000          // one day in ms
//   OYd = 5 * NYd             // warn window: 5 days
//   slr():
//     - require firstParty (Claude.ai) OAuth AND mE() (claude.ai subscriber)
//     - require refreshTokenExpiresAt to be a number
//     - guard: if expiresAt (access) > refreshTokenExpiresAt + OYd, suppress
//       (long-lived inference-only edge case where the access token outlives
//       the refresh token by more than the warn window)
//     - only warn when 0 < remaining <= OYd
//     - return { daysLeft: Math.ceil(remaining / NYd) }

import { getAPIProvider } from './model/providers.js'
import {
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from './auth.js'
import type { OAuthTokens } from '../services/oauth/types.js'

/** One day in milliseconds. */
export const MS_PER_DAY = 86_400_000
/** Warn window: a login expiring within this many ms triggers the warning. */
export const LOGIN_EXPIRY_WARN_WINDOW_MS = 5 * MS_PER_DAY

export type OAuthLoginExpiryInfo = {
  /** Whole days left until the refresh token (login) expires (always >= 1). */
  daysLeft: number
}

export type OAuthLoginExpiryContext = {
  /** True when the active API provider is Anthropic first-party (Claude.ai OAuth). */
  providerIsFirstParty: boolean
  /** True when the current login is a Claude.ai subscriber (has the inference scope). */
  isClaudeAISubscriber: boolean
}

/**
 * Pure computation of login-expiry info from a token's refresh-token expiry.
 * Extracted from the live state read so it can be unit-tested without touching
 * secure storage or the memoized token cache.
 *
 * Returns `{ daysLeft }` (ceil of remaining days) when the login is within the
 * warn window, or `null` when no warning should be shown.
 */
export function computeOAuthLoginExpiry(
  tokens: OAuthTokens | null | undefined,
  context: OAuthLoginExpiryContext,
  now: number = Date.now(),
): OAuthLoginExpiryInfo | null {
  if (!context.providerIsFirstParty || !context.isClaudeAISubscriber) {
    return null
  }
  if (!tokens || typeof tokens.refreshTokenExpiresAt !== 'number') {
    return null
  }
  const refreshTokenExpiresAt = tokens.refreshTokenExpiresAt

  // Guard: an access token that outlives the refresh token by more than the
  // warn window means this isn't a normal Claude.ai login — suppress.
  if (
    typeof tokens.expiresAt === 'number' &&
    tokens.expiresAt > refreshTokenExpiresAt + LOGIN_EXPIRY_WARN_WINDOW_MS
  ) {
    return null
  }

  const remaining = refreshTokenExpiresAt - now
  // Already expired, or more than the warn window left: no warning.
  if (remaining > LOGIN_EXPIRY_WARN_WINDOW_MS || remaining <= 0) {
    return null
  }
  return { daysLeft: Math.ceil(remaining / MS_PER_DAY) }
}

/**
 * Live login-expiry info for the current session. Reads the current OAuth
 * tokens (memoized) and provider/subscriber state. Returns null when no
 * warning should be shown (API-key users, no OAuth login, login not near
 * expiry, etc.).
 */
export function getOAuthLoginExpiryInfo(): OAuthLoginExpiryInfo | null {
  return computeOAuthLoginExpiry(getClaudeAIOAuthTokens(), {
    providerIsFirstParty: getAPIProvider() === 'firstParty',
    isClaudeAISubscriber: isClaudeAISubscriber(),
  })
}

/**
 * Pluralize a noun for a count (day/days). Mirrors the official `Lt(n, "day")`
 * helper used to render the warning copy.
 */
export function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
