import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { query } from '../../query.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import type { ToolUseContext } from '../../Tool.js'
import { type Tool, toolMatchesName } from '../../Tool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ALL_AGENT_DISALLOWED_TOOLS } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { createAttachmentMessage } from '../attachments.js'
import { createCombinedAbortSignal } from '../combinedAbortSignal.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import type { HookResult } from '../hooks.js'
import { createUserMessage, handleMessageFromStream } from '../messages.js'
import { isModelAlias } from '../model/aliases.js'
import { getSmallFastModel, parseUserSpecifiedModel } from '../model/model.js'
import { hasPermissionsToUseTool } from '../permissions/permissions.js'
import { getAgentTranscriptPath, getTranscriptPath } from '../sessionStorage.js'
import type { AgentHook } from '../settings/types.js'
import { jsonStringify } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  HOOK_JUDGMENT_GUIDANCE,
  addArgumentsToPrompt,
  createStructuredOutputTool,
  hookResponseSchema,
  registerStructuredOutputEnforcement,
} from './hookHelpers.js'
// Aliased: the local derivation below keeps the name `hookTimeoutMs` (it feeds
// createCombinedAbortSignal), so the import must not collide with it.
import { hookTimeoutMs as computeHookTimeoutMs } from './hookSessionSlots312.js'
import { clearSessionHooks } from './sessionHooks.js'

/**
 * CC 2.1.300 (#28) — official `AIr` (@219020138, byte-verified):
 * `function AIr(e){return jme(e.toLowerCase().trim())?Ot(e):e}` — an alias
 * check on the normalized string, but parseUserSpecifiedModel receives the
 * ORIGINAL value. Only applied when hook.model is explicitly set (official
 * `qt=e.model===void 0?Ut:AIr(Ut)` @227965400).
 */
function resolveAgentHookModel(model: string): string {
  return isModelAlias(model.toLowerCase().trim())
    ? parseUserSpecifiedModel(model)
    : model
}

/**
 * CC 2.1.300 (#28) — official refusal detector `ORe` (@229228103,
 * byte-verified):
 * `e.isApiErrorMessage===!0&&[400,403,404].includes(e.apiErrorStatus??0)&&!e.resendCannotCure`
 *
 * OCC deviation (documented): OCC assistant messages carry no
 * `apiErrorStatus`/`resendCannotCure` envelope fields, so when the official
 * status field is absent the detector falls back to OCC's SDK error category
 * (`invalid_request` maps to 400/404, `authentication_failed` to 401/403 —
 * 401 is a harmless over-inclusion: a real 401 also cannot succeed on the
 * caller model, and the retry is then simply refused again).
 */
function isModelRefusalMessage(message: unknown): boolean {
  const candidate = message as {
    isApiErrorMessage?: boolean
    apiErrorStatus?: number
    resendCannotCure?: boolean
    error?: string
  }
  if (candidate?.isApiErrorMessage !== true || candidate.resendCannotCure) {
    return false
  }
  if (typeof candidate.apiErrorStatus === 'number') {
    return [400, 403, 404].includes(candidate.apiErrorStatus)
  }
  return (
    candidate.error === 'invalid_request' ||
    candidate.error === 'authentication_failed'
  )
}

/**
 * Execute an agent-based hook using a multi-turn LLM query
 */
export async function execAgentHook(
  hook: AgentHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
  // Kept for signature stability with the other exec*Hook functions.
  // Was used by hook.prompt(messages) before the .transform() was removed
  // (CC-79) — the only consumer of that was ExitPlanModeV2Tool's
  // programmatic construction, since refactored into VerifyPlanExecutionTool.
  _messages: Message[],
  agentName?: string,
): Promise<HookResult> {
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`

  // Get transcript path from context
  const transcriptPath = toolUseContext.agentId
    ? getAgentTranscriptPath(toolUseContext.agentId)
    : getTranscriptPath()
  const hookStartTime = Date.now()
  try {
    // Replace $ARGUMENTS with the JSON input
    const processedPrompt = addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing agent hook with prompt: ${processedPrompt}`,
    )

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })
    const agentMessages = [userMessage]

    logForDebugging(
      `Hooks: Starting agent query with ${agentMessages.length} messages`,
    )

    // Setup timeout and combine with parent signal
    // CC 2.1.312 (#22) — official `let Oe=BM(e,60000)` @251774554
    // (byte-verified): `BM(e,n){return e.timeout?Math.max(e.timeout,pEr)*1000:n}`
    // with `pEr=1` @251761428 — a `timeout` under 1 second counts as 1 second;
    // falsy `timeout` (0/undefined) falls back to the 60000ms event default.
    const hookTimeoutMs = computeHookTimeoutMs(hook, 60000)
    const hookAbortController = createAbortController()

    // Combine parent signal with timeout, and have it abort our controller
    const { signal: parentTimeoutSignal, cleanup: cleanupCombinedSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })
    const onParentTimeout = () => hookAbortController.abort()
    parentTimeoutSignal.addEventListener('abort', onParentTimeout)

    // Combined signal is just our controller's signal now
    const combinedSignal = hookAbortController.signal

    try {
      // Create StructuredOutput tool with our schema
      const structuredOutputTool = createStructuredOutputTool()

      // Filter out any existing StructuredOutput tool to avoid duplicates with different schemas
      // (e.g., when parent context has a StructuredOutput tool from --json-schema flag)
      const filteredTools = toolUseContext.options.tools.filter(
        tool => !toolMatchesName(tool, SYNTHETIC_OUTPUT_TOOL_NAME),
      )

      // Use all available tools plus our structured output tool
      // Filter out disallowed agent tools to prevent stop hook agents from spawning subagents
      // or entering plan mode, and filter out duplicate StructuredOutput tools
      const tools: Tool[] = [
        ...filteredTools.filter(
          tool => !ALL_AGENT_DISALLOWED_TOOLS.has(tool.name),
        ),
        structuredOutputTool,
      ]

      // CC 2.1.294 (OCC-150): official `Rt` head — Stop/SubagentStop keep the
      // stop-condition wording; every other event gets the generic
      // evaluate-the-condition head (byte-verified from the 294 ELF).
      const isStopEvent = hookEvent === 'Stop' || hookEvent === 'SubagentStop'
      const promptHead = isStopEvent
        ? 'You are verifying a stop condition in Claude Code. Your task is to verify that the agent completed the given plan.'
        : `You are evaluating a ${hookEvent} hook in Claude Code. Your task is to evaluate the condition described in the user message.`
      // OCC always has a local transcript path (no served-remote sessions —
      // the official `z`/"served for another machine's session" branch is
      // dormant in OCC and intentionally not ported).
      const systemPrompt = asSystemPrompt([
        `${promptHead} The conversation transcript is available at: ${transcriptPath}\nYou can read this file to analyze the conversation history if needed.

Use the available tools to inspect the codebase and verify the condition.
Use as few steps as possible - be efficient and direct.

When done, return your result using the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool, always with a reason.

${HOOK_JUDGMENT_GUIDANCE}`,
      ])

      // CC 2.1.300 (#28) — official executor head (@227965400, byte-verified):
      // `Ut=UIe(e.model??Ov()),qt=e.model===void 0?Ut:AIr(Ut),Wt=oc(y),
      //  tn=e.model===void 0&&Ie()==="gateway"&&…?Wt:qt`
      // Aliases resolve ONLY for an explicit hook.model; the caller model
      // (`Wt`) is the retry target. OCC deviations: `UIe` (deniedModels
      // redirect) was never ported (no OCC surface); the gateway branch is
      // dead in OCC (getAPIProvider never returns 'gateway').
      const configuredModel = hook.model ?? getSmallFastModel()
      const model =
        hook.model === undefined
          ? configuredModel
          : resolveAgentHookModel(configuredModel)
      const callerModel = toolUseContext.options.mainLoopModel
      const MAX_AGENT_TURNS = 50

      // Create unique agentId for this hook agent
      const hookAgentId = asAgentId(`hook-agent-${randomUUID()}`)

      // Create a modified toolUseContext for the agent
      const agentToolUseContext: ToolUseContext = {
        ...toolUseContext,
        agentId: hookAgentId,
        abortController: hookAbortController,
        options: {
          ...toolUseContext.options,
          tools,
          mainLoopModel: model,
          isNonInteractiveSession: true,
          thinkingConfig: { type: 'disabled' as const },
        },
        setInProgressToolUseIDs: () => {},
        getAppState() {
          const appState = toolUseContext.getAppState()
          // Add session rule to allow reading transcript file
          const existingSessionRules =
            appState.toolPermissionContext.alwaysAllowRules.session ?? []
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              mode: 'dontAsk' as const,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                session: [...existingSessionRules, `Read(/${transcriptPath})`],
              },
            },
          }
        },
      }

      // Register a session-level stop hook to enforce structured output
      registerStructuredOutputEnforcement(
        toolUseContext.setAppState,
        hookAgentId,
      )

      let structuredOutputResult: { ok: boolean; reason?: string } | null = null
      let turnCount = 0
      let hitMaxTurns = false
      // CC 2.1.300 (#28): official captures the refusal verdict from the
      // FIRST assistant message only (`if($n===0)Xn=ORe(_n)` @227966xxx).
      let modelRefused = false

      // Use query() for multi-turn execution
      for await (const message of query({
        messages: agentMessages,
        systemPrompt,
        userContext: {},
        systemContext: {},
        canUseTool: hasPermissionsToUseTool,
        toolUseContext: agentToolUseContext,
        querySource: 'hook_agent',
      })) {
        // Process stream events to update response length in the spinner
        handleMessageFromStream(
          message,
          () => {}, // onMessage - we handle messages below
          newContent =>
            toolUseContext.setResponseLength(
              length => length + newContent.length,
            ),
          toolUseContext.setStreamMode ?? (() => {}),
          () => {}, // onStreamingToolUses - not needed for hooks
        )

        // Skip streaming events for further processing
        if (
          message.type === 'stream_event' ||
          message.type === 'stream_request_start'
        ) {
          continue
        }

        // Count assistant turns
        if (message.type === 'assistant') {
          if (turnCount === 0) {
            modelRefused = isModelRefusalMessage(message)
          }
          turnCount++

          // Check if we've hit the turn limit
          if (turnCount >= MAX_AGENT_TURNS) {
            hitMaxTurns = true
            logForDebugging(
              `Hooks: Agent turn ${turnCount} hit max turns, aborting`,
            )
            hookAbortController.abort()
            break
          }
        }

        // Check for structured output in attachments
        if (
          message.type === 'attachment' &&
          (message as any).attachment.type === 'structured_output'
        ) {
          const parsed = hookResponseSchema().safeParse((message as any).attachment.data)
          if (parsed.success) {
            structuredOutputResult = parsed.data
            logForDebugging(
              `Hooks: Got structured output: ${jsonStringify(structuredOutputResult)}`,
            )
            // Got structured output, abort and exit
            hookAbortController.abort()
            break
          }
        }
      }

      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      // Clean up the session hook we registered for this agent
      clearSessionHooks(toolUseContext.setAppState, hookAgentId)

      // Check if we got a result
      if (!structuredOutputResult) {
        // CC 2.1.300 (#28) — official retry block (@227967400, byte-verified):
        // `if(Xn&&tn!==Wt&&e.model!==Wt&&!h.aborted&&!kG())
        //    return t(\`Hooks: ${tn} was refused, running the agent hook on ${Wt}\`),
        //      {...await jZe({...e,model:Wt},n,r,s,h,y,S,w),hook:e}`
        // — an unavailable model falls back to the CALLER's model instead of
        // allowing the action; the retry precedes the max-turns branch and the
        // ORIGINAL hook object is preserved on the returned result. `kG`
        // (@219010844) is the CLAUDE_CODE_NO_MODEL_FALLBACK env tripwire.
        if (
          modelRefused &&
          model !== callerModel &&
          hook.model !== callerModel &&
          !signal.aborted &&
          !isEnvTruthy(process.env.CLAUDE_CODE_NO_MODEL_FALLBACK)
        ) {
          logForDebugging(
            `Hooks: ${model} was refused, running the agent hook on ${callerModel}`,
          )
          return {
            ...(await execAgentHook(
              { ...hook, model: callerModel },
              hookName,
              hookEvent,
              jsonInput,
              signal,
              toolUseContext,
              toolUseID,
              _messages,
              agentName,
            )),
            hook,
          }
        }

        // If we hit max turns, just log and return cancelled (no UI message)
        if (hitMaxTurns) {
          logForDebugging(
            `Hooks: Agent hook did not complete within ${MAX_AGENT_TURNS} turns`,
          )
          logEvent('tengu_agent_stop_hook_max_turns', {
            durationMs: Date.now() - hookStartTime,
            turnCount,
            hookEvent:
              hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            agentName:
              agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return {
            hook,
            outcome: 'cancelled',
          }
        }

        // For other cases (e.g., agent finished without calling structured output tool),
        // just log and return cancelled (don't show error to user)
        logForDebugging(`Hooks: Agent hook did not return structured output`)
        logEvent('tengu_agent_stop_hook_error', {
          durationMs: Date.now() - hookStartTime,
          turnCount,
          errorType: 1, // 1 = no structured output
          hookEvent:
            hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          agentName:
            agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          hook,
          outcome: 'cancelled',
        }
      }

      // Return result based on structured output
      if (!structuredOutputResult.ok) {
        logForDebugging(
          `Hooks: Agent hook condition was not met: ${structuredOutputResult.reason}`,
        )
        // CC 2.1.294 (OCC-150): official adds the blocking telemetry event
        // (byte-verified @24381500 region of the 294 ELF) — was missing in OCC.
        logEvent('tengu_agent_stop_hook_blocking', {
          durationMs: Date.now() - hookStartTime,
          turnCount,
          hookEvent:
            hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          agentName:
            agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: `Agent hook condition was not met: ${structuredOutputResult.reason}`,
            command: hook.prompt,
          },
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Agent hook condition was met`)
      logEvent('tengu_agent_stop_hook_success', {
        durationMs: Date.now() - hookStartTime,
        turnCount,
        hookEvent:
          hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        agentName:
          agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return {
        hook,
        outcome: 'success',
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      parentTimeoutSignal.removeEventListener('abort', onParentTimeout)
      cleanupCombinedSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Agent hook error: ${errorMsg}`)
    logEvent('tengu_agent_stop_hook_error', {
      durationMs: Date.now() - hookStartTime,
      errorType: 2, // 2 = general error
      hookEvent:
        hookEvent as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentName:
        agentName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing agent hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}
