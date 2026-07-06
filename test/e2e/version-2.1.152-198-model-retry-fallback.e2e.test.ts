import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { REPO_ROOT } from "./helpers";

/**
 * claude-code 2.1.152–2.1.198 (model / api retry layer) e2e: source-grep
 * assertions that the OCC reconstruction matches the official 2.1.200 binary's
 * provider, retry-watchdog, and model-fallback behavior.
 *
 * Strings are verified against /tmp/occ-audit/claude.strings (the official
 * 2.1.200 binary) — see A12/A13/A16/A17 gap notes.
 *
 * Touches ONLY: src/utils/model/* + src/services/api/*.
 */
describe("2.1.152–2.1.198 model/retry layer (e2e)", () => {
  test("A12: anthropicAws (Claude Platform on AWS) upstream provider + failover", async () => {
    const script = `
const providers = await Bun.file("${REPO_ROOT}/src/utils/model/providers.ts").text();
const client = await Bun.file("${REPO_ROOT}/src/services/api/client.ts").text();
const retry = await Bun.file("${REPO_ROOT}/src/services/api/withRetry.ts").text();
const out = {
  // Provider type includes anthropic_aws
  typeHasAnthropicAws: providers.includes("'anthropic_aws'"),
  // Selection chain: CLAUDE_CODE_USE_ANTHROPIC_AWS -> "anthropic_aws"
  // Binary: it(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)?"anthropicAws"
  selectionEnv: providers.includes("CLAUDE_CODE_USE_ANTHROPIC_AWS"),
  selectionReturns: providers.includes("'anthropic_aws'"),
  // Binary order: bedrock -> foundry -> anthropicAws -> vertex (foundry before anthropicAws)
  orderBedrockBeforeFoundry:
    providers.indexOf("CLAUDE_CODE_USE_BEDROCK") < providers.indexOf("CLAUDE_CODE_USE_FOUNDRY"),
  orderFoundryBeforeAnthropicAws:
    providers.indexOf("CLAUDE_CODE_USE_FOUNDRY") < providers.indexOf("CLAUDE_CODE_USE_ANTHROPIC_AWS"),
  orderAnthropicAwsBeforeVertex:
    providers.indexOf("CLAUDE_CODE_USE_ANTHROPIC_AWS") < providers.indexOf("CLAUDE_CODE_USE_VERTEX"),
  // Base URL: ANTHROPIC_AWS_BASE_URL || https://aws-external-anthropic.\${region}.api.aws
  baseURLEnv: providers.includes("ANTHROPIC_AWS_BASE_URL"),
  baseURLDefault: providers.includes("aws-external-anthropic") && providers.includes(".api.aws"),
  baseURLHelper: providers.includes("getAnthropicAwsBaseURL"),
  // Workspace header (anthropic-workspace-id) from ANTHROPIC_AWS_WORKSPACE_ID
  workspaceEnv: providers.includes("ANTHROPIC_AWS_WORKSPACE_ID"),
  // CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH ("Claude Platform on AWS auth skipped")
  skipAuth: providers.includes("CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"),
  // Client constructs a standard Anthropic SDK client for anthropicAws
  clientBranch: client.includes("CLAUDE_CODE_USE_ANTHROPIC_AWS"),
  clientApiKey: client.includes("ANTHROPIC_AWS_API_KEY"),
  clientBaseURL: client.includes("aws-external-anthropic"),
  clientWorkspaceHeader: client.includes("anthropic-workspace-id"),
  clientSkipAuth: client.includes("CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH"),
  // Failover: anthropicAws/mantle 403 + CredentialsProviderError are retryable
  // Binary: if(it(CLAUDE_CODE_USE_ANTHROPIC_AWS)||it(CLAUDE_CODE_USE_MANTLE))
  //         {if(Uhi(e)||e instanceof Wo&&e.status===403)return!0}
  failoverEnv: retry.includes("CLAUDE_CODE_USE_ANTHROPIC_AWS") && retry.includes("CLAUDE_CODE_USE_MANTLE"),
  failoverCredsProvider: retry.includes("isAwsCredentialsProviderError"),
  failover403: /status === 403/.test(retry),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.typeHasAnthropicAws).toBe(true);
    expect(out.selectionEnv).toBe(true);
    expect(out.selectionReturns).toBe(true);
    expect(out.orderBedrockBeforeFoundry).toBe(true);
    expect(out.orderFoundryBeforeAnthropicAws).toBe(true);
    expect(out.orderAnthropicAwsBeforeVertex).toBe(true);
    expect(out.baseURLEnv).toBe(true);
    expect(out.baseURLDefault).toBe(true);
    expect(out.baseURLHelper).toBe(true);
    expect(out.workspaceEnv).toBe(true);
    expect(out.skipAuth).toBe(true);
    expect(out.clientBranch).toBe(true);
    expect(out.clientApiKey).toBe(true);
    expect(out.clientBaseURL).toBe(true);
    expect(out.clientWorkspaceHeader).toBe(true);
    expect(out.clientSkipAuth).toBe(true);
    expect(out.failoverEnv).toBe(true);
    expect(out.failoverCredsProvider).toBe(true);
    expect(out.failover403).toBe(true);
  });

  test("A13: CLAUDE_CODE_MAX_RETRIES cap-at-15 + CLAUDE_CODE_RETRY_WATCHDOG", async () => {
    const script = `
const retry = await Bun.file("${REPO_ROOT}/src/services/api/withRetry.ts").text();
const out = {
  // Watchdog flag: CLAUDE_CODE_RETRY_WATCHDOG (binary vge())
  watchdogEnv: retry.includes("CLAUDE_CODE_RETRY_WATCHDOG"),
  watchdogFn: retry.includes("isRetryWatchdogEnabled"),
  // Cap-at-15 (binary uZo=15): only applied when watchdog is OFF
  cap15: retry.includes("MAX_RETRIES_CLAMP") && retry.includes("> MAX_RETRIES_CLAMP") && retry.includes("!watchdog"),
  clampWarn: retry.includes("clamped to"),
  // Watchdog default 300 (binary zCm=300); normal default 10 (binary VCm=10)
  watchdogDefault: retry.includes("WATCHDOG_DEFAULT_MAX_RETRIES"),
  // getDefaultMaxRetries honors watchdog param (binary T3o: let e=vge())
  getDefaultSignature: /getDefaultMaxRetries\\s*\\(/.test(retry),
  // 529 background-drop suppressed when watchdog on (binary !vge() guard)
  bgDropGuarded: retry.includes("is529Error(error)") && retry.includes("!isRetryWatchdogEnabled()"),
  // custom 529 overload throw suppressed when watchdog on
  customOverloadGuarded: /isRetryWatchdogEnabled\\(\\)/.test(retry),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.watchdogEnv).toBe(true);
    expect(out.watchdogFn).toBe(true);
    expect(out.cap15).toBe(true);
    expect(out.clampWarn).toBe(true);
    expect(out.watchdogDefault).toBe(true);
    expect(out.getDefaultSignature).toBe(true);
    expect(out.bgDropGuarded).toBe(true);
    expect(out.customOverloadGuarded).toBe(true);
  });

  test("A16: fallback model triggered on model-not-found (not just 529)", async () => {
    const script = `
const retry = await Bun.file("${REPO_ROOT}/src/services/api/withRetry.ts").text();
const out = {
  // isModelNotFoundError (binary FTc): 404 + not_found_error + "model:"
  modelNotFoundFn: retry.includes("isModelNotFoundError"),
  modelNotFoundStatus: retry.includes("error.status !== 404"),
  modelNotFoundType: retry.includes('"type":"not_found_error"'),
  modelNotFoundMsg: retry.includes("model:"),
  // isModelPermissionDeniedError (binary UTc): 403 + permission_error + "model:"
  permDeniedFn: retry.includes("isModelPermissionDeniedError"),
  permDeniedType: retry.includes('"type":"permission_error"'),
  // Trigger reason resolver (binary R = FTc?"model_not_found":UTc?"permission_denied":"server_error")
  reasonFn: retry.includes("getFallbackTriggerReason"),
  reasonModelNotFound: retry.includes("'model_not_found'"),
  reasonPermDenied: retry.includes("'permission_denied'"),
  reasonServerError: retry.includes("'server_error'"),
  // FallbackTriggeredError carries the trigger
  fallbackCarriesTrigger: retry.includes("public readonly trigger"),
  // Telemetry: tengu_api_model_not_found_fallback_triggered (binary)
  telemetry: retry.includes("tengu_api_model_not_found_fallback_triggered"),
  // "API model not found: <model>" log (binary)
  logNotFound: retry.includes("API model not found:"),
  // Fallback condition includes model_not_found (not only 529)
  fallbackUsesReason: retry.includes("fallbackTriggerReason !== null"),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.modelNotFoundFn).toBe(true);
    expect(out.modelNotFoundStatus).toBe(true);
    expect(out.modelNotFoundType).toBe(true);
    expect(out.modelNotFoundMsg).toBe(true);
    expect(out.permDeniedFn).toBe(true);
    expect(out.permDeniedType).toBe(true);
    expect(out.reasonFn).toBe(true);
    expect(out.reasonModelNotFound).toBe(true);
    expect(out.reasonPermDenied).toBe(true);
    expect(out.reasonServerError).toBe(true);
    expect(out.fallbackCarriesTrigger).toBe(true);
    expect(out.telemetry).toBe(true);
    expect(out.logNotFound).toBe(true);
    expect(out.fallbackUsesReason).toBe(true);
  });

  test("A17: turn retry on fallback for unexpected non-retryable (watchdog retries overload/429)", async () => {
    const script = `
const retry = await Bun.file("${REPO_ROOT}/src/services/api/withRetry.ts").text();
const out = {
  // isWatchdogRetryable (binary WTc = Hge || status===429): overload || 429
  watchdogRetryableFn: retry.includes("isWatchdogRetryable"),
  watchdogRetryableOverload: /is529Error\\(error\\)/.test(retry),
  watchdogRetryable429: /status === 429/.test(retry),
  // Exhaustion check: attempt > maxRetries && !persistent && !watchdogRetryable
  // Binary: let T=vge()&&WTc(b); if(h>r&&!T) throw Ie("api_request","api_request_retry_exhausted")
  exhaustionGuard: retry.includes("!watchdogRetryable"),
  watchdogRetryableVar: retry.includes("watchdogRetryable"),
  // Comment referencing the binary's api_request_retry_exhausted
  retryExhaustedRef: retry.includes("api_request_retry_exhausted"),
};
console.log(JSON.stringify(out));
`;
    const out = JSON.parse((await $`bun -e ${script}`.quiet()).stdout.toString().trim());
    expect(out.watchdogRetryableFn).toBe(true);
    expect(out.watchdogRetryableOverload).toBe(true);
    expect(out.watchdogRetryable429).toBe(true);
    expect(out.exhaustionGuard).toBe(true);
    expect(out.watchdogRetryableVar).toBe(true);
    expect(out.retryExhaustedRef).toBe(true);
  });
});
