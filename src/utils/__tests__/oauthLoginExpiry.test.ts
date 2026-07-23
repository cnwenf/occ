// Unit tests for the 2.1.203 login-expiry warning logic (feature #20).
//
// The real-model e2e (occ -p) cannot exercise an OAuth login near its refresh-
// token expiry, so these unit tests are the done-gate for the warning THRESHOLD
// LOGIC — a faithful port of the official `slr()` decompiled from the 2.1.204
// linux-x64 binary.

import { test, expect } from 'bun:test'
import {
  computeOAuthLoginExpiry,
  pluralize,
  MS_PER_DAY,
  LOGIN_EXPIRY_WARN_WINDOW_MS,
} from '../oauthLoginExpiry.js'
import type { OAuthTokens } from '../../../services/oauth/types.js'

const SUBSCRIBER_CTX = {
  providerIsFirstParty: true,
  isClaudeAISubscriber: true,
}

const NOW = 1_700_000_000_000 // fixed "now" for deterministic tests

function tokenWith(
  refreshTokenExpiresAt: number | undefined,
  expiresAt?: number | undefined,
): OAuthTokens {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt,
    refreshTokenExpiresAt,
    scopes: ['user:inference', 'user:profile'],
  } as OAuthTokens
}

// -- guard conditions (return null) -----------------------------------------

test('returns null when there are no tokens', () => {
  expect(computeOAuthLoginExpiry(null, SUBSCRIBER_CTX, NOW)).toBeNull()
})

test('returns null when the provider is not firstParty (e.g. Bedrock)', () => {
  const tokens = tokenWith(NOW + 1 * MS_PER_DAY)
  expect(
    computeOAuthLoginExpiry(tokens, { ...SUBSCRIBER_CTX, providerIsFirstParty: false }, NOW),
  ).toBeNull()
})

test('returns null when not a Claude.ai subscriber (API-key user)', () => {
  const tokens = tokenWith(NOW + 1 * MS_PER_DAY)
  expect(
    computeOAuthLoginExpiry(tokens, { ...SUBSCRIBER_CTX, isClaudeAISubscriber: false }, NOW),
  ).toBeNull()
})

test('returns null when refreshTokenExpiresAt is not a number (inference-only grant)', () => {
  // The backend either returns a valid number or omits the field entirely.
  expect(computeOAuthLoginExpiry(tokenWith(undefined), SUBSCRIBER_CTX, NOW)).toBeNull()
})

test('suppresses when the access token outlives the refresh token by more than the warn window', () => {
  // expiresAt is 6 days past refreshTokenExpiresAt → guard fires.
  const refreshExpiry = NOW + 1 * MS_PER_DAY
  const tokens = tokenWith(refreshExpiry, refreshExpiry + 6 * MS_PER_DAY)
  expect(computeOAuthLoginExpiry(tokens, SUBSCRIBER_CTX, NOW)).toBeNull()
})

test('does NOT suppress when the access token is within the warn window past refresh expiry', () => {
  // expiresAt is 3 days past refreshTokenExpiresAt (== warn window) → guard does not fire.
  const refreshExpiry = NOW + 1 * MS_PER_DAY
  const tokens = tokenWith(refreshExpiry, refreshExpiry + 3 * MS_PER_DAY)
  const result = computeOAuthLoginExpiry(tokens, SUBSCRIBER_CTX, NOW)
  expect(result).not.toBeNull()
  expect(result?.daysLeft).toBe(1)
})

// -- threshold boundaries (faithful to slr: warn when 0 < remaining <= 3d) ---
// 2.1.217 #16: warn window narrowed from 5 days to 3 days before expiry.

test('returns null when more than 3 days remain', () => {
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW + 4 * MS_PER_DAY), SUBSCRIBER_CTX, NOW),
  ).toBeNull()
})

// 2.1.217 #16 behavior change: 4 days before expiry no longer warns (was 5d).
test('does NOT warn at 4 days before expiry (narrowed from 5d to 3d)', () => {
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW + 4 * MS_PER_DAY), SUBSCRIBER_CTX, NOW),
  ).toBeNull()
})

test('warns at exactly 3 days before expiry (the new boundary)', () => {
  const result = computeOAuthLoginExpiry(
    tokenWith(NOW + 3 * MS_PER_DAY),
    SUBSCRIBER_CTX,
    NOW,
  )
  expect(result).not.toBeNull()
  expect(result?.daysLeft).toBe(3)
})

test('warns at 2 days before expiry', () => {
  const result = computeOAuthLoginExpiry(
    tokenWith(NOW + 2 * MS_PER_DAY),
    SUBSCRIBER_CTX,
    NOW,
  )
  expect(result).not.toBeNull()
  expect(result?.daysLeft).toBe(2)
})

test('returns null when the login has already expired (remaining <= 0)', () => {
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW), SUBSCRIBER_CTX, NOW),
  ).toBeNull() // remaining == 0
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW - 1 * MS_PER_DAY), SUBSCRIBER_CTX, NOW),
  ).toBeNull() // remaining < 0
})

test('warns at exactly the warn-window boundary (remaining == warn window)', () => {
  const result = computeOAuthLoginExpiry(
    tokenWith(NOW + LOGIN_EXPIRY_WARN_WINDOW_MS),
    SUBSCRIBER_CTX,
    NOW,
  )
  expect(result?.daysLeft).toBe(3)
})

test('daysLeft is the ceiling of remaining days', () => {
  // 2.5 days left → ceil → 3
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW + 2.5 * MS_PER_DAY), SUBSCRIBER_CTX, NOW)
      ?.daysLeft,
  ).toBe(3)
  // 0.01 days left (~14 min) → ceil → 1
  expect(
    computeOAuthLoginExpiry(tokenWith(NOW + 0.01 * MS_PER_DAY), SUBSCRIBER_CTX, NOW)
      ?.daysLeft,
  ).toBe(1)
})

test('warns with daysLeft=1 within the last day (the urgent notification window)', () => {
  const result = computeOAuthLoginExpiry(
    tokenWith(NOW + 1 * MS_PER_DAY),
    SUBSCRIBER_CTX,
    NOW,
  )
  expect(result?.daysLeft).toBe(1)
})

// -- pluralize (mirrors official Lt(n, "day")) -------------------------------

test('pluralize: singular for 1, plural otherwise', () => {
  expect(pluralize(1, 'day')).toBe('day')
  expect(pluralize(2, 'day')).toBe('days')
  expect(pluralize(5, 'day')).toBe('days')
})
