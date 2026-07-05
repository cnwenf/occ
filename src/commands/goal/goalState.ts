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
