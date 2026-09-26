/**
 * x-claude-code-prompt-id — official Claude Code 2.1.283 (byte-verified port).
 *
 * The official 2.1.283 binary gained a per-user-prompt correlation id that is
 * sent to the first-party gateway as the `x-claude-code-prompt-id` request
 * header (behind the same CLAUDE_CODE_GATEWAY_HINT_HEADERS gate as the 2.1.273
 * hint headers) and embedded in the attribution billing header as
 * `cc_prompt_id=<uuid>;`. 2.1.282 has zero occurrences of the header string;
 * 2.1.283 has two (string table @100701900, code @198746664).
 *
 * Official symbols → OCC symbols (all logic recovered verbatim from the
 * 2.1.283 linux-x64 ELF; offsets are byte positions in that binary):
 *   bqn → PROMPT_ID_HEADER            ("x-claude-code-prompt-id" @198746664)
 *   d   → PROMPT_ID_UUID_RE           (chunk-s1pmhfks, next to `en`)
 *   en  → validatePromptId            (@195845579 region)
 *   Zfe → isToolResultContent         (@207039600)
 *   lmt → isForkBoilerplateMessage    (@196084486, C_e="fork-boilerplate")
 *   SZt → findLastRealUserTurnIndex   (@207039822)
 *   EIe → getMessagesPromptId         (@207039918)
 *   qEo → (inlined into resolveQueryPromptId — `qEo(e){return EIe(e)}`)
 *   Wve → resolveQueryPromptId        (@205293880)
 *   UE  → isSubagentContext           (@198917846: `e.agentType==="subagent"`)
 *   hnr/iwr → backfillMessagePromptId (@207040552 region; promptId half only)
 *
 * Lifecycle (official):
 *  - Stamped per user prompt into the RequestJournal (`qmt(e)` @195899116
 *    region; module accessor pair U_e()/qmt() @195978270). OCC already mirrors
 *    the journal with bootstrap/state.ts getPromptId()/setPromptId() — the
 *    submit paths (processTextPrompt / processSlashCommand) already stamp it.
 *  - Carried on user messages (`Ae` factory spread `...tt!==void 0&&
 *    {promptId:tt}` @207040852; callers @211216853 REPL, @223340118 SDK).
 *  - Persisted on transcript user entries (@207233931 — OCC mirrors this in
 *    sessionStorage recordTranscript) and STRIPPED when history is served
 *    back (QLn @207272833, fork-context @207253880, agent transcript
 *    @207355846, resume-sanitize @206164983 — OCC mirrors via
 *    removeExtraFields).
 *  - Read back per API request in the query loop (`W=Wve(e,h.agentContext)`
 *    @205302055) and threaded into the client factory EV (`promptId:S` param,
 *    header spread `...W&&S!==void 0&&en(S)!==null&&{[bqn]:S}` @202058441),
 *    the non-streaming fallback yOt (@205291335, call sites @205395827 /
 *    @205399719), and the attribution builder r0r (`cc_prompt_id` @199419765,
 *    called via Uqe @205315912).
 *  - Subagents inherit the parent turn's id: every spawn/resume site computes
 *    `parentPromptId:Wve(messages,agentContext)` (@210571017 spawn →
 *    @210575482 async / @210576534 sync context literals; @221139412 resume;
 *    @227166616 workflow launch) and Wve falls back to
 *    `agentContext.parentPromptId` for subagent (non-main-session) contexts.
 *  - Auto-compaction backfills the derived id onto the summary messages so
 *    post-compaction requests keep sending it (`g.summaryMessages=
 *    iwr(g.summaryMessages,A)` @211120458 / @211163030).
 *
 * Deviations (documented, no invented behavior):
 *  - `turnOrigin`: the official SZt real-turn condition is
 *    `r.promptId||r.turnOrigin||!(isMeta||isVirtual||isVisibleInTranscriptOnly)`
 *    and iwr/hnr backfill turnOrigin alongside promptId. OCC has not ported
 *    the turn-origin feature, so no message ever carries `turnOrigin` and the
 *    term is observationally dead — it is omitted here (and the backfill is
 *    promptId-only). Re-add when turnOrigin lands.
 *  - `isMainSession`: the official Wve fallback gate is
 *    `UE(n)&&!n.isMainSession`. OCC's SubagentContext gains the optional
 *    field as a forward-compat seam, but no OCC creation site sets it (the
 *    official background-main-session context is the only setter). Since OCC
 *    also never stamps parentPromptId on a main-session context, the gate
 *    resolves identically.
 *  - The official `TC` reserved-header set (@198747073, custom-header
 *    rejection error-message classification) has no OCC analog surface —
 *    OCC does not port the XG InvalidRequestHeaderValueError validation
 *    chain, so there is nothing to add the header name to.
 *  - The official JSONL field-order list `Q=["cwd","gitBranch","version",
 *    "userType","entrypoint","promptId"]` (@200146159, Bbo strip-on-serve)
 *    has no OCC analog: OCC's single serve-time strip choke point is
 *    removeExtraFields (updated to strip promptId, matching QLn).
 */

import { FORK_BOILERPLATE_TAG } from 'src/constants/xml.js'
import type { Message } from 'src/types/message.js'
import type { AgentContext } from 'src/utils/agentContext.js'
import { isSubagentContext } from 'src/utils/agentContext.js'
import { logForDebugging } from 'src/utils/debug.js'

/**
 * Official `bqn` (@198746664): `var bqn="x-claude-code-prompt-id"`.
 * Emitted by the client factory only when the gateway-hints gate (official
 * `qnn()` — OCC isGatewayHintHeadersEnabled) is on AND the value passes
 * validatePromptId.
 */
export const PROMPT_ID_HEADER = 'x-claude-code-prompt-id'

/**
 * Official `d` (chunk-s1pmhfks, shared by `en` and inlined verbatim in the
 * r0r attribution builder's cc_prompt_id gate):
 *   /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
 */
export const PROMPT_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Official `en(t)` verbatim (@195845579 region):
 *   function en(t){if(typeof t!=="string")return null;return d.test(t)?t:null}
 * Returns the id unchanged when it is a UUID-format string, else null.
 */
export function validatePromptId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  return PROMPT_ID_UUID_RE.test(value) ? value : null
}

/**
 * Official `Zfe(e)` verbatim (@207039600):
 *   Array.isArray(e)&&e.some((n)=>n.type==="tool_result")
 */
export function isToolResultContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  )
}

/**
 * Official `lmt(e)` verbatim (@196084486; C_e="fork-boilerplate"):
 *   if(e.type!=="user")return!1;
 *   let r=e.message?.content;
 *   return Array.isArray(r)&&r.some((s)=>s?.type==="text"&&
 *     typeof s.text==="string"&&s.text.startsWith(`<${C_e}>`))
 */
export function isForkBoilerplateMessage(message: Message): boolean {
  if (message.type !== 'user') {
    return false
  }
  const content = message.message?.content
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string' &&
        ((block as { text: string }).text.startsWith(
          `<${FORK_BOILERPLATE_TAG}>`,
        )),
    )
  )
}

/** Reads the wrapper-level promptId off a user message (typed passthrough). */
function readMessagePromptId(message: Message): string | undefined {
  const value = (message as { promptId?: unknown }).promptId
  return typeof value === 'string' ? value : undefined
}

/**
 * Official `SZt(e)` verbatim (@207039822) — index of the last real user turn,
 * scanning backwards:
 *   for(let n=e.length-1;n>=0;n--){let r=e[n];
 *     if(r.type!=="user")continue;
 *     if(lmt(r))return-1;                       // fork boilerplate → no turn
 *     if(Zfe(r.message.content))continue;       // tool_result → keep scanning
 *     if(r.promptId||r.turnOrigin||
 *        !(r.isMeta||r.isVirtual||r.isVisibleInTranscriptOnly))return n}
 *   return -1
 * The `r.turnOrigin` term is omitted — see the file-header deviation note.
 */
export function findLastRealUserTurnIndex(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.type !== 'user') {
      continue
    }
    if (isForkBoilerplateMessage(message)) {
      return -1
    }
    if (isToolResultContent(message.message?.content)) {
      continue
    }
    if (
      readMessagePromptId(message) !== undefined ||
      !(message.isMeta || message.isVirtual || message.isVisibleInTranscriptOnly)
    ) {
      return index
    }
  }
  return -1
}

/**
 * Official `EIe(e)` verbatim (@207039918):
 *   let n=SZt(e);if(n===-1)return;
 *   let r=e[n];return r.type==="user"?r.promptId:void 0
 */
export function getMessagesPromptId(
  messages: readonly Message[],
): string | undefined {
  const index = findLastRealUserTurnIndex(messages)
  if (index === -1) {
    return undefined
  }
  const message = messages[index]
  return message?.type === 'user' ? readMessagePromptId(message) : undefined
}

/**
 * Official `Wve(e,n)` verbatim (@205293880; qEo(e){return EIe(e)} inlined):
 *   let r;try{r=qEo(e)}catch(s){d(te(s)),r=void 0}
 *   return r??(UE(n)&&!n.isMainSession?n.parentPromptId:void 0)
 * The catch logs and degrades to undefined (official logs via its error
 * telemetry helper; OCC logs via logForDebugging). The fallback only fires
 * for subagent contexts that are not a main session — official `UE` is
 * `agentType==="subagent"`; the `!isMainSession` term is kept byte-faithful
 * via the optional SubagentContext field (see file-header deviation note).
 */
export function resolveQueryPromptId(
  messages: readonly Message[],
  agentContext: AgentContext | undefined,
): string | undefined {
  let fromMessages: string | undefined
  try {
    fromMessages = getMessagesPromptId(messages)
  } catch (error) {
    logForDebugging(
      `resolveQueryPromptId: message derivation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    fromMessages = undefined
  }
  if (fromMessages !== undefined) {
    return fromMessages
  }
  if (isSubagentContext(agentContext) && !agentContext.isMainSession) {
    return agentContext.parentPromptId
  }
  return undefined
}

/**
 * Official `hnr(e,n,r)` (@207040552) restricted to its promptId half, applied
 * the way `iwr(e,n)` (@207040763) applies it after auto-compaction:
 *   iwr: let r;try{r=EIe(n)}catch(g){d(g),r=void 0}return hnr(e,r,void 0)
 *   hnr: stamp promptId onto every message that lacks one, from the id
 *        derived off the source (pre-compaction) array; identity-preserving
 *        when there is nothing to stamp.
 * Used by query.ts on compactionResult.summaryMessages so post-compaction
 * requests keep carrying the current prompt id (official @211120458 /
 * @211163030). The turnOrigin half of hnr is omitted — see file header.
 */
export function backfillMessagePromptId<T extends Message>(
  messages: T[],
  sourceMessages: readonly Message[],
): T[] {
  let promptId: string | undefined
  try {
    promptId = getMessagesPromptId(sourceMessages)
  } catch (error) {
    logForDebugging(
      `backfillMessagePromptId: derivation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    promptId = undefined
  }
  if (promptId === undefined) {
    return messages
  }
  return messages.map(message =>
    readMessagePromptId(message) === undefined
      ? ({ ...message, promptId } as T)
      : message,
  )
}
