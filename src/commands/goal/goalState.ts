/**
 * /goal command state management (claude-code 2.1.139).
 * Stores the completion condition + tracks elapsed/turns/tokens.
 */

interface GoalState {
  condition: string
  startTime: number
  turnCount: number
  tokenCount: number
  achieved: boolean
  lastReason?: string
}

let currentGoal: GoalState | null = null

export function setGoal(condition: string): void {
  currentGoal = {
    condition,
    startTime: Date.now(),
    turnCount: 0,
    tokenCount: 0,
    achieved: false,
  }
}

export function clearGoal(): void {
  currentGoal = null
}

export function getGoal(): GoalState | null {
  return currentGoal
}

export function isGoalActive(): boolean {
  return currentGoal !== null && !currentGoal.achieved
}

export function incrementGoalTurn(): void {
  if (currentGoal) {
    currentGoal.turnCount++
  }
}

export function addGoalTokens(tokens: number): void {
  if (currentGoal) {
    currentGoal.tokenCount += tokens
  }
}

export function markGoalAchieved(): void {
  if (currentGoal) {
    currentGoal.achieved = true
  }
}

export function setGoalLastReason(reason: string): void {
  if (currentGoal) {
    currentGoal.lastReason = reason
  }
}

export function getGoalLastReason(): string | undefined {
  return currentGoal?.lastReason
}

export function getGoalElapsedMs(): number {
  if (!currentGoal) return 0
  return Date.now() - currentGoal.startTime
}

export function getGoalTurns(): number {
  return currentGoal?.turnCount ?? 0
}

export function getGoalTokens(): number {
  return currentGoal?.tokenCount ?? 0
}

export function getGoalCondition(): string | null {
  return currentGoal?.condition ?? null
}

/**
 * GAP D: restore-on-resume. Scan the transcript (in reverse) for the last
 * "Goal set: <condition>" message. If a "Goal cleared" or "Goal achieved"
 * appears after it, the goal was resolved — return null. Mirrors the
 * official findGoalToRestore (scans goal_status attachments; OCC scans
 * the command-stdout text since it doesn't emit goal_status attachments).
 */
export function findGoalToRestore(messages: Array<{ message?: { content?: unknown } }>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.message?.content
    const text = typeof content === 'string' ? content : ''
    if (text.includes('Goal cleared:') || text.includes('Goal achieved:')) {
      return null
    }
    const match = text.match(/Goal set: (.+)/)
    if (match) {
      return match[1].trim()
    }
  }
  return null
}
