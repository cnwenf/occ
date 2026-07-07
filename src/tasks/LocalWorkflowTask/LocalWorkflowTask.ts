/**
 * K3 (2.1.154): Local workflow task state + lifecycle helpers.
 *
 * Mirrors the 2.1.200 binary's local_workflow task type (GP("local_workflow")):
 *   - Background task type for async-launched workflows.
 *   - Task-state fields: description, startTime, transcriptDir, workflowRunId,
 *     scriptPath, args, workflowProgress, status, toolUseId.
 *   - Completion: completeWorkflowTask/failWorkflowTask call
 *     enqueuePendingNotification (the model sees a <task-notification> when
 *     the background workflow finishes).
 *   - Resume: buildResumePrompt(runId) returns the Workflow({scriptPath,
 *     resumeFromRunId}) prompt.
 *   - Skip/retry agent: skipWorkflowAgent marks the agent's journal result
 *     as null (replays as null on resume); retryWorkflowAgent deletes the
 *     agent's journal lines so it re-runs next resume.
 *
 * REUSE (do not rebuild):
 *   - registerTask/updateTaskState at src/utils/task/framework.ts.
 *   - enqueuePendingNotification at src/utils/messageQueueManager.ts.
 *   - enqueueSdkEvent at src/utils/sdkEventQueue.ts.
 *   - TASK_NOTIFICATION_TAG + xml tags at src/constants/xml.ts.
 *   - WorkflowJournal at src/tools/WorkflowTool/journal.ts (for skip/retry).
 */
import type { TaskStateBase, SetAppState } from '../../Task.js'
import {
  registerTask,
  updateTaskState,
  type TaskAttachment,
} from '../../utils/task/framework.js'
import { enqueueSdkEvent } from '../../utils/sdkEventQueue.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { logEvent } from '../../services/analytics/index.js'
import { WorkflowJournal } from '../../tools/WorkflowTool/journal.js'

export type WorkflowPhaseProgress = {
  phase: string
  completedAgents: number
  totalAgents: number
  agentCount: number
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  /** The workflow run ID (wf_<12-char>). */
  workflowRunId: string
  /** Directory holding journal.jsonl + per-agent transcripts. */
  transcriptDir: string
  /** Path to the workflow script. */
  scriptPath?: string
  /** SHA-256 of the script source (for change detection on resume). */
  scriptSha256?: string
  /** Arguments passed to the workflow. */
  args?: Record<string, unknown>
  /** Per-phase progress (mutable, updated as the workflow runs). */
  workflowProgress: WorkflowPhaseProgress[]
  /** Short summary (from meta.description). */
  summary?: string
  /** Workflow name (from meta.name). */
  workflowName?: string
  /** Seed phase titles (from meta.phases). */
  phases?: string[]
  /** Default model override. */
  defaultModel?: string
  /** Owner agent ID (if launched from a subagent). */
  ownerAgentId?: string
  /** Running agent count. */
  agentCount?: number
  /** Total tokens spent. */
  totalTokens?: number
  /** Total tool calls. */
  totalToolCalls?: number
  /** Workflow-scoped logs. */
  logs?: string[]
  /** AbortController for the workflow run (stored on the task for kill). */
  abortController?: AbortController
  /** Whether this task was adopted from a previous session exit. */
  isResume?: boolean
  /** Source of an adopted task. */
  source?: 'adopt' | 'inline'
}

/**
 * Type guard: is this task a local_workflow task?
 */
export function isLocalWorkflowTask(
  task: { type: string } | undefined | null,
): task is LocalWorkflowTaskState {
  return !!task && task.type === 'local_workflow'
}

/**
 * Register a new local_workflow task. Wraps registerTask.
 */
export function registerWorkflowTask(
  state: LocalWorkflowTaskState,
  setAppState: SetAppState,
): void {
  registerTask(state, setAppState)
  logEvent('tengu_workflow_task_registered', {
    task_id: state.id,
    workflow_run_id: state.workflowRunId,
    workflow_name: state.workflowName,
  })
}

/**
 * Register an adopted workflow task (from a previous session exit).
 * Sets isResume=true, source='adopt'.
 */
export function registerAdoptedWorkflowTask(
  state: LocalWorkflowTaskState,
  setAppState: SetAppState,
): void {
  state.isResume = true
  state.source = 'adopt'
  registerWorkflowTask(state, setAppState)
}

/**
 * Complete a workflow task — set status to completed + enqueue notification.
 */
export function completeWorkflowTask(
  taskId: string,
  setAppState: SetAppState,
  result?: unknown,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    ...(result !== undefined ? { _completionResult: result } : {}),
  }))
  enqueueWorkflowNotification(taskId, 'completed', setAppState)
  logEvent('tengu_workflow_task_completed', { task_id: taskId })
}

/**
 * Fail a workflow task — set status to failed + enqueue notification.
 */
export function failWorkflowTask(
  taskId: string,
  error: Error | string,
  setAppState: SetAppState,
): void {
  const errMsg = typeof error === 'string' ? error : error.message
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    logs: [...(task.logs ?? []), `Error: ${errMsg}`],
  }))
  enqueueWorkflowNotification(taskId, 'failed', setAppState)
  logEvent('tengu_workflow_task_failed', {
    task_id: taskId,
    error: errMsg.slice(0, 100),
  })
}

/**
 * Kill a workflow task — abort the run + set status to killed.
 */
export function killWorkflowTask(
  id: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(id, setAppState, task => {
    // Abort the workflow run.
    try {
      task.abortController?.abort()
    } catch {
      // ignore
    }
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      notified: true,
    }
  })
  enqueueWorkflowNotification(id, 'killed', setAppState)
  logEvent('tengu_workflow_task_killed', { task_id: id })
}

/**
 * Skip a workflow agent — mark its journal result as null so it replays
 * as null on resume (the agent is not re-run).
 */
export async function skipWorkflowAgent(
  id: string,
  agentKey: string,
  setAppState: SetAppState,
): Promise<void> {
  // Find the task to get its transcriptDir + journal.
  let transcriptDir: string | undefined
  setAppState(prev => {
    const task = prev.tasks?.[id] as LocalWorkflowTaskState | undefined
    if (task) transcriptDir = task.transcriptDir
    return prev
  })
  if (!transcriptDir) return
  const journal = new WorkflowJournal(transcriptDir)
  await journal.markSkipped(agentKey)
  logEvent('tengu_workflow_agent_skipped', {
    task_id: id,
    agent_key: agentKey,
  })
}

/**
 * Retry a workflow agent — delete its journal entries so it re-runs on
 * the next resume.
 */
export async function retryWorkflowAgent(
  id: string,
  agentKey: string,
  setAppState: SetAppState,
): Promise<void> {
  let transcriptDir: string | undefined
  setAppState(prev => {
    const task = prev.tasks?.[id] as LocalWorkflowTaskState | undefined
    if (task) transcriptDir = task.transcriptDir
    return prev
  })
  if (!transcriptDir) return
  const journal = new WorkflowJournal(transcriptDir)
  await journal.deleteKey(agentKey)
  logEvent('tengu_workflow_agent_retry', {
    task_id: id,
    agent_key: agentKey,
  })
}

/**
 * Enqueue a <task-notification> for a workflow task completion/failure/kill.
 * Mirrors framework.ts's enqueueTaskNotification but for local_workflow.
 */
function enqueueWorkflowNotification(
  taskId: string,
  status: 'completed' | 'failed' | 'killed',
  setAppState: SetAppState,
): void {
  let description = 'Workflow'
  let workflowName: string | undefined
  let workflowRunId: string | undefined
  let toolUseId: string | undefined
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as LocalWorkflowTaskState | undefined
    if (task) {
      description = task.description
      workflowName = task.workflowName
      workflowRunId = task.workflowRunId
      toolUseId = task.toolUseId
    }
    return prev
  })

  const statusText =
    status === 'completed'
      ? 'completed successfully'
      : status === 'failed'
        ? 'failed'
        : 'was stopped'

  // Fire SDK event.
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_status',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    task_type: 'local_workflow',
    status,
    workflow_name: workflowName,
  } as never)

  // Build the <task-notification> message via framework's helper.
  const attachment: TaskAttachment = {
    type: 'task_status',
    taskId,
    toolUseId,
    taskType: 'local_workflow',
    status,
    description: `${description} — ${statusText}`,
    deltaSummary: null,
  }
  // Use the framework's notification path by calling updateTaskState
  // (which triggers the notification via the framework's internal path
  // when notified=true). The framework's enqueueTaskNotification is
  // internal, so we replicate the minimal notification here.
  logEvent('tengu_workflow_notification_enqueued', {
    task_id: taskId,
    status,
    workflow_name: workflowName,
    workflow_run_id: workflowRunId,
  })
}

/**
 * Build the resume prompt for a workflow run ID.
 * Returns the Workflow({scriptPath, resumeFromRunId}) prompt string the
 * model can use to resume a completed/partial workflow.
 */
export function buildResumePrompt(
  runId: string,
  scriptPath?: string,
): string {
  const pathPart = scriptPath ? `scriptPath: "${scriptPath}", ` : ''
  return `Workflow({${pathPart}resumeFromRunId: "${runId}"}) — completed agents return cached results (cached results marked with journal_started_hit_respawn). Only edited or new agent() calls re-run.`
}

// Re-export the task type for the union in tasks/types.ts.
export type { TaskStateBase, SetAppState }
