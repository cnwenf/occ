import * as React from 'react'
import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  setGoal,
  clearGoal,
  isGoalActive,
  getGoalCondition,
  getGoalTurns,
} from './goalState.js'
import { GoalStatus } from './GoalStatus.js'

/**
 * The prompt injected as an isMeta user message when a goal is set, so the
 * model starts (and keeps) working toward the condition. Mirrors the official
 * claude-code 2.1.139 `bj8(condition)` text.
 */
function goalPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\``
}

// Interactive (REPL) variant: local-jsx. Mirrors the official Nk5/vk5.
export const goalInteractive: Command = {
  type: 'local-jsx',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () =>
    Promise.resolve({
      call: async (onDone: any, context: any, args: string) => {
        const trimmed = (args ?? '').trim()

        // No args — show the status panel (official: VZ4).
        if (trimmed === '') {
          return <GoalStatus onDone={() => onDone(undefined, { display: 'skip' })} />
        }

        // clear
        if (trimmed === 'clear') {
          if (!isGoalActive()) {
            onDone('No goal set', { display: 'system' })
            return null
          }
          const condition = getGoalCondition()
          clearGoal()
          context.setAppState((s: any) => ({ ...s, activeGoal: undefined }))
          onDone(`Goal cleared: ${condition}`, { display: 'system' })
          return null
        }

        // set
        clearGoal()
        setGoal(trimmed)
        const setAt = Date.now()
        context.setAppState((s: any) => ({
          ...s,
          activeGoal: { condition: trimmed, iterations: 0, setAt, tokensAtStart: 0 },
        }))
        onDone(`Goal set: ${trimmed}`, { shouldQuery: true, metaMessages: [goalPrompt(trimmed)] })
        return null
      },
    }),
}

// Non-interactive (-p) variant: local SNI. Mirrors the official Ek5/kk5.
export const goalNonInteractive: Command = {
  type: 'local',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  supportsNonInteractive: true,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  load: () =>
    Promise.resolve({
      call: async (args: string) => {
        const trimmed = (args ?? '').trim()
        if (trimmed === '') {
          if (!isGoalActive()) {
            return { type: 'text' as const, value: 'No goal set. Usage: `/goal <condition>`' }
          }
          const turns = getGoalTurns()
          return {
            type: 'text' as const,
            value: `Goal active: ${getGoalCondition()} (${turns === 0 ? 'not yet evaluated' : `${turns} turns`})`,
          }
        }
        if (trimmed === 'clear') {
          if (!isGoalActive()) {
            return { type: 'text' as const, value: 'No goal set' }
          }
          const condition = getGoalCondition()
          clearGoal()
          return { type: 'text' as const, value: `Goal cleared: ${condition}` }
        }
        clearGoal()
        setGoal(trimmed)
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
