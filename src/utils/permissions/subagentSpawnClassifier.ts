import { feature } from 'src/utils/featureFlags.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import { logEvent } from '../../services/analytics/index.js'
import type { ToolPermissionContext, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { YoloClassifierResult } from '../../types/permissions.js'
import { isInProtectedNamespace } from '../envUtils.js'
import { classifyYoloAction, formatActionForClassifier } from './yoloClassifier.js'

/**
 * G11 (2.1.178): the auto-mode classifier evaluates a subagent spawn BEFORE
 * launch, not only at handback. Mirrors the official 2.1.200 binary, where
 * AgentTool.checkPermissions returns `{behavior:"passthrough"}` in auto mode
 * (message: "Agent tool requires permission to spawn subagents.") so the
 * spawn — the subagent_type + prompt — is run through classifyYoloAction
 * before the child agent is ever started.
 *
 * This is the pre-spawn analogue of classifyHandoffIfNeeded (which runs after
 * the subagent finishes). The classified action is the Agent/Task tool_use
 * built from the spawn args; the parent transcript supplies context. The
 * caller (AgentTool spawn path) blocks the launch when `shouldBlock` is true
 * and surfaces `reason`.
 *
 * Returns null when the transcript classifier is off (non-ant builds) or the
 * session isn't in auto mode — same gates as the handoff path.
 */
export async function classifySubagentSpawnBeforeLaunch({
  parentMessages,
  subagentType,
  subagentPrompt,
  subagentMode,
  tools,
  toolPermissionContext,
  abortSignal,
}: {
  parentMessages: Message[]
  subagentType: string
  subagentPrompt: string
  subagentMode?: string
  tools: Tools
  toolPermissionContext: ToolPermissionContext
  abortSignal: AbortSignal
}): Promise<YoloClassifierResult | null> {
  // Same gate as classifyHandoffIfNeeded — the transcript classifier is
  // ant-only; external builds short-circuit before spending a classifier call.
  if (!feature('TRANSCRIPT_CLASSIFIER')) return null
  if (toolPermissionContext.mode !== 'auto') return null

  // The classified action is the spawn itself: an Agent/Task tool_use whose
  // toAutoClassifierInput projection is "(subagent_type, mode): prompt".
  // 'Task' is the legacy name the lookup resolves to the Agent tool via alias.
  const action = formatActionForClassifier('Task', {
    subagent_type: subagentType,
    mode: subagentMode,
    prompt: subagentPrompt,
  })

  const result = await classifyYoloAction(
    parentMessages,
    action,
    tools,
    toolPermissionContext,
    abortSignal,
  )

  const decision = result.unavailable
    ? 'unavailable'
    : result.shouldBlock
      ? 'blocked'
      : 'allowed'
  logEvent('tengu_auto_mode_decision', {
    decision:
      decision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // Legacy name for analytics continuity across the Task→Agent rename.
    toolName: 'Task' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inProtectedNamespace: isInProtectedNamespace(),
    classifierModel:
      result.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    agentType:
      subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    isHandoff: false,
    isPreSpawn: true,
    classifierStage:
      result.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    classifierStage1RequestId:
      result.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    classifierStage1MsgId:
      result.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    classifierStage2RequestId:
      result.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    classifierStage2MsgId:
      result.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return result
}
