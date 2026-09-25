import { APIError } from '@anthropic-ai/sdk'
import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { AssistantMessage } from '../../../types/message.js'

/**
 * 2.1.281 #068 🔒 — HTML error-page sanitization in the 429 path.
 *
 * v280's no-quota-headers 429 branch composed `Request rejected (429) · detail`
 * straight from the raw server message, so a proxy/CDN HTML error page leaked raw
 * markup into the transcript. v281 (@201495169, byte-verified in
 * /tmp/cc-diff-281/vver/package/claude) sanitizes the non-JSON case:
 *
 *   try { inner = JSON.parse(stripped)?.error?.message ?? .message }
 *   catch { let s = wOr(e); if (s !== e.message) detail = s.replace(/^429(\s+|$)/,"") }
 *   detail = sanitized ?? (inner || stripped)
 *   …overage line: `${ua}: Request rejected (429)${detail ? ` \xB7 ${detail}` : ""}`
 *
 * `wOr` ≡ OCC's sanitizeAPIError (HTML → <title> text, or '' when no title).
 * OCC reconstructs the JSON.parse try/catch as "no inner "message" match ⟹
 * sanitize", which is equivalent because sanitizeAPIError only alters strings
 * that contain HTML — a JSON body without a "message" field has no markup, so
 * sanitized === raw and the code falls back to `inner || stripped` unchanged.
 */

// Force the 429 handler gate open: shouldProcessRateLimits(...) must be true.
// rateLimitMocking is a tiny facade — spread-real + override is the smallest mock.
const RATE_LIMIT_MOCKING_PATH = '../../rateLimitMocking.js'
const realRateLimitMocking = await import(RATE_LIMIT_MOCKING_PATH)
mock.module(RATE_LIMIT_MOCKING_PATH, () => ({
  ...realRateLimitMocking,
  shouldProcessRateLimits: () => true,
}))

const { getAssistantMessageFromError } = require('../errors.js') as typeof import('../errors.js')

const MODEL = 'claude-opus-5'
const PREFIX = 'API Error: Request rejected (429)'

/**
 * A 429 APIError with no rate-limit headers → skips the quota-header branch and
 * lands in the no-quota path this fix targets. makeMessage prepends "429 ".
 */
function rateLimitError(bodyMessage: string): APIError {
  return new APIError(429, { message: bodyMessage }, bodyMessage, undefined)
}

/** A 429 whose body has no top-level message → makeMessage JSON-stringifies it. */
function rateLimitJsonError(body: Record<string, unknown>): APIError {
  return new APIError(429, body, undefined, undefined)
}

/** Extract the rendered text from the AssistantMessage the handler returns. */
function messageText(msg: AssistantMessage): string {
  const content = msg.message.content as Array<{ text?: string }>
  return content.map(block => block.text ?? '').join('')
}

function textFor(error: APIError): string {
  return messageText(getAssistantMessageFromError(error, MODEL))
}

describe('2.1.281 #068 — 429 HTML error-page sanitization', () => {
  test('sanitizes an HTML proxy error page down to its <title> (no raw markup leaks)', () => {
    // Arrange — a CDN/proxy HTML page; the SDK prepends "429 " to error.message.
    const html =
      '<!DOCTYPE html><html><head><title>Rate Limited</title></head><body><h1>429</h1></body></html>'

    // Act
    const text = textFor(rateLimitError(html))

    // Assert — markup is gone; only the safe title survives.
    expect(text).not.toContain('<html')
    expect(text).not.toContain('<!DOCTYPE')
    expect(text).not.toContain('<body>')
    expect(text).toBe(`${PREFIX} · Rate Limited`)
  })

  test('does not duplicate a leading "429" carried by the sanitized title', () => {
    // Arrange — title itself begins with "429 "; binary strips /^429(\s+|$)/.
    const html = '<html><head><title>429 Too Many Requests</title></head></html>'

    // Act
    const text = textFor(rateLimitError(html))

    // Assert
    expect(text).toBe(`${PREFIX} · Too Many Requests`)
    expect(text).not.toContain('(429) · 429')
  })

  test('title-less HTML renders the bare status line (no markup, no separator)', () => {
    // Arrange — HTML with no <title> sanitizes to '' → detail is empty → bare line.
    const html = '<!DOCTYPE html><html><body>Server Error</body></html>'

    // Act
    const text = textFor(rateLimitError(html))

    // Assert — this is the "429 without detail renders bare" case.
    expect(text).toBe(PREFIX)
    expect(text).not.toContain('·')
    expect(text).not.toContain('<html')
  })

  test('a trailing newline in server text cannot break the status onto a 2nd line', () => {
    // Arrange — plain (non-HTML) body with a trailing newline.
    // Act
    const text = textFor(rateLimitError('Overloaded.\n'))

    // Assert — trimEnd keeps it on one line.
    expect(text).toBe(`${PREFIX} · Overloaded.`)
    expect(text).not.toContain('\n')
  })

  test('a JSON body still surfaces its inner message (no sanitization regression)', () => {
    // Arrange — the pre-#068 path: a JSON error body, no HTML.
    const error = rateLimitJsonError({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    })

    // Act
    const text = textFor(error)

    // Assert — inner "message" extracted verbatim.
    expect(text).toBe(`${PREFIX} · Rate limit exceeded`)
  })

  test('a plain text 429 detail is preserved unchanged', () => {
    // Arrange — non-HTML, non-JSON server text.
    // Act
    const text = textFor(rateLimitError('Overloaded, please retry'))

    // Assert
    expect(text).toBe(`${PREFIX} · Overloaded, please retry`)
  })
})

afterAll(() => {
  mock.restore()
})
