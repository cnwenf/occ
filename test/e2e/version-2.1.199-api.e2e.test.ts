import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.199 (api layer) e2e: source-grep assertions that the OCC
 * reconstruction matches the official binary's mid-stream / SSL / subagent
 * error behavior.
 *
 * Strings are verified against /tmp/occ-audit/claude.strings (the official
 * 2.1.200 binary) — see J1/J2/J3 gap notes.
 *
 * Touches ONLY: src/services/api/* + src/query.ts + src/QueryEngine.ts.
 */
describe("2.1.199 api layer (e2e)", () => {
  test("J1: mid-stream partial responses are finalized with an incomplete-response notice", async () => {
    const script = `
const f = await Bun.file("${REPO_ROOT}/src/services/api/claude.ts").text();
const out = {
  stalledNotice: f.includes("Response stalled mid-stream. The response above may be incomplete."),
  serverErrorNotice: f.includes("Server error mid-response. The response above may be incomplete."),
  connectionClosedNotice: f.includes("Connection closed mid-response. The response above may be incomplete."),
  finalizeLog: f.includes("finalizing partial response"),
  telemetry: f.includes("tengu_streaming_partial_finalized"),
  // Partial is kept (return), not discarded+retried, when real output was yielded
  hasPartialOutputGuard: f.includes("hasPartialOutput"),
  causes: ["watchdog", "server_error", "stale_connection"].every(c => f.includes(c)),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.stalledNotice).toBe(true);
    expect(out.serverErrorNotice).toBe(true);
    expect(out.connectionClosedNotice).toBe(true);
    expect(out.finalizeLog).toBe(true);
    expect(out.telemetry).toBe(true);
    expect(out.hasPartialOutputGuard).toBe(true);
    expect(out.causes).toBe(true);
  });

  test("J2: SSL certificate errors fail immediately (no retry) with a fix hint", async () => {
    const script = `
const retry = await Bun.file("${REPO_ROOT}/src/services/api/withRetry.ts").text();
const utils = await Bun.file("${REPO_ROOT}/src/services/api/errorUtils.ts").text();
const out = {
  // shouldRetry returns false for SSL before the APIConnectionError retry branch
  sslNoRetry: retry.includes("isSSLError") && retry.includes("APIConnectionError"),
  sslFailFastComment: retry.includes("never retryable"),
  // user-facing fix hint (matches official wording)
  hint: utils.includes("SSL certificate error"),
  extraCerts: utils.includes("NODE_EXTRA_CA_CERTS"),
  allowlist: utils.includes("*.anthropic.com"),
  // specific SSL code -> message mapping
  selfSigned: utils.includes("Self-signed certificate detected"),
  certExpired: utils.includes("SSL certificate has expired"),
  certRevoked: utils.includes("SSL certificate has been revoked"),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.sslNoRetry).toBe(true);
    expect(out.sslFailFastComment).toBe(true);
    expect(out.hint).toBe(true);
    expect(out.extraCerts).toBe(true);
    expect(out.allowlist).toBe(true);
    expect(out.selfSigned).toBe(true);
    expect(out.certExpired).toBe(true);
    expect(out.certRevoked).toBe(true);
  });

  test("J3: subagents cut off by an API error report model_error to the parent", async () => {
    const script = `
const f = await Bun.file("${REPO_ROOT}/src/query.ts").text();
const out = {
  // On isApiErrorMessage, subagents (agentId) return model_error, not completed
  subagentModelError: f.includes("toolUseContext.agentId") &&
    f.includes("reason: 'model_error'") &&
    f.includes("subagent terminated due to API error"),
  // Main thread still returns completed (error message already shown to user)
  mainCompleted: /return \\{ reason: 'completed' \\}/.test(f),
  stopFailureHooks: f.includes("executeStopFailureHooks"),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.subagentModelError).toBe(true);
    expect(out.mainCompleted).toBe(true);
    expect(out.stopFailureHooks).toBe(true);
  });
});
