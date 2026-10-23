// Centralized analytics/telemetry logging for tool permission decisions.
// All permission approve/reject events flow through logPermissionDecision(),
// which fans out to Statsig analytics, OTel telemetry, and code-edit metrics.
import { feature } from 'src/utils/featureFlags.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  extractMcpToolDetails,
  extractSkillName,
  isToolDetailsLoggingEnabled,
  sanitizeToolNameForAnalytics,
} from 'src/services/analytics/metadata.js'
import { getCodeEditToolDecisionCounter } from '../../bootstrap/state.js'
import type { Tool as ToolType, ToolUseContext } from '../../Tool.js'
import type { BashToolInput } from '../../tools/BashTool/BashTool.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { getLanguageName } from '../../utils/cliHighlight.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import type {
  PermissionDecisionReason,
  PermissionMode,
} from '../../types/permissions.js'
import {
  buildClassifierToolDecisionFields,
  permissionModeToExternal,
} from './classifierDecisionTelemetry.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from './PermissionContext.js'
import { logSafetyEvent } from './safetyEvent.js'

type PermissionLogContext = {
  tool: ToolType
  input: unknown
  toolUseContext: ToolUseContext
  messageId: string
  toolUseID: string
  /**
   * CC 2.1.301 (occ160 WP-C): the official Pfs ctx destructures
   * `permissionMode:H` (@227800703) — captured ONCE at permission-context
   * creation by the official wrapper (OVt @248276644:
   * `let _=le(n).mode; ... Pfs({...,permissionMode:_},...)`; pre-existing in
   * 300's Qds @226891992 for span attributes, new in 301 as the
   * `permission_mode` telemetry source). Optional here: OCC callers outside
   * this WP's file cluster (src/hooks/useCanUseTool.tsx) don't pass it yet,
   * so logPermissionDecision falls back to the effective app-state mode at
   * emit time (same value source as the official dispatch-fallback site's
   * `no=le(Gt).mode`).
   */
  permissionMode?: PermissionMode
}

// Discriminated union: 'accept' pairs with approval sources, 'reject' with rejection sources
type PermissionDecisionArgs =
  | {
      decision: 'accept'
      source: PermissionApprovalSource | 'config'
      /**
       * CC 2.1.301 (occ160 WP-C): official config-source accept records
       * gained `decisionReason` — the main allow path (@250192611:
       * `logDecision({decision:"accept",source:"config",decisionReason:
       * no.decisionReason,surface:...})`) and the recheck accept path
       * (@248296194). Consumed by u9e to derive classifier_verdict.
       */
      decisionReason?: PermissionDecisionReason
      /**
       * CC 2.1.301 (occ160 WP-C): NEW in 301 (300 binary: 0 hits; 301: 3) —
       * set ONLY on the permission-recheck accept path (@248296273:
       * `modeAtRecheck:le(s.toolUseContext).mode`). The emit expression
       * prefers it over the ctx-captured mode:
       * `Fl(n.decision==="accept"&&n.modeAtRecheck||H)` — the recheck fires
       * precisely because the mode may have changed mid-prompt, so the
       * captured mode can be stale.
       */
      modeAtRecheck?: PermissionMode
    }
  | {
      decision: 'reject'
      source: PermissionRejectionSource | 'config'
      /**
       * CC 2.1.301 (occ160 WP-C): official deny-config record gained
       * `decisionReason` (@250193828; the 300 counterpart @247867132 was
       * bare `{decision:"reject",source:"config"}`).
       */
      decisionReason?: PermissionDecisionReason
    }

const CODE_EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit']

function isCodeEditingTool(toolName: string): boolean {
  return CODE_EDITING_TOOLS.includes(toolName)
}

// Builds OTel counter attributes for code editing tools, enriching with
// language when the tool's target file path can be extracted from input
async function buildCodeEditToolAttributes(
  tool: ToolType,
  input: unknown,
  decision: 'accept' | 'reject' | 'abort',
  source: string,
): Promise<Record<string, string>> {
  // Derive language from file path if the tool exposes one (e.g., Edit, Write)
  let language: string | undefined
  if (tool.getPath && input) {
    const parseResult = tool.inputSchema.safeParse(input)
    if (parseResult.success) {
      const filePath = tool.getPath(parseResult.data)
      if (filePath) {
        language = await getLanguageName(filePath)
      }
    }
  }

  return {
    decision,
    source,
    tool_name: tool.name,
    ...(language && { language }),
  }
}

// Flattens structured source into a string label for analytics/OTel events
function sourceToString(
  source: PermissionApprovalSource | PermissionRejectionSource,
): string {
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    return 'classifier'
  }
  switch (source.type) {
    case 'hook':
      return 'hook'
    case 'user':
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'user_abort':
      return 'user_abort'
    case 'user_reject':
      return 'user_reject'
    default:
      return 'unknown'
  }
}

function baseMetadata(
  messageId: string,
  toolName: string,
  waitMs: number | undefined,
): { [key: string]: boolean | number | undefined } {
  return {
    messageID:
      messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolName: sanitizeToolNameForAnalytics(toolName),
    sandboxEnabled: SandboxManager.isSandboxingEnabled(),
    // Only include wait time when the user was actually prompted (not auto-approved)
    ...(waitMs !== undefined && { waiting_for_user_permission_ms: waitMs }),
  }
}

// Emits a distinct analytics event name per approval source for funnel analysis
function logApprovalEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionApprovalSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // Auto-approved by allowlist in settings -- no user wait time
    logEvent(
      'tengu_tool_use_granted_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    logEvent(
      'tengu_tool_use_granted_by_classifier',
      baseMetadata(messageId, tool.name, waitMs),
    )
    return
  }
  switch (source.type) {
    case 'user':
      logEvent(
        source.permanent
          ? 'tengu_tool_use_granted_in_prompt_permanent'
          : 'tengu_tool_use_granted_in_prompt_temporary',
        baseMetadata(messageId, tool.name, waitMs),
      )
      break
    case 'hook':
      logEvent('tengu_tool_use_granted_by_permission_hook', {
        ...baseMetadata(messageId, tool.name, waitMs),
        permanent: source.permanent ?? false,
      })
      break
    default:
      break
  }
}

// Rejections share a single event name, differentiated by metadata fields
function logRejectionEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionRejectionSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // Denied by denylist in settings
    logEvent(
      'tengu_tool_use_denied_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  logEvent('tengu_tool_use_rejected_in_prompt', {
    ...baseMetadata(messageId, tool.name, waitMs),
    // Distinguish hook rejections from user rejections via separate fields
    ...(source.type === 'hook'
      ? { isHook: true }
      : {
          hasFeedback:
            source.type === 'user_reject' ? source.hasFeedback : false,
        }),
  })
}

/**
 * CC 2.1.302 #14B — official `w0r` (v302 @237506975) ≡ `PDr` (v301
 * @220029703), byte-identical across both versions:
 *
 *   function w0r(e){let n=!e?"builtin":eu(e)?"sdk_host_builtin_mcp":"mcp";
 *     return{tool_source:c(n)}}
 *   eu(e){return e?.serverType==="sdk"&&Bu()}   // Bu(){return f()&&!n().childSession}
 *
 * `c` is the official telemetry string-attribute wrapper — identity in OCC
 * (logOTelEvent takes plain strings; see classifierDecisionTelemetry.ts).
 *
 * The middle `sdk_host_builtin_mcp` branch needs an SDK-hosted builtin MCP.
 * BOTH official discriminants reference surfaces OCC lacks: mcpInfo.serverType
 * (OCC's mcpInfo — Tool.ts:553 — is {serverName, toolName}, no serverType; the
 * McpAuthTool divergence notes confirm OCC never stamps it) and the SDK-host
 * runtime check `Bu()=!childSession` (backgroundDeadline.ts documents OCC has
 * no childSession/claudecode host-context flags). The branch is therefore
 * STRUCTURALLY PRESENT BUT DORMANT: every real OCC mcpInfo maps to 'mcp', and
 * it activates automatically should OCC ever gain serverType==='sdk'.
 */
function buildToolSourceAttribute(tool: ToolType): {
  tool_source: 'builtin' | 'sdk_host_builtin_mcp' | 'mcp'
} {
  const mcpInfo = tool.mcpInfo
  if (!mcpInfo) {
    return { tool_source: 'builtin' }
  }
  // Official eu(e): e?.serverType==="sdk"&&Bu(). OCC has no Bu() surface, so
  // the serverType field is the sole (dormant) discriminant — see above.
  const isSdkHostBuiltin =
    (mcpInfo as { serverType?: string }).serverType === 'sdk'
  return { tool_source: isSdkHostBuiltin ? 'sdk_host_builtin_mcp' : 'mcp' }
}

/**
 * CC 2.1.302 #14B — the tool_decision `tool_parameters` extractor, official
 * `F5n` equivalent (`Te=F5n(s.name,h,s.mcpInfo)`), gated by
 * OTEL_LOG_TOOL_DETAILS (parameters can carry sensitive command / MCP-server
 * content, so they're opt-in only).
 *
 * DRY (OCC-122 P3-1): this exported helper is the SINGLE implementation for
 * BOTH OTel parameter sites — the interactive tool_decision emit below, the
 * headless dispatch-fallback tool_decision emit in toolExecution.ts
 * (checkPermissionsAndCallTool; adopted in OCC-121 Gap-121a), and the
 * tool_result emit in toolExecution.ts (adopted in OCC-122, retiring the
 * byte-identical inline copy that previously lived there). All three share
 * the same sub-helpers (isToolDetailsLoggingEnabled, extractMcpToolDetails,
 * extractSkillName) through this one function, so the sites cannot drift.
 *
 * Returns {} when the gate is off or nothing is extractable; the emit site
 * includes the key only when non-empty (official
 * `...Object.keys(Te).length>0&&{tool_parameters:_(Te)}`). The returned
 * object is fresh per call and mutable — the tool_result site enriches it
 * post-call with git_commit_id / git_branch before emitting.
 */
function buildToolParametersForTelemetry(
  tool: ToolType,
  input: unknown,
): Record<string, unknown> {
  if (!isToolDetailsLoggingEnabled()) {
    return {}
  }
  const toolParameters: Record<string, unknown> = {}
  if (
    tool.name === BASH_TOOL_NAME &&
    typeof input === 'object' &&
    input !== null &&
    'command' in input
  ) {
    const bashInput = input as BashToolInput
    const commandParts = bashInput.command.trim().split(/\s+/)
    const bashCommand = commandParts[0] || ''
    toolParameters.bash_command = bashCommand
    toolParameters.full_command = bashInput.command
    if (bashInput.timeout !== undefined) {
      toolParameters.timeout = bashInput.timeout
    }
    if (bashInput.description !== undefined) {
      toolParameters.description = bashInput.description
    }
    if ('dangerouslyDisableSandbox' in bashInput) {
      toolParameters.dangerouslyDisableSandbox =
        bashInput.dangerouslyDisableSandbox
    }
  }
  const mcpDetails = extractMcpToolDetails(tool.name)
  if (mcpDetails) {
    toolParameters.mcp_server_name = mcpDetails.serverName
    toolParameters.mcp_tool_name = mcpDetails.mcpToolName
  }
  const skillName = extractSkillName(tool.name, input)
  if (skillName) {
    toolParameters.skill_name = skillName
  }
  return toolParameters
}

// Single entry point for all permission decision logging. Called by permission
// handlers after every approve/reject. Fans out to: analytics events, OTel
// telemetry, code-edit OTel counters, and toolUseContext decision storage.
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  permissionPromptStartTimeMs?: number,
): void {
  const { tool, input, toolUseContext, messageId, toolUseID } = ctx
  const { source } = args

  const waiting_for_user_permission_ms =
    permissionPromptStartTimeMs !== undefined
      ? Date.now() - permissionPromptStartTimeMs
      : undefined

  // CC 2.1.216 #29 — telemetry misreporting permission denials:
  // A user INTERRUPT (user_abort) is not a rejection. The abort analytics
  // event (tengu_tool_use_cancelled) is already emitted by the caller via
  // logCancelled(); we must NOT also fire the rejection analytics event or
  // telemeter the OTel tool_decision as 'reject'. Interrupts are reported as
  // user aborts instead.
  const isAbort =
    args.decision === 'reject' &&
    source !== 'config' &&
    source.type === 'user_abort'
  // OTel decision label: 'abort' for interrupts, otherwise the raw decision.
  const decision: 'accept' | 'reject' | 'abort' = isAbort
    ? 'abort'
    : args.decision

  // Log the analytics event
  if (args.decision === 'accept') {
    logApprovalEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  } else if (!isAbort) {
    // Genuine rejections only — aborts are covered by tengu_tool_use_cancelled.
    logRejectionEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  }

  const sourceString = source === 'config' ? 'config' : sourceToString(source)

  // Track code editing tool metrics
  if (isCodeEditingTool(tool.name)) {
    void buildCodeEditToolAttributes(tool, input, decision, sourceString).then(
      attributes => getCodeEditToolDecisionCounter()?.add(1, attributes),
    )
  }

  // Persist decision on the context so downstream code can inspect what happened
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })

  // CC 2.1.301 (occ160 WP-C): official Pfs (@227800703) gained exactly two
  // additions vs 300's Qds (@226891992):
  //   let be=V==="config"?u9e(K,n.decisionReason):void 0   → spread into emit
  //   permission_mode:Fl(n.decision==="accept"&&n.modeAtRecheck||H)
  // The classifier fields (classifier_verdict / classifier_category) let
  // auto-mode classifier decisions be told apart from permission-rule
  // decisions — both surface as source:"config". Gate on the RAW source
  // (`source === 'config'`), matching the official `V==="config"` check on
  // the pre-stringification value.
  const classifierFields =
    source === 'config'
      ? buildClassifierToolDecisionFields(decision, args.decisionReason)
      : undefined
  // Official: Fl(n.decision==="accept"&&n.modeAtRecheck||H). H is the
  // ctx-captured mode (OVt @248276644); OCC callers that don't pass it yet
  // fall back to the effective app-state mode (optional-chained so a minimal
  // ToolUseContext without getAppState can't crash the emit — undefined then
  // maps to "default", exactly the official Ft(e)??Kl.default fallback).
  const modeForTelemetry =
    (args.decision === 'accept' && args.modeAtRecheck) ||
    ctx.permissionMode ||
    toolUseContext.getAppState?.().toolPermissionContext?.mode

  // CC 2.1.302 changelog #14 part B — the emitted attribute object is REORDERED
  // so the core identifiers come FIRST and the truncatable tail (classifier
  // verdict/category + permission_mode) comes LAST. A low
  // OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT then evicts the tail instead of the
  // identifiers. Key order in this object literal IS the OTel log-record wire
  // order — that IS the fix.
  //   v301 (@227800703): {decision,source,...be,permission_mode,tool_name,
  //     tool_use_id,...PDr(mcpInfo),...(params&&{tool_parameters})}
  //   v302 (@245156620): {decision,source,tool_name,tool_use_id,...w0r(mcpInfo),
  //     ...(params&&{tool_parameters}),...be,permission_mode}
  // OCC also never emitted tool_use_id / tool_source / tool_parameters (a
  // pre-existing gap vs BOTH official versions) — this closes it: tool_use_id
  // from the in-scope ctx, tool_source via w0r, tool_parameters via the
  // details-gated F5n extractor (included only when non-empty).
  // Part A (server-side classifier_category fLs bracket-prefix fallback) is
  // N-A: OCC has no server-side/arbiter classifier (client-side yoloClassifier
  // already emits a structured category) — nothing to port.
  const toolParameters = buildToolParametersForTelemetry(tool, input)
  void logOTelEvent('tool_decision', {
    decision,
    source: sourceString,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
    tool_use_id: toolUseID,
    ...buildToolSourceAttribute(tool),
    ...(Object.keys(toolParameters).length > 0 && {
      tool_parameters: jsonStringify(toolParameters),
    }),
    ...classifierFields,
    permission_mode: permissionModeToExternal(modeForTelemetry),
  })

  // CC 2.1.307 A2 — the official Pfs dispatch fans each recorded permission
  // decision out to BOTH the tool_decision emit above AND the new
  // claude_code.safety_event emitter (LMn @36240106). safety_event carries the
  // RAW decision ('reject', never the abort-mapped 'abort' label) and the raw
  // source object (buildSafetyRecord derives the EYr decision_source itself).
  logSafetyEvent(
    {
      decision: args.decision,
      source: args.source,
      sourceString,
      decisionReason: args.decisionReason,
      permissionMode: modeForTelemetry,
    },
    { tool, toolUseID, toolUseContext },
  )
}

export {
  isCodeEditingTool,
  buildCodeEditToolAttributes,
  buildToolSourceAttribute,
  buildToolParametersForTelemetry,
  logPermissionDecision,
}
export type { PermissionLogContext, PermissionDecisionArgs }
