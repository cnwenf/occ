// Pure (non-React) kill helpers for LocalShellTask.
// Extracted so runAgent.ts can kill agent-scoped bash tasks without pulling
// React/Ink into its module graph (same rationale as guards.ts).

import treeKill from 'tree-kill'
import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import type { ShellStopCause } from './backgroundDeadline.js'
import { isLocalShellTask } from './guards.js'

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

/**
 * 2.1.285 #85: `stopCause` persists WHY the task was stopped out-of-band
 * (official `prn(e,n)` carries the cause into the task snapshot). Only the
 * background-deadline reap passes it today; plain kills stay undefined and
 * render the bare "was stopped" summary.
 */
export function killTask(
  taskId: string,
  setAppState: SetAppStateFn,
  stopCause?: ShellStopCause,
): void {
  updateTaskState(taskId, setAppState, task => {
    if ((task as any).status !== 'running' || !isLocalShellTask(task)) {
      return task
    }

    try {
      logForDebugging(`LocalShellTask ${taskId} kill requested`)
      if (task.shellCommand) {
        task.shellCommand.kill()
        task.shellCommand.cleanup()
      } else if (task.pid) {
        // CC 2.1.217 #12: shellCommand is null (reference lost after
        // backgrounding or reload) but we have the PID — use treeKill
        // directly so the shell process is actually stopped.
        logForDebugging(`LocalShellTask ${taskId} shellCommand null, killing by PID ${task.pid}`)
        treeKill(task.pid, 'SIGKILL')
      }
    } catch (error) {
      logError(error)
    }

    task.unregisterCleanup?.()
    if (task.cleanupTimeoutId) {
      clearTimeout(task.cleanupTimeoutId)
    }

    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      unregisterCleanup: undefined,
      cleanupTimeoutId: undefined,
      endTime: Date.now(),
      ...(stopCause !== undefined ? { stopCause } : {}),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * Kill all running bash tasks spawned by a given agent.
 * Called from runAgent.ts finally block so background processes don't outlive
 * the agent that started them (prevents 10-day fake-logs.sh zombies).
 */
export function killShellTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isLocalShellTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killShellTasksForAgent: killing orphaned shell task ${taskId} (agent ${agentId} exiting)`,
      )
      killTask(taskId, setAppState)
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them. killTask fires 'killed' notifications
  // asynchronously; drop the ones already queued and any that land later sit
  // harmlessly (no consumer matches a dead agentId).
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}
