import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  NotFoundError,
} from '@anthropic-ai/sdk'
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 2.1.281 #067 — /model failure message humanization + classification flags.
 *
 * The byte-verified v281 mapper (`A` @208670286, retryable-status helper `C`
 * @208671019, in /tmp/cc-diff-281/vver/package/claude) turns a failed model
 * probe into a human message plus flags:
 *   - generic API error →
 *       `API error: ${QZ(e).replace(/[.!?…]+$/,"")} \xB7 model not changed`
 *     with `retryable` spread in ONLY when `C(status)` = undefined|408|429|>=500.
 *   - AuthenticationError → `authFailed:!0` ONLY. The binary does NOT mark auth
 *     retryable (re-auth is a user action). The triage prose grouped
 *     "authFailed+retryable" across the branch SET; the byte-verified auth branch
 *     carries authFailed alone, and these tests assert the binary, not the prose.
 *   - NotFoundError / not_found_error body → `notFound:!0`
 *   - APIConnectionError / unknown error → `retryable:!0`
 *
 * `QZ` ≡ OCC's formatAPIError. The " · model not changed" suffix keeps a failed
 * switch from looking applied. The `permissionDenied` branch (binary `lDt`) is
 * staged — OCC has no equivalent entitlement helper.
 */

// Drive validateModel()'s catch path: sideQuery throws whatever the active test
// staged, and the allowlist gate is opened so the probe reaches the API call.
const SIDE_QUERY_PATH = '../../sideQuery.js'
const ALLOWLIST_PATH = '../modelAllowlist.js'
const realSideQuery = await import(SIDE_QUERY_PATH)
const realAllowlist = await import(ALLOWLIST_PATH)

let probeError: unknown

mock.module(SIDE_QUERY_PATH, () => ({
  ...realSideQuery,
  sideQuery: async () => {
    throw probeError
  },
}))
mock.module(ALLOWLIST_PATH, () => ({
  ...realAllowlist,
  isModelAllowed: () => true,
}))

const { validateModel } = require('../validateModel.js') as typeof import('../validateModel.js')

// Not an alias, not the custom-model env override, and never cached (failures
// don't populate validModelCache) — so every call reaches sideQuery.
const PROBE_MODEL = 'probe-model-281'

beforeEach(() => {
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  probeError = undefined
})

afterAll(() => {
  mock.restore()
})

/** SDK makeMessage prepends "<status> " when both status and body message exist. */
function apiError(status: number | undefined, message: string): APIError {
  return new APIError(status, { message }, message, undefined)
}

describe('2.1.281 #067 — generic API error mapper', () => {
  test('humanizes via formatAPIError and appends " · model not changed"', async () => {
    // Arrange — an HTML body: formatAPIError (binary QZ) sanitizes it to the
    // <title>, proving the branch routes through QZ rather than raw error.message
    // (v280 used `API error: ${error.message}`).
    probeError = apiError(
      400,
      '<html><head><title>Bad Request</title></head></html>',
    )

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.valid).toBe(false)
    expect(result.error).toBe('API error: Bad Request · model not changed')
    expect(result.error?.endsWith(' · model not changed')).toBe(true)
    expect(result.error).not.toContain('<html')
  })

  test('passes a plain server message through and strips trailing punctuation', async () => {
    // Arrange — makeMessage yields "400 Model rejected."; the trailing "." goes.
    probeError = apiError(400, 'Model rejected.')

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert — binary regex `[.!?…]+$`
    expect(result.error).toBe('API error: 400 Model rejected · model not changed')
    expect(result.error).not.toContain('rejected. ·')
  })

  test('strips a trailing ellipsis (…)', async () => {
    // Arrange
    probeError = apiError(400, 'Loading…')

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.error).toBe('API error: 400 Loading · model not changed')
  })
})

describe('2.1.281 #067 — retryable classification (binary C(status))', () => {
  test('marks 408 / 429 / 500 / 503 retryable', async () => {
    for (const status of [408, 429, 500, 503]) {
      probeError = apiError(status, 'Transient failure')
      const result = await validateModel(PROBE_MODEL)
      expect(result.retryable).toBe(true)
    }
  })

  test('marks an undefined status retryable (connection-level failure)', async () => {
    // Arrange
    probeError = apiError(undefined, 'Server hiccup')

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.retryable).toBe(true)
  })

  test('omits retryable for a 400 (field absent, not false — binary conditional spread)', async () => {
    // Arrange
    probeError = apiError(400, 'Bad request')

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert — binary `...C(e.status)&&{retryable:!0}` omits the field for 400.
    expect(result.retryable).toBeUndefined()
    expect(result.retryable).toBeFalsy()
  })
})

describe('2.1.281 #067 — error-class branches', () => {
  test('AuthenticationError sets authFailed only (NOT retryable — binary @208670286)', async () => {
    // Arrange
    probeError = new AuthenticationError(
      401,
      { message: 'invalid x-api-key' },
      'invalid x-api-key',
      undefined,
    )

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert — the byte-verified auth branch returns authFailed:!0 with NO
    // retryable field. (Triage prose said "authFailed+retryable"; binary wins.)
    expect(result.valid).toBe(false)
    expect(result.error).toBe(
      'Authentication failed. Please check your API credentials.',
    )
    expect(result.authFailed).toBe(true)
    expect(result.retryable).toBeUndefined()
  })

  test('NotFoundError sets notFound', async () => {
    // Arrange
    probeError = new NotFoundError(404, { message: 'not found' }, 'not found', undefined)

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not found')
    expect(result.notFound).toBe(true)
  })

  test('APIConnectionError sets retryable', async () => {
    // Arrange
    probeError = new APIConnectionError({ message: 'Connection error.' })

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.valid).toBe(false)
    expect(result.error).toBe(
      'Network error. Please check your internet connection.',
    )
    expect(result.retryable).toBe(true)
  })

  test('not_found_error body sets notFound', async () => {
    // Arrange — a 404 APIError (not the NotFoundError class) carrying a
    // not_found_error body whose message references "model:".
    probeError = new APIError(
      404,
      { type: 'not_found_error', message: 'No such model: foo' },
      'No such model: foo',
      undefined,
    )

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.valid).toBe(false)
    expect(result.error).toBe(`Model '${PROBE_MODEL}' not found`)
    expect(result.notFound).toBe(true)
  })

  test('unknown (non-API) error sets retryable', async () => {
    // Arrange
    probeError = new Error('boom')

    // Act
    const result = await validateModel(PROBE_MODEL)

    // Assert
    expect(result.valid).toBe(false)
    expect(result.error).toBe('Unable to validate model: boom')
    expect(result.retryable).toBe(true)
  })
})
