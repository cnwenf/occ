/**
 * CC 2.1.286 (item-C): context-window-drop notice for model fallback +
 * autocompact-thrashing error.
 *
 * Official changelog: "Improved the model fallback notice and the
 * autocompact-thrashing error to say when a fallback dropped the context
 * window from 1M to 200K tokens."
 *
 * Binary references (v286 ELF @212133200-212135300 + @205138562, all
 * byte-verified this round via dd dumps):
 *   - `el(e,o,n,r)` createFallbackRecord, `tl(e,o)` mergeFallbackChain,
 *     `ol(e,o)` buildFallbackNoticeSuffix, `nl(e)` fallbackContextWindows,
 *     `rl(e,o)` suggest1mFallbackAlternative, `Ho(e)` formatWindowLabel,
 *     `TN(e)` add1mSuffix, `ds({fallback,mainLoopModel,configuredWindow})`
 *     composeThrashingMessage.
 *   - `XEr`/`dSo` thrashing message split @205138562.
 *
 * STAGED (recovered, not wired — call sites live in the query engine /
 * compaction loop, outside the retry modules): notice call site @212193507
 * (content = `Ac(...)+(It?.noticeSuffix??"")`, telemetry adds
 * original/fallback_context_window) and the two thrashing-breaker sites
 * @212156257/@212198514 (both add `afterShrinkingFallback` to
 * `tengu_auto_compact_rapid_refill_breaker`). OCC has no rapid-refill
 * breaker yet; `composeThrashingMessage` below is the pure builder for it.
 */
import { getContextWindowForModel, has1mContext, modelSupports1M } from '../context.js'
import { formatTokens } from '../format.js'
import { logError } from '../log.js'
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'
import { getCanonicalName, getPublicModelDisplayName } from './model.js'
import { pickerFamily, stripTrailing1mTag } from './modelOptions.js'

/**
 * Binary `XEr` @205138562 (byte-verified string).
 */
export const AUTOCOMPACT_THRASHING_MESSAGE =
  'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.'

/**
 * Binary `dSo` = `${XEr} A file being read…` (byte-verified string).
 */
export const AUTOCOMPACT_THRASHING_HINT_MESSAGE = `${AUTOCOMPACT_THRASHING_MESSAGE} A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.`

/** Fallback trigger reason as recorded on a fallback record (binary `r` of `el`). */
export type FallbackRecordReason = 'overloaded' | string

/** Binary `el`/`tl` record shape. */
export interface FallbackRecord {
  fromModel: string
  toModel: string
  toModelIsConfigured: boolean
  leftModels: string[]
  allOverloaded: boolean
}

/** Binary window pair (return of `nl`). */
export interface FallbackContextWindows {
  fromWindow: number
  toWindow: number
}

/** Binary `ol` return: windows + the notice suffix. */
export interface FallbackNoticeInfo extends FallbackContextWindows {
  noticeSuffix: string
}

/** Binary `ds` return. */
export interface ThrashingMessage {
  content: string
  afterShrinkingFallback: boolean
}

/**
 * Binary `el(e,o,n,r)` (byte-verified):
 *   return{fromModel:e,toModel:o,toModelIsConfigured:n,leftModels:[e],
 *          allOverloaded:r==="overloaded"}
 */
export function createFallbackRecord(
  fromModel: string,
  toModel: string,
  toModelIsConfigured: boolean,
  reason: FallbackRecordReason,
): FallbackRecord {
  return {
    fromModel,
    toModel,
    toModelIsConfigured,
    leftModels: [fromModel],
    allOverloaded: reason === 'overloaded',
  }
}

/**
 * Binary `tl(e,o)` (byte-verified): merge consecutive fallback records when
 * the previous hop landed on the next hop's origin — the merged record keeps
 * the FIRST fromModel, concatenates leftModels, and ANDs allOverloaded.
 */
export function mergeFallbackChain(
  previous: FallbackRecord | undefined,
  next: FallbackRecord,
): FallbackRecord {
  return previous?.toModel === next.fromModel
    ? {
        ...next,
        fromModel: previous.fromModel,
        leftModels: [...previous.leftModels, ...next.leftModels],
        allOverloaded: previous.allOverloaded && next.allOverloaded,
      }
    : next
}

/**
 * Binary `Ho(e){return ur(e).toUpperCase()}` — `1000000` → `1M`,
 * `200000` → `200K` (ur ≡ formatTokens).
 */
export function formatWindowLabel(tokens: number): string {
  return formatTokens(tokens).toUpperCase()
}

/**
 * Binary `TN(e){return e.replace(/(\[1m\])+$/i,"")+"[1m]"}` — strip any
 * trailing `[1m]` repetitions, then append exactly one.
 */
export function add1mSuffix(model: string): string {
  return `${model.replace(/(\[1m])+$/i, '')}[1m]`
}

/**
 * Binary `nl(e)` (byte-verified): `um(model, Cf())` per side. Documented
 * simplification: the official passes sdk betas; OCC's pure-util layer has no
 * beta list, and `getContextWindowForModel` honors the `[1m]` suffix
 * directly, so betas are omitted.
 */
export function fallbackContextWindows(
  record: FallbackRecord,
): FallbackContextWindows {
  return {
    fromWindow: getContextWindowForModel(record.fromModel),
    toWindow: getContextWindowForModel(record.toModel),
  }
}

/**
 * Binary `rl(e,o)` (byte-verified):
 *   if(!e.toModelIsConfigured||!vd(o)||!e.allOverloaded)return;
 *   let n=TN(e.toModel);
 *   if(e.leftModels.some((g)=>g.toLowerCase()===n.toLowerCase()))return;
 *   let r=Ue(n),u=j6(n,r);
 *   return(u==="opus"?zP():u==="sonnet"?EN():!0)&&
 *     fa(kt(r))?.context?.supports_1m_beta===!0
 *     ?`use ${n} for this entry in your fallback model list`:void 0
 *
 * Suggest re-running the fallback model with a `[1m]` suffix when the window
 * shrank purely from overloads and the to-model's family is 1M-entitled.
 * Mappings: `vd` ≡ has1mContext; `j6` ≡ pickerFamily; `zP`/`EN` ≡ OCC's
 * established checkOpus1mAccess/checkSonnet1mAccess ports of the same
 * `Zx`/`Wy`/`Gy` gate; `fa(kt(r))?.context?.supports_1m_beta` ≡
 * modelSupports1M (OCC's capability cache strips supports_1m_beta — the
 * canonical substring check is OCC's established `cj`/`fa` mapping).
 */
export function suggest1mFallbackAlternative(
  record: FallbackRecord,
  fromModel: string,
): string | undefined {
  if (!record.toModelIsConfigured || !has1mContext(fromModel) || !record.allOverloaded) {
    return undefined
  }
  const with1m = add1mSuffix(record.toModel)
  if (record.leftModels.some(m => m.toLowerCase() === with1m.toLowerCase())) {
    return undefined
  }
  const canonical = getCanonicalName(with1m)
  const family = pickerFamily(with1m)
  const entitled =
    family === 'opus'
      ? checkOpus1mAccess()
      : family === 'sonnet'
        ? checkSonnet1mAccess()
        : true
  return entitled && modelSupports1M(stripTrailing1mTag(canonical))
    ? `use ${with1m} for this entry in your fallback model list`
    : undefined
}

/**
 * Binary `ol(e,o)` (byte-verified): windows of the CURRENT record `e`, 1M
 * suggestion from the MERGED chain record `o`. The suffix is empty unless the
 * window actually shrank; the `(to keep …)` clause is appended only when a
 * 1M suggestion exists. try/catch → undefined.
 */
export function buildFallbackNoticeSuffix(
  record: FallbackRecord,
  mergedRecord: FallbackRecord,
): FallbackNoticeInfo | undefined {
  try {
    const windows = fallbackContextWindows(record)
    const suggestion = suggest1mFallbackAlternative(mergedRecord, record.fromModel)
    return {
      ...windows,
      noticeSuffix:
        windows.toWindow >= windows.fromWindow
          ? ''
          : ` · context window ${formatWindowLabel(windows.fromWindow)} → ${formatWindowLabel(windows.toWindow)} tokens` +
            (suggestion === undefined
              ? ''
              : ` (to keep ${formatWindowLabel(windows.fromWindow)}, ${suggestion})`),
    }
  } catch (error) {
    logError(error)
    return undefined
  }
}

/**
 * Binary `ds({fallback,mainLoopModel,configuredWindow})` (byte-verified):
 * the autocompact-thrashing error text, extended when the thrash happened
 * after a fallback shrank the context window. Falls back to the plain hint
 * message (`dSo`) unless: a fallback record exists, it landed on the current
 * main-loop model, the window shrank, and (official extra guard) the
 * auto-compact-window resolution for the to-model is not already >= the
 * from-model's.
 *
 * Documented simplification: the official second guard uses
 * `jw(Au(model), configuredWindow).window` — the believed/declared window
 * store + CLAUDE_CODE_AUTO_COMPACT_WINDOW resolution, which OCC has no
 * per-model surface for; OCC uses getContextWindowForModel on both sides
 * (the `configuredWindow` parameter is accepted for call-site parity but
 * unused).
 */
export function composeThrashingMessage(params: {
  fallback: FallbackRecord | undefined
  mainLoopModel: string
  configuredWindow?: number
}): ThrashingMessage {
  const { fallback, mainLoopModel } = params
  const plain: ThrashingMessage = {
    content: AUTOCOMPACT_THRASHING_HINT_MESSAGE,
    afterShrinkingFallback: false,
  }
  if (fallback === undefined || fallback.toModel !== mainLoopModel) {
    return plain
  }
  try {
    const windows = fallbackContextWindows(fallback)
    if (
      windows.toWindow >= windows.fromWindow ||
      getContextWindowForModel(fallback.toModel) >=
        getContextWindowForModel(fallback.fromModel)
    ) {
      return plain
    }
    const fromName = getPublicModelDisplayName(fallback.fromModel)
    const suggestion = suggest1mFallbackAlternative(fallback, fallback.fromModel)
    return {
      content:
        `${AUTOCOMPACT_THRASHING_MESSAGE} The likely cause: while working on this response, Claude Code fell back from ${fromName} to ${getPublicModelDisplayName(fallback.toModel)} and runs that model with a ${formatWindowLabel(windows.toWindow)}-token context window on your provider, instead of ${formatWindowLabel(windows.fromWindow)}. Your next message tries ${fromName} first. ` +
        (suggestion === undefined
          ? `To avoid this, use a fallback model with a ${formatWindowLabel(windows.fromWindow)} context window, or use /clear to start fresh.`
          : `To keep ${formatWindowLabel(windows.fromWindow)}, ${suggestion}.`),
      afterShrinkingFallback: true,
    }
  } catch (error) {
    logError(error)
    return plain
  }
}
