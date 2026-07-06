import * as React from 'react'
import type { Command, LocalJSXCommandContext } from '../../commands.js'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import { getTotalInputTokens } from '../../cost-tracker.js'
import { logEvent } from "../../services/analytics/index.js"
import { logEvent } from "../../services/analytics/index.js"
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

function pluralizeTurns(n: number): string {
  return `${n} turn${n === 1 ? '' : 's'}`
}

/**
 * Register the goal condition as a session-scoped prompt-type Stop hook —
 * mirrors the official `sessionHooksRegistry.add(r,"Stop","",{type:"prompt",
 * prompt:e})`. The existing executeStopHooks → execPromptHook evaluates it
 * each turn (returns {ok,reason}; blocks stopping until the condition holds).
 */
function registerGoalHook(context: LocalJSXCommandContext, condition: string): void {
  // G1: trusted-workspace + hooks gate (mirrors official z4o)
  const settings = context.getAppState().settings
  if (settings?.disableAllHooks) {
  logEvent("tengu_goal_blocked", { reason: "disableAllHooks" })
  }
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
    // attachment met:true + Dvt remove).
    () => {
      clearGoal()
      const achieved = context.getAppState().activeGoal
      context.setAppState((s: any) => ({
        ...s,
        activeGoal: undefined,
        lastAchievedGoal: achieved ? {
          condition: achieved.condition,
          durationMs: Date.now() - achieved.setAt,
          iterations: achieved.iterations,
        } : undefined,
      }))
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
          logEvent("tengu_stop_hook_removed", { via: "goal" }), onDone(`Goal cleared: ${condition}`, { display: 'system' })
          return null
        }

        if (trimmed.length > GOAL_CONDITION_MAX) {
          onDone(`Goal condition is limited to ${GOAL_CONDITION_MAX} characters (got ${trimmed.length})`, { display: 'system' })
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
        logEvent("tengu_stop_hook_added", { via: "goal" }), onDone(`Goal set: ${trimmed}`, { shouldQuery: true, metaMessages: [goalPrompt(trimmed)] })
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
          return { type: 'text' as const, value: `Goal condition is limited to ${GOAL_CONDITION_MAX} characters (got ${trimmed.length})` }
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
