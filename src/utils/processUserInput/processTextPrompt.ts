import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { randomUUID } from 'crypto'
import { setPromptId } from 'src/bootstrap/state.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logEvent } from '../../services/analytics/index.js'
import type { PermissionMode } from '../../types/permissions.js'
import { createUserMessage } from '../messages.js'
import { logOTelEvent, redactIfDisabled } from '../telemetry/events.js'
import { startInteractionSpan } from '../telemetry/sessionTracing.js'
import {
  matchesKeepGoingKeyword,
  matchesNegativeKeyword,
} from '../userPromptKeywords.js'
// K3 (ultracode): the "ultracode" keyword in a user prompt opts that turn
// into the Workflow tool (xhigh effort + dynamic-workflow orchestration for
// the session). Consumes the decision logic in src/utils/effort/ultracode.ts.
import {
  shouldTriggerUltracodeFromPrompt,
  enableUltracodeForSession,
  isHumanTypedPrompt,
  HUMAN_PROMPT_ORIGIN,
} from '../effort/ultracode.js'
import type { PromptOrigin } from '../effort/ultracode.js'

export function processTextPrompt(
  input: string | Array<ContentBlockParam>,
  imageContentBlocks: ContentBlockParam[],
  imagePasteIds: number[],
  attachmentMessages: AttachmentMessage[],
  uuid?: string,
  permissionMode?: PermissionMode,
  isMeta?: boolean,
  // CC 2.1.210 #4: the origin of the prompt. Human-typed input (interactive
  // REPL, `occ -p`, SDK) carries kind:"human"; programmatic / relayed input
  // (webhook payloads, relayed PR comments) carries a non-"human" kind so the
  // ultracode keyword opt-in does not fire on it. Defaults to human — the only
  // callers that reach processTextPrompt today are human-typed prompt paths.
  promptOrigin: PromptOrigin = HUMAN_PROMPT_ORIGIN,
): {
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
} {
  const promptId = randomUUID()
  setPromptId(promptId)

  const userPromptText =
    typeof input === 'string'
      ? input
      : input.find(block => block.type === 'text')?.text || ''
  startInteractionSpan(userPromptText)

  // Emit user_prompt OTEL event for both string (CLI) and array (SDK/VS Code)
  // input shapes. Previously gated on `typeof input === 'string'`, so VS Code
  // sessions never emitted user_prompt (anthropics/claude-code#33301).
  // For array input, use the LAST text block: createUserContent pushes the
  // user's message last (after any <ide_selection>/attachment context blocks),
  // so .findLast gets the actual prompt. userPromptText (first block) is kept
  // unchanged for startInteractionSpan to preserve existing span attributes.
  const otelPromptText =
    typeof input === 'string'
      ? input
      : input.findLast(block => block.type === 'text')?.text || ''
  if (otelPromptText) {
    void logOTelEvent('user_prompt', {
      prompt_length: String(otelPromptText.length),
      prompt: redactIfDisabled(otelPromptText),
      'prompt.id': promptId,
    })
  }

  const isNegative = matchesNegativeKeyword(userPromptText)
  const isKeepGoing = matchesKeepGoingKeyword(userPromptText)
  logEvent('tengu_input_prompt', {
    is_negative: isNegative,
    is_keep_going: isKeepGoing,
  })

  // K3 (ultracode): if the user's prompt carries the "ultracode" keyword and
  // the keyword trigger is enabled (default) and ultracode isn't already
  // active, enable it for the session. CC 2.1.210 #4: the opt-in must only
  // fire on human-originated input — webhook payloads and relayed PR comments
  // carry a non-"human" origin and must NOT trigger it. Mirrors the 2.1.210
  // binary's `workflow_keyword_request` gate:
  //   s?.isHumanTypedPrompt && !s.suppressWorkflowKeyword && WFn() && keyword
  // shouldTriggerUltracodeFromPrompt() also enforces the human-origin guard
  // when an origin is passed; isHumanTypedPrompt(promptOrigin) is applied here
  // to mirror the binary's separate isHumanTypedPrompt gate on the opt-in.
  if (shouldTriggerUltracodeFromPrompt(userPromptText) && isHumanTypedPrompt(promptOrigin)) {
    enableUltracodeForSession()
    logEvent('tengu_ultracode_keyword_triggered', {
      source: 'user_prompt',
    })
  }

  // If we have pasted images, create a message with image content
  if (imageContentBlocks.length > 0) {
    // Build content: text first, then images below
    const textContent =
      typeof input === 'string'
        ? input.trim()
          ? [{ type: 'text' as const, text: input }]
          : []
        : input
    const userMessage = createUserMessage({
      content: [...textContent, ...imageContentBlocks],
      uuid: uuid,
      imagePasteIds: imagePasteIds.length > 0 ? imagePasteIds : undefined,
      permissionMode,
      isMeta: isMeta || undefined,
    })

    return {
      messages: [userMessage, ...attachmentMessages],
      shouldQuery: true,
    }
  }

  const userMessage = createUserMessage({
    content: input,
    uuid,
    permissionMode,
    isMeta: isMeta || undefined,
  })

  return {
    messages: [userMessage, ...attachmentMessages],
    shouldQuery: true,
  }
}
