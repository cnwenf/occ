import { describe, expect, test } from "bun:test";
import { resolveBedrockAuthArgs } from "../client";

/**
 * claude-code 2.1.96: Bedrock bearer-token auth fix. skipAuth:true made the
 * Bedrock SDK strip the Authorization header → 403 "Authorization header is
 * missing" (2.1.94 regression). Fix: bearer token goes through the SDK's
 * apiKey field; skipAuth only when skip_auth AND no auth header.
 */
describe("2.1.96 resolveBedrockAuthArgs", () => {
  test("bearer token: apiKey set, skipAuth NOT set, authHeader on defaultHeaders", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: false,
      bearerToken: "mytoken",
    });
    expect(r.authHeader).toBe("Bearer mytoken");
    expect(r.skipAuth).toBe(false);
    expect(r.apiKey).toBe("mytoken"); // Bearer prefix stripped
  });

  test("bearer token takes precedence over skip_bedrock_auth (no skipAuth)", () => {
    // The 2.1.94 bug: this set skipAuth=true even with a bearer token.
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: true,
      bearerToken: "mytoken",
    });
    expect(r.skipAuth).toBe(false);
    expect(r.apiKey).toBe("mytoken");
    expect(r.authHeader).toBe("Bearer mytoken");
  });

  test("skip_bedrock_auth with no bearer: skipAuth true, no apiKey", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: true,
    });
    expect(r.skipAuth).toBe(true);
    expect(r.apiKey).toBeUndefined();
    expect(r.authHeader).toBeUndefined();
  });

  test("neither skip nor bearer: no skipAuth, no apiKey (AWS sigv4 path)", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: false,
    });
    expect(r.skipAuth).toBe(false);
    expect(r.apiKey).toBeUndefined();
    expect(r.authHeader).toBeUndefined();
  });

  test("falls back to a user-set Authorization header when no bearer env", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: false,
      existingAuthorization: "Bearer custom-token",
    });
    expect(r.authHeader).toBe("Bearer custom-token");
    expect(r.skipAuth).toBe(false);
    expect(r.apiKey).toBe("custom-token");
  });

  test("bearer env overrides a user-set Authorization header", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: false,
      bearerToken: "env-token",
      existingAuthorization: "Bearer custom-token",
    });
    expect(r.authHeader).toBe("Bearer env-token");
    expect(r.apiKey).toBe("env-token");
  });

  test("non-Bearer auth header is passed through as apiKey verbatim", () => {
    const r = resolveBedrockAuthArgs({
      skipBedrockAuth: false,
      existingAuthorization: "Basic abc123",
    });
    expect(r.authHeader).toBe("Basic abc123");
    expect(r.apiKey).toBe("Basic abc123"); // no Bearer prefix → verbatim
  });
});
