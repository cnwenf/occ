/**
 * K3 (2.1.154): Workflow engine error classes.
 *
 * Mirrors the 2.1.200 binary's named error types:
 *   - WorkflowBudgetExceededError (iBl) — thrown when the token budget is
 *     exhausted. NON-FATAL: parallel()/pipeline() branches catch it, return
 *     null, and preserve in-flight results. The workflow completes with
 *     partial results.
 *   - WorkflowAgentCapError (sBl) — thrown when the lifetime agent count
 *     cap (1000) is reached. A runaway-loop backstop.
 *
 * Both are caught per-branch in parallel()/pipeline() so a single branch
 * hitting a cap does not abort the whole workflow.
 */

/**
 * Thrown when the workflow's token budget is exhausted.
 * Message mirrors the binary:
 * "Workflow token budget exceeded ($spent / $total). Cap reached —
 *  parallel/pipeline branches halted; in-flight agents complete; their
 *  results are preserved."
 */
export class WorkflowBudgetExceededError extends Error {
  readonly spent: number
  readonly total: number
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent} / ${total}). ` +
        `Cap reached — parallel/pipeline branches halted; in-flight agents ` +
        `complete; their results are preserved.`,
    )
    this.name = 'WorkflowBudgetExceededError'
    this.spent = spent
    this.total = total
  }
}

/**
 * Thrown when the lifetime agent count cap is reached (default 1000).
 * A runaway-loop backstop — the binary fires tengu_workflow_agent_cap_exceeded
 * then throws this.
 */
export class WorkflowAgentCapError extends Error {
  readonly agentCount: number
  constructor(agentCount: number) {
    super(
      `Workflow agent count cap exceeded (${agentCount}). ` +
        `Total agent count across a workflow's lifetime is capped at 1000 — ` +
        `a runaway-loop backstop.`,
    )
    this.name = 'WorkflowAgentCapError'
    this.agentCount = agentCount
  }
}

/**
 * Returns true if the error is one of the non-fatal workflow cap errors
 * that parallel()/pipeline() swallow per-branch.
 */
export function isWorkflowCapError(err: unknown): boolean {
  return (
    err instanceof WorkflowBudgetExceededError ||
    err instanceof WorkflowAgentCapError ||
    (err instanceof Error &&
      (err.name === 'WorkflowBudgetExceededError' ||
        err.name === 'WorkflowAgentCapError'))
  )
}
