/**
 * Official Claude Code 2.1.299 (#149): background-agent notification REASON
 * set. The task-notification body gained a <note> section explaining WHY the
 * agent stopped and what happens next:
 *
 *   1. waiting on its own background work (official `pt` gate, `WZr`) —
 *      summary reason "is waiting on its own background work" + interim note.
 *   2. message arrived too late for the result (official `nn`) — the agent is
 *      being resumed with the late messages and will notify again.
 *   3. stopped by a usage limit (official `Wn`/`qn`/`u8t`/`Vyo`) — work is
 *      saved, the limit reset time, and how to continue the same agent.
 *
 * Byte-exact strings verified from the v299 ELF (offsets into
 * /tmp/cc-diff-299/v299/package/claude):
 *   - builder region @227857400 (`pt=s==="completed"&&WZr(Be)`, summary
 *     ternary, `Yt` note variants, `nn` late-message gate + sentence,
 *     `Nn=S?.limits`, `qn` reset gate, `Wn` usage-limit block, body assembly
 *     `\n<${v$}>${Yt}${nn}${Wn}</${v$}>${Bt}${zt}${Kt}`).
 *   - `v$="note"`, `Wln='Agent "'`, `RHo="finished"` @214912783.
 *   - `Vyo` @219469900 region: ` Once its requests are accepted again, send
 *     the agent a message (${Dn}) …` with `Dn="SendMessage"` @216443604.
 *   - `u8t`/`c8t` @222657300 region: `resets at ${l}` / `resets ${l}`.
 *   - `WZr` @227854582: backgrounded completed agent with a live
 *     monitor:/workflow:/bash: keepalive child.
 *   - `fNe` @221665588: resumable = not user-stopped and running|completed.
 * v296 has ZERO hits for "too late for the result below", "work so far is
 * saved", and "Once its requests are accepted again" — those reasons are new
 * in v299 (the pt/Yt pair predates them but was absent from OCC).
 *
 * OCC adaptations (documented deviations, not paraphrases of the strings —
 * the strings themselves are byte-exact):
 *   - `WZr` scans OCC's appState.tasks for live (status==='running') tasks
 *     owned by this agent: local_bash (agentId — covers both bash and monitor
 *     kinds) and local_workflow (ownerAgentId). The official keepalive-reason
 *     registry (YA/`monitor:`/`workflow:`/`bash:` prefixes) does not exist in
 *     OCC. The official bash branch is gated on `BG()`; OCC has no such gate,
 *     so owned live bash children always count (conservative: the note says
 *     work "may resume … when that work completes or reports", which is true
 *     in OCC — shell completion notifications route to the owner agent).
 *   - `nn` gate: official `fNe(Be)&&((Be.pendingMessages?.length??0)>0 ||
 *     Q>0&&(Be.status==="running"||Be.resuming))`. OCC has no unreadMessages
 *     (Q) counter and no `resuming` flag, so the gate reduces to
 *     pendingMessages.length > 0 on a completed notification (fNe's
 *     status==='completed' arm; `stoppedByUser` does not exist in OCC).
 *   - `u8t` uses OCC's existing `formatResetTime` (src/utils/format.ts, the
 *     pre-existing adaptation of the official shared time formatter `BT`);
 *     `resetsAt` is epoch SECONDS, matching OCC's RateLimitInfo.
 *   - The official `maxTurnsReached` (`G`) summary branch and its `mEr`
 *     suffix are not ported — OCC has no per-agent max-turns stop path.
 */
import { NOTE_TAG } from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import { formatResetTime } from '../../utils/format.js'
import { isLocalShellTask } from '../LocalShellTask/guards.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'

// Official summary reasons (v299 @227858109 / @214912897).
export const WAITING_ON_BACKGROUND_WORK_SUMMARY =
  'is waiting on its own background work'
export const FINISHED_SUMMARY = 'finished'

// Official `Yt` variants (v299 @227859000 region), byte-exact.
export const BACKGROUND_WORK_INTERIM_NOTE =
  'This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.'
export const DEFAULT_STOP_NOTE =
  'A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.'

// Official `nn` (v299 @227859415 region), byte-exact (leading space included).
export const LATE_MESSAGE_NOTE =
  " One or more messages sent to this agent arrived after this run's last step, too late for the result below. The agent is being resumed with them and will notify again. Wait for that notification before resending."

// Official `Vyo` (v299 @219469900 region) with `Dn` = "SendMessage".
export const USAGE_LIMIT_CONTINUE_SENTENCE =
  ' Once its requests are accepted again, send the agent a message (SendMessage) to let it continue from where it stopped instead of starting a new agent.'

/**
 * Structural subset of OCC's rate-limit info (src/services/claudeAiLimits.ts)
 * matching the official `usageLimitDenial.limits` fields the builder reads.
 * `resetsAt` is epoch seconds.
 */
export type UsageLimitDenialInfo = {
  limits?: {
    resetsAt?: number
    rateLimitType?: string
  }
}

/**
 * Official `WZr` adaptation: does this completed background agent still own
 * live background work (shell/monitor or workflow tasks)?
 */
export function hasLiveOwnedBackgroundWork(
  task: Pick<LocalAgentTaskState, 'id' | 'agentId'>,
  appState: AppState,
): boolean {
  const tasks = appState.tasks ?? {}
  for (const other of Object.values(tasks)) {
    if (other.id === task.id || other.status !== 'running') {
      continue
    }
    if (isLocalShellTask(other) && other.agentId === task.agentId) {
      return true
    }
    if (
      other.type === 'local_workflow' &&
      other.ownerAgentId === task.agentId
    ) {
      return true
    }
  }
  return false
}

/** Official completed-status summary reason (`ct` without the `G` branch). */
export function completedSummaryReason(waitingOnBackgroundWork: boolean): string {
  return waitingOnBackgroundWork
    ? WAITING_ON_BACKGROUND_WORK_SUMMARY
    : FINISHED_SUMMARY
}

/**
 * Official `u8t(resetsAt, true)` → `qn` phrase, e.g. "resets at 3:00 PM" or
 * "resets in 2 hours". Returns undefined when the official gate fails
 * (no resetsAt, no rateLimitType, or the overage limit — overage has its own
 * messaging).
 */
export function usageLimitResetPhrase(
  limits: UsageLimitDenialInfo['limits'],
): string | undefined {
  if (!limits?.resetsAt || !limits.rateLimitType) {
    return undefined
  }
  if (limits.rateLimitType === 'overage') {
    return undefined
  }
  const formatted = formatResetTime(limits.resetsAt, true)
  if (formatted === undefined) {
    return undefined
  }
  return /^\d/.test(formatted)
    ? `resets at ${formatted}`
    : `resets ${formatted}`
}

/** Official `Wn` usage-limit note (leading space included); '' when no denial. */
export function usageLimitNote(
  denial: UsageLimitDenialInfo | undefined,
  callerCanContinueAgents?: boolean,
): string {
  if (!denial) {
    return ''
  }
  const resetPhrase = usageLimitResetPhrase(denial.limits)
  const continueSentence =
    callerCanContinueAgents === false ? '' : USAGE_LIMIT_CONTINUE_SENTENCE
  return ` This agent's work so far is saved.${resetPhrase ? ` The limit ${resetPhrase}.` : ''}${continueSentence}`
}

export type NotificationNoteInput = {
  waitingOnBackgroundWork: boolean
  hasLateMessages: boolean
  usageLimitDenial?: UsageLimitDenialInfo
  callerCanContinueAgents?: boolean
}

/**
 * Official body prefix `\n<${v$}>${Yt}${nn}${Wn}</${v$}>` (v$ = "note").
 * The Yt guidance variant is always present — pt picks the interim wording.
 */
export function buildNotificationNote(input: NotificationNoteInput): string {
  const guidance = input.waitingOnBackgroundWork
    ? BACKGROUND_WORK_INTERIM_NOTE
    : DEFAULT_STOP_NOTE
  const lateMessage = input.hasLateMessages ? LATE_MESSAGE_NOTE : ''
  const usageLimit = usageLimitNote(
    input.usageLimitDenial,
    input.callerCanContinueAgents,
  )
  return `\n<${NOTE_TAG}>${guidance}${lateMessage}${usageLimit}</${NOTE_TAG}>`
}
