import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

// Non-interactive (-p) variant of /usage. Shows session cost, plan usage, and
// what's contributing to limits. Mirrors the official 2.1.200 description:
// "Show session cost, plan usage, and what's contributing to your limits".
export const call: LocalCommandCall = async () => {
  const parts: string[] = []

  // Session cost
  parts.push(formatTotalCost())

  // Plan usage / limit contribution
  if (isClaudeAISubscriber()) {
    if (currentLimits.isUsingOverage) {
      parts.push(
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset',
      )
    } else {
      parts.push(
        'You are currently using your subscription to power your Claude Code usage',
      )
    }
    if (typeof currentLimits.utilization === 'number') {
      parts.push(
        `Current utilization: ${Math.round(currentLimits.utilization * 100)}%`,
      )
    }
  }

  return { type: 'text', value: parts.join('\n\n') }
}
