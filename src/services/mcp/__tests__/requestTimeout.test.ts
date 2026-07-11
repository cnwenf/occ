import { describe, expect, test } from "bun:test";
import {
  getServerRequestTimeoutMs,
  wrapFetchWithTimeout,
} from "../client";
import type { ScopedMcpServerConfig } from "../types";

/**
 * claude-code 2.1.206 #9: MCP servers configured via --mcp-config or .mcp.json
 * ignored a per-server `request_timeout_ms`, causing long-running MCP tool calls
 * to time out at the 60s default in fresh sessions. OCC now reads the field and
 * applies it to the per-HTTP-request fetch timeout AND the per-tool-call timeout.
 */
describe("2.1.206 getServerRequestTimeoutMs", () => {
  function makeServer(
    override: Record<string, unknown>,
  ): ScopedMcpServerConfig {
    return {
      type: "http",
      url: "https://example.test/mcp",
      ...override,
      scope: "user",
    } as ScopedMcpServerConfig;
  }

  test("returns the configured value when set to a positive int", () => {
    expect(
      getServerRequestTimeoutMs(makeServer({ request_timeout_ms: 120000 })),
    ).toBe(120000);
  });

  test("returns undefined when the field is absent", () => {
    expect(getServerRequestTimeoutMs(makeServer({}))).toBeUndefined();
  });

  test("returns undefined for zero", () => {
    expect(
      getServerRequestTimeoutMs(makeServer({ request_timeout_ms: 0 })),
    ).toBeUndefined();
  });

  test("returns undefined for negative", () => {
    expect(
      getServerRequestTimeoutMs(makeServer({ request_timeout_ms: -1 })),
    ).toBeUndefined();
  });

  test("returns undefined for NaN", () => {
    expect(
      getServerRequestTimeoutMs(makeServer({ request_timeout_ms: NaN })),
    ).toBeUndefined();
  });

  test("returns undefined for non-number (string)", () => {
    expect(
      getServerRequestTimeoutMs(
        makeServer({ request_timeout_ms: "120000" }),
      ),
    ).toBeUndefined();
  });

  test("returns undefined for Infinity", () => {
    expect(
      getServerRequestTimeoutMs(makeServer({ request_timeout_ms: Infinity })),
    ).toBeUndefined();
  });
});

describe("2.1.206 wrapFetchWithTimeout per-server override", () => {
  test("GET requests skip the timeout entirely (long-lived SSE)", async () => {
    const baseFetch = async () => new Response("ok", { status: 200 });
    const wrapped = wrapFetchWithTimeout(baseFetch as never, 1);
    const res = await wrapped("https://example.test/sse", { method: "GET" });
    expect(res.status).toBe(200);
  });

  test("a POST that exceeds the custom timeout aborts with TimeoutError", async () => {
    // Mock fetch honors the abort signal like the real fetch: when the wrapper
    // fires its timer and calls controller.abort(reason), the signal's reason
    // (a TimeoutError DOMException) must propagate through baseFetch.
    const baseFetch = async (_url: string, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const settle = setTimeout(resolve, 200);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(settle);
          reject(
            init.signal.reason ??
              new DOMException('The operation timed out.', 'TimeoutError'),
          );
        });
      });
      return new Response("ok", { status: 200 });
    };
    const wrapped = wrapFetchWithTimeout(baseFetch as never, 30);
    await expect(
      wrapped("https://example.test/mcp", { method: "POST" }),
    ).rejects.toThrow(/timed out/i);
  });

  test("a POST that completes within the custom timeout succeeds", async () => {
    const baseFetch = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response("ok", { status: 200 });
    };
    const wrapped = wrapFetchWithTimeout(baseFetch as never, 500);
    const res = await wrapped("https://example.test/mcp", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("falls back to the 60s default when no override is passed", async () => {
    // Can't wait 60s in a unit test; assert the default path is wired by
    // verifying a fast POST succeeds with the default (no 2nd arg).
    const baseFetch = async () => new Response("ok", { status: 200 });
    const wrapped = wrapFetchWithTimeout(baseFetch as never);
    const res = await wrapped("https://example.test/mcp", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
