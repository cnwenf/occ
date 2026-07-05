import type { Command } from '../../commands.js'
import {
  setGoal,
  clearGoal,
  isGoalActive,
  getGoalCondition,
} from './goalState.js'

const goal: Command = {
  type: 'local',
  name: 'goal',
  description: 'Set a completion condition — Claude keeps working across turns until it is met',
  argumentHint: '<condition> | clear',
  supportsNonInteractive: true,
  isEnabled: () => true,
  async load() {
    return {
      async call(args: string) {
        const trimmed = args.trim()
        if (!trimmed || trimmed === 'clear') {
          if (isGoalActive()) {
            clearGoal()
            return { type: 'text' as const, value: 'Goal cleared. Stopping early.' }
          }
          return { type: 'text' as const, value: 'No active goal to clear.' }
        }
        if (trimmed === 'status') {
          if (isGoalActive()) {
            return { type: 'text' as const, value: `Goal active: ${getGoalCondition()}` }
          }
          return { type: 'text' as const, value: 'No active goal. Use /goal <condition> to set one.' }
        }
        // Set a new goal
        clearGoal()
        setGoal(trimmed)
        return {
          type: 'text' as const,
          value: `Goal set: "${trimmed}"\nClaude will keep working across turns until this condition is met. Use /goal clear to stop early.`,
        }
      },
    }
  },
}

export default goal
