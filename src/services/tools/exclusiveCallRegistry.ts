/**
 * CC 2.1.295 (#026) — exclusive-call-queued-behind registry.
 *
 * Official face: `Gn().exclusiveCallQueuedBehind` — a Map on the official
 * global app-state singleton (s295 @5934827, added.txt @9365045), keyed by
 * the executing tool_use id. The streaming tool executor registers a check
 * for every tool call it starts; the local-agent auto-background timer
 * consults it before moving a subagent to the background.
 *
 * Why: CLAUDE_AUTO_BACKGROUND_TASKS used to fire its timer and background a
 * running subagent even when a non-concurrency-safe tool call (an edit or a
 * shell command) was already queued behind the subagent's Agent call in the
 * same turn. Backgrounding released the executor's exclusive lock, so the
 * queued edit/shell started BEFORE the subagent finished — the bug the
 * official 2.1.295 changelog fixes.
 *
 * OCC keeps this as a standalone leaf module (no imports at all) instead of
 * an AppState field: StreamingToolExecutor (writer) and LocalAgentTask
 * (reader) both reach it without cycles, and semantics are identical to the
 * official process-global singleton.
 */

/** Official `C` record (s295 @9365240). */
export type ExclusiveQueuedBehindCheck = {
  /**
   * True while a tool call that must run alone (non-concurrency-safe: edit,
   * shell, …) sits queued behind the call that owns this entry.
   */
  isQueued: () => boolean
  /**
   * True while the assistant response is still streaming, so an exclusive
   * call may yet arrive and queue behind the current one.
   */
  mayYetBeQueued: () => boolean
  /** Official once-per-entry log latch (`holdLogged`). */
  holdLogged: boolean
}

const exclusiveCallQueuedBehind = new Map<string, ExclusiveQueuedBehindCheck>()

export function setExclusiveQueuedBehindCheck(
  toolUseId: string,
  check: ExclusiveQueuedBehindCheck,
): void {
  exclusiveCallQueuedBehind.set(toolUseId, check)
}

export function getExclusiveQueuedBehindCheck(
  toolUseId: string,
): ExclusiveQueuedBehindCheck | undefined {
  return exclusiveCallQueuedBehind.get(toolUseId)
}

/**
 * Delete only if the entry is still the same object — official
 * `if(T.get(e.id)===C)T.delete(e.id)` dispose guard, so a late dispose from
 * a discarded execution never removes a newer registration for the same id.
 */
export function clearExclusiveQueuedBehindCheck(
  toolUseId: string,
  check: ExclusiveQueuedBehindCheck,
): void {
  if (exclusiveCallQueuedBehind.get(toolUseId) === check) {
    exclusiveCallQueuedBehind.delete(toolUseId)
  }
}

/** Test/teardown helper — official resets the whole global state on init. */
export function resetExclusiveQueuedBehindRegistry(): void {
  exclusiveCallQueuedBehind.clear()
}
