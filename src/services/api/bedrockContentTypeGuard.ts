import { isEnvTruthy } from '../../utils/envUtils.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'

/**
 * 2.1.208 (#16): Bedrock streaming content-type guard.
 *
 * A gateway or proxy between Claude Code and Bedrock can transform the binary
 * event-stream response body (e.g. re-encode it as `text/event-stream`). When
 * that happens, the AWS SDK's binary event-stream parser fails with a misleading
 * `Truncated event message received.` error — because the body is no longer
 * valid binary event-stream framing. This guard inspects the response
 * content-type up front and throws a clear, actionable error naming the
 * content-type and pointing at the proxy, instead of letting the misleading
 * truncation error surface from the SDK's parser.
 *
 * Matches the official 2.1.208 binary throw-site (verified against
 * /tmp/occ-gap210/p210/package/claude):
 *
 *   let d = u.headers.get("content-type"), p = d?.toLowerCase();
 *   if (n === "bedrock" && u.ok && l.includes("/invoke-with-response-stream")
 *       && d && !p?.includes("vnd.amazon.eventstream")
 *       && !Se.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD)
 *     throw u.body?.cancel().catch(() => {}), new E0c(d);
 *
 * where `n` is the provider, `u` the Response, `l` the request URL, `d` the
 * content-type, and `Se` the env object. `E0c` is `BedrockUnexpectedContentTypeError`
 * (extends `xn` = TelemetrySafeError) — the strings `BedrockUnexpectedContentType`,
 * `BedrockUnexpectedContentTypeError`, and `CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD`
 * are present in 210.strings and ABSENT from 206.strings (the 208 delta).
 *
 * Escape hatch: `CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD=1`.
 */

export const BEDROCK_STREAMING_PATH = '/invoke-with-response-stream'
export const BEDROCK_EVENTSTREAM_CONTENT_TYPE = 'vnd.amazon.eventstream'

/**
 * Error thrown when a Bedrock streaming response carries a content-type other
 * than `application/vnd.amazon.eventstream` — i.e. a gateway/proxy transformed
 * the binary event-stream body. Mirrors the binary's `E0c extends xn`.
 *
 * The full message names the observed content-type and points the user at the
 * proxy; `telemetryMessage` (the second super-arg) is a sanitized summary that
 * does not leak the (potentially request-specific) content-type value, matching
 * the binary's `super(msg, "Bedrock streaming response content-type is not application/vnd.amazon.eventstream")`.
 */
export class BedrockUnexpectedContentTypeError extends TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  readonly contentType: string
  readonly code = 'BedrockUnexpectedContentType'

  constructor(contentType: string) {
    super(
      `Bedrock streaming response has content-type ${JSON.stringify(contentType)}; expected "application/vnd.amazon.eventstream". A gateway or proxy between Claude Code and Bedrock is likely transforming the response body — Bedrock's binary event-stream format must be passed through unmodified. Set CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD=1 to suppress this check while the gateway is being fixed.`,
      'Bedrock streaming response content-type is not application/vnd.amazon.eventstream',
    )
    this.contentType = contentType
    this.name = 'BedrockUnexpectedContentTypeError'
  }
}

/**
 * Inspect a fetch Response and throw `BedrockUnexpectedContentTypeError` if a
 * gateway/proxy transformed a Bedrock streaming response's content-type away
 * from the expected `application/vnd.amazon.eventstream`. Otherwise returns
 * without throwing so the response passes through to the SDK unchanged.
 *
 * The request URL is passed in (rather than read off the Response) because the
 * binary checks the request-side URL `l` for `/invoke-with-response-stream`.
 * The provider is passed in (captured at fetch-wrapper build time, matching the
 * binary's `n`) so this stays a pure, env-isolated function — only the
 * escape-hatch reads `process.env`.
 *
 * Exported so the guard's decision logic is unit-testable directly (feeding a
 * real `Response` with a proxy-transformed content-type is the behavioral
 * done-gate, not a source-grep).
 */
export function assertBedrockStreamingContentType(
  response: Response,
  requestUrl: string,
  provider: string,
): void {
  // Only Bedrock streaming uses the binary event-stream format the guard
  // protects. Mantle/first-party/vertex use SSE and are unaffected.
  if (provider !== 'bedrock') return
  // A non-OK response is handled by normal error handling; only an OK
  // response with a wrong content-type is the "proxy transformed it" case.
  if (!response.ok) return
  // Only the Bedrock InvokeWithResponseStream endpoint streams binary events.
  if (!requestUrl.includes(BEDROCK_STREAMING_PATH)) return
  const contentType = response.headers.get('content-type')
  // No content-type header → nothing to assert; let the SDK proceed.
  if (!contentType) return
  // Correct content-type → pass through unchanged.
  const lower = contentType.toLowerCase()
  if (lower.includes(BEDROCK_EVENTSTREAM_CONTENT_TYPE)) return
  // Escape hatch: users whose gateway can't be fixed yet can opt out.
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD)) {
    return
  }
  // Fire-and-forget cancel (matches `u.body?.cancel().catch(()=>{})`), then
  // throw the clear, actionable error instead of the misleading
  // "Truncated event message received." from the AWS SDK parser.
  response.body?.cancel().catch(() => {})
  throw new BedrockUnexpectedContentTypeError(contentType)
}
