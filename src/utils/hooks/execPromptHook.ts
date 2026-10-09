import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import { isPromptTooLongMessage } from '../../services/api/errors.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { safeParseJSON } from '../json.js'
import {
  createUserMessage,
  extractTextContent,
  getContentText,
} from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import type { PromptHook } from '../settings/types.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  HOOK_JUDGMENT_GUIDANCE,
  addArgumentsToPrompt,
  capHookString,
  hookResponseSchema,
} from './hookHelpers.js'
import {
  HOOK_TRANSCRIPT_BUDGET_RATIO,
  truncateHookTranscript,
} from './hookTranscriptTruncation.js'

/**
 * Execute a prompt-based hook using an LLM.
 *
 * CC 2.1.292–2.1.294 (OCC-150): verbatim port of the official prompt-hook
 * judge (292 `Rnn` → 294 `Pon`, byte-verified from the linux-x64 ELFs). The
 * 293→294 delta is the shared judgment-guidance fragment (`q3` →
 * HOOK_JUDGMENT_GUIDANCE) injected into both system prompts plus the
 * decision-oriented rewrite of the non-Stop prompt; the 292 baseline already
 * carried the Stop/non-Stop split, transcript truncation (`Hpr`), the
 * prompt-too-long retry at half budget (`Mon/2`), the [prompt]: reason
 * blocking format with 500-char cap (`Fpr`/`tc`/`Npr`), required
 * ["ok","reason"], tools: [], the hook_success attachment messages, and the
 * timedOut flag + tengu_hook_prompt_timeout telemetry.
 *
 * Official options NOT ported (fields absent from OCC's query Options /
 * ThinkingConfig — recorded in the OCC-150 ledger): promptTooLongIsHandled,
 * proactivityLevel, stickyBetas, agentContext, credentials,
 * thinkingConfig.mechanical.
 */

/** Official `Npr` — cap for the echoed hook prompt in the blocking error. */
const HOOK_PROMPT_BLOCKING_CAP = 500

/**
 * Official 294 Stop/SubagentStop evaluator system prompt (`Ne`), verbatim.
 * Built lazily: HOOK_JUDGMENT_GUIDANCE lives in hookHelpers, which sits on an
 * import cycle through messages/attachments back to hooks.ts — a top-level
 * template here would hit the TDZ when hookHelpers is evaluated first.
 */
const stopConditionSystemPrompt = () => `You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

${HOOK_JUDGMENT_GUIDANCE}

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

/** Official 294 non-Stop evaluator system prompt (`Ye`), verbatim. Lazy for
 * the same TDZ-cycle reason as stopConditionSystemPrompt above. */
const hookSystemPrompt = () => `You are evaluating a hook in Claude Code. The user's text says what to check. Decide whether the action may go ahead.

${HOOK_JUDGMENT_GUIDANCE}

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<why the action may go ahead>"}
- {"ok": false, "reason": "<why the action is blocked>"}

Always include a "reason" field.`

/** Official `z2` — strip a single wrapping ``` fence from the model reply. */
function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim()
}

/** Official `Fpr` — does the transcript already contain a user message with this marker? */
function transcriptContains(
  messages: Message[] | undefined,
  needle: string,
): boolean {
  return (messages ?? []).some(
    message =>
      message.type === 'user' &&
      (getContentText(message.message?.content ?? '') ?? '').includes(needle),
  )
}

export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  const isStopEvent = hookEvent === 'Stop' || hookEvent === 'SubagentStop'
  try {
    // Official 292+: Stop/SubagentStop wrap the condition in a
    // transcript-evidence instruction before $ARGUMENTS substitution.
    const rawPrompt = isStopEvent
      ? `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ${hook.prompt}`
      : hook.prompt
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(rawPrompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    const model = hook.model ?? getSmallFastModel()

    // Official `be` builder: transcript (truncated to the evaluator budget)
    // followed by the hook's user message. The ratio parameter drives the
    // prompt-too-long retry at half budget (official `Mon/2`).
    const buildMessages = (budgetRatio?: number): Message[] =>
      messages && messages.length > 0
        ? [
            ...truncateHookTranscript(messages, model, budgetRatio),
            userMessage,
          ]
        : [userMessage]
    let messagesToQuery = buildMessages()

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000
    const hookStartTime = Date.now()

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const queryOnce = () =>
        queryModelWithoutStreaming({
          messages: messagesToQuery,
          systemPrompt: asSystemPrompt([
            isStopEvent ? stopConditionSystemPrompt() : hookSystemPrompt(),
          ]),
          thinkingConfig: { type: 'disabled' as const },
          // Official 292+: the judge is text-only — no tools.
          tools: [],
          signal: combinedSignal,
          options: {
            async getToolPermissionContext() {
              const appState = toolUseContext.getAppState()
              return appState.toolPermissionContext
            },
            model,
            toolChoice: undefined,
            isNonInteractiveSession: true,
            hasAppendSystemPrompt: false,
            agents: [],
            querySource: 'hook_prompt',
            mcpTools: [],
            agentId: toolUseContext.agentId,
            outputFormat: {
              type: 'json_schema',
              schema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  reason: { type: 'string' },
                  impossible: { type: 'boolean' },
                },
                // Official 292+: reason is REQUIRED in the judge's output.
                required: ['ok', 'reason'],
                additionalProperties: false,
              },
            },
          },
        })

      let response = await queryOnce()

      // Official `ave` retry: "Prompt is too long" → halve the transcript
      // budget (Mon/2) and retry once.
      if (
        isPromptTooLongMessage(response) &&
        messages &&
        messages.length > 0
      ) {
        logEvent('tengu_hook_prompt_too_long_retry', {
          evaluatorModel:
            model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        messagesToQuery = buildMessages(HOOK_TRANSCRIPT_BUDGET_RATIO / 2)
        logForDebugging(
          `Hooks: evaluator prompt too long; retrying with ${messagesToQuery.length} messages`,
        )
        response = await queryOnce()
      }

      cleanupSignal()

      // Official 292+: a surfaced API error (that survived the too-long retry)
      // becomes a non-blocking hook error carrying the API message.
      if (response.isApiErrorMessage) {
        const apiErrorText = extractTextContent(
          Array.isArray(response.message.content) ? response.message.content : [],
        ).trim()
        logForDebugging(
          `Hooks: prompt-hook evaluator API error: ${apiErrorText}`,
          { level: 'error' },
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Hook evaluator API error: ${apiErrorText}`,
            stdout: '',
            exitCode: 1,
          }),
        }
      }

      // Extract text content from response
      const content = extractTextContent(
        Array.isArray(response.message.content) ? response.message.content : [],
      )

      // Update response length for spinner display (OCC-specific UX; the
      // official binary updates the spinner through its own stream path).
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      // Official `gt(z2(st),!1)` — strip a wrapping code fence before parsing.
      const json = safeParseJSON(stripCodeFence(fullResponse), false)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        // Official 292+: `impossible` is honored ONLY on Stop/SubagentStop
        // (V-gated) — /goal D8: don't block forever; mark the goal failed so
        // the GoalStatus panel shows "Goal could not be achieved" and let the
        // session stop. onHookSuccess (registerGoalHook) reads `impossible`
        // off the aggregated result to set ActiveGoal.failed.
        if (parsed.data.impossible === true && isStopEvent) {
          logForDebugging(
            `Hooks: Prompt hook condition judged impossible: ${parsed.data.reason}`,
          )
          return {
            hook,
            outcome: 'success',
            impossible: true,
            stopReason: parsed.data.reason,
            message: createAttachmentMessage({
              type: 'hook_success',
              hookName,
              toolUseID: effectiveToolUseID,
              hookEvent,
              content: '',
            }),
          }
        }
        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        // Official `Fpr`/`tc`/`Npr`: when the transcript already contains a
        // `[prompt]:` feedback marker (a repeated Stop block), cap the echoed
        // prompt at 500 chars so the feedback loop doesn't grow unboundedly.
        const command = transcriptContains(messages, `[${hook.prompt}]:`)
          ? capHookString(hook.prompt, HOOK_PROMPT_BLOCKING_CAP)
          : hook.prompt
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `[${command}]: ${parsed.data.reason}`,
            command,
          },
          // 2.1.139 (OCC-51): official binary formula (2.1.139 linux-x64
          // bundle, prompt-hook judge) is
          //   preventContinuation = !isStopEvent && hook.continueOnBlock !== true
          // with isStopEvent = hookEvent === 'Stop' || hookEvent === 'SubagentStop'.
          // On Stop/SubagentStop a blocking prompt hook NEVER hard-stops: the
          // rejection reason is fed back ("Stop hook feedback:") and the turn
          // continues — that is what makes /goal's keep-working loop run.
          // The earlier port misread the event guard as the `impossible` flag
          // (which returns early above), so every blocking Stop prompt hook
          // hard-stopped the session ('stop_hook_prevented') and left the
          // feedback-retry chain + block cap in query.ts unreachable.
          // continueOnBlock only has effect on non-Stop events (e.g. PostToolUse).
          preventContinuation: !isStopEvent && hook.continueOnBlock !== true,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(
        `Hooks: Prompt hook condition was met: ${parsed.data.reason}`,
      )
      return {
        hook,
        outcome: 'success',
        stopReason: parsed.data.reason,
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        // Official: the hook timed out iff OUR combined signal aborted while
        // the ambient toolUseContext.abortController did not (a user/parent
        // abort cancels both and is a plain 'cancelled').
        const timedOut = !toolUseContext.abortController.signal.aborted
        if (timedOut) {
          const durationMs = Date.now() - hookStartTime
          const timeoutMs = hookTimeoutMs
          logForDebugging(
            `Hooks: prompt hook (${hookEvent}) timed out after ${durationMs}ms (limit ${timeoutMs}ms)`,
            { level: 'warn' },
          )
          logEvent('tengu_hook_prompt_timeout', {
            hookEvent:
              hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            timeoutMs,
            durationMs,
          })
        }
        return {
          hook,
          outcome: 'cancelled',
          timedOut,
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
