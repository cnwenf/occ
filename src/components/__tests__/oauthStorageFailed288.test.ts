/**
 * claude-code 2.1.288 #35 — /login storage-failure surface in
 * ConsoleOAuthFlow (the interactive flow the official gates on
 * `let me=Y?.storage; if(me&&!me.success)` @223557800).
 *
 * Byte-verified official evidence (/tmp/cc-diff-288/v288/package/claude):
 *
 *  - Caller branch @223558664/223558737/223558787 — notification messages:
 *      transient: "Claude Code login needs attention: credentials may not have been saved"
 *      permanent: "Claude Code login needs attention: credentials could not be saved"
 *      notificationType: "auth_storage_failure"
 *    (success path stays "Claude Code login successful" / "auth_success").
 *
 *  - Gt backend display map @223576870:
 *      keychain → "the macOS Keychain"
 *      keychain-with-plaintext-fallback → "the macOS Keychain or the credentials file"
 *      windows-credman → "Windows Credential Manager"
 *      windows-credman-with-plaintext-fallback → "Windows Credential Manager or the credentials file"
 *      plaintext → "the credentials file"
 *      default → "secure storage"
 *
 *  - n8o analytics scrubber @202275360 + TL set @202275228:
 *      `e!==void 0&&TL.has(e)?e:"other"` over the five known backend names.
 *
 *  - storage_failed render @223572100-223575000 (fresh/previous/none blocks,
 *    advice lines, footers) — source-level byte checks below (no render harness
 *    for the full keybinding stack; same staged pattern as
 *    feedbackGitHubIssueUrl287.test.ts).
 */
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

// MACRO polyfill before importing the component module (import-time reads).
;(globalThis as { MACRO?: unknown }).MACRO ??= {
  VERSION: '2.1.288',
  BUILD_TIME: 'test',
  BUILD_TARGET: 'test',
}

const {
  getStorageBackendDisplayName,
  storageBackendAnalyticsName,
  resolveAuthStorageFailureNotification,
  AUTH_STORAGE_FAILURE_NOTIFICATION_TYPE,
  AUTH_STORAGE_FAILURE_MESSAGE_TRANSIENT,
  AUTH_STORAGE_FAILURE_MESSAGE_PERMANENT,
} = await import('../ConsoleOAuthFlow.js')

// Verbatim official strings (grep -aobF in the v288 ELF):
//   "may not have been saved" @223558664 · "could not be saved" @223558737 ·
//   "auth_storage_failure"    @223558787
const VERBATIM_TRANSIENT =
  'Claude Code login needs attention: credentials may not have been saved'
const VERBATIM_PERMANENT =
  'Claude Code login needs attention: credentials could not be saved'

describe('#35 storage-failure notification — verbatim official strings', () => {
  test('transient failure uses the "may not have been saved" message', () => {
    expect(resolveAuthStorageFailureNotification(true)).toBe(VERBATIM_TRANSIENT)
    expect(AUTH_STORAGE_FAILURE_MESSAGE_TRANSIENT).toBe(VERBATIM_TRANSIENT)
  })

  test('permanent failure uses the "could not be saved" message', () => {
    expect(resolveAuthStorageFailureNotification(false)).toBe(VERBATIM_PERMANENT)
    expect(resolveAuthStorageFailureNotification(undefined)).toBe(VERBATIM_PERMANENT)
    expect(AUTH_STORAGE_FAILURE_MESSAGE_PERMANENT).toBe(VERBATIM_PERMANENT)
  })

  test('failure notification type is auth_storage_failure', () => {
    expect(AUTH_STORAGE_FAILURE_NOTIFICATION_TYPE).toBe('auth_storage_failure')
  })
})

describe('#35 getStorageBackendDisplayName — official Gt map @223576870', () => {
  test.each([
    ['keychain', 'the macOS Keychain'],
    ['keychain-with-plaintext-fallback', 'the macOS Keychain or the credentials file'],
    ['windows-credman', 'Windows Credential Manager'],
    [
      'windows-credman-with-plaintext-fallback',
      'Windows Credential Manager or the credentials file',
    ],
    ['plaintext', 'the credentials file'],
  ])('%s → %s', (backend, expected) => {
    expect(getStorageBackendDisplayName(backend)).toBe(expected)
  })

  test('unknown or missing backends fall back to "secure storage"', () => {
    expect(getStorageBackendDisplayName(undefined)).toBe('secure storage')
    expect(getStorageBackendDisplayName('something-else')).toBe('secure storage')
  })
})

describe('#35 storageBackendAnalyticsName — official n8o scrubber @202275360', () => {
  test.each([
    'keychain',
    'plaintext',
    'windows-credman',
    'keychain-with-plaintext-fallback',
    'windows-credman-with-plaintext-fallback',
  ])('known backend %s passes through', backend => {
    expect(storageBackendAnalyticsName(backend)).toBe(backend)
  })

  test('unknown or missing backends scrub to "other"', () => {
    expect(storageBackendAnalyticsName('custom-backend')).toBe('other')
    expect(storageBackendAnalyticsName(undefined)).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// Source-level structural checks (staged render harness — see header).
// ---------------------------------------------------------------------------

const source = await readFile(
  new URL('../ConsoleOAuthFlow.tsx', import.meta.url),
  'utf8',
)

describe('#35 ConsoleOAuthFlow — storage_failed wiring (source-level)', () => {
  test('the caller branch consumes the install storage result', () => {
    expect(source).toMatch(/installResult\?\.storage/)
    expect(source).toMatch(/storage && !storage\.success/)
  })

  test('enters the storage_failed state with backendName/sessionAuth/transient', () => {
    expect(source).toMatch(/state: 'storage_failed'/)
    expect(source).toMatch(/backendName: storage\.backendName/)
    expect(source).toMatch(/sessionAuth: storage\.sessionAuth/)
    expect(source).toMatch(/transient: storage\.transient/)
  })

  test('logs tengu_oauth_persist_failure_shown with scrubbed backend + transient===true', () => {
    expect(source).toMatch(/tengu_oauth_persist_failure_shown/)
    expect(source).toMatch(/storageBackend: storageBackendAnalyticsName\(storage\.backendName\)/)
    expect(source).toMatch(/session_auth: storage\.sessionAuth/)
    expect(source).toMatch(/transient: storage\.transient === true/)
  })

  test('sends the auth_storage_failure notification instead of auth_success on failure', () => {
    expect(source).toMatch(
      /message: resolveAuthStorageFailureNotification\(storage\.transient\)/,
    )
    expect(source).toMatch(
      /notificationType: AUTH_STORAGE_FAILURE_NOTIFICATION_TYPE/,
    )
  })

  test('success path keeps the verbatim "Claude Code login successful" / auth_success', () => {
    expect(source).toMatch(/Claude Code login successful/)
    expect(source).toMatch(/notificationType: 'auth_success'/)
  })

  test('Enter continues on fresh storage_failed WITHOUT logging tengu_oauth_success', () => {
    expect(source).toMatch(/oauthStatus\.state !== 'storage_failed'/)
    expect(source).toMatch(/oauthStatus\.state === 'storage_failed' && oauthStatus\.sessionAuth === 'fresh'/)
  })

  test('Enter retries on non-fresh storage_failed via about_to_retry', () => {
    expect(source).toMatch(/oauthStatus\.state === 'storage_failed' && oauthStatus\.sessionAuth !== 'fresh'/)
    expect(source).toMatch(/state: 'about_to_retry'/)
  })

  test('renders the verbatim official storage_failed copy', () => {
    // fresh block
    expect(source).toMatch(
      /Logged in for now, but Claude Code couldn't confirm your new credentials were saved to \$\{backendDisplayName\}\./,
    )
    expect(source).toMatch(
      /Logged in for now, but your new credentials could not be saved to \$\{backendDisplayName\}\./,
    )
    expect(source).toMatch(
      /This login may expire mid-session and may not persist after you exit Claude Code\./,
    )
    expect(source).toMatch(
      /This login may expire mid-session and will not persist after you exit Claude Code\./,
    )
    // previous block
    expect(source).toMatch(
      /Sign-in completed in the browser, but your new credentials could not be saved to/,
    )
    expect(source).toMatch(
      /a previous login's credentials are still in place and will be used instead\./,
    )
    expect(source).toMatch(
      /\(Your new sign-in did not replace the existing credentials\.\)/,
    )
    // none block
    expect(source).toMatch(
      /Sign-in completed in the browser, but your credentials could not be saved to/,
    )
    expect(source).toMatch(/you are not logged in\./)
    expect(source).toMatch(
      /\(No previous login on this machine is usable right now either\.\)/,
    )
    // advice block
    expect(source).toMatch(/To avoid having to log in again each session:/)
    expect(source).toMatch(/fix access to/)
    expect(source).toMatch(/, then run \/login again/)
    expect(source).toMatch(/or run claude setup-token and set CLAUDE_CODE_OAUTH_TOKEN/)
    // footers
    expect(source).toMatch(/to continue…/)
    expect(source).toMatch(/to retry\./)
  })
})
