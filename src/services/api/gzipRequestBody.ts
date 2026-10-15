import { gzipSync } from 'zlib'
import { logForDebugging } from '../../utils/debug.js'
import { getMTLSConfig } from '../../utils/mtls.js'
import { getProxyUrl, shouldBypassProxy } from '../../utils/proxy.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

/**
 * CC 2.1.300 (#59): "Changed large requests to api.anthropic.com to use gzip
 * compression even when telemetry is disabled; set
 * CLAUDE_CODE_GZIP_REQUEST_BODIES=0 to turn it off."
 *
 * Official v300 gzip module @219895347 (byte-verified):
 *
 *   var T="tengu_gentle_hammock",L="tengu_golden_popcorn",D=4096,j=1024,
 *       M=604800000,N=8192;
 *   function O(e){return e==="ccr_worker"?a.CLAUDE_CODE_GZIP_CCR_REQUEST_BODIES
 *     :a.CLAUDE_CODE_GZIP_REQUEST_BODIES}
 *   function U(e){return e==="ccr_worker"?j:D}
 *   function H(e){if(a.ANTHROPIC_UNIX_SOCKET)return"unix_socket";
 *     if(Mf()!==void 0&&!Uy(e))return"proxy";let n=UE();
 *     if(n?.cert!==void 0||n?.key!==void 0)return"mtls";
 *     if(a.NODE_EXTRA_CA_CERTS){…return"custom_ca"}return}
 *   function vMt(e,n,r,s="api"){if(!If(e))return;
 *     let d=typeof n==="string"?n.length:void 0,l=O(s);
 *     if(l===!1)return{gzip:!1,reason:"env_off",bodyChars:d};
 *     if(!Gv())return{gzip:!1,reason:"not_bun_runtime",bodyChars:d};
 *     if(d===void 0)return{gzip:!1,reason:"non_string_body",bodyChars:d};
 *     if(d<U(s))return{gzip:!1,reason:"below_min_size",bodyChars:d};
 *     if(l===!0)return Is().gzipRequestBody.rejectedThisProcess?
 *       {gzip:!1,reason:"latched_off",bodyChars:d}:{gzip:!0,bodyChars:d};
 *     let _=H(e);if(_!==void 0)return{gzip:!1,reason:_,bodyChars:d};
 *     if(s==="ccr_worker"&&!k(T,!1))return{gzip:!1,reason:"flag_off",bodyChars:d};
 *     if(te(r))return{gzip:!1,reason:"latched_off",bodyChars:d};
 *     return{gzip:!0,bodyChars:d}}
 *
 * Host check `If` @216214637: `["api.anthropic.com"].includes(new URL(e).host)`.
 * `Gv()` @216042867 is `return!0` (always Bun) — OCC is Bun-only, dropped.
 * The v299 flags `tengu_gzip_request_bodies`/`tengu_atomic_ocean` are gone in
 * v300 (0 hits in s300) — gzip is default-on for the api rollout.
 *
 * Rejection latch (official `q()`): after an origin/intermediary rejects a
 * gzipped body, gzip is disabled for the rest of the process
 * (`rejectedThisProcess`) and the request is re-sent uncompressed once
 * (official `a_o`). The official also persists the latch to config for 7 days
 * (`M=604800000`, `C({persist:…})` → `gzipRequestBodiesLatchedOff`); OCC has
 * no config-schema surface in this cluster, so only the process-wide latch is
 * ported (documented deviation). The ccr_worker rollout (j=1024, tengu_gentle_
 * hammock) has no OCC surface — api rollout only.
 */

/** Official `D` = 4096 — minimum body chars for the api rollout (`U("api")`). */
export const GZIP_MIN_BODY_CHARS = 4096

/** Official `N` = 8192 — max bytes sniffed from the response for rejection. */
export const GZIP_SNIFF_MAX_BYTES = 8192

/** The env var named in the changelog (`O("api")`). */
export const GZIP_REQUEST_BODIES_ENV = 'CLAUDE_CODE_GZIP_REQUEST_BODIES'

/** Official host allowlist `["api.anthropic.com"]` (If @216214637). */
const ANTHROPIC_API_HOSTS = ['api.anthropic.com']

/** Official `Q` — origin bad-JSON message prefixes (byte-verified). */
const ORIGIN_BAD_JSON_MESSAGE_PREFIXES = [
  'The request body is not valid JSON',
  'Failed to parse request: could not parse request body as JSON',
]

/** Official `G` — raw bad-json body pattern (byte-verified). */
const BAD_JSON_BODY_PATTERN =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/

/** Official rejection kinds (`h()` return values). */
export type GzipRejectionKind =
  | 'non_anthropic_rejection'
  | 'invalid_json_at_origin'

export type GzipRequestBodyDecision =
  | { gzip: true; bodyChars: number }
  | { gzip: false; reason: string; bodyChars: number | undefined }

/**
 * Official `Is().gzipRequestBody` in-memory fields. The persisted-latch
 * fields (`persistedLatchChecked`, config read `ee()`/`te()`) collapse to the
 * process latch — see the module header deviation note.
 */
interface GzipRequestBodyLatch {
  latchedOff: boolean
  rejectedThisProcess: boolean
}

const latch: GzipRequestBodyLatch = {
  latchedOff: false,
  rejectedThisProcess: false,
}

/** Official `q()` — set every latch field at once. */
export function latchGzipRequestBodyOff(): void {
  latch.latchedOff = true
  latch.rejectedThisProcess = true
}

/** The `te(r)`/`rejectedThisProcess` check inside `vMt`. */
export function isGzipRequestBodyLatchedOff(): boolean {
  return latch.latchedOff
}

/** Test-only reset of the process-wide latch. */
export function resetGzipRequestBodyLatch(): void {
  latch.latchedOff = false
  latch.rejectedThisProcess = false
}

/** Official `If(e)` @216214637 — strict host allowlist. */
function isAnthropicApiHost(url: string): boolean {
  try {
    return ANTHROPIC_API_HOSTS.includes(new URL(url).host)
  } catch {
    return false
  }
}

/**
 * Tri-state read of CLAUDE_CODE_GZIP_REQUEST_BODIES. The official reads it
 * through the env proxy and compares `l===!1` / `l===!0`; OCC parses
 * 0/false → false, 1/true → true, unset/other → undefined.
 */
function readGzipEnvTriState(
  env: Record<string, string | undefined>,
): boolean | undefined {
  const raw = env[GZIP_REQUEST_BODIES_ENV]
  if (raw === undefined || raw === '') {
    return undefined
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === '0' || normalized === 'false') {
    return false
  }
  if (normalized === '1' || normalized === 'true') {
    return true
  }
  return undefined
}

/**
 * Official `H(e)` — transports where a request-level Content-Encoding could
 * break the intermediary. DEVIATION: the official custom_ca arm exempts
 * managed-settings-injected NODE_EXTRA_CA_CERTS (`Dr()`) and the local-agent
 * entrypoint; OCC treats any NODE_EXTRA_CA_CERTS as custom_ca (skip).
 */
function getTransportSkipReason(
  url: string,
  env: Record<string, string | undefined>,
): string | undefined {
  if (env.ANTHROPIC_UNIX_SOCKET) {
    return 'unix_socket'
  }
  if (getProxyUrl(env) !== undefined && !shouldBypassProxy(url)) {
    return 'proxy'
  }
  const mtls = getMTLSConfig()
  if (mtls?.cert !== undefined || mtls?.key !== undefined) {
    return 'mtls'
  }
  if (env.NODE_EXTRA_CA_CERTS) {
    return 'custom_ca'
  }
  return undefined
}

/**
 * Official `vMt(e,n,r,s="api")` — decide whether a request body goes out
 * gzip-compressed. Returns undefined for non-api.anthropic.com URLs (the
 * caller sends untouched); otherwise a decision with the official reason
 * strings for telemetry.
 */
export function shouldGzipRequestBody(
  url: string,
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): GzipRequestBodyDecision | undefined {
  if (!isAnthropicApiHost(url)) {
    return undefined
  }
  const bodyChars = typeof body === 'string' ? body.length : undefined
  const envFlag = readGzipEnvTriState(env)
  if (envFlag === false) {
    return { gzip: false, reason: 'env_off', bodyChars }
  }
  // Official `Gv()` (not_bun_runtime) is `return!0` — OCC is Bun-only.
  if (bodyChars === undefined) {
    return { gzip: false, reason: 'non_string_body', bodyChars }
  }
  if (bodyChars < GZIP_MIN_BODY_CHARS) {
    return { gzip: false, reason: 'below_min_size', bodyChars }
  }
  if (envFlag === true) {
    // Explicit env-on skips the transport checks but honors the process
    // latch (official `rejectedThisProcess` arm).
    return latch.rejectedThisProcess
      ? { gzip: false, reason: 'latched_off', bodyChars }
      : { gzip: true, bodyChars }
  }
  const transportReason = getTransportSkipReason(url, env)
  if (transportReason !== undefined) {
    return { gzip: false, reason: transportReason, bodyChars }
  }
  if (latch.latchedOff) {
    return { gzip: false, reason: 'latched_off', bodyChars }
  }
  return { gzip: true, bodyChars }
}

/**
 * Official `bNt` @219216120 (byte-verified) — append a newline plus 0-256
 * random spaces/tabs before compressing. Trailing whitespace is invisible to
 * JSON parsers; it keeps identical bodies from producing identical payloads.
 *
 *   function bNt(e){return e+`\n`+Array.from({length:Math.floor(
 *     Math.random()*257)},()=>Math.random()<0.5?" ":"\t").join("")}
 */
export function padRequestBodyForGzip(body: string): string {
  const padLength = Math.floor(Math.random() * 257)
  let padding = ''
  for (let i = 0; i < padLength; i++) {
    padding += Math.random() < 0.5 ? ' ' : '\t'
  }
  return `${body}\n${padding}`
}

/** gzipSync of the padded body (official `eH(bNt(s))` @219216365). */
export function gzipRequestBody(body: string): Buffer {
  return gzipSync(Buffer.from(padRequestBodyForGzip(body), 'utf8'))
}

/** Official `W(e)` — response looks like it came from Anthropic/Cloudflare. */
function isAnthropicLikeResponse(header: (name: string) => string | undefined): boolean {
  return (
    (header('request-id')?.startsWith('req_') ?? false) ||
    header('cf-ray') !== undefined
  )
}

/** Official `Z(e)` — clone-based bounded body read (max N=8192 bytes). */
async function readSniffText(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let budget = GZIP_SNIFF_MAX_BYTES
  try {
    while (budget > 0) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const chunk = value.subarray(0, budget)
      budget -= chunk.byteLength
      text += decoder.decode(chunk, { stream: true })
    }
  } catch {
    // best-effort sniff — an unreadable body simply is not a bad-json body
  } finally {
    reader.cancel().catch(() => {})
  }
  return text
}

/**
 * Official `V(e)` — the body reads as a JSON-parse rejection: either the
 * API error envelope with one of the `Q` message prefixes, the raw
 * `bad json: …` text, or the `{error,reason:"bad_json"}` shape.
 */
function isBadJsonBodyText(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return BAD_JSON_BODY_PATTERN.test(text.trimEnd())
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return false
  }
  const record = parsed as Record<string, unknown>
  if (
    record.type === 'error' &&
    typeof record.error === 'object' &&
    record.error !== null
  ) {
    const message = (record.error as Record<string, unknown>).message
    if (typeof message === 'string') {
      return ORIGIN_BAD_JSON_MESSAGE_PREFIXES.some(prefix =>
        message.startsWith(prefix),
      )
    }
  }
  if (typeof record.error === 'string' && typeof record.reason === 'string') {
    return record.reason === 'bad_json' && BAD_JSON_BODY_PATTERN.test(record.error)
  }
  return false
}

/**
 * Official `i_o(e)` — null when the response is ok or is not a gzip
 * rejection; otherwise the rejection kind that triggers the `a_o`
 * uncompressed re-send + latch.
 */
export async function classifyGzipRejection(
  response: Response,
): Promise<GzipRejectionKind | null> {
  if (response.ok) {
    return null
  }
  // Official `h(e)`: only 400/403/415 can be gzip rejections.
  if (
    response.status !== 400 &&
    response.status !== 403 &&
    response.status !== 415
  ) {
    return null
  }
  const header = (name: string): string | undefined =>
    response.headers.get(name) ?? undefined
  if (!isAnthropicLikeResponse(header)) {
    return 'non_anthropic_rejection'
  }
  if (response.status === 400 && isBadJsonBodyText(await readSniffText(response))) {
    return 'invalid_json_at_origin'
  }
  return null
}

/**
 * Official `X(e)` — classify the uncompressed re-send's outcome for the
 * `tengu_gzip_request_body_fallback` telemetry (`retryOutcome`).
 */
export async function classifyGzipResendOutcome(
  response: Response,
): Promise<'same_rejection' | 'api_response' | 'not_api_response'> {
  if ((await classifyGzipRejection(response)) !== null) {
    return 'same_rejection'
  }
  return (response.headers.get('request-id') ?? '').startsWith('req_')
    ? 'api_response'
    : 'not_api_response'
}

// Official `pen()`/`x(e,"sent")` — once-per-process gzip-sent telemetry.
let gzipSentLogged = false

/** Official `g("api_gzip_request_body")` via `Is().once(…)`. */
export function noteGzipRequestBodySent(): void {
  if (gzipSentLogged) {
    return
  }
  gzipSentLogged = true
  logEvent('tengu_api_gzip_request_body', {})
}

/** Official `S({…})` warn line + `tengu_gzip_request_body_fallback` event. */
export function logGzipRequestBodyFallback(facts: {
  rejection: GzipRejectionKind
  status: number
  viaCloudflare: boolean
  retryOutcome: string
  retryStatus: number
  latched: 'process' | 'persisted'
  bodyChars: number
}): void {
  logForDebugging(
    `[API REQUEST] gzip request body rejected (rollout=api status=${facts.status} kind=${facts.rejection}); re-sent uncompressed → ${facts.retryOutcome} status=${facts.retryStatus}; gzip latched off: ${facts.latched}`,
    { level: 'warn' },
  )
  logEvent('tengu_gzip_request_body_fallback', {
    rollout:
      'api' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    rejection:
      facts.rejection as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    status: facts.status,
    viaCloudflare: facts.viaCloudflare,
    retryOutcome:
      facts.retryOutcome as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    retryStatus: facts.retryStatus,
    latched:
      facts.latched as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    requestBodyChars: facts.bodyChars,
  })
}
