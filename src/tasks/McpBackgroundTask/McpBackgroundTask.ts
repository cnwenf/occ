/**
 * CC 2.1.212: MCP tool auto-background task state.
 *
 * When an MCP tool call exceeds the auto-background threshold (default
 * 120000ms / 2 min, override via CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS), the
 * in-flight call is moved to the background so the session stays usable.
 * The tool KEEPS RUNNING under its own AbortController; its eventual result
 * is delivered via the background-tasks system (the model sees a "moved to
 * background" result immediately with the task id).
 *
 * This module mirrors the official 2.1.212 `kZu` task object shape:
 *   { ...baseTaskFields(id, "mcp_task", `${serverName}/${toolName}`,
 *      toolUseId), type: "mcp_task", status: "running", serverName,
 *      toolName, mcpTaskId, mcpStatus: "working", pollIntervalMs,
 *      abortController }.
 *
 * REUSE (do not rebuild):
 *   - registerTask at src/utils/task/framework.ts (inserts into AppState.tasks
 *     so /tasks shows the row + the SDK task_started event fires).
 *   - createChildAbortController at src/utils/abortController.js (parent abort
 *     propagates to the background task's controller without the parent
 *     retaining a strong ref to it).
 */
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import {
  generateTaskId,
  type SetAppState,
  type Task,
  type TaskStateBase,
} from '../../Task.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'

/**
 * Status of a backgrounded MCP tool call. Mirrors the binary's `mcpStatus`:
 *   - "working" while the tool is still running.
 *   - "completed" / "failed" when the tool settles (set by the completion
 *     handler that observes the backgrounded run promise).
 */
export type McpTaskStatus = 'working' | 'completed' | 'failed'

export type McpBackgroundTaskState = TaskStateBase & {
  type: 'mcp_task'
  // `status` inherits TaskStateBase['status'] (TaskStatus). A backgrounded call
  // STARTS at 'running' (see makeMcpBackgroundTask) and reaches a terminal
  // state when it settles or is stopped — kill() below sets 'killed'. The
  // official 2.1.295 eviction guards test isTerminalTaskStatus() on mcp_task
  // rows, so the type must permit terminal values (not just 'running').
  /** MCP server name (from the connection). */
  serverName: string
  /** MCP tool name (the tool being called). */
  toolName: string
  /** Stable id for the MCP background task (separate from the AppState row id). */
  mcpTaskId: string
  /** Current lifecycle status of the underlying MCP call. */
  mcpStatus: McpTaskStatus
  /** Polling interval for /tasks (mirrors the binary's pollIntervalMs). */
  pollIntervalMs: number
  /**
   * The background task's OWN AbortController. The tool keeps running under
   * this controller after the foreground turn ends. Aborting it cancels the
   * backgrounded call. Runtime-only — not serialized.
   */
  abortController?: AbortController
}

/** Poll interval shown in /tasks for a backgrounded MCP tool call. */
export const MCP_TASK_POLL_INTERVAL_MS = 1000

/**
 * Build a backgrounded MCP task state object (official `kZu`). Does NOT
 * register it — the caller registers via registerMcpBackgroundTask or passes
 * the object to the task registry.
 */
export function makeMcpBackgroundTask({
  serverName,
  toolName,
  toolUseId,
  abortController,
  pollIntervalMs = MCP_TASK_POLL_INTERVAL_MS,
}: {
  serverName: string
  toolName: string
  toolUseId: string
  abortController: AbortController
  pollIntervalMs?: number
}): McpBackgroundTaskState {
  const id = generateTaskId('mcp_task')
  return {
    ...createMcpTaskBase(id, `${serverName}/${toolName}`, toolUseId),
    type: 'mcp_task',
    status: 'running',
    serverName,
    toolName,
    mcpTaskId: id,
    mcpStatus: 'working',
    pollIntervalMs,
    abortController,
  }
}

// Local base builder (mirrors createTaskStateBase but kept local so this
// module is self-contained for the mcp_task variant — avoids coupling to
// Task.ts's createTaskStateBase which writes to disk output paths we don't
// need for an in-memory MCP call tracker).
function createMcpTaskBase(
  id: string,
  description: string,
  toolUseId: string,
): TaskStateBase {
  return {
    id,
    type: 'mcp_task',
    status: 'running',
    description,
    toolUseId,
    startTime: Date.now(),
    // MCP background tasks don't write a transcript to disk — the tool's
    // eventual result is delivered inline via the background-task system.
    // Empty string keeps the type's required field satisfied without
    // allocating a disk file.
    outputFile: '',
    outputOffset: 0,
    notified: false,
  }
}

/**
 * Register a backgrounded MCP task in AppState.tasks (so /tasks shows it and
 * the SDK task_started event fires). Wraps registerTask. Returns the
 * registered state for the caller to thread through the auto-background
 * primitive's return value.
 */
export function registerMcpBackgroundTask(
  task: McpBackgroundTaskState,
  setAppState: SetAppState,
): McpBackgroundTaskState {
  registerTask(task, setAppState)
  return task
}

/**
 * Build the `<task-notification>` XML delivered to the model when a
 * backgrounded MCP tool call is stopped.
 *
 * Faithful to the official 2.1.295 `SQn` builder (binary-verified):
 *   Di({ taskId, toolUseId?, status: "killed",
 *        summary: `Task "${description}" was stopped by the user` })
 *   → enqueuePendingNotification({ mode: "task-notification", priority: "next" })
 *
 * The official `Di` call for this path passes ONLY taskId/toolUseId/status/
 * summary — no outputFile and no taskType — so the emitted block omits
 * `<output-file>` and `<task-type>`. That is correct for an MCP background
 * task: it has no disk transcript (outputFile is '') and delivers its result
 * inline. `summary` is XML-escaped (official `Ut`); the tag names match
 * OCC's shared constants/xml.js so print.ts's task_notification parser and the
 * SDK event see the same shape LocalShellTask emits.
 */
export function buildMcpTaskStoppedNotification(
  taskId: string,
  description: string,
  toolUseId?: string,
): string {
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const summary = `Task "${description}" was stopped by the user`
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${STATUS_TAG}>killed</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
}

/**
 * Task-registry entry for a backgrounded MCP tool call (CC 2.1.212).
 *
 * Registering this in getAllTasks() (src/tasks.ts) is what makes `mcp_task`
 * stoppable: stopTask() looks the type up via getTaskByType() and dispatches to
 * kill(). Before registration, stopTask() threw `Unsupported task type:
 * mcp_task` (StopTaskError code 'unsupported_type'), so a long-running MCP call
 * could not be stopped and the model never learned the outcome.
 *
 * kill() follows the DreamTask/LocalShellTask convention — abort + state
 * transition + notification all live here — so BOTH the stopTask() path (LLM /
 * SDK stop_task) and the BackgroundTasksDialog direct-kill path ('x') deliver
 * the tool result exactly once. The `notified` flag is the idempotency guard:
 * it prevents double-delivery and marks the row terminal+notified so the
 * framework's retention-windowed eviction (MCP_TASK_RETENTION_MS) can GC it.
 */
export const McpBackgroundTask: Task = {
  name: 'McpBackgroundTask',
  type: 'mcp_task',
  async kill(taskId, setAppState) {
    // Captured inside the atomic updater so the notification reflects the state
    // we actually transitioned (and is skipped entirely on a no-op kill).
    let stopped: { description: string; toolUseId?: string } | undefined
    updateTaskState<McpBackgroundTaskState>(taskId, setAppState, task => {
      // Idempotent: a second kill — or a kill after the call already settled —
      // is a no-op. Returning the same reference makes updateTaskState skip the
      // write (and leaves `stopped` undefined so no notification is enqueued).
      if (task.status !== 'running') return task
      // Abort the backgrounded call's OWN controller. autoBackground.ts creates
      // it via createChildAbortController(parent), so the tool keeps running
      // under this controller after the foreground turn ends; aborting it here
      // cancels the in-flight MCP request.
      task.abortController?.abort()
      stopped = { description: task.description, toolUseId: task.toolUseId }
      return {
        ...task,
        status: 'killed',
        endTime: Date.now(),
        notified: true,
        // Drop the runtime-only controller ref so it isn't retained on the
        // (soon-evicted) state object.
        abortController: undefined,
      }
    })
    if (stopped) {
      // priority 'next' matches the official SQn builder: the stop result is
      // delivered mid-turn (between the aborted tool result and the next API
      // round-trip) so Claude sees it promptly, not deferred to end-of-turn.
      enqueuePendingNotification({
        value: buildMcpTaskStoppedNotification(
          taskId,
          stopped.description,
          stopped.toolUseId,
        ),
        mode: 'task-notification',
        priority: 'next',
      })
    }
  },
}
