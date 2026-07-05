import type { Command } from '../../commands.js'
import {
  setGoal,
  clearGoal,
  isGoalActive,
  getGoalCondition,
  getGoalTurns,
} from './goalState.js'

/**
 * The prompt injected as an isMeta user message when a goal is set, so the
 * model starts (and keeps) working toward the condition. Mirrors the official
 * claude-code 2.1.139 `bj8(condition)` text: a session-scoped Stop hook is
 * active, the model briefly acknowledges then immediately works toward the
 * condition, and does not tell the user to run /goal clear.
 */
function goalPrompt(condition: string): string {
  return `A session-scoped Stop hook is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The hook will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\``
}

const goal: Command = {
  type: 'local',
  name: 'goal',
  description: 'Set a goal — keep working until the condition is met',
  argumentHint: '[<condition> | clear]',
  supportsNonInteractive: true,
  isEnabled: () => true,
  async load() {
    return {
      // Mirrors the official 2.1.139 non-interactive goal command (kk5):
      //   no args  -> status (or "No goal set. Usage: `/goal <condition>`")
      //   clear    -> "No goal set" | "Goal cleared: <condition>"
      //   <cond>   -> {type:'query', value:`Goal set: <cond>`, prompt:bj8(cond)}
      async call(args: string) {
        const trimmed = args.trim()

        // No args — show status (official: no-args is the status query).
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

        // clear — official returns "No goal set" or "Goal cleared: <condition>".
        if (trimmed === 'clear') {
          if (!isGoalActive()) {
            return { type: 'text' as const, value: 'No goal set' }
          }
          const condition = getGoalCondition()
          clearGoal()
          return { type: 'text' as const, value: `Goal cleared: ${condition}` }
        }

        // Set a new goal — display the confirmation, then trigger a model
        // turn with the goal prompt (the {type:'query'} result) so Claude
        // actually starts working toward the condition.
        clearGoal()
        setGoal(trimmed)
        return {
          type: 'query' as const,
          value: `Goal set: ${trimmed}`,
          prompt: goalPrompt(trimmed),
        }
      },
    }
  },
}

export default goal
