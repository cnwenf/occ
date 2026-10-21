import { feature } from 'src/utils/featureFlags.js'
import { z } from 'zod/v4'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type {
  Message as MessageType,
  ContentItem,
  SystemModelFallbackMessage,
} from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  getMcpPrefix,
  mcpInfoFromString,
} from '../../services/mcp/mcpStringUtils.js'
import { mcpAllowRuleReachesTool } from '../../utils/permissions/mcpRuleMatching.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import {
  normalizeModelSpecifier,
  normalizeModelStringForAPI,
  renderModelName,
} from '../../utils/model/model.js'
import { sanitizeSubagentOutput, sanitizeLastAssistantOutput, sanitizeLastAssistantOutputWithFindings, reportFlaggedSubagentOutput } from './subagentOutputSanitizer.js'
import { frameHandbackIfEnabled } from './subagentHandback.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
export type ResolvedAgentTools = {
  hasWildcard: boolean
  validTools: string[]
  invalidTools: string[]
  resolvedTools: Tools
  allowedAgentTypes?: string[]
}

export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * Resolves and validates agent tools against available tools
 * Handles wildcard expansion and validation in one place
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools,
    }
  }

  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []
  const invalidTools: string[] = []
  const resolved: Tool[] = []
  const resolvedToolsSet = new Set<Tool>()
  let allowedAgentTypes: string[] | undefined

  for (const toolSpec of agentTools) {
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    // CC 2.1.299 #158/#159 (official agent-tools branch @231360600): a
    // server-wide MCP entry (`mcp__<server>` or `mcp__<server>__*`) takes ONLY
    // the named server's tools — every candidate must pass the whole-name
    // allow matcher (official lXe). A server whose normalized name contains
    // `__` must be listed as `mcp__<whole name>__*` (second branch below).
    const mcpEntry = mcpInfoFromString(toolName)
    if (
      mcpEntry !== null &&
      mcpEntry.serverName !== '*' &&
      (mcpEntry.toolName === undefined || mcpEntry.toolName === '*')
    ) {
      validTools.push(toolSpec)
      let matchedAnyTool = false
      for (const candidate of allowedAvailableTools) {
        if (!mcpAllowRuleReachesTool(toolName, candidate)) {
          continue
        }
        matchedAnyTool = true
        if (!resolvedToolsSet.has(candidate)) {
          resolved.push(candidate)
          resolvedToolsSet.add(candidate)
        }
      }
      if (!matchedAnyTool) {
        // Byte-exact official warn (@231360600).
        logForDebugging(
          `Agent tools entry "${toolSpec}" takes no tool: no connected MCP server of that name has one.`,
          { level: 'warn' },
        )
      }
      continue
    }
    // Official second branch: `__*` entries are matched against the tool's
    // WHOLE server name via getMcpPrefix (official zs(server,"")===`${pt}__`).
    const wholeNamePrefix = toolName.endsWith('__*')
      ? toolName.slice(0, -3)
      : toolName
    if (wholeNamePrefix !== toolName && mcpEntry !== null) {
      const wholeNameTools = allowedAvailableTools.filter(
        candidate =>
          candidate.mcpInfo !== undefined &&
          getMcpPrefix(candidate.mcpInfo.serverName) ===
            `${wholeNamePrefix}__` &&
          mcpAllowRuleReachesTool(`${wholeNamePrefix}__*`, candidate),
      )
      if (wholeNameTools.length > 0) {
        validTools.push(toolSpec)
        for (const candidate of wholeNameTools) {
          if (!resolvedToolsSet.has(candidate)) {
            resolved.push(candidate)
            resolvedToolsSet.add(candidate)
          }
        }
        continue
      }
    }

    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes,
  }
}

// Hoisted function declaration (not const) to avoid circular-dep TDZ:
// AgentTool.tsx ↔ agentToolUtils.ts have a circular import. A `const` is in
// TDZ when accessed during module-eval (buildTool calls outputSchema() at
// construction → factory runs → accesses agentToolResultSchema → TDZ if
// agentToolUtils hasn't finished loading). Function declarations are hoisted,
// so agentToolResultSchema is available before its definition is reached.
var _agentToolResultSchemaCache: z.ZodObject<any, any> | undefined
export function agentToolResultSchema() {
  return (_agentToolResultSchemaCache ??= z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    // Official 2.1.293 #9: whether SendMessage is in the session tool table,
    // captured at launch/completion so the result trailer only offers
    // SendMessage continuation when it's actually available. Optional —
    // absent (legacy/resume) reads back as default-true.
    canContinueAgent: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }))
}

export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      const content = m.message?.content as ContentItem[] | undefined
      for (const block of content ?? []) {
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  return count
}

/**
 * CC 2.1.306 (#P7): official `k4` (v306@241937594) — normalized model
 * equality: `Wm(Dt(e))===Wm(Dt(n))`, where `Dt` resolves aliases and
 * lowercases (v306@240941147) and `Wm` canonicalizes + strips the `[1m]`
 * suffix (`C1t` re-appends `` `${s}[1m]` `` to its output, v306@240936550).
 * OCC equivalents: normalizeModelSpecifier (alias resolution) then
 * normalizeModelStringForAPI (suffix strip), lowercased like `Dt`.
 */
function modelsEqualForFallbackScan(a: string, b: string): boolean {
  const normalize = (model: string): string =>
    normalizeModelStringForAPI(normalizeModelSpecifier(model)).toLowerCase()
  return normalize(a) === normalize(b)
}

/**
 * CC 2.1.306 (#P7): official `iu` (v306@255040600, verbatim semantics) —
 * reverse-scan the agent's messages tracking the FINAL assistant model
 * (skipping `isVirtual` / `isApiErrorMessage` placeholders). Bail out
 * (undefined) when an assistant model is non-string or diverges from the
 * final model (the tail is not uniformly one model). Return the
 * `model_fallback` system message whose `fallbackModel` equals the final
 * model AND differs from its `originalModel` — i.e. the switch that produced
 * the model the agent actually finished on.
 */
export function findAgentModelFallbackMessage(
  messages: MessageType[],
): SystemModelFallbackMessage | undefined {
  let finalModel: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      (message.isVirtual === true || message.isApiErrorMessage === true)
    ) {
      continue
    }
    if (message.type === 'assistant') {
      const model = message.message?.model
      if (typeof model !== 'string') {
        return undefined
      }
      finalModel ??= model
      if (!modelsEqualForFallbackScan(model, finalModel)) {
        return undefined
      }
    } else if (
      finalModel !== undefined &&
      message.type === 'system' &&
      message.subtype === 'model_fallback'
    ) {
      const fallback = message as unknown as SystemModelFallbackMessage
      if (
        typeof fallback.fallbackModel !== 'string' ||
        typeof fallback.originalModel !== 'string'
      ) {
        continue
      }
      if (
        modelsEqualForFallbackScan(finalModel, fallback.fallbackModel) &&
        !modelsEqualForFallbackScan(fallback.fallbackModel, fallback.originalModel)
      ) {
        return fallback
      }
    }
  }
  return undefined
}

/**
 * CC 2.1.306 (#P7): the verbatim harness-notice text from the official
 * finalize (`smr`, v306@255043853):
 * `` `⚠ This agent switched to ${qo(Ce.fallbackModel)} because its earlier
 * model could not be used.\n` `` (`qo` = renderModelName). Pushed into the
 * harness-notes list BEFORE the report content.
 */
export function formatAgentModelFallbackNotice(fallbackModel: string): string {
  return `⚠ This agent switched to ${renderModelName(fallbackModel)} because its earlier model could not be used.\n`
}

export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content.
  let content = (lastAssistantMessage.message?.content as ContentItem[] ?? []).filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = (m.message?.content as ContentItem[] ?? []).filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  // CC 2.1.306 (#P7): official finalize (`smr`, v306@255043600) — when the
  // agent produced real output (`ae.length>0`) and ended on a fallback model
  // (`iu` match), prepend the harness notice so the parent doesn't attribute
  // the work to the unusable original model. Official pushes it into the
  // harness-notes list `te`, which precedes the report content
  // (`At=[...te,...xe,...ke]`). The official prior-notice branch (`X` from
  // `Nit`, a `model_refusal_fallback` message) has no OCC surface — refusal
  // fallback is not ported — so only the `iu` else-branch applies.
  if (content.length > 0) {
    const modelFallback = findAgentModelFallbackMessage(agentMessages)
    if (modelFallback !== undefined) {
      content = [
        { type: 'text', text: formatAgentModelFallbackNotice(modelFallback.fallbackModel) },
        ...content,
      ]
    }
  }

  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message?.usage as Parameters<typeof getTokenCountFromUsage>[0])
  const totalToolUseCount = countToolUses(agentMessages)

  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message?.usage as AgentToolResult['usage'],
  }
}

/**
 * Returns the name of the last tool_use block in an assistant message,
 * or undefined if the message is not an assistant message with tool_use.
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  const block = (message.message?.content as ContentItem[] ?? []).findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (toolPermissionContext.mode !== 'auto') return null

    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (classifierResult.shouldBlock) {
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      // 2.1.210: sanitize the classifier reason before inlining it into the
      // SECURITY WARNING — the reason may quote subagent-read content carrying
      // injection-shaped patterns. ser() neutralizes forged control tags and
      // prepends no marker (the SECURITY WARNING prefix already frames it).
      const sanitizedReason = sanitizeSubagentOutput(classifierResult.reason, { prependMarker: false }).sanitized
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${sanitizedReason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null
}

/**
 * Extract a partial result string from an agent's accumulated messages.
 * Used when an async agent is killed to preserve what it accomplished.
 * Returns undefined if no text content is found.
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message?.content as ContentItem[] ?? [], '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * Drives a background agent from spawn to terminal notification.
 * Shared between AgentTool's async-from-start path and resumeAgentBackground.
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined
  const agentMessages: MessageType[] = []
  try {
    const tracker = createProgressTracker()
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop
        }
      : undefined
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    stopSummarization?.()

    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    completeAsyncAgent(agentResult, rootSetAppState)

    // 2.1.210: harden the boundary against indirect prompt injection via
    // content a subagent read. The subagent's final assistant-message text is
    // the surface a parent agent / user reads on completion - sanitize it
    // (binary: aer / ser) which neutralizes forged control tags and prepends a
    // [harness: ...] marker when escalation-shaped patterns matched, so
    // injection carried in content the subagent read cannot commandeer the
    // parent. Falls back to the raw content text when no assistant text exists.
    //
    // Analyze the raw text ONCE (not the already-sanitized text - re-analysis
    // would match the marker we prepend, creating a feedback loop). The findings
    // feed telemetry (binary: wNu / tengu_subagent_output_flagged).
    const sanitizedFinal = sanitizeLastAssistantOutputWithFindings(agentMessages)
    let finalMessage = sanitizedFinal?.sanitized ?? extractTextContent(agentResult.content, '\n')
    if (sanitizedFinal && sanitizedFinal.findings.some(f => f.reportable)) {
      reportFlaggedSubagentOutput(sanitizedFinal.findings, {
        agentId: taskId,
        surface: 'async_final_message',
      })
    }

    // 2.1.277 (B12): wrap the sanitized report in the harness-attribution
    // provenance frame BEFORE the handoff warning is prepended, so the
    // classifier note stays above the frame (official `aBt` places notes
    // above; header: "Notes above this frame may quote model-derived text").
    // Additive to the sanitizer — frame(gate: fie/lfn, default-on).
    finalMessage = frameHandbackIfEnabled(finalMessage)

    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    const worktreeResult = await getWorktreeResult()

    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      // 2.1.299 #149: reason gates — live owned background work (pt/WZr) +
      // SendMessage continuation availability (V).
      getAppState: () => toolUseContext.getAppState(),
      callerCanContinueAgents: toolUseContext.options.tools.some(t =>
        toolMatchesName(t, SEND_MESSAGE_TOOL_NAME),
      ),
      ...worktreeResult,
    })
  } catch (error) {
    stopSummarization?.()
    if (error instanceof AbortError) {
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const worktreeResult = await getWorktreeResult()
      // 2.1.210: sanitize the partial result (binary: finalMessage: aer(g))
      // so injection carried in content a killed subagent read cannot
      // commandeer the parent via the kill notification.
      const partialResult = sanitizeLastAssistantOutput(agentMessages) ?? extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult,
        ...worktreeResult,
      })
      return
    }
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    clearInvokedSkillsForAgent(agentIdForCleanup)
    clearDumpState(agentIdForCleanup)
  }
}
