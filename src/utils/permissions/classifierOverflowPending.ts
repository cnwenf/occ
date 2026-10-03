/**
 * CC 2.1.288 #65 — auto mode classifier overflow now compacts.
 *
 * Pending-registry + consumer/telemetry module for the v288 delta where a
 * classifier-transcript overflow in auto mode no longer just falls back to
 * manual approval: it registers a pending compaction request, denies the call
 * with the new `jor` reason, and the next autocompact pass consumes the
 * pending request (forcing compaction below the token threshold) and attaches
 * a critical_system_reminder about the denied calls.
 *
 * Official symbols ported byte-faithfully from the 2.1.288 linux-x64 ELF:
 *   - $At gate (@208550061): A("tengu_merry_popcorn",!0)
 *   - NMe/$Me/WEt/zEt/qEt/KEt registry (@208315655)
 *   - LFo consumer / ojt post-compact finalize / TY not-run handler (@209130xxx)
 *   - VHt reminder builder (@209096408), ln = createAttachmentMessage (@210667935)
 *   - jor reason constant (chunk-rzrpg02t.js)
 *
 * Documented divergences (see docs/gap-research-288/cluster-c-instructions-resume.md #65):
 *   - NMe is session-scoped (kt) in the official binary; OCC runs one session
 *     per process, so a module-level Map keyed by agentId ("main" fallback) is
 *     equivalent.
 *   - de(ctx).servedCall does not exist in OCC; qi(mode, servedCall) is mapped
 *     to OCC's auto-mode entry gate (mode 'auto', or 'plan' with
 *     isAutoModeActive()/isPlanModeAutoBashActive()).
 *   - The official p/y/m OTEL helpers route through an internal 1P OTEL event
 *     registry that OCC lacks; mapped to
 *     logOTelEvent('compact_classifier_overflow', {outcome, reason?}) with
 *     outcome success(y)/failure(m)/skip(p).
 */
import type { CompactionResult } from 'src/services/compact/compact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import type { ToolUseContext } from 'src/Tool.js'
import type { AttachmentMessage, Message } from 'src/types/message.js'
import { createAttachmentMessage } from 'src/utils/attachments.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import { isAutoModeActive, isPlanModeAutoBashActive } from './autoModeState.js'

type AnalyticsString =
  AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

/** Official telemetry event name (v288, verbatim). */
export const OVERFLOW_COMPACT_TELEMETRY_EVENT =
  'tengu_auto_mode_classifier_overflow_compact'

/** Official OTEL event name (v288, verbatim). */
const OVERFLOW_COMPACT_OTEL_EVENT = 'compact_classifier_overflow'

/** Official growthbook gate (v288 $At, verbatim): A("tengu_merry_popcorn",!0). */
const MERRY_POPCORN_FLAG = 'tengu_merry_popcorn'

/** Official registry fallback agent key ($Me): e??"main". */
const MAIN_AGENT_KEY = 'main'

/**
 * Official jor reason constant (v288, verbatim — NEVER paraphrase):
 * the deny+compact decisionReason string.
 */
export const CLASSIFIER_OVERFLOW_COMPACT_REASON =
  'Auto mode classifier transcript exceeded context window; will try to compact the conversation before the next request'

/** A pending overflow-compaction request (official zEt `pending` shape). */
export interface OverflowPendingRequest {
  epoch: string
  mode: string
  toolName: string
  deniedToolNames: string[]
}

/** Registry entry (official NMe value shape: {canCompact?, spentEpoch?, pending?}). */
interface RegistryEntry {
  canCompact?: boolean
  spentEpoch?: string
  pending?: OverflowPendingRequest
}

/**
 * Official NMe (@208315655): `var NMe=new kt(()=>new Map)` — session-scoped.
 * OCC divergence: module-level Map (one session per process), keyed by
 * agentId with "main" fallback ($Me).
 */
const registry = new Map<string, RegistryEntry>()

/** Official $Me: `function $Me(e){return e??"main"}` */
function agentKey(context: ToolUseContext): string {
  return context.agentId ?? MAIN_AGENT_KEY
}

/**
 * Official WEt: `function WEt(e){return e[0]?.uuid}` — transcript epoch.
 * OCC hardening: tolerate an undefined messages array (test fakes / partial
 * contexts); the official call sites always pass a real array.
 */
function epochOf(messages: Message[] | undefined): string | undefined {
  return (messages?.[0] as { uuid?: string } | undefined)?.uuid
}

/** Official $At gate (@208550061): A("tengu_merry_popcorn",!0). */
export function isClassifierOverflowCompactEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE<boolean>(MERRY_POPCORN_FLAG, true) ===
    true
  )
}

/**
 * Official qi mapping — "is this mode still auto-like?". OCC divergence:
 * servedCall does not exist in OCC, so this mirrors OCC's auto-mode entry
 * gate (permissions.ts): mode 'auto', or 'plan' with the auto-mode /
 * plan-mode-auto-bash toggles active.
 */
function isAutoLikeMode(mode: string): boolean {
  return (
    mode === 'auto' ||
    (mode === 'plan' && (isAutoModeActive() || isPlanModeAutoBashActive()))
  )
}

/**
 * Official zEt (@208315655), verbatim semantics:
 * registers a pending overflow compaction when the entry was primed with
 * canCompact===true and the epoch was not already spent; joins an existing
 * same-epoch pending (accumulating deniedToolNames) otherwise creates one.
 * Returns 'joined' | 'requested' | undefined.
 */
export function registerClassifierOverflowPending(
  context: ToolUseContext,
  messages: Message[],
  request: { toolName: string; denied: boolean; mode: string },
): 'requested' | 'joined' | undefined {
  const epoch = epochOf(messages)
  if (epoch === undefined) {
    return undefined
  }
  const key = agentKey(context)
  const entry = registry.get(key)
  if (entry?.canCompact !== true || entry.spentEpoch === epoch) {
    return undefined
  }
  const joined = entry.pending?.epoch === epoch ? entry.pending : undefined
  const base: OverflowPendingRequest = joined ?? {
    epoch,
    mode: request.mode,
    toolName: request.toolName,
    deniedToolNames: [],
  }
  registry.set(key, {
    ...entry,
    pending: request.denied
      ? { ...base, deniedToolNames: [...base.deniedToolNames, request.toolName] }
      : base,
  })
  return joined ? 'joined' : 'requested'
}

/**
 * Official qEt (@208315655), verbatim semantics — NOTE: this is a TAKE.
 * It REPLACES the entry with {canCompact, spentEpoch} (dropping pending) and
 * reports the taken pending plus a staleness verdict ('epoch' moved on, or
 * 'mode' changed away from the pending's registered mode).
 */
export function takeClassifierOverflowPending(
  context: ToolUseContext,
  messages: Message[],
  currentMode: string,
  canCompact: boolean,
): { pending?: OverflowPendingRequest; stale?: 'epoch' | 'mode' } {
  const key = agentKey(context)
  const entry = registry.get(key)
  registry.set(key, { canCompact, spentEpoch: entry?.spentEpoch })
  const pending = entry?.pending
  if (pending === undefined) {
    return {}
  }
  if (pending.epoch !== epochOf(messages)) {
    return { pending, stale: 'epoch' }
  }
  if (pending.mode !== currentMode) {
    return { pending, stale: 'mode' }
  }
  return { pending }
}

/**
 * Official KEt (@208315655), verbatim semantics: clears the pending and marks
 * the epoch spent so the same epoch cannot re-register.
 */
function markOverflowEpochSpent(
  context: ToolUseContext,
  pending: OverflowPendingRequest,
): void {
  const key = agentKey(context)
  registry.set(key, {
    ...registry.get(key),
    pending: undefined,
    spentEpoch: pending.epoch,
  })
}

/**
 * Official TY not-run handler: reports a pending overflow compaction that did
 * NOT run (skipped/unavailable/hook_blocked or failed/aborted/too_few_groups/
 * error). Clears + spends the epoch except for user-abort (retryable).
 */
export function reportOverflowCompactionNotRun(
  context: ToolUseContext,
  pending: OverflowPendingRequest,
  report: { kind: 'failed' | 'skipped'; reason: string },
): void {
  const aborted = report.reason === 'aborted'
  if (!aborted) {
    markOverflowEpochSpent(context, pending)
  }
  logForDebugging(
    `autocompact: compaction after the auto mode classifier overflowed ${report.kind} (${report.reason})`,
    { level: 'warn' },
  )
  logEvent(OVERFLOW_COMPACT_TELEMETRY_EVENT, {
    stage: (aborted ? 'skipped' : report.kind) as AnalyticsString,
    reason: report.reason as AnalyticsString,
    deniedCalls: pending.deniedToolNames.length,
    isSubagent: context.agentId !== undefined,
  })
  if (report.kind === 'failed' && !aborted) {
    void logOTelEvent(OVERFLOW_COMPACT_OTEL_EVENT, {
      outcome: 'failure',
      reason: report.reason,
    })
  } else {
    void logOTelEvent(OVERFLOW_COMPACT_OTEL_EVENT, {
      outcome: 'skip',
      reason: report.reason,
    })
  }
}

/**
 * Official LFo consumer, verbatim semantics: takes the pending (qEt), drops
 * stale ones with dropped/stale or dropped/left_auto_mode telemetry, reports
 * skipped/unavailable when compaction is unavailable, otherwise returns the
 * pending request so the caller forces compaction.
 */
export function consumeClassifierOverflowForCompaction(
  context: ToolUseContext,
  messages: Message[],
  canCompact: boolean,
): OverflowPendingRequest | undefined {
  const mode = context.getAppState().toolPermissionContext.mode
  const { pending, stale } = takeClassifierOverflowPending(
    context,
    messages,
    mode,
    canCompact,
  )
  if (pending === undefined) {
    return undefined
  }
  const leftAutoMode =
    stale === 'mode' && !isAutoLikeMode(mode) && mode !== 'dontAsk'
  if (stale === 'epoch' || leftAutoMode) {
    const reason = stale === 'epoch' ? 'stale' : 'left_auto_mode'
    logEvent(OVERFLOW_COMPACT_TELEMETRY_EVENT, {
      stage: 'dropped' as AnalyticsString,
      reason: reason as AnalyticsString,
      isSubagent: context.agentId !== undefined,
    })
    void logOTelEvent(OVERFLOW_COMPACT_OTEL_EVENT, {
      outcome: 'skip',
      reason,
    })
    return undefined
  }
  if (!canCompact) {
    reportOverflowCompactionNotRun(context, pending, {
      kind: 'skipped',
      reason: 'unavailable',
    })
    return undefined
  }
  return pending
}

/**
 * Official VHt reminder builder (@209096408) — both content strings are
 * verbatim from the 2.1.288 binary; NEVER paraphrase.
 */
export function buildOverflowCompactReminder(
  deniedCallCount: number,
  deniedToolNames: string[],
): AttachmentMessage {
  if (deniedCallCount === 0) {
    return createAttachmentMessage({
      type: 'critical_system_reminder',
      content:
        "The conversation was compacted because it had become too long for auto mode's classifier.",
    })
  }
  const singular = deniedCallCount === 1
  const subject = singular
    ? `an earlier tool call (${deniedToolNames.join(', ')})`
    : `${deniedCallCount} earlier tool calls (${deniedToolNames.join(', ')})`
  return createAttachmentMessage({
    type: 'critical_system_reminder',
    content: `Auto mode could not review ${subject} because the conversation was too long for its classifier, so ${
      singular ? 'that call' : 'those calls'
    } did not run. The conversation has now been compacted. If still needed, issue ${
      singular ? 'it' : 'them'
    } again and ${singular ? 'it' : 'they'} will be reviewed normally.`,
  })
}

/**
 * Official ojt post-compact finalize, verbatim semantics: emits the compacted
 * telemetry + success OTEL and appends the VHt reminder to the compaction
 * result's attachments (immutably).
 */
export function finalizeOverflowCompaction(
  context: ToolUseContext,
  pending: OverflowPendingRequest,
  result: CompactionResult,
): CompactionResult {
  logForDebugging(
    'autocompact: compacted after the auto mode classifier overflowed',
  )
  logEvent(OVERFLOW_COMPACT_TELEMETRY_EVENT, {
    stage: 'compacted' as AnalyticsString,
    deniedCalls: pending.deniedToolNames.length,
    isSubagent: context.agentId !== undefined,
    preCompactTokenCount: result.preCompactTokenCount,
    postCompactTokenCount: result.postCompactTokenCount,
    truePostCompactTokenCount: result.truePostCompactTokenCount,
  })
  void logOTelEvent(OVERFLOW_COMPACT_OTEL_EVENT, { outcome: 'success' })
  return {
    ...result,
    attachments: [
      ...result.attachments,
      buildOverflowCompactReminder(
        pending.deniedToolNames.length,
        pending.deniedToolNames,
      ),
    ],
  }
}

/**
 * Official v288 deny+compact arm message (verbatim — NEVER paraphrase).
 */
export function buildOverflowCompactDenyMessage(toolName: string): string {
  return `${toolName} was not reviewed and did not run: the conversation is too long for auto mode's classifier. Claude Code will try to compact the conversation before the next request; if this action is still needed after that, issue it again and it will be reviewed normally.`
}

/** Test-only: clears the module-level registry. */
export function _resetClassifierOverflowForTesting(): void {
  registry.clear()
}
