import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { ALLOWED_OAUTH_BASE_URLS } from '../../constants/oauth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'

export type APIProvider =
  | 'firstParty'
  | 'bedrock'
  | 'vertex'
  | 'foundry'
  | 'anthropic_aws'
  | 'mantle'
  | 'gateway'

export function getAPIProvider(): APIProvider {
  // Match the official 2.1.200 binary selection order exactly:
  //   CLAUDE_CODE_USE_BEDROCK       -> "bedrock"
  //   CLAUDE_CODE_USE_FOUNDRY       -> "foundry"
  //   CLAUDE_CODE_USE_ANTHROPIC_AWS -> "anthropicAws"   (2.1.198: Claude Platform on AWS)
  //   CLAUDE_CODE_USE_MANTLE        -> "mantle"          (2.1.94: Bedrock Mantle)
  //   CLAUDE_CODE_USE_VERTEX        -> "vertex"
  //   default                       -> "firstParty"
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
      ? 'foundry'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)
        ? 'anthropic_aws'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)
          ? 'mantle'
          : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
            ? 'vertex'
            : 'firstParty'
}

/**
 * 2.1.94 (A15): Bedrock Mantle (`CLAUDE_CODE_USE_MANTLE`).
 *
 * Mantle is an Anthropic-operated Bedrock-derived offering routed through
 * `https://bedrock-mantle.<region>.api.aws`. When a user sets BOTH
 * `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_MANTLE`, the binary promotes
 * the effective provider from "bedrock" to "mantle" (mantle wins). This mirrors
 * the binary's promotion helper:
 *   `if (fr() === "bedrock" && it(CLAUDE_CODE_USE_MANTLE)) return "mantle"`
 *
 * Binary references (claude.strings):
 *   - `it(process.env.CLAUDE_CODE_USE_MANTLE)?"mantle"`
 *   - `CLAUDE_CODE_SKIP_MANTLE_AUTH`, `CLAUDE_CODE_MANTLE_BASE_URL`
 *   - `https://bedrock-mantle.${region}.api.aws`, `bedrock-mantle`,
 *     `mantle-fallback`, `tengu_mantle_default_check`
 */
export function isMantleProvider(): boolean {
  return getAPIProvider() === 'mantle'
}

/**
 * The effective provider, applying the bedrock→mantle promotion when both
 * `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_MANTLE` are set. Matches the
 * binary's promotion helper (fr()==="bedrock" && CLAUDE_CODE_USE_MANTLE => "mantle").
 */
export function getEffectiveAPIProvider(): APIProvider {
  const provider = getAPIProvider()
  if (provider === 'bedrock' && isEnvTruthy(process.env.CLAUDE_CODE_USE_MANTLE)) {
    return 'mantle'
  }
  return provider
}

/**
 * Whether auth is skipped for Bedrock Mantle (CLAUDE_CODE_SKIP_MANTLE_AUTH).
 */
export function isSkipMantleAuth(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SKIP_MANTLE_AUTH)
}

/**
 * Default base URL for Bedrock Mantle, derived from the AWS region.
 * Mirrors the binary's `https://bedrock-mantle.${region}.api.aws`.
 */
export function getMantleBaseURL(): string {
  return (
    process.env.CLAUDE_CODE_MANTLE_BASE_URL ||
    `https://bedrock-mantle.${getAWSRegion()}.api.aws`
  )
}

/**
 * 2.1.198 (A12): Claude Platform on AWS (`anthropicAws` / `anthropic_aws`).
 * Anthropic-operated AWS offering with same-day API parity. Uses bare
 * first-party model IDs (NOT the `anthropic.` Bedrock prefix). The standard
 * Anthropic SDK client is used against an AWS endpoint, authenticated via
 * `ANTHROPIC_AWS_API_KEY` (or desktop-app-managed credentials), with an
 * optional workspace header.
 *
 * Binary references (claude.strings):
 *   - `it(process.env.CLAUDE_CODE_USE_ANTHROPIC_AWS)?"anthropicAws"`
 *   - baseURL: `process.env.ANTHROPIC_AWS_BASE_URL||\`https://aws-external-anthropic.${O4e()}.api.aws\``
 *   - "Claude Platform on AWS auth skipped" (CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH)
 *   - auth failover: 403 / CredentialsProviderError are retryable for anthropicAws
 */
export function isAnthropicAwsProvider(): boolean {
  return getAPIProvider() === 'anthropic_aws'
}

/**
 * Default base URL for Claude Platform on AWS, derived from the AWS region.
 * Mirrors the binary's `https://aws-external-anthropic.${region}.api.aws`.
 */
export function getAnthropicAwsBaseURL(): string {
  return (
    process.env.ANTHROPIC_AWS_BASE_URL ||
    `https://aws-external-anthropic.${getAWSRegion()}.api.aws`
  )
}

/**
 * Whether auth is skipped for Claude Platform on AWS
 * (CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH).
 */
export function isSkipAnthropicAwsAuth(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH)
}

/**
 * Workspace header value for Claude Platform on AWS
 * (ANTHROPIC_AWS_WORKSPACE_ID), sent as `anthropic-workspace-id`.
 */
export function getAnthropicAwsWorkspaceId(): string | undefined {
  return process.env.ANTHROPIC_AWS_WORKSPACE_ID
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 *
 * Port of the official base-url allowlist predicate, byte-verified in the
 * 2.1.274 binary (named `Xo` there; `es` in 2.1.275/276):
 *   function Xo(){if(a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return dw()}
 *   function dw(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return av(e)}
 *   function av(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 * The api-staging arm for USER_TYPE=ant is an OCC superset (the official
 * ships api-staging.anthropic.com in sibling allowlists, e.g. the
 * `new Set(["api.anthropic.com","api-staging.anthropic.com",...])` set).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  if (isEnvTruthy(process.env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)) {
    return true
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}

/**
 * Whether the current provider is Anthropic-operated ("first-party owned").
 *
 * Port of the official 2.1.280 `al()` predicate (byte-verified @193045941):
 *   function al(){let e=ms();return e==="firstParty"||e==="anthropicAws"||e==="gateway"}
 * `ms()` is the official provider resolver including its gateway arm; OCC's
 * getAPIProvider() never returns 'gateway' (no managed-gateway build surface)
 * and OCC folds the official anthropicGoogleCloud arm into firstParty, so the
 * port checks the same three official provider names against
 * getAPIProvider(). Used by the 2.1.280 default-model resolver (`cv`),
 * parseUserSpecifiedModel's legacy-Opus remap gate (`kt`), and the picker
 * option builders (`wj`/`Pv`/`r7`).
 */
export function isAnthropicOwnedProvider(): boolean {
  const provider = getAPIProvider()
  return (
    provider === 'firstParty' ||
    provider === 'anthropic_aws' ||
    provider === 'gateway'
  )
}

/**
 * 2.1.285 (item: ANTHROPIC_AUTH_TOKEN org policy fix): port of the official
 * endpoint-host predicate `ng(e)` used to gate the env-bearer fallback in the
 * auth header builder (`cRe`). Byte-verified in the 2.1.285 binary
 * (auth chunk-f74xvn8g):
 *
 *   var RC="api.anthropic.com";                                     // @198111811
 *   function tg(){if(a.ANTHROPIC_BASE_URL)return Vi(a.ANTHROPIC_BASE_URL);return RC}
 *   function ng(e){return ji(tg(),e)}
 *   function ji(e,n){let r=MC(n)?Vi(n):void 0;return e!==void 0&&e===r&&DC(r)}
 *   function MC(e){try{return new URL(e).protocol==="https:"}catch{return!1}}
 *   function Vi(e){if(!e)return;try{return new URL(e).host}catch{return}}
 *   function DC(e){return vh(`https://${e}`)||mIe.some((n)=>Vi(n)===e)}
 *   function vh(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 *
 * i.e. the endpoint must be https, its host must equal the configured
 * ANTHROPIC_BASE_URL host (defaulting to api.anthropic.com), and that host
 * must be api.anthropic.com or one of the approved FedStart/staging OAuth
 * hosts (`mIe` — OCC's ALLOWED_OAUTH_BASE_URLS).
 */
const DEFAULT_ANTHROPIC_BASE_HOST = 'api.anthropic.com'

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function isApprovedCredentialHost(host: string): boolean {
  if (host === DEFAULT_ANTHROPIC_BASE_HOST) {
    return true
  }
  return ALLOWED_OAUTH_BASE_URLS.some(url => hostOf(url) === host)
}

export function isEndpointOnConfiguredAnthropicBase(
  endpoint: string,
): boolean {
  // tg(): `if(a.ANTHROPIC_BASE_URL)return Vi(a.ANTHROPIC_BASE_URL);return RC`
  // — a SET-but-unparseable base yields undefined (Vi catches), and ji()'s
  // `e!==void 0` guard then rejects every endpoint. Only an UNSET base
  // defaults to RC.
  const baseHost = process.env.ANTHROPIC_BASE_URL
    ? hostOf(process.env.ANTHROPIC_BASE_URL)
    : DEFAULT_ANTHROPIC_BASE_HOST
  let endpointHost: string
  try {
    const parsed = new URL(endpoint)
    // MC: https only
    if (parsed.protocol !== 'https:') {
      return false
    }
    endpointHost = parsed.host
  } catch {
    return false
  }
  return (
    baseHost !== undefined &&
    endpointHost === baseHost &&
    isApprovedCredentialHost(endpointHost)
  )
}

/**
 * CC 2.1.309 #37: Bedrock default-endpoint detector — byte-faithful port of
 * the official `jrr()` (NEW in 2.1.309, @BIN309:240757331; zero hits in
 * BIN308):
 *
 *   function jrr(){let e=i.ANTHROPIC_BEDROCK_BASE_URL;if(e===void 0)return!0;
 *     return I4r("bedrock",e)&&K.test(new URL(e).hostname.toLowerCase().replace(/\.$/,""))}
 *
 * Supporting infrastructure @BIN309:240755400 (present in BOTH 308/309 —
 * only the FGTS gate's use of it is new):
 *
 *   var E="[a-z]{2,4}(?:-[a-z]{2,5})?-[a-z]+-\\d+"                       // region
 *   var W="(?:amazonaws\\.(?:com(?:\\.cn)?|eu)|api\\.aws|c2s\\.ic\\.gov|sc2s\\.sgov\\.gov|cloud\\.adc-e\\.uk|csp\\.hci\\.ic\\.gov)"
 *   var K=new RegExp(`\\.(?!us-gov-)${E}\\.(?:vpce\\.)?(?:amazonaws\\.com|api\\.aws)$`)
 *   function y(e){return new RegExp(`^(?:vpce-[a-z0-9-]+\\.)?${e}(?:-fips)?\\.${E}\\.(?:vpce\\.)?${W}$`)}
 *   x.bedrock.ownHost = y("bedrock(?:-runtime)?")
 *   function k(e,t){...unparsable→"unparsable"; !ownHost→"foreign"; https→"own"; else "insecure"}
 *   function I4r(e,t){return k(e,t)==="own"}
 *
 * Semantics: env unset → true; env set → must PARSE, be https, match the
 * bedrock(-runtime) own-host regex (optional vpce prefix, optional -fips,
 * any official partition suffix), AND end in a COMMERCIAL amazonaws.com or
 * api.aws region suffix (K excludes us-gov via lookahead and .cn/eu/gov
 * partitions by only admitting amazonaws.com|api.aws).
 *
 * Consumed by the api.ts FGTS gate's bedrock arm (309 delta: 308's
 * `!a.ANTHROPIC_BEDROCK_BASE_URL` → `jrr()`, so a SET-but-DEFAULT endpoint
 * now enables eager_input_streaming; custom/proxy endpoints stay off —
 * GH#32742 400-avoidance preserved).
 *
 * Official symbol → OCC name: `jrr` → isDefaultBedrockBaseUrl.
 */
// E — AWS region id: 2-4 letters, optional 2-5-letter mid-segment, -name-#
const BEDROCK_REGION_PATTERN = '[a-z]{2,4}(?:-[a-z]{2,5})?-[a-z]+-\\d+'
// W — official AWS partition DNS suffixes
const BEDROCK_PARTITION_SUFFIX =
  '(?:amazonaws\\.(?:com(?:\\.cn)?|eu)|api\\.aws|c2s\\.ic\\.gov|sc2s\\.sgov\\.gov|cloud\\.adc-e\\.uk|csp\\.hci\\.ic\\.gov)'
// K — commercial-partition region suffix (excludes us-gov, .cn, .eu, gov clouds)
const BEDROCK_COMMERCIAL_REGION_SUFFIX = new RegExp(
  `\\.(?!us-gov-)${BEDROCK_REGION_PATTERN}\\.(?:vpce\\.)?(?:amazonaws\\.com|api\\.aws)$`,
)
// y("bedrock(?:-runtime)?") — bedrock own-host regex
const BEDROCK_OWN_HOST = new RegExp(
  `^(?:vpce-[a-z0-9-]+\\.)?bedrock(?:-runtime)?(?:-fips)?\\.${BEDROCK_REGION_PATTERN}\\.(?:vpce\\.)?${BEDROCK_PARTITION_SUFFIX}$`,
)

export function isDefaultBedrockBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL
  // jrr: `if(e===void 0)return!0` — ONLY undefined short-circuits; a set
  // empty string falls through to the URL parse and fails (unparsable).
  if (baseUrl === undefined) {
    return true
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    // k(): "unparsable" ≠ "own"
    return false
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
  // I4r("bedrock", url) === k()==="own": ownHost match AND https
  if (!BEDROCK_OWN_HOST.test(hostname)) {
    return false
  }
  if (parsed.protocol !== 'https:') {
    return false
  }
  return BEDROCK_COMMERCIAL_REGION_SUFFIX.test(hostname)
}
