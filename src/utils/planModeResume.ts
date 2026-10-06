/**
 * CC 2.1.290 — plan-mode restoration on interactive session resume.
 *
 * Byte-faithful port of the official plan-resume chunk (`chunk-ye07rzst.js`
 * in the 2.1.290/2.1.291 linux-x64 ELF, module @229169372..229174700),
 * which exports `hws` re-exported as `planModeOnInteractiveResume`
 * (@235818971). Changelog entry (docs/gap-research-291/
 * changelog-entries-290.txt:99): "Fixed plan mode not being restored when
 * resuming a session with `--continue` or `--resume <session-id>` in the
 * terminal."
 *
 * Official symbol → OCC mapping (each verified against the binary):
 *   c()  = `xr("tengu_tranquil_fern",!0)`      → isPlanRestoreGuardEnabled()
 *          (OCC's GrowthBook is a stub that returns the supplied default —
 *          the official gate default is `true`, so this resolves to true.)
 *   P()  = fresh telemetry/decision state     → createResumeState()
 *   R(e) = recorded-mode normalizer           → normalizeRecordedMode()
 *          (`Lm(e){let n=Gg(e);return Js.find(s=>s===n)}`, Gg = the
 *          "manual"→"default" alias = OCC normalizePermissionModeInput.)
 *   E(e) = eligibility                        → isResumeRestoreEligible()
 *          (`c()&&e.mode!=="plan"&&U2.isEnabled()&&!_s(e,U2)`; U2 = the
 *          ExitPlanMode tool object; `_s` = first alwaysDenyRules entry
 *          matching the tool = OCC getDenyRuleForTool. The official `_s`
 *          additionally exempts end-conversation tools via `Gve` —
 *          ExitPlanMode is not one, so the exemption is immaterial here.)
 *   x(e) = `{...EI(e.mode,"plan",e),mode:"plan"}` → applyPlanMode()
 *          (EI = transitionPermissionMode; caller sets mode on the result —
 *          same contract as OCC transitionPermissionMode.)
 *   M(e) = transcript scan                    → scanTranscriptPlanState()
 *   T(e) = duplicate tool_use ids             → duplicateToolUseIds()
 *   h(e,n) = awaiting-leader-approval check   → isAwaitingLeaderApproval()
 *   J$   = is-tool-result-user-message        → isToolResultUserMessage()
 *   cg   = user message text extractor        → getUserMessageText()
 *   vy   = human-like origin check            → isHumanLikeOrigin()
 *          (`e===void 0||e.kind==="human"||e.kind==="auto-continuation"`
 *          @204695637. OCC user rows carry no `origin` field, so this
 *          evaluates via the undefined branch — same as official rows
 *          without origin.)
 *   Zu   = "command-name" tag                 → COMMAND_NAME_TAG
 *   Tu   = "ExitPlanMode"                     → EXIT_PLAN_MODE_TOOL_NAME
 *   xT   = "EnterPlanMode"                    → ENTER_PLAN_MODE_TOOL_NAME
 *   S()  = tengu_worker_permission_mode_restore telemetry (interactive
 *          lane: hadExternal/hadInternal always false).
 *   t()  = debug log                          → logForDebugging()
 *
 * Not ported (other official lanes, absent from OCC and not part of the 290
 * interactive fix): `O()` internal worker_permission_mode lane, `VTr()`
 * settleWorkerPermissionModeRecord, `b()` transcript-only lane, `KTr` print
 * lane, `$1n` resume lane, `N1n` sdk-url predicate. See
 * docs/gap-research-291/cluster-f-session-durability.md §E.
 */
import { COMMAND_NAME_TAG } from '../constants/xml.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { ExitPlanModeV2Tool } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { Message } from '../types/message.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
  type ToolPermissionContext,
} from '../types/permissions.js'
import { logForDebugging } from './debug.js'
import { getUserMessageText } from './messages.js'
import { normalizePermissionModeInput } from './permissions/PermissionMode.js'
import { transitionPermissionMode } from './permissions/permissionSetup.js'
import { getDenyRuleForTool } from './permissions/permissions.js'

// ---------------------------------------------------------------------------
// Official c()/R()/x()/E() — guard, normalizer, transition, eligibility
// ---------------------------------------------------------------------------

/** Official `c(){return xr(k,!0)}` with k="tengu_tranquil_fern". */
function isPlanRestoreGuardEnabled(): boolean {
  // OCC's GrowthBook is a stub returning the supplied default (true).
  return true
}

type RecordedMode = 'absent' | 'invalid' | PermissionMode

/**
 * Official `R(e)`: undefined/null → "absent"; a string that normalizes into
 * the valid-mode list → that mode; anything else → "invalid".
 */
function normalizeRecordedMode(value: unknown): RecordedMode {
  if (value === undefined || value === null) return 'absent'
  if (typeof value === 'string') {
    const normalized = normalizePermissionModeInput(value)
    const found = (PERMISSION_MODES as readonly string[]).find(
      mode => mode === normalized,
    )
    return found !== undefined ? (found as PermissionMode) : 'invalid'
  }
  return 'invalid'
}

/** Official `x(e){return{...EI(e.mode,"plan",e),mode:"plan"}}`. */
function applyPlanMode(
  context: ToolPermissionContext,
): ToolPermissionContext {
  return {
    ...transitionPermissionMode(context.mode, 'plan', context),
    mode: 'plan',
  }
}

/**
 * Official `E(e){return c()&&e.mode!=="plan"&&U2.isEnabled()&&!_s(e,U2)}`.
 */
function isResumeRestoreEligible(context: ToolPermissionContext): boolean {
  return (
    isPlanRestoreGuardEnabled() &&
    context.mode !== 'plan' &&
    ExitPlanModeV2Tool.isEnabled() &&
    !getDenyRuleForTool(context, ExitPlanModeV2Tool)
  )
}

// ---------------------------------------------------------------------------
// Official M()/T()/h() — transcript scan
// ---------------------------------------------------------------------------

/** Official `T(e)` — ids of tool_use blocks that appear more than once. */
function duplicateToolUseIds(messages: Message[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if ((block as { type?: string }).type !== 'tool_use') continue
      const id = (block as { id: string }).id
      if (seen.has(id)) duplicates.add(id)
      else seen.add(id)
    }
  }
  return duplicates
}

/** Official `J$(l)` — user message whose content carries tool_result blocks. */
function isToolResultUserMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message?.content
  if (typeof content === 'string' || !Array.isArray(content)) return false
  return content.some(
    block => (block as { type?: string }).type === 'tool_result',
  )
}

/**
 * Official `h(e,n)` — the ExitPlanMode result is treated as errored (plan
 * stays open) while awaiting team-lead approval.
 */
function isAwaitingLeaderApproval(
  message: Message,
  resultContent: unknown,
): boolean {
  const toolUseResult = message.toolUseResult
  if (
    toolUseResult !== null &&
    typeof toolUseResult === 'object' &&
    (toolUseResult as { awaitingLeaderApproval?: unknown })
      .awaitingLeaderApproval === true
  ) {
    return true
  }
  return (
    typeof resultContent === 'string' &&
    resultContent.startsWith('Your plan has been submitted to the team lead')
  )
}

/** Official `vy(e)` @204695637. */
function isHumanLikeOrigin(origin: unknown): boolean {
  if (origin === undefined) return true
  if (typeof origin !== 'object' || origin === null) return false
  const kind = (origin as { kind?: unknown }).kind
  return kind === 'human' || kind === 'auto-continuation'
}

type TranscriptPlanState = 'open' | 'exited' | 'none'

/**
 * Official `M(e)` — backward scan of the transcript for the most recent
 * plan-mode boundary. Verbatim control flow from the cc290 binary.
 */
function scanTranscriptPlanState(messages: Message[]): TranscriptPlanState {
  const marker = `<${COMMAND_NAME_TAG}>/plan</${COMMAND_NAME_TAG}>`
  const errored = new Set<string>()
  const approved = new Set<string>()
  const duplicateIds = duplicateToolUseIds(messages)
  let sawLaterNonPlanRow = false
  const open = (): TranscriptPlanState =>
    sawLaterNonPlanRow ? 'none' : 'open'

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type === 'attachment') {
      const attachmentType = message.attachment?.type
      if (attachmentType === 'plan_mode' || attachmentType === 'plan_mode_reentry') {
        return open()
      }
      if (attachmentType === 'plan_mode_exit') return 'exited'
    } else if (
      message.type === 'assistant' &&
      Array.isArray(message.message?.content)
    ) {
      const blocks = message.message!.content as Array<Record<string, unknown>>
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]!
        if (block.type !== 'tool_use') continue
        const id = block.id as string
        const name = block.name as string
        if (
          name === EXIT_PLAN_MODE_TOOL_NAME &&
          approved.has(id) &&
          !errored.has(id) &&
          !duplicateIds.has(id)
        ) {
          return 'exited'
        }
        if (
          name === ENTER_PLAN_MODE_TOOL_NAME &&
          approved.has(id) &&
          (!errored.has(id) || duplicateIds.has(id))
        ) {
          return open()
        }
      }
    } else if (message.type === 'user' && isToolResultUserMessage(message)) {
      const content = message.message?.content
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== 'tool_result') continue
          const target =
            block.is_error || isAwaitingLeaderApproval(message, block.content)
              ? errored
              : approved
          target.add(block.tool_use_id as string)
        }
      }
    } else if (message.type === 'user') {
      if (getUserMessageText(message)?.trimStart().startsWith(marker)) {
        return open()
      }
      const permissionMode = message.permissionMode as string | undefined
      if (permissionMode === 'plan') return open()
      if (
        permissionMode !== undefined &&
        !message.isMeta &&
        isHumanLikeOrigin(message.origin)
      ) {
        sawLaterNonPlanRow = true
      }
    }
  }
  return 'none'
}

// ---------------------------------------------------------------------------
// Official P()/S()/hws() — state, telemetry, entry point
// ---------------------------------------------------------------------------

type ResumeSource = 'none' | 'stored' | 'transcript'

interface PlanModeResumeState {
  source: ResumeSource
  trustedMode: PermissionMode | undefined
  recordedMode: RecordedMode
  recordTranscriptState?: TranscriptPlanState
  transcriptOpen?: boolean
}

/** Official `P()`. */
function createResumeState(): PlanModeResumeState {
  return { source: 'none', trustedMode: undefined, recordedMode: 'absent' }
}

/** Official `S(e,{lane,hadExternal,hadInternal})` → tengu_worker_permission_mode_restore. */
function logResumeTelemetry(
  state: PlanModeResumeState,
  lane: string,
  hadExternal: boolean,
  hadInternal: boolean,
): void {
  const targetMode = state.source === 'none' ? state.trustedMode : 'plan'
  logEvent('tengu_worker_permission_mode_restore', {
    source: state.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    lane: lane as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    trusted_mode: state.trustedMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    recorded_mode: state.recordedMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    target_mode: targetMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    had_external: hadExternal,
    had_internal: hadInternal,
    guard_enabled: isPlanRestoreGuardEnabled(),
    ...(state.recordTranscriptState && {
      record_transcript_state: state
        .recordTranscriptState as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(state.transcriptOpen && { transcript_open: true }),
  })
}

/**
 * Official `hws(e,{storedPermissionMode:n,messages:r,forkSession:a,
 * startupModePinned:s})` — the 2.1.290 interactive-resume plan-mode restore.
 *
 * Returns a new permission context with mode "plan" when the resume should
 * re-enter plan mode, or undefined when nothing changes (the caller keeps
 * its existing context — official call site: `b = ae(b ?? …, {…}) ?? b`).
 */
export function planModeOnInteractiveResume(
  context: ToolPermissionContext,
  {
    storedPermissionMode,
    messages,
    forkSession,
    startupModePinned,
  }: {
    storedPermissionMode: unknown
    messages: Message[]
    forkSession: boolean
    startupModePinned: boolean
  },
): ToolPermissionContext | undefined {
  const state = createResumeState()
  state.trustedMode = context.mode
  state.recordedMode = normalizeRecordedMode(storedPermissionMode)
  if (!startupModePinned && !forkSession && isResumeRestoreEligible(context)) {
    if (state.recordedMode === 'plan') {
      state.recordTranscriptState = scanTranscriptPlanState(messages)
      if (state.recordTranscriptState !== 'exited') state.source = 'stored'
    } else if (
      (state.recordedMode === 'absent' || state.recordedMode === 'invalid') &&
      scanTranscriptPlanState(messages) === 'open'
    ) {
      state.transcriptOpen = true
      state.source = 'transcript'
    }
  }
  logResumeTelemetry(state, 'interactive', false, false)
  if (state.source === 'none') return undefined
  logForDebugging(
    `[planModeResume] re-entering plan mode on resume (source: ${state.source}, was ${context.mode})`,
  )
  return applyPlanMode(context)
}
