/**
 * Environment variables that control inference routing: which provider to use,
 * which endpoint to hit, and which model IDs to send.
 *
 * When CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST is truthy in the spawn env, these
 * are stripped from settings-sourced env so the host's routing config isn't
 * overridden by a user's ~/.claude/settings.json — e.g. a Bedrock setup for
 * terminal CLI that would break a host that only supports first-party auth.
 *
 * @[MODEL LAUNCH]: New models usually don't need changes here —
 * VERTEX_REGION_CLAUDE_* is prefix-matched. New providers or new routing
 * config vars (endpoint, project, region, auth) do.
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // The flag itself — settings can't unset it once the host set it
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // Provider selection
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Endpoint config (base URLs, project/resource identifiers)
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  // Region routing (per-model VERTEX_REGION_CLAUDE_* handled by prefix below)
  'CLOUD_ML_REGION',
  // Auth
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  // Model defaults — often set to provider-specific ID formats
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  // 2.1.257 (Gap-113b): member of the official provider-managed set `Tg`
  // (byte-verified in the 2.1.258 ELF).
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  // CC 2.1.296 (#003): member of the official managed-env list (@208771578)
  // and 3P-probe list (@208765415); schema-registered as `H.str()` right
  // after SUBAGENT_MODEL/_FORCE (`CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL:()=>LU`).
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
])

const PROVIDER_MANAGED_ENV_PREFIXES = [
  // Per-model Vertex region overrides — scales with model releases, so
  // prefix-matched to avoid drift on each launch.
  'VERTEX_REGION_CLAUDE_',
]

export function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase()
  return (
    PROVIDER_MANAGED_ENV_VARS.has(upper) ||
    PROVIDER_MANAGED_ENV_PREFIXES.some(p => upper.startsWith(p))
  )
}

/**
 * CC 2.1.300 (#55) — "Changed CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST sessions to
 * ignore CA-bundle, tool-proxy, git TLS and git config variables like
 * SSL_CERT_FILE in settings; under Claude Desktop, only in project settings."
 *
 * Official v300 filter fn `b(e,n,r,i)` @219874600 strips a settings env var
 * when `r.managedByHostFlag && (!r.desktopHost || oJe(n)) && (Vln(s) || iJe(s))`
 * (docs/gap-research-300/triage-T3.md ## 55). The two predicate arms:
 *
 *   Vln(s) = Tl.has(s.toUpperCase())                     // proxy set (9 vars)
 *   iJe(s) = Ky.has(s.toUpperCase()) || vDr(s)           // mTLS/auth ∪ Pl ∪ git regexes
 *   vDr(s) = Pl.includes(upper) || l5n.test(s) || mQe.test(s)
 *   Pl     = dedup([...pte, ...Gme, ...CYn.upper, ...vl, ...(pJ∖fQe)])
 *            .filter(x => x≠NODE_EXTRA_CA_CERTS && x≠JAVA_TOOL_OPTIONS && x∉Tl)
 *   Ky     = Set(CLAUDE_CODE_CLIENT_CERT, CLAUDE_CODE_CLIENT_KEY,
 *            CLAUDE_CODE_CLIENT_KEY_PASSPHRASE, NODE_EXTRA_CA_CERTS,
 *            NODE_TLS_REJECT_UNAUTHORIZED, CLAUDE_CODE_OAUTH_SCOPES, ...Pl)
 *   l5n    = /^GIT_(?:SSL|PROXY)_/i
 *   mQe    = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i
 *
 * Every list member below is byte-verified against the v300 ELF: Tl @216530205,
 * pte(TYn∪AYn)/Gme/vl @216530140 + @216517650, CYn @216520764, fQe/pJ
 * @216276040. JAVA_TOOL_OPTIONS is a CYn member that the official Pl filter
 * explicitly DROPS, so it is NOT stripped. NODE_EXTRA_CA_CERTS is filtered out
 * of Pl but re-included via the Ky base, so it IS stripped.
 *
 * NOTE: the git repo-location vars (fQe) are intentionally KEPT — they say
 * *where* the repo is (GIT_DIR, GIT_WORK_TREE, …), not *how* to establish TLS,
 * so a host-managed session still needs them to locate the checkout.
 */

// Tl — the proxy arm `Vln`. @216530205
const HOST_MANAGED_PROXY_VARS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'CLAUDE_CODE_HTTP_PROXY',
  'CLAUDE_CODE_HTTPS_PROXY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTP_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
])

// Ky base — the mTLS/auth vars stripped independent of Pl. @216530140
const HOST_MANAGED_MTLS_AUTH_VARS = [
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'CLAUDE_CODE_OAUTH_SCOPES',
]

// pte = TYn(6) ∪ AYn(8) — CA-bundle vars. @216530140 / @216517650
const HOST_MANAGED_CA_BUNDLE_VARS = [
  // TYn
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE',
  'HTTPLIB2_CA_CERTS',
  // AYn
  'AWS_CA_BUNDLE',
  'DENO_CERT',
  'CARGO_HTTP_CAINFO',
  'PIP_CERT',
  'GIT_SSL_CAINFO',
  'GRPC_DEFAULT_SSL_ROOTS_FILE_PATH',
  'NIX_SSL_CERT_FILE',
  'HEX_CACERTS_PATH',
]

// Gme — native-TLS CA-store switches. @216530140
const HOST_MANAGED_NATIVE_TLS_VARS = ['UV_NATIVE_TLS', 'DENO_TLS_CA_STORE']

// CYn — per-tool proxy vars (uppercased for membership). @216520764
const HOST_MANAGED_TOOL_PROXY_VARS = [
  'YARN_HTTP_PROXY',
  'YARN_HTTPS_PROXY',
  'NPM_CONFIG_PROXY',
  'NPM_CONFIG_HTTPS_PROXY',
  'NPM_CONFIG_NOPROXY',
  'GLOBAL_AGENT_HTTP_PROXY',
  'GLOBAL_AGENT_HTTPS_PROXY',
  'GLOBAL_AGENT_NO_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'ELECTRON_GET_USE_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'CLOUDSDK_PROXY_USERNAME',
  'CLOUDSDK_PROXY_PASSWORD',
  'FSSPEC_GCS',
  'JAVA_TOOL_OPTIONS',
]

// vl — extra SSL/proxy vars. @216276040
const HOST_MANAGED_SSL_EXTRA_VARS = ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'ALL_PROXY']

// fQe — git repo-location vars. KEPT (excluded from the strip). @216276040
export const GIT_REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SHALLOW_FILE',
  'GIT_NAMESPACE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_REFERENCE_BACKEND',
]

// pJ∖fQe — the git-config vars (pJ minus the repo-location fQe). @216276040
const HOST_MANAGED_GIT_CONFIG_VARS = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG',
]

// l5n / mQe — git TLS/proxy + indexed git-config regexes. @216530140
const GIT_TLS_OR_PROXY_REGEX = /^GIT_(?:SSL|PROXY)_/i
const GIT_INDEXED_CONFIG_REGEX = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i

// Pl — the deduped CA/native-TLS/tool-proxy/SSL/git-config list, after the
// official filter drops NODE_EXTRA_CA_CERTS, JAVA_TOOL_OPTIONS, and Tl members.
const HOST_MANAGED_PL_VARS: ReadonlySet<string> = (() => {
  const pl = new Set<string>()
  for (const raw of [
    ...HOST_MANAGED_CA_BUNDLE_VARS,
    ...HOST_MANAGED_NATIVE_TLS_VARS,
    ...HOST_MANAGED_TOOL_PROXY_VARS,
    ...HOST_MANAGED_SSL_EXTRA_VARS,
    ...HOST_MANAGED_GIT_CONFIG_VARS,
  ]) {
    const upper = raw.toUpperCase()
    if (upper === 'NODE_EXTRA_CA_CERTS') continue
    if (upper === 'JAVA_TOOL_OPTIONS') continue
    if (HOST_MANAGED_PROXY_VARS.has(upper)) continue
    pl.add(upper)
  }
  return pl
})()

// Ky — the explicit mTLS/auth base ∪ Pl.
const HOST_MANAGED_KY_VARS: ReadonlySet<string> = new Set([
  ...HOST_MANAGED_MTLS_AUTH_VARS,
  ...HOST_MANAGED_PL_VARS,
])

/**
 * True when `key` is a TLS/proxy/CA/git-config var that a host-managed session
 * must ignore from settings (official `Vln(s) || iJe(s)`). Case-insensitive on
 * the set arms; the git regexes test the raw key (also case-insensitive).
 */
export function isHostManagedTlsOrProxyVar(key: string): boolean {
  const upper = key.toUpperCase()
  // Vln arm — proxy set.
  if (HOST_MANAGED_PROXY_VARS.has(upper)) return true
  // iJe arm — Ky (mTLS/auth ∪ Pl).
  if (HOST_MANAGED_KY_VARS.has(upper)) return true
  // vDr regex arms — git TLS/proxy + indexed git-config.
  if (GIT_TLS_OR_PROXY_REGEX.test(key)) return true
  if (GIT_INDEXED_CONFIG_REGEX.test(key)) return true
  return false
}

/**
 * Dangerous shell settings that can execute arbitrary shell code
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
] as const

/**
 * Safe environment variables that can be applied before trust dialog.
 * These are Claude Code specific settings that don't pose security risks.
 *
 * IMPORTANT: This is the source of truth for which env vars are safe.
 * Any env var NOT in this list is considered dangerous and will trigger
 * a security dialog when set via remote managed settings.
 *
 * Dangerous env vars (NOT in this list):
 *
 * === REDIRECT TO ATTACKER-CONTROLLED SERVER ===
 * - ANTHROPIC_BASE_URL, ANTHROPIC_BEDROCK_BASE_URL, ANTHROPIC_FOUNDRY_BASE_URL, ANTHROPIC_VERTEX_BASE_URL
 * - HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
 * - OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
 *
 * === TRUST ATTACKER-CONTROLLED SERVER ===
 * - NODE_TLS_REJECT_UNAUTHORIZED
 * - NODE_EXTRA_CA_CERTS
 *
 * === SWITCH TO ATTACKER-CONTROLLED PROJECT ===
 * - ANTHROPIC_FOUNDRY_RESOURCE
 * - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 * - AWS_BEARER_TOKEN_BEDROCK
 */
export const SAFE_ENV_VARS = new Set([
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_WORKSPACE_ID',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  // 2.1.288 (#14): structured-outputs kill switch (second independent arm of
  // the official v288 gate `aEn`@202198805; registered in the official v288
  // env registry @199612605 and paired with DISABLE_EXPERIMENTAL_BETAS in the
  // session-env set @212352579 and the child-env propagation
  // `...a.X&&{X:"1"}` @213670299). Note: the official pre-trust safe-env
  // allowlist (@199900616 region) does NOT list it — OCC registers it here
  // anyway as a curated extension: like its DISABLE_EXPERIMENTAL_BETAS
  // sibling it is fail-safe (can only stop output_config.format being sent;
  // no redirect/trust/exfil surface), so applying it from settings before the
  // trust dialog cannot harm.
  'CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS',
  'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
  'CLAUDE_CODE_ENABLE_AUTO_MODE',
  'CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  // 2.1.280 (#003): member of the official safe-env allowlist `Wl`
  // (byte-verified in the 2.1.280 ELF @191031530, listed between
  // CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL and CLAUDE_CODE_MAX_OUTPUT_TOKENS).
  // Caps MCP tool descriptions / server instructions; numeric, no routing or
  // trust impact — safe to apply before the trust dialog.
  'CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE',
  'CLAUDE_CODE_PROPAGATE_TRACEPARENT',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
  // CC 2.1.296 (#003): same class of model-routing var as
  // CLAUDE_CODE_SUBAGENT_MODEL above — a model ID preference with no
  // endpoint/trust impact.
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'DISABLE_COMPACT',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_TELEMETRY',
  'ENABLE_TOOL_SEARCH',
  'FORCE_HYPERLINK',
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_RAW_API_BODIES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_INCLUDE_ENTRYPOINT',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  'TRACEPARENT',
  'TRACESTATE',
  'USE_BUILTIN_RIPGREP',
  'VERTEX_REGION_CLAUDE_3_5_HAIKU',
  'VERTEX_REGION_CLAUDE_3_5_SONNET',
  'VERTEX_REGION_CLAUDE_3_7_SONNET',
  'VERTEX_REGION_CLAUDE_4_0_OPUS',
  'VERTEX_REGION_CLAUDE_4_0_SONNET',
  'VERTEX_REGION_CLAUDE_4_1_OPUS',
  'VERTEX_REGION_CLAUDE_4_5_SONNET',
  'VERTEX_REGION_CLAUDE_4_6_SONNET',
  'VERTEX_REGION_CLAUDE_HAIKU_4_5',
  'VERTEX_REGION_CLAUDE_HAIKU_5_5',
])
