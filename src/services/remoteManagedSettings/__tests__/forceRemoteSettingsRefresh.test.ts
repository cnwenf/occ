import { describe, expect, test, mock } from "bun:test";
import { SettingsSchema } from "../../../utils/settings/types";

// MACRO polyfill — getClaudeCodeUserAgent() reads MACRO.VERSION, a build-time
// constant polyfilled in cli.tsx for runtime execution (same pattern as
// webfetchDeadline268.test.ts and other in-process tests). Without it the
// eligible fetch path throws ReferenceError inside fetchRemoteManagedSettings,
// which classifyAxiosError deems retryable ('other') — a 5-retry backoff storm
// that overruns the 10s per-test timeout. Mirror the polyfill so the fetch
// path works in tests.
if (typeof globalThis.MACRO === "undefined") {
  ;(globalThis as { MACRO?: unknown }).MACRO = { VERSION: "test" };
}

/**
 * claude-code 2.1.92: forceRemoteSettingsRefresh policy — block startup until
 * remote managed settings are freshly fetched; exit (fail-closed) on failure.
 *
 * Hermetic network boundary (OCC-129): eligibility is decided from ambient
 * credentials. With ANY ANTHROPIC_API_KEY present — including the CI dummy key
 * (scripts/ci-test.sh) — "Console users (API key): all eligible" applies and
 * the force-refresh issues a real axios.get to {BASE_API_URL}/api/claude_code/
 * settings. On a clean-env machine (GitHub runner) that request fails with 401
 * for the dummy key (or hangs); on dev machines the outcome depends on the
 * real key's org and the network. Neither belongs in a unit test, so axios is
 * mocked (same pattern as WebFetchTool's webfetchDeadline268.test.ts) and the
 * fetch always returns the documented "no settings exist" shape (404 →
 * success with empty settings → valid:true). The non-eligible short-circuit
 * path (custom ANTHROPIC_BASE_URL / no credentials) also ends in valid:true,
 * so the assertions hold deterministically in every environment.
 */
const actualAxios = await import("axios");
const mockedGet = mock(
  async (_url: string, _config?: unknown): Promise<unknown> => ({
    status: 404,
    data: {},
    headers: {},
  }),
);
mock.module("axios", () => ({
  ...actualAxios,
  default: { ...actualAxios.default, get: mockedGet },
}));

const { forceRefreshRemoteManagedSettingsOrFailClosed } = await import(
  "../index"
);

describe("2.1.92 forceRemoteSettingsRefresh: schema", () => {
  test("accepts forceRemoteSettingsRefresh: true", () => {
    expect(
      SettingsSchema().safeParse({ forceRemoteSettingsRefresh: true }).success,
    ).toBe(true);
  });
  test("accepts omitting it", () => {
    expect(SettingsSchema().safeParse({}).success).toBe(true);
  });
});

describe("forceRefreshRemoteManagedSettingsOrFailClosed", () => {
  test("returns valid:true when not eligible (no backend configured)", async () => {
    // In the test env there's no remote-managed-settings backend, so the
    // fresh-fetch short-circuits to "nothing to fetch" — not a failure.
    // With credentials present the fetch runs but the mocked endpoint reports
    // "no settings exist" (404) — same valid:true outcome, no real network.
    const result = await forceRefreshRemoteManagedSettingsOrFailClosed();
    expect(result.valid).toBe(true);
    expect(typeof result.message).toBe("string");
  });
});
