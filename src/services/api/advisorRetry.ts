import type { APIError } from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QuerySource } from 'src/constants/querySource.js'
import type { AssistantMessage, UserMessage } from 'src/types/message.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import { isAdvisorEnabled, markAdvisorEntryRefused } from '../../utils/advisor.js'
import { logError } from '../../utils/log.js'
import { stripAdvisorBlocks } from '../../utils/messages.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  isAdvisorEntryRefusedError,
  isAdvisorOrgWideEntryRefusedError,
} from './errorUtils.js'

/**
 * 2.1.276 advisor hotfix — port of the official `zHe` advisor-entry-refused
 * retry handler (v276 binary, JS-source region ~198909457):
 *
 *   Wvt=!1,zHe=(hr)=>{if(Wvt||!TPe(hr))return;
 *     let Co=(Xo)=>!("input_schema"in Xo)&&("name"in Xo)&&Xo.name===YR;
 *     if(!zm.some(Co))return;Wvt=!0;try{
 *       if(zm=zm.filter((Xo)=>!Co(Xo)),
 *          bi=ga(kOe(Cz(bi)),"error_recovery"),Bvt(),ks="error_recovery",ui=!1,
 *          Ue.advisorHeld={model:void 0,viaToolChange:Ue.advisorHeld?.viaToolChange??!1,refused:!0},
 *          vtt(hr))Yqt();
 *       Hvt(),i("tengu_advisor_entry_refused_retry",
 *          {query_source:ms(h.querySource),organization_wide:vtt(hr)})
 *     }catch(Xo){d(ue(Xo))}return"retry:advisor-entry-refused"}
 *
 * The official handler closes over the query's mutable request state
 * (`zm` = tools, `bi` = messages, `we` = betas); OCC injects the same three
 * slots via AdvisorRetryRequestState so the handler stays unit-testable.
 *
 * Official steps with no OCC analog (documented deviations):
 *   - `kOe` strips `advisor` from api_system toolAdditions/toolRemovals —
 *     OCC has no api_system tool-change machinery.
 *   - `Bvt()` re-wraps the system-prompt getters with `kOe(Cz(...))` — OCC's
 *     system prompt is prebuilt plain-text sections with no advisor blocks,
 *     so Cz/kOe over it are no-ops.
 *   - `ga(…, "error_recovery")` / `ks="error_recovery"` / `ui=!1` are the
 *     official normalization-reason bookkeeping; OCC's messagesForAPI is
 *     already normalized and stripAdvisorBlocks (the `Cz` step) is the only
 *     advisor-specific transform.
 *   - `advisorHeld.viaToolChange` preservation — OCC has no sticky-betas
 *     state; markAdvisorEntryRefused is the refused-latch analog.
 *   - `Gvt` (defer_loading strip): OCC's schema push never sets
 *     `defer_loading` (matches the official `...Oo&&{defer_loading:!0}` with
 *     advisorDeferred=false), so Gvt can never fire — not ported.
 */

/** Official `YR` — the advisor server-tool name. */
const ADVISOR_TOOL_NAME = 'advisor'

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
 * request (official `zHe` + its `Wvt` latch, created fresh per query
 * closure and shared by the official stream and sync fatal-400 chains).
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
    // Official `if(Wvt||!TPe(hr))return`
    if (retryUsed || !isAdvisorEntryRefusedError(error)) {
      return false
    }
    // Official `if(!zm.some(Co))return` — only advisor-caused when this
    // request actually carried the advisor schema; otherwise fall through to
    // the other fatal-400 handlers.
    if (!state.getTools().some(isAdvisorToolSchema)) {
      return false
    }
    retryUsed = true
    const organizationWide = isAdvisorOrgWideEntryRefusedError(error)
    try {
      // Official `zm=zm.filter((Xo)=>!Co(Xo))`
      state.setTools(
        state.getTools().filter(tool => !isAdvisorToolSchema(tool)),
      )
      // Official `bi=ga(kOe(Cz(bi)),"error_recovery")` — `Cz` is
      // stripAdvisorBlocks (byte-equivalent in messages.ts); `kOe` is N/A.
      state.setMessages(stripAdvisorBlocks(state.getMessages()))
      // Official `Ue.advisorHeld={model:void 0,…,refused:!0}` and
      // `if(vtt(hr))Yqt()` — session refused latch + org-wide kill-switch.
      markAdvisorEntryRefused(organizationWide)
      // Official `Hvt()`: `if(!Bb())we=we.filter((hr)=>hr!==Ewn)` — the beta
      // header is stripped ONLY when advisor is now fully disabled (org-wide
      // kill or config); a non-org refusal keeps the header exactly as the
      // official does (unknown beta header strings are ignored by gateways).
      if (!isAdvisorEnabled()) {
        state.setBetas(
          state.getBetas().filter(beta => beta !== ADVISOR_BETA_HEADER),
        )
      }
      // Official `i("tengu_advisor_entry_refused_retry",
      //   {query_source:ms(h.querySource),organization_wide:vtt(hr)})`
      logEvent('tengu_advisor_entry_refused_retry', {
        query_source:
          querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        organization_wide: organizationWide,
      })
    } catch (e) {
      // Official `catch(Xo){d(ue(Xo))}` — log, but still retry (the
      // `return "retry:advisor-entry-refused"` sits outside the try).
      logError(e)
    }
    return true
  }
}
