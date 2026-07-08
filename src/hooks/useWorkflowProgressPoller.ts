/**
 * useWorkflowProgressPoller — main-thread poller for daemon-worker-launched
 * (remote) workflows.
 *
 * When a workflow is launched with `remote: true`, WorkflowTool.call() spawns
 * a separate daemon-worker process (kind 'workflow') that runs runWorkflow
 * with a non-interactive toolUseContext. The worker CANNOT mutate the main
 * OCC's AppState (that would require a shared store reachable from a
 * background promise, crashing the Ink renderer via cross-root flushSync).
 * Instead, the worker writes progress snapshots to
 * ~/.claude/wf-progress/<runId>.json (see workflowWorker.ts).
 *
 * This hook runs on the MAIN THREAD (mounted in REPL.tsx) and polls those
 * files for running local_workflow tasks, updating AppState from the main
 * thread — safe (no background setAppState, no Ink crash). This is how
 * /workflows sees RUNNING workflows launched in the background worker.
 *
 * Terminal snapshots (workflow_completed/failed/aborted) move the task to a
 * terminal status via completeWorkflowTask/failWorkflowTask and delete the
 * progress file so stale files don't accumulate.
 */
import { useEffect, useRef } from 'react'
import { useSetAppState, useAppStateStore } from '../state/AppState.js'
import {
  readWorkflowProgress,
  deleteWorkflowProgress,
} from '../utils/wfProgress.js'
import {
  isLocalWorkflowTask,
  updateWorkflowProgressBatch,
  completeWorkflowTask,
  failWorkflowTask,
  type LocalWorkflowTaskState,
  type WorkflowPhaseProgress,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/** How often the poller reads wf-progress files for active runs. */
const POLL_INTERVAL_MS = 1500

export function useWorkflowProgressPoller(): void {
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  // Track the last `updatedAt` we applied per runId, so we only write AppState
  // when the file actually changed (avoids redundant re-renders).
  const lastSeenRef = useRef<Map<string, number>>(new Map())

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
          const result = snap.result
          completeWorkflowTask(taskId, setAppState, result)
          deleteWorkflowProgress(runId)
          lastSeenRef.current.delete(runId)
        } else if (type === 'workflow_failed' || type === 'workflow_aborted') {
          const error =
            (snap.error as string) ??
            (type === 'workflow_aborted' ? 'workflow aborted' : 'workflow failed')
          failWorkflowTask(taskId, error, setAppState)
          deleteWorkflowProgress(runId)
          lastSeenRef.current.delete(runId)
        }
      }
      }, 0)
    }

    const timer = setInterval(tick, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [setAppState, store])
}
