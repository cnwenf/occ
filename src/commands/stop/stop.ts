import type { LocalCommandCall } from '../../types/command.js'
import { stopTask } from '../../tasks/stopTask.js'
import { updateTaskState } from '../../utils/task/framework.js'
import {
  getWorker,
  settleWorker,
  readDaemonStatus,
} from '../../daemon/workerRegistry.js'
import { sigtermWorker, isPidAlive } from '../../daemon/process.js'
import { isTerminalTaskStatus } from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'

/**
 * /stop — stop a background agent/session by ID or pid.
 *
 * Looks up the target in three places, in order:
 *   1. appState.tasks (REPL background tasks — bash, agent, workflow, …)
 *   2. the in-process daemon worker registry (same process only)
 *   3. the persisted daemon-status snapshot (~/.claude/daemon-status.json),
 *      so a REPL process can stop a worker owned by the daemon supervisor
 *
 * With no argument, lists every running target and tells the user how to pick.
 */
export const call: LocalCommandCall = async (args, context) => {
  const { getAppState, setAppState } = context
  const id = args.trim()

  if (!id) {
    return { type: 'text', value: listTargets(getAppState().tasks ?? {}) }
  }

  // 1. REPL background task?
  const tasks = getAppState().tasks ?? {}
  const task = tasks[id]
  if (task && !isTerminalTaskStatus(task.status)) {
    try {
      const result = await stopTask(id, { getAppState, setAppState })
      // Ensure the task is marked 'killed' with an endTime (belt-and-suspenders
      // — kill implementations may set a different terminal status).
      updateTaskState<TaskState>(id, setAppState, t => ({
        ...t,
        status: 'killed',
        endTime: Date.now(),
      }))
      return {
        type: 'text',
        value: `Stopped ${result.taskType} task ${result.id}${
          result.command ? ` (${result.command})` : ''
        }.`,
      }
    } catch {
      // not_found / not_running / unsupported_type — fall through to daemon.
    }
  }

  // 2. Daemon worker (in-process registry)?
  const worker = getWorker(id)
  if (worker) {
    await settleWorker(id, 3000)
    return {
      type: 'text',
      value: `Stopped daemon worker ${id} (pid=${worker.pid}, kind=${worker.kind}).`,
    }
  }

  // 3. Daemon worker via persisted status snapshot (cross-process).
  const snap = readDaemonStatus().find(
    w => w.id === id || String(w.pid) === id,
  )
  if (snap && isPidAlive(snap.pid)) {
    sigtermWorker(snap.pid)
    return {
      type: 'text',
      value: `Sent SIGTERM to daemon worker ${snap.id} (pid=${snap.pid}, kind=${snap.kind}).`,
    }
  }

  // 4. Bare pid?
  const pid = Number(id)
  if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
    if (sigtermWorker(pid)) {
      return { type: 'text', value: `Sent SIGTERM to pid ${pid}.` }
    }
  }

  return {
    type: 'text',
    value: `No background task or daemon worker found for "${id}". Run /stop with no argument to list running targets.`,
  }
}

/** Build a text listing of every running REPL task + daemon worker. */
function listTargets(tasks: Record<string, TaskState>): string {
  const lines: string[] = []
  const running = Object.values(tasks).filter(
    t => !isTerminalTaskStatus(t.status),
  )
  const workers = readDaemonStatus().filter(
    w => w.outcome === 'running' && isPidAlive(w.pid),
  )

  if (running.length === 0 && workers.length === 0) {
    return 'No running background tasks or daemon workers.\nUsage: /stop <id|pid>'
  }

  lines.push('Running background tasks:')
  if (running.length > 0) {
    for (const t of running) {
      lines.push(`  ${t.id}  [${t.type}]  ${t.status}  ${t.description}`)
    }
  } else {
    lines.push('  (none)')
  }
  lines.push('')
  lines.push('Daemon workers:')
  if (workers.length > 0) {
    for (const w of workers) {
      lines.push(
        `  ${w.id}  pid=${w.pid}  kind=${w.kind}  started=${new Date(w.startedAt).toISOString()}`,
      )
    }
  } else {
    lines.push('  (none)')
  }
  lines.push('')
  lines.push('Usage: /stop <id|pid>')
  return lines.join('\n')
}
