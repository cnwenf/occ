import type { APIError } from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QuerySource } from 'src/constants/querySource.js'
import type { AssistantMessage, UserMessage } from 'src/types/message.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  isAdvisorEnabled,
  isAdvisorOrgDisabled,
  markAdvisorEntryRefused,
} from '../../utils/advisor.js'
import { logError } from '../../utils/log.js'
import { stripAdvisorBlocks } from '../../utils/messages.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  classifyAdvisorRefusalScope,
  isAdvisorEntryRefusedError,
} from './errorUtils.js'

/**
 * 2.1.276 advisor hotfix, extended by 2.1.280 (#032) — port of the official
 * advisor-entry-refused retry handler. v276 `zHe` (JS-source region
 * ~198909457) was org-scope-only; v280 renamed it `Ece` and split the disable
 * path by `kat` scope (v280 binary @199639819):
 *
 *   QHe=!1,Ece=(er)=>{if(QHe||!ake(er))return;
 *     let Ar=(Nr)=>!("input_schema"in Nr)&&("name"in Nr)&&Nr.name===bce;
 *     if(!qu.some(Ar))return;QHe=!0;try{
 *       qu=qu.filter(($o)=>!Ar($o)),_r=di(uz(zE(_r)),"error_recovery"),
 *       YHe(),Tr="error_recovery",li=!1,
 *       ht.advisorHeld={model:void 0,viaToolChange:…,refused:!0};
 *       let Nr=kat(er);
 *       if(Nr==="process")TJr();else if(Nr==="host")RJr();
 *       XHe(),i("tengu_advisor_entry_refused_retry",
 *         {query_source:Rs(h.querySource),
 *          organization_wide:Nr==="process",host_wide:Nr==="host"})
 *     }catch(Nr){d(ce(Nr))}return"retry:advisor-entry-refused"}
 *
 * Delta vs the v276 `mTe`/`zHe` baseline (v278 @200513362 verified to still
 * carry it): `vtt(hr)→Gst()` org-only kill became the `kat` three-way scope
 * split with the new `RJr()` host-disable arm, and the telemetry event gained
 * the `host_wide` boolean.
 *
 * The official handler closes over the query's mutable request state
 * (`qu` = tools, `_r` = messages, `Ee` = betas); OCC injects the same three
 * slots via AdvisorRetryRequestState so the handler stays unit-testable.
 *
 * Official steps with no OCC analog (documented deviations):
 *   - `uz`/`YHe` strip `advisor` from api_system toolAdditions/toolRemovals —
 *     OCC has no api_system tool-change machinery.
 *   - `di(…, "error_recovery")` / `Tr="error_recovery"` / `li=!1` are the
 *     official normalization-reason bookkeeping; OCC's messagesForAPI is
 *     already normalized and stripAdvisorBlocks (the `zE` step) is the only
 *     advisor-specific transform.
 *   - `advisorHeld.viaToolChange` preservation — OCC has no sticky-betas
 *     state; markAdvisorEntryRefused is the refused-latch analog.
 *   - `XHe()` also drops the advisor beta from the sticky-betas list when the
 *     beta is no longer active — OCC has no sticky-betas registry, so only
 *     the per-request `Ee` filter is ported (same as v276 `Hvt`).
 */

/** Official `bce`/`YR` — the advisor server-tool name. */
const ADVISOR_TOOL_NAME = 'advisor'

// ---------------------------------------------------------------------------
// Official v280 host-scoped advisor disable (#032) — `mm`/`Ok`/`Pk`/`RJr`/`$H`
// (v280 binary @196095138):
//
//   var mm=new Set,Ok=null;
//   function CJr(e){Ok=e}          // registers the host-key getter
//   function Pk(){try{return Ok?.()??"default"}catch{return"default"}}
//   function RJr(){mm.add(Pk())}   // disable advisor for the current host
//   function $H(){return Ck||mm.size>0&&mm.has(Pk())}   // Ck = process kill
//
// The registered getter is `xQr` (v280 @196305973, registration `CJr(xQr)`
// @199710349):
//
//   function xQr(){if(a.ANTHROPIC_BASE_URL!==void 0)return a.ANTHROPIC_BASE_URL;
//     try{if(X2()){let e=YJ();if(typeof e==="string")return e}}catch{}
//     return"https://api.anthropic.com"}
//
// The key is the RAW base-URL string — deliberately NOT the Lit gateway-vendor
// table (OCC analog: `detectGateway` in logging.ts): two different LiteLLM
// deployments are different hosts for disable purposes, and the official
// never consults Lit here. OCC has no getter registry (single implementation),
// so `resolveAdvisorBaseUrl` inlines the xQr lookup: ANTHROPIC_BASE_URL env →
// getOauthConfig().BASE_API_URL (the OCC analog of the official config URL —
// same lookup apiPreconnect.ts uses; prod default "https://api.anthropic.com",
// so the tail fallback only matters for the throw path) → the literal default.
//
// STAGED (outside this file's scope): the official `$H` is consulted inside
// the infra gate `YJe`→`qb` (OCC analog: isAdvisorEnabled in utils/advisor.ts)
// and by the advisor-schema resolution gate in claude.ts, so a host-disabled
// advisor is never re-added on later requests to the same host. OCC's
// isAdvisorEnabled() only has the process arm; until advisor.ts/claude.ts are
// wired to isAdvisorEnabledForCurrentHost() below, the host kill is enforced
// within the request/retry path (beta strip + session refused latch) but not
// yet at schema-assembly time.
// ---------------------------------------------------------------------------

/** Official `mm` — session-level set of disabled base-URL host keys. */
const advisorDisabledHosts = new Set<string>()

/** Official `xQr` — the base URL advisor requests actually go to. */
function resolveAdvisorBaseUrl(): string {
  if (process.env.ANTHROPIC_BASE_URL !== undefined) {
    return process.env.ANTHROPIC_BASE_URL
  }
  try {
    const configured = getOauthConfig().BASE_API_URL
    if (typeof configured === 'string') {
      return configured
    }
  } catch {
    // Official wraps the config lookup in try/catch and falls through.
  }
  return 'https://api.anthropic.com'
}

/** Official `Pk` — current host key with the 'default' failure fallback. */
function getAdvisorHostKey(): string {
  try {
    return resolveAdvisorBaseUrl() ?? 'default'
  } catch {
    return 'default'
  }
}

/** Official `RJr` — disable the advisor for the current base-URL host. */
export function markAdvisorHostDisabled(): void {
  advisorDisabledHosts.add(getAdvisorHostKey())
}

/** Host arm of official `$H` — is the CURRENT host disabled this session? */
export function isAdvisorHostDisabled(): boolean {
  return (
    advisorDisabledHosts.size > 0 &&
    advisorDisabledHosts.has(getAdvisorHostKey())
  )
}

/**
 * OCC analog of the official `qb()` advisor-enabled gate with the v280 `$H`
 * host arm wired in: `isAdvisorEnabled()` (utils/advisor.ts — env vars, org
 * kill-switch `Ck`, firstParty, growthbook) minus a host-scoped disable for
 * the current base URL. This is what the official `XHe()` beta strip and the
 * staged advisor.ts/claude.ts gates consult.
 */
export function isAdvisorEnabledForCurrentHost(): boolean {
  return isAdvisorEnabled() && !isAdvisorHostDisabled()
}

/**
 * Official `$H` in full (`Ck||mm.size>0&&mm.has(Pk())`) — process-wide kill
 * OR host-scoped kill for the current host. Exported for the staged
 * advisor.ts gate wiring; process arm read live from utils/advisor.ts.
 */
export function isAdvisorKilledForCurrentHost(): boolean {
  return isAdvisorOrgDisabled() || isAdvisorHostDisabled()
}

/** @internal Test-only reset for the host-disable set. */
export function _resetAdvisorHostDisableForTesting(): void {
  advisorDisabledHosts.clear()
}

/**
 * The mutable per-request slots the retry rewrites (official `zm`/`bi`/`we`
 * in the query closure). claude.ts binds these to its `allTools`,
 * `messagesForAPI`, and `betas` locals so `paramsFromContext` picks the
 * stripped values up on the retried attempt (same live-binding pattern as
 * the 2.1.157 `stripMediaBlock` retry).
 */
export interface AdvisorRetryRequestState {
  readonly getTools: () => BetaToolUnion[]
  readonly setTools: (tools: BetaToolUnion[]) => void
  readonly getMessages: () => (UserMessage | AssistantMessage)[]
  readonly setMessages: (messages: (UserMessage | AssistantMessage)[]) => void
  readonly getBetas: () => string[]
  readonly setBetas: (betas: string[]) => void
}

/**
 * Official `Co` predicate: the advisor server-tool schema entry
 * (`{type:"advisor_20260301",name:"advisor",model:…}` — no `input_schema`).
 */
function isAdvisorToolSchema(tool: BetaToolUnion): boolean {
  return (
    !('input_schema' in tool) &&
    'name' in tool &&
    (tool as { name?: unknown }).name === ADVISOR_TOOL_NAME
  )
}

/**
 * Create the one-shot advisor-entry-refused retry handler for a single
 * request (official v280 `Ece` + its `QHe` latch — v276 `zHe`/`Wvt` — created
 * fresh per query closure and shared by the official stream and sync fatal
 * chains, where it is wired FIRST: `Ece(hs)??Tce(hs,"stream")??…`).
 *
 * @returns a callback for withRetry's `retryAdvisorEntryRefused` option:
 *   true when the request was stripped of the advisor tool and must be
 *   retried once (official `"retry:advisor-entry-refused"`), false when the
 *   error is not an advisor-entry refusal, the request carried no advisor
 *   schema, or the one-shot latch was already used.
 */
export function createAdvisorEntryRefusedRetryHandler(
  state: AdvisorRetryRequestState,
  querySource: QuerySource | undefined,
): (error: APIError) => boolean {
  // Official `Wvt` — one-shot: at most one advisor-entry-refused retry per
  // request, across both the streaming and non-streaming paths.
  let retryUsed = false

  return (error: APIError): boolean => {
    // Official `if(QHe||!ake(er))return` — v280's `ake` classifier covers the
    // 400 shapes plus the 422 Input-tag shape (#032).
    if (retryUsed || !isAdvisorEntryRefusedError(error)) {
      return false
    }
    // Official `if(!qu.some(Ar))return` — only advisor-caused when this
    // request actually carried the advisor schema; otherwise fall through to
    // the other fatal-400 handlers.
    if (!state.getTools().some(isAdvisorToolSchema)) {
      return false
    }
    retryUsed = true
    // Official `let Nr=kat(er)` — process / host / conversation scope.
    const scope = classifyAdvisorRefusalScope(error)
    try {
      // Official `qu=qu.filter(($o)=>!Ar($o))`
      state.setTools(
        state.getTools().filter(tool => !isAdvisorToolSchema(tool)),
      )
      // Official `_r=di(uz(zE(_r)),"error_recovery")` — `zE` is
      // stripAdvisorBlocks (byte-equivalent in messages.ts); `uz` is N/A.
      state.setMessages(stripAdvisorBlocks(state.getMessages()))
      // Official `ht.advisorHeld={model:void 0,…,refused:!0}` plus
      // `if(Nr==="process")TJr();else if(Nr==="host")RJr()` — session
      // refused latch always; process-wide kill-switch on org refusals,
      // host-scoped disable on gateway Input-tag refusals (#032).
      markAdvisorEntryRefused(scope === 'process')
      if (scope === 'host') {
        markAdvisorHostDisabled()
      }
      // Official `XHe()`: `if(!qb())Ee=Ee.filter((er)=>er!==tLn)` — the beta
      // header is stripped ONLY when advisor is now fully disabled. v280's
      // `qb` consults `$H` (process kill OR host disable), so a host-scoped
      // refusal also strips the beta on the retried request; a
      // conversation-scoped refusal keeps it exactly as the official does
      // (unknown beta header strings are ignored by gateways).
      if (!isAdvisorEnabledForCurrentHost()) {
        state.setBetas(
          state.getBetas().filter(beta => beta !== ADVISOR_BETA_HEADER),
        )
      }
      // Official v280 `i("tengu_advisor_entry_refused_retry",
      //   {query_source:Rs(h.querySource),
      //    organization_wide:Nr==="process",host_wide:Nr==="host"})`
      logEvent('tengu_advisor_entry_refused_retry', {
        query_source:
          querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        organization_wide: scope === 'process',
        host_wide: scope === 'host',
      })
    } catch (e) {
      // Official `catch(Nr){d(ce(Nr))}` — log, but still retry (the
      // `return "retry:advisor-entry-refused"` sits outside the try).
      logError(e)
    }
    return true
  }
}
