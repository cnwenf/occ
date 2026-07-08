/**
 * useWorkflowProgressPoller — main-thread poller for async-launched workflows.
 *
 * When a workflow is launched with `remote: true`, WorkflowTool.call() runs
 * runWorkflow in a background promise with a NO-OP setAppState (no Ink
 * renderer reachable — prevents cross-root flushSync crash). The background
 * promise CANNOT mutate the main OCC's AppState directly. Instead, it writes
 * progress snapshots to ~/.claude/wf-progress/<runId>.json (see
 * WorkflowTool.ts + wfProgress.ts).
 *
 * This hook runs on the MAIN THREAD (mounted in REPL.tsx) and polls those
 * files for running local_workflow tasks, updating AppState from the main
 * thread — safe (no background setAppState, no Ink crash). This is how
 * /workflows sees RUNNING workflows launched in the background.
 *
 * Terminal snapshots (workflow_completed/failed/aborted) move the task to a
 * terminal status via completeWorkflowTask/failWorkflowTask and delete the
 * progress file so stale files don't accumulate.
 *
 * Subagent-level records (<runId>.sub.<subagentId>.json) are also polled:
 * subagent_spawn creates a local_agent task (fleet visibility), subagent_done
 * moves it to a terminal status. These are cleaned up when the parent
 * workflow reaches a terminal state.
 */
import { useEffect, useRef } from 'react'
import { useSetAppState, useAppStateStore } from '../state/AppState.js'
import {
  readWorkflowProgress,
  deleteWorkflowProgress,
  listSubagentProgress,
  deleteSubagentProgress,
} from '../utils/wfProgress.js'
import {
  isLocalWorkflowTask,
  updateWorkflowProgressBatch,
  completeWorkflowTask,
  failWorkflowTask,
  type LocalWorkflowTaskState,
  type WorkflowPhaseProgress,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { isLocalAgentTask } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from '../state/AppState.js'

/** How often the poller reads wf-progress files for active runs. */
const POLL_INTERVAL_MS = 1500

export function useWorkflowProgressPoller(): void {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  // Track the last `updatedAt` we applied per runId, so we only write AppState
  // when the file actually changed (avoids redundant re-renders).
  const lastSeenRef = useRef<Map<string, number>>(new Map())
  // Track subagent snapshots we've applied (by subagent file key) to avoid
  // re-processing the same record.
  const lastSubSeenRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    const tick = (): void => {
      const tasks = store.getState().tasks ?? {}
      const running = Object.values(tasks).filter(
        (t): t is LocalWorkflowTaskState =>
          isLocalWorkflowTask(t) &&
          (t.status === 'running' || t.status === 'pending') &&
          !!t.workflowRunId,
      )
      if (running.length === 0) return

      // Defer the state updates to the next tick. The poller runs in a
      // setInterval (not a React event handler), so a synchronous setAppState
      // here can fire DURING an in-flight render (e.g. the /workflows dialog) +
      // trigger the Ink renderer's cross-root flushSyncWork crash. setTimeout(0)
      // lets the current render commit first; the update then batches cleanly.
      setTimeout(() => {
        for (const task of running) {
          const runId = task.workflowRunId
          const snap = readWorkflowProgress(runId)
          if (!snap) continue

          // Skip if we already applied this exact snapshot.
          const last = lastSeenRef.current.get(runId) ?? 0
          if (snap.updatedAt <= last) continue
          lastSeenRef.current.set(runId, snap.updatedAt)

          const type = (snap.type as string) ?? ''
          const taskId = task.id

          if (type === 'workflow_progress') {
            const phases = (snap.phases as WorkflowPhaseProgress[]) ?? []
            const narratorLines = (snap.narratorLines as string[]) ?? []
            updateWorkflowProgressBatch(taskId, phases, narratorLines, setAppState)
          } else if (type === 'workflow_completed') {
            // Check current status to avoid double-completion (the in-process
            // background path calls completeWorkflowTask via setTimeout(0) on
            // the main thread's setAppState; the poller may race with it).
            const currentTask = store.getState().tasks?.[taskId]
            if (currentTask && currentTask.status !== 'running' && currentTask.status !== 'pending') {
              // Already terminal — just clean up files.
              deleteWorkflowProgress(runId)
              deleteSubagentProgress(runId)
              lastSeenRef.current.delete(runId)
              continue
            }
            const result = snap.result
            completeWorkflowTask(taskId, setAppState, result)
            deleteWorkflowProgress(runId)
            deleteSubagentProgress(runId)
            lastSeenRef.current.delete(runId)
          } else if (type === 'workflow_failed' || type === 'workflow_aborted') {
            // Same double-completion guard as above.
            const currentTask = store.getState().tasks?.[taskId]
            if (currentTask && currentTask.status !== 'running' && currentTask.status !== 'pending') {
              deleteWorkflowProgress(runId)
              deleteSubagentProgress(runId)
              lastSeenRef.current.delete(runId)
              continue
            }
            const error =
              (snap.error as string) ??
              (type === 'workflow_aborted' ? 'workflow aborted' : 'workflow failed')
            failWorkflowTask(taskId, error, setAppState)
            deleteWorkflowProgress(runId)
            deleteSubagentProgress(runId)
            lastSeenRef.current.delete(runId)
          }
        }

        // Process subagent-level records for all running workflows.
        // These create/update local_agent tasks for fleet visibility.
        const currentTasks = store.getState().tasks ?? {}
        const stillRunning = Object.values(currentTasks).filter(
          (t): t is LocalWorkflowTaskState =>
            isLocalWorkflowTask(t) &&
            (t.status === 'running' || t.status === 'pending') &&
            !!t.workflowRunId,
        )
        for (const task of stillRunning) {
          const runId = task.workflowRunId
          const subSnaps = listSubagentProgress(runId)
          for (const subSnap of subSnaps) {
            const subKey = subSnap.runId // e.g. "wf_xxx.sub.agentId"
            const lastSub = lastSubSeenRef.current.get(subKey) ?? 0
            if (subSnap.updatedAt <= lastSub) continue
            lastSubSeenRef.current.set(subKey, subSnap.updatedAt)

            const subType = (subSnap.type as string) ?? ''
            const subagentId = subSnap.subagentId as string
            if (!subagentId) continue
            const subagentTaskId = `wf_sub_${runId}_${subagentId}`

            if (subType === 'subagent_spawn') {
              const agentType =
                (subSnap.agentType as string) ??
                (subSnap.name as string) ??
                'workflow-agent'
              const startedAt = (subSnap.startedAt as number) ?? Date.now()
              setAppState((prev: AppState) => {
                // Don't overwrite an existing task (e.g. already completed).
                if (prev.tasks?.[subagentTaskId]) return prev
                const subagentTask = {
                  id: subagentTaskId,
                  type: 'local_agent' as const,
                  status: 'running' as const,
                  description: `Workflow agent: ${subSnap.name ?? subagentId}`,
                  agentId: subagentId,
                  prompt: '',
                  agentType,
                  startTime: startedAt,
                  outputFile: '',
                  outputOffset: 0,
                  notified: false,
                  retrieved: false,
                  lastReportedToolCount: 0,
                  lastReportedTokenCount: 0,
                  isBackgrounded: true,
                  pendingMessages: [] as string[],
                  retain: false,
                  diskLoaded: false,
                  workflowRunId: runId,
                }
                return {
                  ...prev,
                  tasks: {
                    ...prev.tasks,
                    [subagentTaskId]: subagentTask,
                  },
                }
              })
            } else if (subType === 'subagent_done') {
              const status = subSnap.status === 'done' ? 'completed' : 'failed'
              setAppState((prev: AppState) => {
                const existing = prev.tasks?.[subagentTaskId]
                if (!existing || !isLocalAgentTask(existing)) return prev
                if (existing.status !== 'running') return prev
                return {
                  ...prev,
                  tasks: {
                    ...prev.tasks,
                    [subagentTaskId]: {
                      ...existing,
                      status,
                      endTime: Date.now(),
                    },
                  },
                }
              })
            }
          }
        }
      }, 0)
    }

    const timer = setInterval(tick, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [setAppState, store])
}
