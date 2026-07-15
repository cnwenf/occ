import { afterEach, describe, expect, test } from "bun:test";
import {
  assertBedrockStreamingContentType,
  BedrockUnexpectedContentTypeError,
  BEDROCK_EVENTSTREAM_CONTENT_TYPE,
  BEDROCK_STREAMING_PATH,
} from "../bedrockContentTypeGuard";
import { buildFetch } from "../client";

/**
 * claude-code 2.1.208 (#16): Bedrock streaming content-type guard.
 *
 * When a gateway/proxy between Claude Code and Bedrock transforms the binary
 * event-stream response (content-type no longer application/vnd.amazon.eventstream),
 * the AWS SDK parser throws a misleading "Truncated event message received."
 * The 208 fix adds a fetch-wrapper guard that inspects the content-type up
 * front and throws a clear BedrockUnexpectedContentTypeError naming the
 * content-type + pointing at the proxy, with a CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD=1
 * escape hatch.
 *
 * Binary throw-site (verified in /tmp/occ-gap210/p210/package/claude, ABSENT
 * from 206.strings — the 208 delta):
 *   if (n==="bedrock" && u.ok && l.includes("/invoke-with-response-stream")
 *       && d && !p?.includes("vnd.amazon.eventstream")
 *       && !Se.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD)
 *     throw u.body?.cancel().catch(()=>{}), new E0c(d);
 */

const BEDROCK_STREAMING_URL = `https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet${BEDROCK_STREAMING_PATH}`;
const SAVED_GUARD = process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD;

afterEach(() => {
  if (SAVED_GUARD === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD;
  } else {
    process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD = SAVED_GUARD;
  }
});

/** Build a real streaming Response with the given content-type + body chunks. */
function streamingResponse(
  contentType: string,
  body: string,
  init?: { status?: number },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { "content-type": contentType },
  });
}

describe("2.1.208 BedrockUnexpectedContentTypeError", () => {
  test("message names the content-type, points at the proxy, and offers the escape hatch", () => {
    const err = new BedrockUnexpectedContentTypeError("text/event-stream");
    expect(err.name).toBe("BedrockUnexpectedContentTypeError");
    expect(err.code).toBe("BedrockUnexpectedContentType");
    expect(err.contentType).toBe("text/event-stream");
    // content-type is JSON-stringified into the message (matches binary's JSON.stringify(e))
    expect(err.message).toContain(JSON.stringify("text/event-stream"));
    expect(err.message).toContain("application/vnd.amazon.eventstream");
    expect(err.message).toContain("gateway or proxy");
    expect(err.message).toContain("CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD=1");
    // telemetryMessage is the sanitized summary (no content-type value leaked)
    expect(err.telemetryMessage).toBe(
      "Bedrock streaming response content-type is not application/vnd.amazon.eventstream",
    );
  });

  test("content-type with special chars is safely quoted in the message", () => {
    const weird = 'text/event-stream; charset="utf-8"';
    const err = new BedrockUnexpectedContentTypeError(weird);
    expect(err.contentType).toBe(weird);
    expect(err.message).toContain(JSON.stringify(weird));
  });
});

describe("2.1.208 assertBedrockStreamingContentType guard logic", () => {
  test("proxy-transformed content-type (text/event-stream) THROWS the clear error, not the misleading truncation error", () => {
    const res = streamingResponse("text/event-stream", "event: ping\n\n");
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).toThrow(BedrockUnexpectedContentTypeError);
    // The misleading AWS-SDK message must NOT be what surfaces
    try {
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock");
    } catch (e) {
      expect((e as Error).message).not.toContain("Truncated event message");
    }
  });

  test("correct content-type (application/vnd.amazon.eventstream) passes through, no throw", () => {
    const res = streamingResponse(
      "application/vnd.amazon.eventstream",
      new Uint8Array([0, 0, 0, 1]).toString(),
    );
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).not.toThrow();
  });

  test("content-type with params still passes through when it includes vnd.amazon.eventstream", () => {
    const res = streamingResponse(
      "application/vnd.amazon.eventstream; charset=utf-8",
      "x",
    );
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).not.toThrow();
  });

  test("escape hatch CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD=1 suppresses the guard", () => {
    process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD = "1";
    const res = streamingResponse("text/event-stream", "event: ping\n\n");
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).not.toThrow();
  });

  test("escape hatch OFF (0) keeps the guard active", () => {
    process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD = "0";
    const res = streamingResponse("text/event-stream", "event: ping\n\n");
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).toThrow(BedrockUnexpectedContentTypeError);
  });

  test("non-bedrock provider (firstParty) skips the guard even with transformed content-type", () => {
    const res = streamingResponse("text/event-stream", "event: ping\n\n");
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "firstParty"),
    ).not.toThrow();
  });

  test("non-streaming bedrock URL (no /invoke-with-response-stream) skips the guard", () => {
    const res = streamingResponse("text/event-stream", "event: ping\n\n");
    expect(() =>
      assertBedrockStreamingContentType(
        res,
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/foo/invoke",
        "bedrock",
      ),
    ).not.toThrow();
  });

  test("non-OK response (500) skips the guard — let normal error handling own it", () => {
    const res = streamingResponse("text/event-stream", "error", {
      status: 500,
    });
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).not.toThrow();
  });

  test("missing content-type header skips the guard", () => {
    const res = new Response("body", { status: 200 });
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).not.toThrow();
  });

  test("guard cancels the streaming body before throwing", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ping\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(() =>
      assertBedrockStreamingContentType(res, BEDROCK_STREAMING_URL, "bedrock"),
    ).toThrow(BedrockUnexpectedContentTypeError);
    // cancel() is fire-and-forget; let the microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
});

describe("2.1.208 buildFetch integration — guard is wired into the fetch path", () => {
  test("wrapped fetch rejects with BedrockUnexpectedContentTypeError for proxy-transformed bedrock stream", async () => {
    // buildFetch captures the provider at build time via getAPIProvider(), which
    // reads CLAUDE_CODE_USE_BEDROCK. Set it so provider === "bedrock".
    const savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      delete process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD;
      const transformed = streamingResponse("text/event-stream", "event: ping\n\n");
      // Mock the inner fetch: return the proxy-transformed bedrock response.
      const wrapped = buildFetch(
        () => Promise.resolve(transformed),
        "test-source",
      );
      await expect(
        wrapped(BEDROCK_STREAMING_URL, {}),
      ).rejects.toBeInstanceOf(BedrockUnexpectedContentTypeError);
    } finally {
      if (savedBedrock === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK;
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
      }
    }
  });

  test("wrapped fetch passes through the correct bedrock event-stream response", async () => {
    const savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    try {
      delete process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD;
      const ok = streamingResponse(
        "application/vnd.amazon.eventstream",
        "x",
      );
      const wrapped = buildFetch(() => Promise.resolve(ok), "test-source");
      const res = await wrapped(BEDROCK_STREAMING_URL, {});
      expect(res).toBe(ok);
    } finally {
      if (savedBedrock === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK;
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
      }
    }
  });

  test("escape hatch lets the transformed response pass through the fetch wrapper", async () => {
    const savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD = "1";
    try {
      const transformed = streamingResponse("text/event-stream", "event: ping\n\n");
      const wrapped = buildFetch(
        () => Promise.resolve(transformed),
        "test-source",
      );
      const res = await wrapped(BEDROCK_STREAMING_URL, {});
      expect(res).toBe(transformed);
    } finally {
      if (savedBedrock === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK;
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
      }
      delete process.env.CLAUDE_CODE_DISABLE_BEDROCK_CONTENT_TYPE_GUARD;
    }
  });
});
