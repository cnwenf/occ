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
 * Restore-on-resume. Scan the transcript (in reverse) for the most recent
 * goal_status marker. A met:true marker (cleared/achieved) after the last
 * met:false marker means the goal was resolved → return null. A met:false
 * marker → restore its condition. Mirrors official `m4l` (scans goal_status
 * attachments). Falls back to scanning command-stdout text ("Goal set:",
 * "Goal cleared:", "Goal achieved:") for transcripts that predate the
 * goal_status attachment markers.
 */
export function findGoalToRestore(
  messages: Array<{ message?: { content?: unknown }; type?: string; attachment?: { type?: string; met?: boolean; condition?: string } }>,
): string | null {
  // First pass: scan for goal_status attachment markers (structured, robust).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'attachment' && msg.attachment?.type === 'goal_status') {
      // Mirrors official S1c: met (cleared/achieved) OR failed → nothing to
      // restore. Without the `failed` check, a failed goal would be incorrectly
      // restored as active on resume.
      if (msg.attachment.met || msg.attachment.failed) {
        return null
      }
      return msg.attachment.condition ?? null
    }
  }
  // Fallback: scan command-stdout text (legacy transcripts without markers).
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
