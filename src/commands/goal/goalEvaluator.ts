/**
 * /goal evaluator (claude-code 2.1.139).
 * After each turn, evaluates whether the goal condition has been met.
 * Uses the main-loop model (not Haiku — OCC doesn't have a separate small-fast model
 * configured by default; the env CLAUDE_CODE_SUBAGENT_MODEL or the main model is used).
 */

import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  isGoalActive,
  markGoalAchieved,
  getGoalCondition,
  incrementGoalTurn,
  addGoalTokens,
  getGoalTurns,
  getGoalTokens,
  getGoalElapsedMs,
} from './goalState.js'

/**
 * The system prompt for the goal evaluator. Asks the model to check if the
 * completion condition has been met based on the conversation so far.
 */
function getGoalEvaluatorPrompt(condition: string): string {
  return `You are a goal evaluator. Read the conversation and determine if the following completion condition has been met:

CONDITION: "${condition}"

Respond with ONLY a JSON object:
- If the condition is met: {"achieved": true, "reason": "brief explanation"}
- If not yet met: {"achieved": false, "reason": "brief explanation of what remains"}`
}

/**
 * Evaluate whether the goal condition has been met.
 * Uses a lightweight model call (the configured subagent model or main model).
 *
 * @param messages - The conversation messages so far
 * @param model - The model to use for evaluation
 * @param apiKey - API key
 * @param baseUrl - API base URL
 * @returns true if the goal is achieved, false otherwise
 */
export async function evaluateGoal(
  messages: Array<{ role: string; content: string }>,
  model: string,
  apiKey: string,
  baseUrl: string,
): Promise<{ achieved: boolean; reason: string }> {
  if (!isGoalActive()) {
    return { achieved: false, reason: 'No active goal' }
  }

  incrementGoalTurn()

  const condition = getGoalCondition()!
  const systemPrompt = getGoalEvaluatorPrompt(condition)

  // Build a compact conversation summary for the evaluator
  const conversationText = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n')
    .slice(-8000) // Last 8KB to keep the eval fast

  try {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Conversation so far:\n\n${conversationText}\n\nHas the condition been met?`,
          },
        ],
      }),
    })

    if (!response.ok) {
      logForDebugging(`Goal evaluator: API error ${response.status}`, { level: 'warn' })
      return { achieved: false, reason: `Evaluator API error: ${response.status}` }
    }

    const data = await response.json()
    const text = data?.content?.[0]?.text ?? ''
    addGoalTokens(data?.usage?.input_tokens ?? 0 + data?.usage?.output_tokens ?? 0)

    // Parse the JSON response
    try {
      const parsed = JSON.parse(text)
      if (parsed.achieved === true) {
        markGoalAchieved()
        logEvent('tengu_goal_achieved', {
          turns: getGoalTurns(),
          tokens: getGoalTokens(),
          elapsedMs: getGoalElapsedMs(),
        })
        return { achieved: true, reason: parsed.reason ?? 'Condition met' }
      }
      return { achieved: false, reason: parsed.reason ?? 'Condition not yet met' }
    } catch {
      // If JSON parse fails, check for keywords
      const lower = text.toLowerCase()
      if (lower.includes('"achieved": true') || lower.includes('achieved: true')) {
        markGoalAchieved()
        logEvent('tengu_goal_achieved', {
          turns: getGoalTurns(),
          tokens: getGoalTokens(),
          elapsedMs: getGoalElapsedMs(),
        })
        return { achieved: true, reason: 'Condition met' }
      }
      return { achieved: false, reason: 'Condition not yet met' }
    }
  } catch (error) {
    logForDebugging(`Goal evaluator error: ${error}`, { level: 'error' })
    return { achieved: false, reason: `Evaluator error: ${error}` }
  }
}
