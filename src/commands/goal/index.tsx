import * as React from 'react'
import { randomUUID } from 'node:crypto'
import type { Command, LocalJSXCommandContext } from '../../commands.js'
import type { AttachmentMessage } from '../../types/message.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import { getTotalInputTokens } from '../../cost-tracker.js'
import { logEvent } from "../../services/analytics/index.js"
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { addSessionHook, removeSessionHook } from '../../utils/hooks/sessionHooks.js'
import type { HookEvent } from '../../schemas/hooks.js'
import {
  setGoal,
  clearGoal,
  isGoalActive,
  getGoalCondition,
  getGoalTurns,
  getGoalLastReason,
} from './goalState.js'
import { GoalStatus } from './GoalStatus.js'

/**
 * The prompt injected when a goal is set. Verbatim from the official 2.1.200
 * `Pir` (verified via strings on /tmp/cc-200/package/claude).
 */
function goalPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`
}

/** Clear aliases — verbatim from the official R3f. */
const CLEAR_ALIASES = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])

/** Char limit on the condition — official kvt = 4000. */
const GOAL_CONDITION_MAX = 4000

function isClearArg(s: string): boolean {
  return CLEAR_ALIASES.has(s.toLowerCase())
}

/**
 * Build a goal_status attachment message (mirrors official `h4l`). Built inline
 * (not via utils/attachments.createAttachmentMessage) to avoid the
 * attachments.ts → Tool → commands.ts → goal circular import that crashed the
 * command registry (D0). Type-only import of AttachmentMessage is erased at
 * runtime, so no cycle. Filtered from the API by normalizeAttachmentForAPI
 * (case 'goal_status'); stays in the transcript for findGoalToRestore.
 *
 * set/clear markers are sentinel:true (restore markers). achieved/failed are
 * non-sentinel (terminal, for the panel) — findGoalToRestore scans all
 * goal_status attachments regardless of sentinel (met||failed → null).
 */
function goalStatusAttachment(
  met: boolean,
  condition: string,
  extra?: { failed?: boolean; reason?: string; iterations?: number; durationMs?: number; tokens?: number },
  sentinel: boolean = true,
): AttachmentMessage {
  return {
    type: 'attachment',
    attachment: { type: 'goal_status', met, condition, sentinel: sentinel as true, ...extra },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  } as AttachmentMessage
}

function pluralizeTurns(n: number): string {
  return `${n} turn${n === 1 ? '' : 's'}`
}

/**
 * Register the goal condition as a session-scoped prompt-type Stop hook —
 * mirrors the official `sessionHooksRegistry.add(r,"Stop","",{type:"prompt",
 * prompt:e})`. The existing executeStopHooks → execPromptHook evaluates it
 * each turn (returns {ok,reason}; blocks stopping until the condition holds).
 */
/**
 * G1: trusted-workspace + hooks gate (mirrors official `z4o`). Returns a
 * blocking message (verbatim from the official 2.1.200 binary) + the official
 * gate code when /goal must not run, or undefined when allowed. The set paths
 * call this BEFORE mutating any goal state — if it returns a message, they
 * surface it, emit the `goal_set` funnel event with the code (OCC uses logEvent
 * as the Statsig-funnel equivalent), and abort.
 */
function goalGate(context: LocalJSXCommandContext): { message: string; code: 'hooks_gate' | 'trust_gate' } | undefined {
  const settings = context.getAppState().settings
  if (settings?.disableAllHooks || settings?.allowManagedHooksOnly) {
    return {
      message: "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy).",
      code: 'hooks_gate',
    }
  }
  // Non-interactive (-p) mode is considered trusted — the workspace trust
  // dialog is skipped (per the --print option text + main.tsx prefetch gate),
  // so the trust branch only applies in interactive mode. There it is
  // defense-in-depth: the trust dialog blocks the REPL before /goal can run,
  // so checkHasTrustDialogAccepted() is true by the time /goal executes.
  if (!getIsNonInteractiveSession() && !checkHasTrustDialogAccepted()) {
    return {
      message: "/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.",
      code: 'trust_gate',
    }
  }
  return undefined
}

function registerGoalHook(context: LocalJSXCommandContext, condition: string): void {
  const sessionId = context.agentId ?? getSessionId()
  // Remove any prior goal hook (same condition) before adding — official
  // removes existing goal hooks in Rvt before adding the new one.
  removeSessionHook(context.setAppState, sessionId, 'Stop' as HookEvent, { type: 'prompt', prompt: condition })
  addSessionHook(
    context.setAppState, sessionId, 'Stop' as HookEvent, '',
    { type: 'prompt', prompt: condition },
    // onHookSuccess: when the goal condition is met (execPromptHook returns
    // ok:true), clear activeGoal + set lastAchievedGoal for the "Goal
    // achieved" panel state + remove the hook (mirrors official goal_status
    // attachment met:true + Dvt remove). When the evaluator returns
    // `impossible` (D8), mark activeGoal.failed instead + remove the hook
    // (stop blocking) — the GoalStatus panel renders "Goal could not be
    // achieved" with the stopReason.
    (_hook, result) => {
      if (result?.impossible) {
        // D8 / P0-3: goal assessed as impossible. Mark activeGoal.failed,
        // emit a non-sentinel goal_status attachment (met:false, failed:true)
        // to the transcript so resume doesn't re-restore the failed goal, and
        // log tengu_goal_failed (mirrors official O.impossible → goal_status
        // failed:true + tengu_goal_failed).
        const failed = context.getAppState().activeGoal
        if (failed) {
          const durationMs = Date.now() - failed.setAt
          const tokens = getTotalInputTokens() - (failed.tokensAtStart ?? 0)
          const failureAttachment = goalStatusAttachment(false, failed.condition, {
            failed: true,
            reason: result.stopReason,
            iterations: failed.iterations,
            durationMs,
            tokens,
          }, false)
          context.setAppState((s: any) => ({
            ...s,
            activeGoal: {
              ...s.activeGoal,
              failed: true,
              failureReason: result.stopReason,
            },
            messages: [...(s.messages ?? []), failureAttachment],
          }))
          logEvent("tengu_goal_failed", {
            promptLength: failed.condition.length,
            reasonLength: result.stopReason?.length ?? 0,
            iterations: failed.iterations,
            durationMs,
            tokens,
          })
        }
        removeSessionHook(context.setAppState, sessionId, 'Stop' as HookEvent, { type: 'prompt', prompt: condition })
        return
      }
      // P0-1: goal achieved. Clear activeGoal, set lastAchievedGoal, emit a
      // non-sentinel goal_status attachment (met:true) to the transcript so
      // resume-after-achievement doesn't re-restore the goal, and log
      // tengu_goal_achieved + goal_met (mirrors official h4l met:true +
      // tengu_goal_achieved + goal_met).
      clearGoal()
      const achieved = context.getAppState().activeGoal
      if (achieved) {
        const durationMs = Date.now() - achieved.setAt
        const tokens = getTotalInputTokens() - (achieved.tokensAtStart ?? 0)
        const achievedAttachment = goalStatusAttachment(true, achieved.condition, {
          iterations: achieved.iterations,
          durationMs,
          tokens,
        }, false)
        context.setAppState((s: any) => ({
          ...s,
          activeGoal: undefined,
          lastAchievedGoal: {
            condition: achieved.condition,
            durationMs,
            iterations: achieved.iterations,
            tokens,
          },
          messages: [...(s.messages ?? []), achievedAttachment],
        }))
        logEvent("tengu_goal_achieved", {
          promptLength: achieved.condition.length,
          iterations: achieved.iterations,
          durationMs,
          tokens,
        })
        logEvent("goal_met", {})
      } else {
        context.setAppState((s: any) => ({ ...s, activeGoal: undefined }))
      }
      removeSessionHook(context.setAppState, sessionId, 'Stop' as HookEvent, { type: 'prompt', prompt: condition })
    },
  )
}

function unregisterGoalHook(context: LocalJSXCommandContext, condition: string): void {
  const sessionId = context.agentId ?? getSessionId()
  removeSessionHook(context.setAppState, sessionId, 'Stop' as HookEvent, { type: 'prompt', prompt: condition })
}

// Interactive (REPL) variant: local-jsx. Mirrors the official Nk5/vk5.
export const goalInteractive: Command = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal Claude checks before stopping',
  argumentHint: '[<condition> | clear]',
  immediate: true,
  load: () =>
    Promise.resolve({
      call: async (onDone: any, context: LocalJSXCommandContext, args: string) => {
        const trimmed = (args ?? '').trim()

        if (trimmed === '') {
          return <GoalStatus onDone={() => onDone(undefined, { display: 'skip' })} />
        }

        if (isClearArg(trimmed)) {
          if (!isGoalActive()) {
            onDone('No goal set', { display: 'system' })
            return null
          }
          const condition = getGoalCondition() ?? ''
          clearGoal()
          unregisterGoalHook(context, condition)
          context.setAppState((s: any) => ({ ...s, activeGoal: undefined }))
          logEvent("tengu_stop_hook_removed", { via: "goal" })
          onDone(`Goal cleared: ${condition}`, { display: 'system', metaMessages: [goalStatusAttachment(true, condition)] })
          return null
        }

        if (trimmed.length > GOAL_CONDITION_MAX) {
          logEvent("goal_set", { code: "too_long" })
          onDone(`Goal condition is limited to ${GOAL_CONDITION_MAX} characters (got ${trimmed.length})`, { display: 'system' })
          return null
        }

        const gate = goalGate(context)
        if (gate) {
          // goal_set funnel: block (OCC logEvent = Statsig `At("goal_set", code)` equivalent)
          logEvent("goal_set", { code: gate.code })
          onDone(gate.message, { display: 'system' })
          return null
        }

        clearGoal()
        setGoal(trimmed)
        registerGoalHook(context, trimmed)
        const setAt = Date.now()
        const tokensAtStart = getTotalInputTokens()
        context.setAppState((s: any) => ({
          ...s,
          activeGoal: { condition: trimmed, iterations: 0, setAt, tokensAtStart },
        }))
        // goal_set funnel: success (OCC logEvent = Statsig `xe("goal_set")` equivalent)
        logEvent("goal_set", {})
        logEvent("tengu_stop_hook_added", { via: "goal", promptLength: trimmed.length })
        onDone(`Goal set: ${trimmed}`, { shouldQuery: true, metaMessages: [goalPrompt(trimmed), goalStatusAttachment(false, trimmed)] })
        return null
      },
    }),
}

// Non-interactive (-p) variant: local SNI. Mirrors the official $Hm/kk5.
export const goalNonInteractive: Command = {
  type: 'local',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  supportsNonInteractive: true,
  thinClientDispatch: 'post-text',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () =>
    Promise.resolve({
      call: async (args: string, context: LocalJSXCommandContext) => {
        const trimmed = (args ?? '').trim()
        if (trimmed === '') {
          if (!isGoalActive()) {
            return { type: 'text' as const, value: 'No goal set. Usage: `/goal <condition>`' }
          }
          const turns = getGoalTurns()
          const lastReason = getGoalLastReason()
          const turnStr = turns === 0 ? 'not yet evaluated' : pluralizeTurns(turns)
          return {
            type: 'text' as const,
            value: `Goal active: ${getGoalCondition()} (${turnStr})${lastReason ? `\nLast check: ${lastReason.trim()}` : ''}`,
          }
        }
        if (isClearArg(trimmed)) {
          if (!isGoalActive()) {
            return { type: 'text' as const, value: 'No goal set' }
          }
          const condition = getGoalCondition() ?? ''
          clearGoal()
          unregisterGoalHook(context, condition)
          context.setAppState((s: any) => ({ ...s, activeGoal: undefined }))
          return { type: 'text' as const, value: `Goal cleared: ${condition}` }
        }
        if (trimmed.length > GOAL_CONDITION_MAX) {
          logEvent("goal_set", { code: "too_long" })
          return { type: 'text' as const, value: `Goal condition is limited to ${GOAL_CONDITION_MAX} characters (got ${trimmed.length})` }
        }
        const gate = goalGate(context)
        if (gate) {
          logEvent("goal_set", { code: gate.code })
          return { type: 'text' as const, value: gate.message }
        }
        clearGoal()
        setGoal(trimmed)
        registerGoalHook(context, trimmed)
        const setAt = Date.now()
        const tokensAtStart = getTotalInputTokens()
        context.setAppState((s: any) => ({
          ...s,
          activeGoal: { condition: trimmed, iterations: 0, setAt, tokensAtStart },
        }))
        logEvent("goal_set", {})
        return {
          type: 'query' as const,
          value: `Goal set: ${trimmed}`,
          prompt: goalPrompt(trimmed),
        }
      },
    }),
}

const goal: Command = goalInteractive
export default goal
