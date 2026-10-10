/**
 * CC 2.1.295 (#070): SessionStart async-hook context dedupe.
 *
 * Bug (v294 and earlier): an async SessionStart hook's unchanged context was
 * re-added to the conversation on EVERY resume — the async delivery path
 * (`getAsyncHookResponseAttachments`) had no dedupe, unlike the sync
 * SessionStart path which filters by content hash. On resume the registry
 * replays the hook output and Claude saw the same additionalContext again
 * and again.
 *
 * Official v295 mechanism (ELF offsets verified against
 * /tmp/cc-153/v295/package/claude; absent from v294 — the
 * "Not adding the output of" string has zero hits in the v294 binary):
 *   - `rPr` @~218461370 (SessionStartResponseTextsSchema, lazy):
 *       {systemMessage: string.optional().catch(undefined),
 *        hookSpecificOutput: {additionalContext: string.optional()}
 *          .optional().catch(undefined)}
 *   - `Hmn` (extractSessionStartTexts): safeParse the response; on failure
 *     return []; else [systemMessage, additionalContext] filtered to entries
 *     that are neither undefined nor ''.
 *   - `sPr` @~218461915 (SessionStartAttachmentSchema, lazy): discriminated
 *     union on "type" where every variant requires hookEvent === literal
 *     "SessionStart":
 *       async_hook_response {response?, command?, pluginId?, exitCode?}
 *       hook_additional_context {content: array.catch([])}
 *       hook_success {content?}
 *     The four `oe()` field aliases must accept objects (response), strings
 *     (command/pluginId/content) and numbers (exitCode) through ONE zod type
 *     while passing values through untransformed — behaviorally z.any().
 *   - `iPr` (parseSessionStartAttachment): safeParse; undefined when the
 *     attachment is not a SessionStart attachment of one of the three types;
 *     per-type result {…data, texts}:
 *       async_hook_response   → {...data, texts: Hmn(data.response)}
 *       hook_additional_context → {texts: data.content}
 *       hook_success          → {texts: content === '' ? [] : [content]}
 *   - `Umn` (isDuplicateSessionStartResponse): texts = Hmn(newResponse.
 *     response); empty → false. Scan priorAttachments BACKWARD; skip
 *     unparseable entries; sameSource = prior.command === new.command &&
 *     prior.pluginId === new.pluginId; a prior entry from a DIFFERENT
 *     command (prior.command !== undefined && !sameSource) is skipped; the
 *     first prior entry WITH texts decides: duplicate iff every new text is
 *     included in the prior texts; a prior same-source async response with
 *     no texts and exitCode 0 → false; otherwise false.
 *
 * The caller (official `JMr`, v295 getAsyncHookResponseAttachments) seeds the
 * prior-attachment list from the conversation messages ONLY when at least one
 * pending response is a SessionStart, appends each attachment it creates (so
 * duplicates within one batch are also caught), and logs
 * "Hooks: Not adding the output of ${processId} (${hookName}) to the
 * conversation: Claude already sees the same text from an earlier
 * SessionStart run" when skipping.
 */
import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'

/** Official `rPr` — response text fields, malformed shapes caught to undefined. */
const SessionStartResponseTextsSchema = lazySchema(() =>
  z.object({
    systemMessage: z.string().optional().catch(undefined),
    hookSpecificOutput: z
      .object({ additionalContext: z.string().optional() })
      .optional()
      .catch(undefined),
  }),
)

/**
 * Official `sPr` — the three SessionStart attachment variants. Non-
 * SessionStart attachments fail the hookEvent literal and are ignored by the
 * dedupe scan (iPr returns undefined).
 */
const SessionStartAttachmentSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('async_hook_response'),
      hookEvent: z.literal('SessionStart'),
      response: z.any().optional(),
      command: z.any().optional(),
      pluginId: z.any().optional(),
      exitCode: z.any().optional(),
    }),
    z.object({
      type: z.literal('hook_additional_context'),
      hookEvent: z.literal('SessionStart'),
      content: z.array(z.any()).catch([]),
    }),
    z.object({
      type: z.literal('hook_success'),
      hookEvent: z.literal('SessionStart'),
      content: z.any().optional(),
    }),
  ]),
)

/** Official `Hmn` verbatim. */
export function extractSessionStartTexts(response: unknown): string[] {
  const parsed = SessionStartResponseTextsSchema().safeParse(response)
  if (!parsed.success) {
    return []
  }
  return [
    parsed.data.systemMessage,
    parsed.data.hookSpecificOutput?.additionalContext,
  ].filter((text): text is string => text !== undefined && text !== '')
}

/** Result of official `iPr` — flat shape; command/pluginId/exitCode exist on
 * the async_hook_response variant only (the other two carry {texts} alone). */
export type SessionStartAttachmentData = {
  texts: string[]
  command?: string
  pluginId?: string
  exitCode?: number
}

/** Official `iPr` verbatim. */
export function parseSessionStartAttachment(
  attachment: unknown,
): SessionStartAttachmentData | undefined {
  const parsed = SessionStartAttachmentSchema().safeParse(attachment)
  if (!parsed.success) {
    return undefined
  }
  switch (parsed.data.type) {
    case 'async_hook_response':
      return {
        ...parsed.data,
        texts: extractSessionStartTexts(parsed.data.response),
      }
    case 'hook_additional_context':
      return { texts: parsed.data.content as string[] }
    case 'hook_success':
      return {
        texts: parsed.data.content === '' ? [] : [parsed.data.content as string],
      }
  }
}

/**
 * Official `Umn` verbatim:
 *   function Umn(e,n){let r=Hmn(e.response);if(r.length===0)return!1;
 *   for(let s=n.length-1;s>=0;s--){let h=iPr(n[s]);if(h===void 0)continue;
 *   let y=h.command===e.command&&h.pluginId===e.pluginId;
 *   if(h.command!==void 0&&!y)continue;
 *   if(h.texts.length>0)return r.every((S)=>h.texts.includes(S));
 *   if(y&&h.exitCode===0)return!1}return!1}
 */
export function isDuplicateSessionStartResponse(
  newResponse: {
    response?: unknown
    command?: string
    pluginId?: string
  },
  priorAttachments: readonly unknown[],
): boolean {
  const texts = extractSessionStartTexts(newResponse.response)
  if (texts.length === 0) {
    return false
  }
  for (let i = priorAttachments.length - 1; i >= 0; i--) {
    const prior = parseSessionStartAttachment(priorAttachments[i])
    if (prior === undefined) {
      continue
    }
    const isSameSource =
      prior.command === newResponse.command &&
      prior.pluginId === newResponse.pluginId
    if (prior.command !== undefined && !isSameSource) {
      continue
    }
    if (prior.texts.length > 0) {
      return texts.every(text => prior.texts.includes(text))
    }
    if (isSameSource && prior.exitCode === 0) {
      return false
    }
  }
  return false
}
