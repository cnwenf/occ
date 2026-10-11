import { getAutoCompactThreshold } from '../services/compact/autoCompact.js'
import { bytesPerTokenForModel } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'
import {
  type AutoCompactWindowOverride,
  getSessionAutoCompactWindow,
} from './autoCompactWindow.js'
import { logForDebugging } from './debug.js'
import {
  CUTOFF_RESUME_REWRITE_TEXT,
  CUTOFF_RESUME_STREAM_TEXT,
  isCompactBoundaryMessage,
  isSyntheticLoopFeedbackMetaRow,
} from './messages.js'
import {
  getTokenUsage,
  isZeroTokenUsage,
  tokenCountWithEstimation,
  type UsageShape,
} from './tokens.js'

/**
 * Claude Code 2.1.296 (OCC-154 #006): the per-turn "context room" that the
 * Read tool's `allow_large` mode consults to decide how much of an oversized
 * file still fits in the current turn.
 *
 * Official surface (v296 ELF, byte-verified):
 *   factory `ra` @224116753, query wiring @224224750
 *     `contextRoom: ra(()=>Rt, p.options.autoCompactWindow, ()=>P)`
 *   cleared-tokens scan `IHe` @216454443
 *   answered-turn check `syr` @211732941 (+ `en` field reader)
 *   cleared sum `Oms` @211732714 (+ `Ee` finite ≥0 validator)
 *   cutoff carrier `CAs` @207902421
 *
 * DOCUMENTED SIMPLIFICATION: the official threshold wrapper `na` clamps via
 * `TV()||ce().cachedExtraUsageDisabledReason===null ? n : Math.min(n,az)` —
 * an extra-usage/subscription surface OCC does not have. OCC maps the
 * threshold directly to getAutoCompactThreshold (identical when the official
 * clamp is inactive, which is the default state).
 */

export interface ContextRoom {
  /** Recomputed on access — official `get threshold(){return na(e(),o)}`. */
  readonly threshold: number
  /** Context tokens currently held: estimate over messages + cleared tokens. */
  held(): number
  /** Tokens claimed by large reads earlier in this turn. */
  claimed(): number
  /** Reserve tokens for a large read that is about to land in context. */
  claim(tokens: number): void
}

export type ContextRoomOptions = {
  /** Official `()=>Rt` — live per-turn model getter. */
  getModel: () => string
  /** Official `p.options.autoCompactWindow`. */
  autoCompactWindow?: AutoCompactWindowOverride
  /** Official `()=>P` — live per-turn messages getter. */
  getMessages: () => readonly Message[]
}

/**
 * Official `ra` @224116753:
 *   `function ra(e,o,n){try{na(e(),o)}catch(u){c(...);return}
 *      let r=0;
 *      return{get threshold(){return na(e(),o)},
 *             held:()=>Ff(n(),e().bytesPerToken)+IHe(n()),
 *             claimed:()=>r, claim:(u)=>{r+=u}}}`
 *
 * Returns undefined when the initial threshold resolution throws — callers
 * (the Read tool) treat that as "room unavailable" and refuse allow_large.
 */
export function createContextRoom(
  options: ContextRoomOptions,
): ContextRoom | undefined {
  const resolveThreshold = (): number =>
    getAutoCompactThreshold(
      options.getModel(),
      options.autoCompactWindow ?? getSessionAutoCompactWindow(),
    )
  try {
    resolveThreshold()
  } catch (error) {
    logForDebugging(`context room hand-in failed: ${String(error)}`)
    return undefined
  }
  let claimedTokens = 0
  return {
    get threshold(): number {
      return resolveThreshold()
    },
    held: (): number =>
      tokenCountWithEstimation(
        options.getMessages(),
        bytesPerTokenForModel(options.getModel()),
      ) + contextManagementClearedTokens(options.getMessages()),
    claimed: (): number => claimedTokens,
    claim: (tokens: number): void => {
      claimedTokens += tokens
    },
  }
}

/** Official `en` @211732941 — read a raw field off message.message. */
function rawMessageField(message: Message, field: string): unknown {
  const inner = message.message as Record<string, unknown> | undefined
  return inner !== undefined && field in inner ? inner[field] : undefined
}

/** Official `Ee` @211732941 — a usable non-negative finite number. */
function isUsableTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Official `Oms` @211732714:
 *   `function Oms(e){let n=e?.applied_edits;if(!Array.isArray(n))return 0;
 *     let s=0;for(let r of n){if(typeof r!=="object"||r===null)continue;
 *     let{type:h,cleared_input_tokens:y}=r;
 *     if(h==="clear_tool_uses_20250919"&&Ee(y))s+=y}return s}`
 */
export function sumClearedInputTokens(contextManagement: unknown): number {
  const appliedEdits = (
    contextManagement as { applied_edits?: unknown } | undefined
  )?.applied_edits
  if (!Array.isArray(appliedEdits)) {
    return 0
  }
  let total = 0
  for (const edit of appliedEdits) {
    if (typeof edit !== 'object' || edit === null) {
      continue
    }
    const { type, cleared_input_tokens } = edit as {
      type?: unknown
      cleared_input_tokens?: unknown
    }
    if (
      type === 'clear_tool_uses_20250919' &&
      isUsableTokenCount(cleared_input_tokens)
    ) {
      total += cleared_input_tokens
    }
  }
  return total
}

/** Official `U` — the first text content of a message content shape. */
function firstTextContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return undefined
  }
  const first = content[0] as { type?: string; text?: unknown } | undefined
  return first?.type === 'text' && typeof first.text === 'string'
    ? first.text
    : undefined
}

/**
 * Official `CAs` @207902421:
 *   `function CAs(e){if(!r3e(e))return!1;let n=U(e.message?.content);
 *     return n===nMt||n===rMt}`
 *
 * r3e = the synthetic loop-feedback meta-row predicate (OCC
 * isSyntheticLoopFeedbackMetaRow); nMt/rMt = the two cut-off resume texts.
 * True exactly for the meta rows the stream-cutoff recovery injects — those
 * are the "the model answered" carriers syr looks for.
 */
export function isCutoffResumeMetaRow(msg: Message): boolean {
  if (!isSyntheticLoopFeedbackMetaRow(msg)) {
    return false
  }
  const text = firstTextContent(msg.message?.content)
  return text === CUTOFF_RESUME_STREAM_TEXT || text === CUTOFF_RESUME_REWRITE_TEXT
}

/**
 * Official `syr` @211732941:
 *   `function syr(e,n){let s=e[n];if(s?.type!=="assistant")return!1;
 *     let r=en(s,"stop_reason");if(r!=="tool_use"&&r!=="end_turn")return!1;
 *     for(let h=n+1;h<e.length;h++){let y=e[h];
 *       if(y?.type==="user")return CAs(y);
 *       if(y?.type!=="assistant")continue;
 *       if(y.isApiErrorMessage)return y.error==="server_error";
 *       if(en(y,"id")!==en(s,"id"))return!1}
 *     return!1}`
 *
 * True when the assistant turn at `index` was actually completed/answered —
 * a following user row is only an "answer" when it is a cutoff-resume meta
 * carrier; same-message-id assistant siblings (parallel tool-call splits)
 * are walked through.
 */
export function isAnsweredAssistantTurn(
  messages: readonly Message[],
  index: number,
): boolean {
  const assistant = messages[index]
  if (assistant?.type !== 'assistant') {
    return false
  }
  const stopReason = rawMessageField(assistant, 'stop_reason')
  if (stopReason !== 'tool_use' && stopReason !== 'end_turn') {
    return false
  }
  const assistantId = rawMessageField(assistant, 'id')
  for (let h = index + 1; h < messages.length; h++) {
    const next = messages[h]
    if (next?.type === 'user') {
      return isCutoffResumeMetaRow(next)
    }
    if (next?.type !== 'assistant') {
      continue
    }
    if (next.isApiErrorMessage === true) {
      return next.error === 'server_error'
    }
    if (rawMessageField(next, 'id') !== assistantId) {
      return false
    }
  }
  return false
}

/**
 * Official `IHe` @216454443:
 *   `function IHe(e){for(let n=e.length-1;n>=0;n--){let r=e[n];
 *     if(r&&zo(r))return 0;
 *     let s=r?.type==="assistant"?mL(r):void 0;
 *     if(r?.type!=="assistant"||!s)continue;
 *     if(NMt(s))continue;
 *     if(!r.message.context_management&&
 *        (r.message.stop_reason===null||syr(e,n)))continue;
 *     return Oms(r.message.context_management)}
 *   return 0}`
 *
 * Tokens freed by server-side context management (microcompact
 * clear_tool_uses edits) that the raw usage numbers no longer reflect —
 * added back into held() so the room math sees the true context size.
 * A compact boundary resets everything to 0.
 */
export function contextManagementClearedTokens(
  messages: readonly Message[],
): number {
  for (let n = messages.length - 1; n >= 0; n--) {
    const msg = messages[n]
    if (msg && isCompactBoundaryMessage(msg)) {
      return 0
    }
    const usage = msg?.type === 'assistant' ? getTokenUsage(msg) : undefined
    if (msg?.type !== 'assistant' || !usage) {
      continue
    }
    if (isZeroTokenUsage(usage as UsageShape)) {
      continue
    }
    const contextManagement = rawMessageField(msg, 'context_management')
    const stopReason = rawMessageField(msg, 'stop_reason')
    if (
      !contextManagement &&
      (stopReason === null || isAnsweredAssistantTurn(messages, n))
    ) {
      continue
    }
    return sumClearedInputTokens(contextManagement)
  }
  return 0
}
