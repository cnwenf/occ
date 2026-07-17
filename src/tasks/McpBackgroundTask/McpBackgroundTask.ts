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
import type { TaskStateBase, SetAppState } from '../../Task.js'
import { registerTask } from '../../utils/task/framework.js'
import { generateTaskId } from '../../Task.js'

/**
 * Status of a backgrounded MCP tool call. Mirrors the binary's `mcpStatus`:
 *   - "working" while the tool is still running.
 *   - "completed" / "failed" when the tool settles (set by the completion
 *     handler that observes the backgrounded run promise).
 */
export type McpTaskStatus = 'working' | 'completed' | 'failed'

export type McpBackgroundTaskState = TaskStateBase & {
  type: 'mcp_task'
  status: 'running'
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
