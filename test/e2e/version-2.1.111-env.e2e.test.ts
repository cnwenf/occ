import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.110–2.1.193 env-var gaps (e2e):
 *   F10 (2.1.152) OTEL_METRICS_INCLUDE_ENTRYPOINT → app.entrypoint attribute
 *   F11 (2.1.193) OTEL_LOG_ASSISTANT_RESPONSES → assistant_response OTEL log event
 *   F12 (2.1.111) OTEL_LOG_RAW_API_BODIES → file:/inline modes
 *   F13 (2.1.110) TRACEPARENT/TRACESTATE → distributed trace linking
 *   F17 (2.1.94)  FORCE_HYPERLINK honored from settings.json env
 *   F18 (2.1.111) CLAUDE_CODE_MAX_CONTEXT_TOKENS honors DISABLE_COMPACT
 */

const src = (rel: string) =>
  readFileSync(`${REPO_ROOT}/${rel}`, "utf8").replace(/\s+/g, " ");

// ---------- F10: OTEL_METRICS_INCLUDE_ENTRYPOINT ----------
describe("F10 OTEL_METRICS_INCLUDE_ENTRYPOINT (2.1.152)", () => {
  test("getEntrypointName reads CLAUDE_CODE_ENTRYPOINT against the valid set", async () => {
    const script = `
process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
const { getEntrypointName } = await import("${REPO_ROOT}/src/utils/telemetryAttributes.ts");
const a = getEntrypointName();
process.env.CLAUDE_CODE_ENTRYPOINT = "bogus-entrypoint";
const b = getEntrypointName();
delete process.env.CLAUDE_CODE_ENTRYPOINT;
const c = getEntrypointName();
console.log(JSON.stringify({ a, b, c }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe("cli");
    expect(out.b).toBeUndefined();
    expect(out.c).toBeUndefined();
  });

  test("telemetryAttributes wires app.entrypoint + default false", () => {
    const s = src("src/utils/telemetryAttributes.ts");
    expect(s).toContain("OTEL_METRICS_INCLUDE_ENTRYPOINT: false");
    expect(s).toContain("'app.entrypoint'");
    expect(s).toContain("shouldIncludeAttribute('OTEL_METRICS_INCLUDE_ENTRYPOINT')");
  });
});

// ---------- F11: OTEL_LOG_ASSISTANT_RESPONSES ----------
describe("F11 OTEL_LOG_ASSISTANT_RESPONSES + assistant_response (2.1.193)", () => {
  test("falls back to OTEL_LOG_USER_PROMPTS; redacts/truncates", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/utils/telemetry/events.ts");
// No env set → false (USER_PROMPTS unset)
delete process.env.OTEL_LOG_ASSISTANT_RESPONSES;
delete process.env.OTEL_LOG_USER_PROMPTS;
const a = m.isAssistantResponseLoggingEnabled();
// ASSISTANT_RESPONSES explicitly false, USER_PROMPTS true → false (takes precedence)
process.env.OTEL_LOG_ASSISTANT_RESPONSES = "0";
process.env.OTEL_LOG_USER_PROMPTS = "1";
const b = m.isAssistantResponseLoggingEnabled();
// ASSISTANT_RESPONSES unset, USER_PROMPTS true → true (fallback)
delete process.env.OTEL_LOG_ASSISTANT_RESPONSES;
const c = m.isAssistantResponseLoggingEnabled();
// redacted when disabled
delete process.env.OTEL_LOG_USER_PROMPTS;
const d = m.getAssistantResponseForLogging("hello");
// content when enabled
process.env.OTEL_LOG_ASSISTANT_RESPONSES = "1";
const e = m.getAssistantResponseForLogging("hello");
// truncated when over 61440
const big = "x".repeat(70000);
const f = m.getAssistantResponseForLogging(big);
console.log(JSON.stringify({ a, b, c, d, e, fLen: f.length, fTrunc: f.includes("[truncated]") }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe(false);
    expect(out.b).toBe(false);
    expect(out.c).toBe(true);
    expect(out.d).toBe("<REDACTED>");
    expect(out.e).toBe("hello");
    expect(out.fTrunc).toBe(true);
  });

  test("logging.ts emits the assistant_response event", () => {
    const s = src("src/services/api/logging.ts");
    expect(s).toContain("logOTelEvent('assistant_response'");
    expect(s).toContain("response_length");
    expect(s).toContain("getAssistantResponseForLogging");
    expect(s).toContain("query_source");
  });
});

// ---------- F12: OTEL_LOG_RAW_API_BODIES ----------
describe("F12 OTEL_LOG_RAW_API_BODIES (2.1.111)", () => {
  test("parses file:/inline/disabled modes (memoized)", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/utils/telemetry/rawApiBodies.ts");
delete process.env.OTEL_LOG_RAW_API_BODIES;
const a = m.getRawApiBodiesConfig();
process.env.OTEL_LOG_RAW_API_BODIES = "0";
const b = m.getRawApiBodiesConfig();
process.env.OTEL_LOG_RAW_API_BODIES = "1";
const c = m.getRawApiBodiesConfig();
process.env.OTEL_LOG_RAW_API_BODIES = "file:/tmp/raw";
const d = m.getRawApiBodiesConfig();
process.env.OTEL_LOG_RAW_API_BODIES = "file:";
const e = m.getRawApiBodiesConfig();
process.env.OTEL_LOG_RAW_API_BODIES = "1";
const enInline = m.isRawApiBodiesLoggingEnabled();
process.env.OTEL_LOG_RAW_API_BODIES = "file:";
const enFileEmpty = m.isRawApiBodiesLoggingEnabled();
console.log(JSON.stringify({ a: a.mode, b: b.mode, c: c.mode, dMode: d.mode, dDir: d.mode==='file'?d.dir:undefined, e: e.mode, enInline, enFileEmpty }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe("disabled");
    expect(out.b).toBe("disabled");
    expect(out.c).toBe("inline");
    expect(out.dMode).toBe("file");
    expect(out.dDir).toContain("raw");
    expect(out.e).toBe("disabled");
    expect(out.enInline).toBe(true);
    expect(out.enFileEmpty).toBe(false);
  });

  test("claude.ts logs api_request_body; logging.ts logs api_response_body", () => {
    expect(src("src/services/api/claude.ts")).toContain(
      "logRawApiBody('api_request_body'",
    );
    expect(src("src/services/api/logging.ts")).toContain(
      "logRawApiBody('api_response_body'",
    );
  });
});

// ---------- F13: TRACEPARENT/TRACESTATE ----------
describe("F13 TRACEPARENT/TRACESTATE (2.1.110)", () => {
  test("shouldPropagateTraceparent + getIncomingTraceContext", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/utils/telemetry/traceparentPropagation.ts");
// No first-party base url override + no env → depends on default base url (true for api.anthropic.com default)
// Force the env gate on.
delete process.env.ANTHROPIC_BASE_URL;
process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT = "1";
const a = m.shouldPropagateTraceparent();
delete process.env.CLAUDE_CODE_PROPAGATE_TRACEPARENT;
process.env.TRACEPARENT = "00-bogus-0";
const b = m.getIncomingTraceContext();
delete process.env.TRACEPARENT;
const c = m.getIncomingTraceContext();
process.env.TRACEPARENT = "00-trace-span";
process.env.TRACESTATE = "k=v";
const d = m.getIncomingTraceContext();
console.log(JSON.stringify({ a, bTP: b?.traceparent, c, dTP: d?.traceparent, dTS: d?.tracestate }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBe(true);
    expect(out.bTP).toBe("00-bogus-0");
    expect(out.c).toBeUndefined();
    expect(out.dTP).toBe("00-trace-span");
    expect(out.dTS).toBe("k=v");
  });

  test("claude.ts forwards traceparent/tracestate headers", () => {
    const s = src("src/services/api/claude.ts");
    expect(s).toContain("shouldPropagateTraceparent()");
    expect(s).toContain("getIncomingTraceContext()");
    expect(s).toContain("traceparent: incomingTrace.traceparent");
    expect(s).toContain("tracestate: incomingTrace.tracestate");
  });

  test("sessionTracing extracts env TRACEPARENT into the interaction span", () => {
    const s = src("src/utils/telemetry/sessionTracing.ts");
    expect(s).toContain("propagation.extract(otelContext.active()");
    expect(s).toContain("traceparent: process.env.TRACEPARENT");
    expect(s).toContain("tracestate: process.env.TRACESTATE");
  });
});

// ---------- F17: FORCE_HYPERLINK ----------
describe("F17 FORCE_HYPERLINK (2.1.94)", () => {
  test("honors FORCE_HYPERLINK from env (settings.json env flows to process.env)", async () => {
    const script = `
const { supportsHyperlinks } = await import("${REPO_ROOT}/src/ink/supports-hyperlinks.ts");
const env = (v) => { const e = { FORCE_HYPERLINK: v }; return supportsHyperlinks({ env: e, stdoutSupported: false }); };
console.log(JSON.stringify({
  one: env("1"),       // explicit enable
  zero: env("0"),      // explicit disable
  empty: env(""),      // set but empty → enabled
  junk: env("yes"),    // truthy non-zero → enabled
}));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.one).toBe(true);
    expect(out.zero).toBe(false);
    expect(out.empty).toBe(true);
    expect(out.junk).toBe(true);
  });

  test("FORCE_HYPERLINK is in the SAFE_ENV_VARS allowlist (settings.json env)", () => {
    expect(src("src/utils/managedEnvConstants.ts")).toContain(
      "'FORCE_HYPERLINK'",
    );
  });
});

// ---------- F18: CLAUDE_CODE_MAX_CONTEXT_TOKENS honors DISABLE_COMPACT ----------
describe("F18 MAX_CONTEXT_TOKENS honors DISABLE_COMPACT (2.1.111)", () => {
  test("getMaxContextTokensOverride + getContextWindowForModel", async () => {
    const script = `
const m = await import("${REPO_ROOT}/src/utils/context.ts");
// DISABLE_COMPACT unset → no override
delete process.env.DISABLE_COMPACT;
delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
delete process.env.USER_TYPE;
const a = m.getMaxContextTokensOverride();
// DISABLE_COMPACT set + MAX_CONTEXT_TOKENS → override honored
process.env.DISABLE_COMPACT = "1";
process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = "50000";
const b = m.getMaxContextTokensOverride();
// DISABLE_COMPACT unset, MAX_CONTEXT_TOKENS set → override NOT honored (cOi gate)
delete process.env.DISABLE_COMPACT;
const c = m.getMaxContextTokensOverride();
// getContextWindowForModel returns the override when DISABLE_COMPACT set
process.env.DISABLE_COMPACT = "1";
const d = m.getContextWindowForModel("claude-sonnet-4");
console.log(JSON.stringify({ a, b, c, d }));
`;
    const out = JSON.parse(
      (await $`bun -e ${script}`.quiet()).stdout.toString().trim(),
    );
    expect(out.a).toBeUndefined();
    expect(out.b).toBe(50000);
    expect(out.c).toBeUndefined();
    expect(out.d).toBe(50000);
  });

  test("DISABLE_COMPACT is in SAFE_ENV_VARS allowlist", () => {
    expect(src("src/utils/managedEnvConstants.ts")).toContain(
      "'DISABLE_COMPACT'",
    );
    expect(src("src/utils/managedEnvConstants.ts")).toContain(
      "'CLAUDE_CODE_MAX_CONTEXT_TOKENS'",
    );
  });
});
