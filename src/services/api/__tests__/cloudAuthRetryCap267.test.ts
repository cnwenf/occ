import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

/**
 * CC 2.1.267 (#9, Gap-121d): cloud credential error retries are capped at 2
 * (official ZDn/eNn) — the loop throws CannotRetryError on the 3rd
 * occurrence with api_request_aws_auth_exhausted /
 * api_request_gcp_auth_exhausted telemetry, instead of cache-clearing and
 * retrying up to DEFAULT_MAX_RETRIES (10).
 *
 * Also ports the official classifier surface:
 *   - `eJ`/`zxt`: CredentialsProviderError matched via a depth-5 .cause walk.
 *   - `JOn`/`JQ`: google-auth-library messages matched via the cause walk,
 *     list extended to QOn+z$o (adds invalid_client, unauthorized_client,
 *     "Failed to acquire Google OAuth credentials.").
 *
 * Red-test baseline: with CLAUDE_CODE_USE_BEDROCK set, a persistent
 * CredentialsProviderError previously made 11 attempts (maxRetries 10); with
 * CLAUDE_CODE_USE_VERTEX set, "invalid_client" or a cause-wrapped credential
 * message was NOT recognized and threw on attempt 1 via the unhandled-error
 * path (no cache-clear retry at all).
 */

const { withRetry, CannotRetryError } =
  require('../withRetry.js') as typeof import('../withRetry.js')

const CLOUD_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

function credentialsProviderError(): Error {
  const error = new Error('Could not load credentials from any provider')
  error.name = 'CredentialsProviderError'
  return error
}

/** Drain the withRetry generator; return how many operation attempts ran. */
async function runUntilThrow(
  failWith: () => Error,
  maxRetries = 10,
): Promise<{ attempts: number; threw: unknown }> {
  let attempts = 0
  const gen = withRetry(
    async () => ({}) as never, // dummy client — operation throws before use
    async () => {
      attempts++
      throw failWith()
    },
    {
      maxRetries,
      model: 'test-model',
      thinkingConfig: { type: 'disabled' as const },
    },
  )
  try {
    while (true) {
      const next = await gen.next()
      if (next.done) break
    }
    return { attempts, threw: null }
  } catch (e) {
    return { attempts, threw: e }
  }
}

describe('2.1.267 #9 cloud auth retry cap (within 3, not 11)', () => {
  test('Bedrock: persistent CredentialsProviderError throws on the 3rd attempt', async () => {
    // Arrange — before the cap this looped maxRetries+1 = 11 times,
    // cache-clearing on every attempt.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    // Act
    const { attempts, threw } = await runUntilThrow(credentialsProviderError)

    // Assert — cap 2 → throws CannotRetryError on the 3rd occurrence.
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  })

  test('Vertex: newly recognized "invalid_client" retries and caps at 3', async () => {
    // Arrange — invalid_client was NOT in OCC's message list before; the
    // error took the unhandled non-APIError path and threw on attempt 1.
    // Official QOn adds it; now it clears the cache, retries, and caps.
    process.env.CLAUDE_CODE_USE_VERTEX = '1'

    // Act
    const { attempts, threw } = await runUntilThrow(
      () => new Error('invalid_client: client not found'),
    )

    // Assert
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  })

  test('Vertex: credential message on a wrapped cause is found (depth-5 walk)', async () => {
    // Arrange — official JOn walks .cause chains; OCC previously matched the
    // top-level message only, so this wrapper threw on attempt 1.
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    const makeWrapped = () => {
      const inner = new Error('Could not refresh access token')
      const middle = new Error('token refresh failed', { cause: inner })
      return new Error('request failed', { cause: middle })
    }

    // Act
    const { attempts, threw } = await runUntilThrow(makeWrapped)

    // Assert — recognized as a vertex auth error → retried → capped at 3.
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  })

  test('Bedrock: persistent APIError 403 caps at 3 for non-first-party provider', async () => {
    // Arrange — classifier `eJ` returns null for APIErrors with a status
    // (HTTP response, not a credential error), but the official loop's
    // second clause `!iW()&&udt(...)` (non-first-party && bedrock auth
    // error) still counts it toward the AWS cap.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const make403 = () =>
      new APIError(
        403,
        { message: 'The security token included in the request is invalid' },
        'The security token included in the request is invalid',
        undefined,
      )

    // Act
    const { attempts, threw } = await runUntilThrow(make403)

    // Assert
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(3)
  })

  test('no cloud env: CredentialsProviderError still fails fast (unchanged)', async () => {
    // Arrange — the classifier counts it as AWS, but with no Bedrock env the
    // error is not a handled cloud auth error, so the pre-existing
    // unhandled-error path throws CannotRetryError immediately. The cap must
    // NOT turn unhandled errors into retryable ones.
    // Act
    const { attempts, threw } = await runUntilThrow(credentialsProviderError)

    // Assert
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test('Vertex: deep cause chain beyond depth 5 is not matched', async () => {
    // Arrange — official `lq` stops after 5 links. Wrap the credential
    // message 6 levels deep: not recognized → unhandled path → attempt 1.
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    const makeDeep = () => {
      let error: Error = new Error('Could not load the default credentials')
      for (let i = 0; i < 6; i++) {
        error = new Error(`wrapper-${i}`, { cause: error })
      }
      return error
    }

    // Act
    const { attempts, threw } = await runUntilThrow(makeDeep)

    // Assert — walk depth exhausted; falls through to the immediate throw.
    expect(threw).toBeInstanceOf(CannotRetryError)
    expect(attempts).toBe(1)
  })

  test(
    'non-cloud errors keep the normal retry budget (no regression)',
    async () => {
      // Arrange — a 500 APIError is not a cloud credential error; it must
      // exhaust maxRetries+1 = 4 attempts (proving the cloud cap of 3 does
      // not apply), NOT bail at 3. Timeout raised: real backoff sleeps run
      // between attempts (getRetryDelay is not mocked).
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      const make500 = () =>
        new APIError(
          500,
          { message: 'Internal server error' },
          'boom',
          undefined,
        )

      // Act
      const { attempts, threw } = await runUntilThrow(make500, 3)

      // Assert
      expect(threw).toBeInstanceOf(CannotRetryError)
      expect(attempts).toBe(4)
    },
    30000,
  )
})
