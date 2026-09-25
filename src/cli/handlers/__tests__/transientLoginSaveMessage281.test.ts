/**
 * claude-code 2.1.281 #049 (🔒) — login-save transient-failure message.
 *
 * v281 `QAe` gained: on a TRANSIENT credential-save failure (locked keychain)
 * it throws a platform-specific message instead of silently continuing with an
 * unsaved login. Byte-verified gate:
 *   `"transient" in r && r.transient===!0 && !env.CLAUDE_CODE_OAUTH_TOKEN && !k5()`
 *   `throw new Pr(H()==="macos" ? T : O)`
 * Both message strings are NEW in v281 (2 hits in the v281 ELF, 0 in v280).
 *
 * `resolveTransientLoginSaveMessage` is the pure, parameterised form of that
 * gate (platform passed in), so every branch is testable without mocking the
 * memoized getPlatform or the env/fd token readers.
 */
import { describe, expect, test } from 'bun:test'

import {
  resolveTransientLoginSaveMessage,
  TRANSIENT_LOGIN_SAVE_MESSAGE_MACOS,
  TRANSIENT_LOGIN_SAVE_MESSAGE_OTHER,
} from '../auth.js'

const NO_TOKENS = { hasEnvOAuthToken: false, hasFdOAuthToken: false }

describe('#049 login-save transient message strings (byte-verified vs v281)', () => {
  test('macOS string matches the v281 binary verbatim', () => {
    expect(TRANSIENT_LOGIN_SAVE_MESSAGE_MACOS).toBe(
      "Couldn't save your login. If your Mac's keychain is locked, unlock it and log in again.",
    )
  })

  test('other-platform string matches the v281 binary verbatim', () => {
    expect(TRANSIENT_LOGIN_SAVE_MESSAGE_OTHER).toBe(
      "Couldn't save your login. Try logging in again.",
    )
  })
})

describe('#049 resolveTransientLoginSaveMessage', () => {
  test('darwin transient => macOS-specific keychain message', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: true,
        ...NO_TOKENS,
        platform: 'macos',
      }),
    ).toBe(TRANSIENT_LOGIN_SAVE_MESSAGE_MACOS)
  })

  test('linux transient => generic message', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: true,
        ...NO_TOKENS,
        platform: 'linux',
      }),
    ).toBe(TRANSIENT_LOGIN_SAVE_MESSAGE_OTHER)
  })

  test('windows / wsl / unknown transient => generic message', () => {
    for (const platform of ['windows', 'wsl', 'unknown'] as const) {
      expect(
        resolveTransientLoginSaveMessage({
          transient: true,
          ...NO_TOKENS,
          platform,
        }),
      ).toBe(TRANSIENT_LOGIN_SAVE_MESSAGE_OTHER)
    }
  })

  test('non-transient => null (no throw) even on darwin', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: false,
        ...NO_TOKENS,
        platform: 'macos',
      }),
    ).toBeNull()
  })

  test('env OAuth token present => null (keychain save is moot)', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: true,
        hasEnvOAuthToken: true,
        hasFdOAuthToken: false,
        platform: 'macos',
      }),
    ).toBeNull()
  })

  test('fd OAuth token present => null (keychain save is moot)', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: true,
        hasEnvOAuthToken: false,
        hasFdOAuthToken: true,
        platform: 'macos',
      }),
    ).toBeNull()
  })

  test('both tokens present => null', () => {
    expect(
      resolveTransientLoginSaveMessage({
        transient: true,
        hasEnvOAuthToken: true,
        hasFdOAuthToken: true,
        platform: 'macos',
      }),
    ).toBeNull()
  })
})
