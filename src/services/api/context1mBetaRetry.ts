import { APIError } from '@anthropic-ai/sdk'
import {
  isContext1mRefusedForModel,
  markContext1mRefusedModel,
} from '../../bootstrap/state.js'
import { CONTEXT_1M_BETA_HEADER } from '../../constants/betas.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import {
  getEffectiveAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

/**
 * CC 2.1.295 (#016) — port of the official context-1m-beta 400 healing state
 * machine (`qtt` handler @217663771 + `Ztt` confirm @217663952, both closing
 * over the per-request `sb` state initialized at @217634933). New in v295
 * (v294 has zero hits for 'retry:context-1m-beta', 'resending once without
 * it', 'left out for this model').
 *
 * The bug: on a gateway/Bedrock/Vertex/Foundry endpoint that refuses the
 * `context-1m-2025-08-07` beta, EVERY request for a `[1m]` model fails with
 * HTTP 400 forever. The official fix resends once without the beta, and when
 * the resend succeeds, records the model as "context-1m refused" (process
 * latch) so the beta stays off — and the context window is sized without 1M —
 * until /clear, a compaction, a resume, or a provider change.
 *
 * Official mechanism, verbatim (v295 binary):
 *
 *   qtt=(Kn)=>{if(!(Kn instanceof xt)||Kn.status!==400)return null;try{
 *     let Uo=Yie(Kn),Zo=!Uo&&iN(Kn);
 *     if(sb==="spent")return null;
 *     if(sb!=="idle")return sb=sb==="guessing"&&Zo?"spent":"unproven",
 *       t(`[betas] the resend without ${YS.header} also got an HTTP 400, …`),null;
 *     if(!OJe||qCe(cc(Y.model))||!(Uo||Zo&&!Rp()))return null;
 *     return sb=Uo?"retrying":"guessing",
 *       t(`[betas] an HTTP 400 … resending once without it`),"retry:context-1m-beta"}
 *     catch(Uo){return c(Uo),null}}
 *
 *   Ztt=()=>{if(sb!=="retrying"&&sb!=="guessing")return;let Kn=sb==="guessing";
 *     sb="spent";try{ct=ct.filter((Uo)=>Uo!==YS),$wr(Y.model),
 *       i("tengu_beta_400_healed",{beta:Dde([YS.header]),model:kt(Y.model),
 *         provider:jT(),status:400,unnamed:Kn})}catch(Uo){c(Uo)}}
 *
 *   SEe=()=>sb!=="idle"&&sb!=="spent"   // suppresses YS at betas assembly
 *
 * Detectors (@215746028/@215746137):
 *   Yie: status 400 && (message includes YS.header || "long context beta")
 *   iN:  status 400 && message.toLowerCase() includes "invalid beta flag"
 *
 * The retry itself does NOT strip the beta inside the handler: the official
 * betas assembly (@217637260) filters YS whenever SEe() is active
 * (`ct.filter((td)=>td!==YS||!SEe())`, same for the bedrock `Ma` list, and
 * the kelp-forest auto-add is gated on `!SEe()`). OCC mirrors that in
 * claude.ts paramsFromContext via isSuppressed(). Ztt's `ct=ct.filter(…)`
 * (conversation betas strip on confirmed heal) maps to setBetas().
 *
 * Documented deviations (no OCC surface):
 *   - `!Rp()` gate (@217627535: `Rp=()=>kc&&!xV()&&PT.includes(n1.header)` —
 *     the request carries the thinking-binding-controls beta): OCC ships no
 *     thinking-binding-controls beta, so Rp() ≡ false and the gate is always
 *     open; the condition reduces to `named || invalidFlag`.
 *   - `cc(Y.model)` (model-aware mantle provider resolution @207084382):
 *     OCC's closest analog is getEffectiveAPIProvider() (bedrock→mantle
 *     promotion); the mantle per-model capability table (`aO`) has no OCC
 *     surface.
 *   - `Dde([YS.header])` (@209330544) passes known beta headers through
 *     unchanged, so the telemetry `beta` field is the literal header; `kt`
 *     model scrubbing follows OCC convention (raw model string, as in the
 *     surrounding tengu_* events in claude.ts).
 *   - The official fatal chain also carries sibling v295 400-heal handlers
 *     (`retry:thinking-token-count-beta`, generic `retry:beta-rejected`,
 *     `retry:thinking-resumption-beta`) — those betas have no OCC surface and
 *     are out of scope for #016; only `qtt` (context-1m) is ported. Chain
 *     position: qtt sits after the advisor-entry-refused handler (`Ece` is
 *     wired FIRST), so the withRetry hook is placed after the advisor hook.
 */

/** Official `sb` — per-request healing state (@217634933 init `sb="idle"`). */
type Context1mBetaRetryState =
  | 'idle' // no refusal seen on this request yet
  | 'retrying' // named refusal; resent without the beta, awaiting outcome
  | 'guessing' // "invalid beta flag" refusal (may be about another beta)
  | 'spent' // healed (or double-guess); no further action this request
  | 'unproven' // resend also 400'd; beta stays off for this request only

/**
 * The per-request slots the handler reads/rewrites. Official closures capture
 * `Y.model` (request model), `ct` (conversation betas list) and `OJe`
 * (whether the outgoing request actually carried the beta, set at each
 * request build: `OJe=qw.includes(YS)||Ma.includes(YS)` @217642062).
 */
export interface Context1mBetaRetryRequestState {
  readonly model: string
  readonly getBetas: () => string[]
  readonly setBetas: (betas: string[]) => void
  /** ≡ OJe — refreshed by claude.ts paramsFromContext on every attempt. */
  readonly requestCarriedBeta: () => boolean
}

export interface Context1mBetaRetryHandler {
  /**
   * ≡ qtt. Returns true when the request must be resent once without the
   * context-1m beta (official `"retry:context-1m-beta"`); the resend's beta
   * list is assembled by claude.ts with isSuppressed() consulted.
   */
  handleRefusal(error: unknown): boolean
  /**
   * ≡ Ztt. Called at the success settle points (streaming `message_start`,
   * non-streaming response received): strips the beta from the conversation
   * betas, latches the model process-wide and emits tengu_beta_400_healed.
   */
  confirmHealed(): void
  /** ≡ SEe — while true, claude.ts keeps the context-1m beta off the wire. */
  isSuppressed(): boolean
}

/**
 * Official `Yie` (@215746137):
 *   function Yie(e){return e instanceof xt&&e.status===400&&
 *     (e.message.includes(YS.header)||e.message.includes("long context beta"))}
 */
export function isContext1mBetaRefusedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 400 &&
    (error.message.includes(CONTEXT_1M_BETA_HEADER) ||
      error.message.includes('long context beta'))
  )
}

/**
 * Official `iN` (@215746028):
 *   function iN(e){return e instanceof xt&&e.status===400&&
 *     e.message.toLowerCase().includes("invalid beta flag")}
 */
export function isInvalidBetaFlagError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid beta flag')
  )
}

/**
 * Official `qCe` (@209475101) — skip healing on genuine first-party
 * endpoints (the first-party API never refuses its own beta; a 400 there
 * means something else):
 *   function qCe(e=Pe()){if(e==="anthropicAws")return
 *     a.ANTHROPIC_AWS_BASE_URL===void 0;return e==="firstParty"&&bi()}
 * `bi` (@207084923) ≡ isFirstPartyAnthropicBaseUrl() (assume-first-party flag
 * OR unset/allowlisted ANTHROPIC_BASE_URL). Provider names are OCC's
 * ('anthropic_aws' for the official 'anthropicAws').
 */
function isFirstPartyBetaEndpoint(): boolean {
  const provider = getEffectiveAPIProvider()
  if (provider === 'anthropic_aws') {
    return process.env.ANTHROPIC_AWS_BASE_URL === undefined
  }
  return provider === 'firstParty' && isFirstPartyAnthropicBaseUrl()
}

/**
 * Official `$wr` (@209332322) — the logging wrapper around the bare store
 * mark (`NIo`):
 *   function $wr(e){if(Gr(e))return;NIo($n(e)),t(`[betas] the backend
 *   rejected the ${YS.header} beta for ${e} (HTTP 400) and answered once it
 *   was removed. It is left out for this model, whose context window is sized
 *   without 1M, and is tried again after /clear, a compaction, a resume or a
 *   provider change.`,{level:"warn"})}
 */
export function latchContext1mRefused(model: string): void {
  if (isContext1mRefusedForModel(model)) {
    return
  }
  markContext1mRefusedModel(model)
  logForDebugging(
    `[betas] the backend rejected the ${CONTEXT_1M_BETA_HEADER} beta for ${model} (HTTP 400) and answered once it was removed. It is left out for this model, whose context window is sized without 1M, and is tried again after /clear, a compaction, a resume or a provider change.`,
    { level: 'warn' },
  )
}

/**
 * Create the per-request context-1m healing handler (official `qtt`/`Ztt`/
 * `SEe` closure). Created once per querySonnet request and shared by the
 * streaming and non-streaming retry loops — same lifecycle as the official
 * per-query-engine `sb` closure and OCC's advisor-entry-refused handler.
 */
export function createContext1mBetaRetryHandler(
  state: Context1mBetaRetryRequestState,
): Context1mBetaRetryHandler {
  // Official `sb="idle"` (@217634933, per-query-engine closure init).
  let healingState: Context1mBetaRetryState = 'idle'

  return {
    handleRefusal(error: unknown): boolean {
      // Official `if(!(Kn instanceof xt)||Kn.status!==400)return null`
      if (!(error instanceof APIError) || error.status !== 400) {
        return false
      }
      try {
        // Official `let Uo=Yie(Kn),Zo=!Uo&&iN(Kn)` — the named detector
        // wins; "invalid beta flag" is only consulted for unnamed 400s.
        const named = isContext1mBetaRefusedError(error)
        const invalidFlag = !named && isInvalidBetaFlagError(error)
        if (healingState === 'spent') {
          return false
        }
        if (healingState !== 'idle') {
          // Official: `sb=sb==="guessing"&&Zo?"spent":"unproven"` + the
          // resend-also-400'd warn log; returns null (no further retry).
          healingState =
            healingState === 'guessing' && invalidFlag ? 'spent' : 'unproven'
          logForDebugging(
            `[betas] the resend without ${CONTEXT_1M_BETA_HEADER} also got an HTTP 400, so the backend is not recorded as rejecting it; ${
              healingState === 'spent'
                ? 'both said "invalid beta flag", so it is sent again from the next attempt'
                : 'it stays off for the remaining attempts of this request and is sent again on the next request'
            }`,
            { level: 'warn' },
          )
          return false
        }
        // Official `if(!OJe||qCe(cc(Y.model))||!(Uo||Zo&&!Rp()))return null`
        // — the request must have carried the beta, the endpoint must not be
        // genuine first-party, and the 400 must read as a beta refusal.
        // `!Rp()` ≡ true (OCC has no thinking-binding-controls beta).
        if (
          !state.requestCarriedBeta() ||
          isFirstPartyBetaEndpoint() ||
          !(named || invalidFlag)
        ) {
          return false
        }
        healingState = named ? 'retrying' : 'guessing'
        logForDebugging(
          `[betas] an HTTP 400 ${
            named
              ? 'reads as the backend rejecting'
              : 'says "invalid beta flag", which may be about'
          } ${CONTEXT_1M_BETA_HEADER}; resending once without it`,
          { level: 'warn' },
        )
        return true
      } catch (e) {
        // Official `catch(Uo){return c(Uo),null}`
        logError(e)
        return false
      }
    },

    confirmHealed(): void {
      // Official `if(sb!=="retrying"&&sb!=="guessing")return`
      if (healingState !== 'retrying' && healingState !== 'guessing') {
        return
      }
      const unnamed = healingState === 'guessing'
      healingState = 'spent'
      try {
        // Official `ct=ct.filter((Uo)=>Uo!==YS)` — strip the beta from the
        // conversation betas so later requests in this conversation don't
        // re-add it (the process latch covers the model-betas source).
        state.setBetas(
          state.getBetas().filter(beta => beta !== CONTEXT_1M_BETA_HEADER),
        )
        // Official `$wr(Y.model)` — process latch + warn log.
        latchContext1mRefused(state.model)
        // Official `i("tengu_beta_400_healed",{beta:Dde([YS.header]),
        //   model:kt(Y.model),provider:jT(),status:400,unnamed:Kn})`
        logEvent('tengu_beta_400_healed', {
          beta:
            CONTEXT_1M_BETA_HEADER as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            state.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          provider:
            getEffectiveAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          status: 400,
          unnamed,
        })
      } catch (e) {
        // Official `catch(Uo){c(Uo)}`
        logError(e)
      }
    },

    isSuppressed(): boolean {
      // Official `SEe=()=>sb!=="idle"&&sb!=="spent"`
      return healingState !== 'idle' && healingState !== 'spent'
    },
  }
}
