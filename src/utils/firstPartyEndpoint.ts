/**
 * First-party endpoint discriminators (Claude Code 2.1.299 port).
 *
 * Security context (#052 + #070): when the user configures a third-party LLM
 * gateway via ANTHROPIC_BASE_URL, the API key resolved for that gateway must
 * NEVER be attached to Anthropic-owned auxiliary requests (feature flags,
 * event logging, fast mode, bootstrap, feedback, usage, remote managed
 * settings) which are hardcoded to api.anthropic.com. Genuine first-party
 * keys are still sent.
 *
 * Official v299 evidence (linux-x64 ELF, provider chunk; export table
 * @239295153 maps minified names to the public family):
 *
 *   gi = isFirstPartyAnthropicBaseUrl        @215998121:
 *     function gi(){if($ie())return!0;return vf()}
 *   $ie = assumesFirstPartyBaseUrl:
 *     function $ie(){return a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL??Ur().clientDataUrl.assumesFirstPartyBaseUrl}
 *   vf = isActualFirstPartyAnthropicBaseUrl:
 *     function vf(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return Pm(e)}
 *   Pm = isFirstPartyAnthropicHost — hostname set is exactly ["api.anthropic.com"]:
 *     function Pm(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
 *   din = hasCustomBaseUrlForAnalytics:
 *     function din(){return he()?void 0:!vf()}
 *   ba = isFirstPartyApiBackend:
 *     function ba(){return Oe()==="firstParty"&&gi()}
 *   fG = hasFirstPartyCapabilities:
 *     function fG(e=Oe()){return e==="firstParty"||pj(e)||e==="foundry"||e==="mantle"}
 *     where pj(e)=isClaudePlatformProvider: e==="anthropicAws"||e==="anthropicGoogleCloud"
 *   cA = getAPIProviderForAnalytics:
 *     function cA(){return c(Oe())}
 *
 * Key sanitizer f5 (fast-mode chunk @~217810900; also used by the
 * anthropic-owned client `yr` @218212358 and remote settings `St` @232349772):
 *
 *   Ax=/^(sk-ant-|sk-[\w-]{86}$)/
 *   vx="api.anthropic.com"
 *   function qu(){if(a.ANTHROPIC_BASE_URL)return ta(a.ANTHROPIC_BASE_URL);return vx}
 *   function nh(e){return Pm(`https://${e}`)||Aje.some((n)=>ta(n)===e)}
 *   Aje=["https://beacon.claude-ai.staging.ant.dev","https://claude.fedstart.com","https://claude-staging.fedstart.com"]
 *   function f5(e){let n=qu(),r=n===void 0||!nh(n),s=typeof e==="string"&&Ax.test(e.trim());return!e||r&&!s?null:e}
 *
 * Official drop reason string (@105112445, @218212358):
 *   "API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host"
 *
 * The official chokepoint (anthropic-owned client `yr`, @218212300):
 *   te=Z.headers["x-api-key"],
 *   le=Z.error??(te&&!f5(te)?"API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host":void 0);
 *   if(le&&s.auth!=="optional")return{ok:!1,reason:"no-auth",detail:le};
 *   S=le?{}:Z.headers
 * i.e. the request is SKIPPED (reason "no-auth") unless auth is optional, in
 * which case it is sent keyless. OCC applies the same rule inside
 * getAuthHeaders() (src/utils/http.ts): callers already treat `.error` as
 * skip-request (growthbook init, feedback, usage, bootstrap) or fall through
 * to keyless send (1P event logging) — matching the official per-site
 * outcomes.
 */

import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './model/providers.js'

/**
 * Official `Pm` hostname set — exactly ["api.anthropic.com"] (@215998121
 * region). api-staging is NOT in this set: official vf()/OG() treat staging
 * as non-actual-first-party for key attachment.
 */
const FIRST_PARTY_ANTHROPIC_HOSTS: readonly string[] = ['api.anthropic.com']

/**
 * Official `Aje` extra approved hosts used by the key sanitizer's `nh`
 * first-party-host check (FedStart + ant staging beacon).
 */
const APPROVED_FIRST_PARTY_EXTRA_URLS: readonly string[] = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

/** Official `vx` — default effective host when ANTHROPIC_BASE_URL is unset. */
const DEFAULT_EFFECTIVE_HOST = 'api.anthropic.com'

/** Official `Ax` — genuine Anthropic API key shape. */
const GENUINE_ANTHROPIC_KEY_SHAPE = /^(sk-ant-|sk-[\w-]{86}$)/

/** Official drop reason (@105112445). */
export const API_KEY_NOT_SENT_REASON =
  'API key not sent: ANTHROPIC_BASE_URL is not an Anthropic host'

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * Official `Pm` (isFirstPartyAnthropicHost): the URL's host must be in the
 * first-party hostname set (exactly api.anthropic.com). Unparseable → false.
 */
export function isFirstPartyAnthropicHost(url: string): boolean {
  const host = hostOf(url)
  return host !== undefined && FIRST_PARTY_ANTHROPIC_HOSTS.includes(host)
}

/**
 * Official `vf` (isActualFirstPartyAnthropicBaseUrl): true when
 * ANTHROPIC_BASE_URL is unset (default API) or points at api.anthropic.com.
 * Unlike isFirstPartyAnthropicBaseUrl, no env override and no staging
 * superset — this mirrors the official key-attachment predicate exactly.
 */
export function isActualFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  return isFirstPartyAnthropicHost(baseUrl)
}

/**
 * Official `din` (hasCustomBaseUrlForAnalytics): `he()?void 0:!vf()`.
 * `he()` could not be recovered verbatim from the binary; from its pairing
 * in `S9e` (`if(he()||Oe()!=="firstParty"||...)`) it is a cloud-provider
 * predicate distinct from provider!=="firstParty". Analytics semantics:
 * third-party cloud providers (bedrock/vertex/foundry/anthropic_aws/mantle)
 * have no ANTHROPIC_BASE_URL concept → undefined (property omitted);
 * otherwise → whether a custom (non-first-party) base URL is configured.
 */
export function hasCustomBaseUrlForAnalytics(): boolean | undefined {
  const provider = getAPIProvider()
  if (provider !== 'firstParty' && provider !== 'gateway') {
    return undefined
  }
  return !isActualFirstPartyAnthropicBaseUrl()
}

/**
 * Official `ba` (isFirstPartyApiBackend): provider==="firstParty" AND
 * isFirstPartyAnthropicBaseUrl(). The canonical gate for Anthropic-owned
 * auxiliary endpoints.
 */
export function isFirstPartyApiBackend(): boolean {
  return getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Official `fG` (hasFirstPartyCapabilities):
 *   e==="firstParty"||e==="anthropicAws"||e==="anthropicGoogleCloud"||e==="foundry"||e==="mantle"
 * OCC folds anthropicGoogleCloud into firstParty and names the AWS provider
 * 'anthropic_aws'.
 */
export function hasFirstPartyCapabilities(): boolean {
  const provider = getAPIProvider()
  return (
    provider === 'firstParty' ||
    provider === 'anthropic_aws' ||
    provider === 'foundry' ||
    provider === 'mantle'
  )
}

/**
 * Official `cA` (getAPIProviderForAnalytics): the sanitized provider label.
 * Provider names are a fixed enum (no user data), so the label is returned
 * as-is.
 */
export function getAPIProviderForAnalytics(): string {
  return getAPIProvider()
}

/**
 * Official `nh`: host is first-party if it is api.anthropic.com (`Pm`) or
 * one of the approved FedStart/staging-beacon hosts (`Aje`).
 */
function isApprovedFirstPartyHost(host: string): boolean {
  if (FIRST_PARTY_ANTHROPIC_HOSTS.includes(host)) {
    return true
  }
  return APPROVED_FIRST_PARTY_EXTRA_URLS.some(url => hostOf(url) === host)
}

/**
 * Official `qu`: the effective host for Anthropic-owned traffic — the
 * ANTHROPIC_BASE_URL host when set (undefined if unparseable), else
 * "api.anthropic.com" (`vx`).
 */
function getEffectiveAnthropicHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (baseUrl) {
    return hostOf(baseUrl)
  }
  return DEFAULT_EFFECTIVE_HOST
}

/**
 * Official `f5` — sanitize an API key for attachment to Anthropic-owned
 * endpoints. Returns null (drop the key) when:
 *   - there is no key, OR
 *   - the effective host is not an approved first-party host (custom
 *     ANTHROPIC_BASE_URL gateway, or a set-but-unparseable base URL) AND the
 *     key does not have the genuine Anthropic key shape
 *     /^(sk-ant-|sk-[\w-]{86}$)/.
 * Genuine first-party keys are returned unchanged even under a gateway base
 * URL — official semantics ("real Anthropic API keys are still sent").
 */
export function sanitizeApiKeyForAnthropicOwnedEndpoint(
  key: string | null | undefined,
): string | null {
  if (!key) {
    return null
  }
  const effectiveHost = getEffectiveAnthropicHost()
  const hostIsNotFirstParty =
    effectiveHost === undefined || !isApprovedFirstPartyHost(effectiveHost)
  const looksLikeGenuineAnthropicKey = GENUINE_ANTHROPIC_KEY_SHAPE.test(
    key.trim(),
  )
  if (hostIsNotFirstParty && !looksLikeGenuineAnthropicKey) {
    return null
  }
  return key
}
