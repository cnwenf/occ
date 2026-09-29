import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

// Transitive imports read MACRO.VERSION (build-time constant polyfilled in
// cli.tsx). Mirror the repo-convention polyfill for test execution.
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: 'test' }
}

const { getAnthropicClient } = await import('../client.js')

/**
 * CC 2.1.284 (security, OCC-101) — ANTHROPIC_FOUNDRY_RESOURCE validator.
 *
 * Official v284 linux-x64 ELF, byte-verified:
 *   @203883609  var Ixr=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])$/i;
 *               function lf(e){return e!==void 0&&Ixr.test(e)?e:void 0}
 *   @203891512  factory guard — throws when RESOURCE is set, BASE_URL is
 *               unset, and lf(RESOURCE)===void 0.
 * v283 (`jh()` @202054583) interpolated the raw env value straight into
 * `https://${RESOURCE}.services.ai.azure.com` — a URL/host smuggled through
 * the resource var redirected inference traffic.
 *
 * These tests pin the guard at OCC's equivalent boundary (client
 * construction in getAnthropicClient) without performing any network I/O.
 */

const VALIDATION_MESSAGE =
  'ANTHROPIC_FOUNDRY_RESOURCE must be a Foundry resource name (2-64 letters, digits and hyphens, not starting or ending with a hyphen, such as my-resource), not a URL or host name. To use a full URL, set ANTHROPIC_FOUNDRY_BASE_URL instead.'

const SAVED_ENV_KEYS = [
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  // Keep the SDK off the Azure AD credential path — no network, no creds.
  process.env.ANTHROPIC_FOUNDRY_API_KEY = 'test-dummy-key'
})

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

async function rejectsWithValidationMessage(): Promise<boolean> {
  try {
    await getAnthropicClient({ maxRetries: 0 })
    return false
  } catch (error) {
    return error instanceof Error && error.message === VALIDATION_MESSAGE
  }
}

describe('CC 2.1.284 — Foundry resource-name guard (Ixr @203883609)', () => {
  test('rejects a host name smuggled through ANTHROPIC_FOUNDRY_RESOURCE', async () => {
    // Arrange — the v283 attack shape: resource var carrying a host
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'evil.services.ai.azure.com'

    // Act & Assert
    expect(await rejectsWithValidationMessage()).toBe(true)
  })

  test('rejects a full URL smuggled through ANTHROPIC_FOUNDRY_RESOURCE', async () => {
    // Arrange
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'https://evil.example.com/path'

    // Act & Assert
    expect(await rejectsWithValidationMessage()).toBe(true)
  })

  test('rejects leading/trailing hyphens, spaces, and 65-char names', async () => {
    // Arrange & Act & Assert — regex boundary cases
    for (const bad of [
      '-leading',
      'trailing-',
      'has space',
      'under_score',
      'a'.repeat(65),
    ]) {
      process.env.ANTHROPIC_FOUNDRY_RESOURCE = bad
      expect(await rejectsWithValidationMessage()).toBe(true)
    }
  })

  test('accepts a well-formed resource name (no validation throw)', async () => {
    // Arrange
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'my-resource'

    // Act & Assert — the guard must not fire; any later construction error
    // (missing SDK creds etc.) is out of scope, so only assert the message.
    expect(await rejectsWithValidationMessage()).toBe(false)
  })

  test('accepts 2-char and 64-char boundary names', async () => {
    // Arrange & Act & Assert
    for (const good of ['ab', 'a'.repeat(64), 'res-01']) {
      process.env.ANTHROPIC_FOUNDRY_RESOURCE = good
      expect(await rejectsWithValidationMessage()).toBe(false)
    }
  })

  test('single-char name is rejected (regex minimum length is 2)', async () => {
    // Ixr's second group is NOT optional — `(?:[a-z0-9-]{0,62}[a-z0-9])`
    // must match at least one char — so the true bounds are exactly the
    // "2-64" the official message claims.
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'a'
    expect(await rejectsWithValidationMessage()).toBe(true)
  })

  test('validation is skipped when ANTHROPIC_FOUNDRY_BASE_URL is set (official BASE_URL===void 0 condition)', async () => {
    // Arrange — with an explicit base URL the resource never reaches the
    // interpolated host, so the official guard does not apply.
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'not a valid name'
    process.env.ANTHROPIC_FOUNDRY_BASE_URL = 'https://foundry.example.com'

    // Act & Assert
    expect(await rejectsWithValidationMessage()).toBe(false)
  })

  test('unset ANTHROPIC_FOUNDRY_RESOURCE never throws the validation error', async () => {
    // Arrange — RESOURCE undefined (official `Ne!==void 0` precondition)
    // Act & Assert
    expect(await rejectsWithValidationMessage()).toBe(false)
  })
})
