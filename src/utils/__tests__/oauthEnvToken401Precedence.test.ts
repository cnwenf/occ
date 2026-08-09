// Regression test for the official 2.1.225 changelog item:
//   "Fix transient 401 replacing a long-lived CLAUDE_CODE_OAUTH_TOKEN with a
//    stored login's short-lived token (breaks headless until restart)."
//
// OCC-78 (2026-08-10) dedicated decompilation round (staged item #3 from the
// OCC-69 triage, `docs/upstream-version-gap-occ69.md`).
//
// Official fix site, byte-recovered from the 2.1.224 vs 2.1.225 linux-x64
// ELFs: the no-refreshToken branch of handleOAuth401Error (2.1.224 `AaS` /
// 2.1.225 `rES`). 2.1.224 unconditionally ADOPTED a differing stored
// credential on 401 — `process.env.CLAUDE_CODE_OAUTH_TOKEN = stored.accessToken`
// — even when the user had supplied their own long-lived env token, so a
// stale stored login token replaced the env token and headless sessions
// 401'd until restart. 2.1.225 added:
//   (a) a guard skipping adoption when the user supplied the env token
//       (not a remote-session child, no ANTHROPIC_UNIX_SOCKET) — telemetry
//       reason `oauth_401_skipped_user_env_token`, plus the error log "OAuth
//       401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of
//       adopting the stored credential...";
//   (b) an expiry gate on adoption (`!isOAuthTokenExpired(stored.expiresAt)`,
//       300s skew).
//
// Verdict for OCC: N/A via structural immunity (same precedent as the OCC-46
// SDK-MCP `constructor` crash verify-only finding). OCC's
// handleOAuth401ErrorImpl has NO stored-credential adoption path: with an env
// token set, getClaudeAIOAuthTokensAsync returns the inference-only env token
// (refreshToken: null) and the handler returns false WITHOUT reading secure
// storage; `process.env.CLAUDE_CODE_OAUTH_TOKEN` is never assigned anywhere
// in src/. The guard 2.1.225 added protects a branch OCC never had (part of
// the trimmed CCR/desktop/SDK recovery stack: SDK getOAuthToken callback
// refresh, disk adoption, rotated-env wait, zombie-exit). These tests pin the
// immunity so a future port of any recovery path cannot silently regress it.

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  clearOAuthTokenCache,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../auth.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

const ENV_TOKEN = 'occ78-long-lived-env-token'
const STORED_TOKEN = 'occ78-stored-short-lived-login-token'
const STORED_REFRESH = 'occ78-stored-refresh-token'

const PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const PREV_ENV: Record<string, string | undefined> = {}
const ENV_TO_CLEAR = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]

let tmpConfigDir: string

function writeStoredCredential(expiresAt: number | null): void {
  writeFileSync(
    join(tmpConfigDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: STORED_TOKEN,
        refreshToken: STORED_REFRESH,
        expiresAt,
        scopes: ['user:inference', 'user:profile'],
      },
    }),
  )
}

function resetCaches(): void {
  // Re-read the tmp CLAUDE_CONFIG_DIR + drop memoized token/keychain state.
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
}

beforeAll(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'occ78-oauth401-'))
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
  for (const k of ENV_TO_CLEAR) {
    PREV_ENV[k] = process.env[k]
    delete process.env[k]
  }
})

afterAll(() => {
  for (const k of ENV_TO_CLEAR) {
    if (PREV_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = PREV_ENV[k]
  }
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR
  getClaudeConfigHomeDir.cache?.clear?.()
  clearOAuthTokenCache()
  try {
    rmSync(tmpConfigDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup of the tmp fixture
  }
})

beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = ENV_TOKEN
  resetCaches()
})

test('env CLAUDE_CODE_OAUTH_TOKEN wins over a stored login token (source + value)', () => {
  // Arrange: expired stored login token alongside the user-supplied env token.
  writeStoredCredential(Date.now() - 60_000)
  resetCaches()

  // Act / Assert
  expect(getAuthTokenSource()).toEqual({
    source: 'CLAUDE_CODE_OAUTH_TOKEN',
    hasToken: true,
  })
  const tokens = getClaudeAIOAuthTokens()
  expect(tokens?.accessToken).toBe(ENV_TOKEN)
  // Inference-only shape: no refresh token, no expiry — never refreshable.
  expect(tokens?.refreshToken).toBeNull()
  expect(tokens?.expiresAt).toBeNull()
})

test('401 with env token never adopts the stored credential (official 2.1.224 bug)', async () => {
  // Arrange: the exact official-bug setup — long-lived env token in use,
  // DIFFERING stored login token on disk (expired, so even the 2.1.225
  // expiry gate would bar adoption — OCC must not get that far at all).
  writeStoredCredential(Date.now() - 60_000)
  resetCaches()

  // Act
  const recovered = await handleOAuth401Error(ENV_TOKEN)

  // Assert: unrecovered (env token has no refresh path)...
  expect(recovered).toBe(false)
  // ...and the env token was NOT replaced by the stored credential.
  // Official 2.1.224 mutated process.env.CLAUDE_CODE_OAUTH_TOKEN here.
  expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(ENV_TOKEN)
  expect(getAuthTokenSource()).toEqual({
    source: 'CLAUDE_CODE_OAUTH_TOKEN',
    hasToken: true,
  })
  expect(getClaudeAIOAuthTokens()?.accessToken).toBe(ENV_TOKEN)
})

test('401 with env token ignores a VALID differing stored credential too', () => {
  // Arrange: stored token still valid (future expiry). Official 2.1.224
  // adopted it on 401 regardless; 2.1.225 refuses when the user supplied
  // the env token. OCC structurally never reads it on this path.
  writeStoredCredential(Date.now() + 3_600_000)
  resetCaches()

  return handleOAuth401Error(ENV_TOKEN).then((recovered) => {
    expect(recovered).toBe(false)
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(ENV_TOKEN)
    expect(getClaudeAIOAuthTokens()?.accessToken).toBe(ENV_TOKEN)
  })
})

test('401 with env token and NO stored credentials is a clean no-op', async () => {
  // Arrange: no .credentials.json at all (fresh headless container).
  resetCaches()

  // Act
  const recovered = await handleOAuth401Error(ENV_TOKEN)

  // Assert
  expect(recovered).toBe(false)
  expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(ENV_TOKEN)
  expect(getAuthTokenSource()).toEqual({
    source: 'CLAUDE_CODE_OAUTH_TOKEN',
    hasToken: true,
  })
})
