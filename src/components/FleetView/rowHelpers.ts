/**
 * FleetView row helpers — pure functions used to build and decorate the
 * inline agent/workflow row list that renders below the input box.
 *
 * Phase 1 (local-only): the data source is `appState.tasks` (in-process
 * background agents + workflows). There is no daemon/heartbeat/host
 * abstraction here — that lands in Phase 2. These helpers stay leaf-safe
 * (no Ink/JSX) so they can be unit-tested and reused by both the inline
 * panel and a future standalone hub mount.
 */

import type { BackgroundTaskState, TaskState } from '../../tasks/types.js'
import type { TaskStatus } from '../../Task.js'
import type { Theme } from '../../utils/theme.js'
import { isBackgroundTask } from '../../tasks/types.js'
import { isTerminalTaskStatus } from '../../Task.js'

/**
 * Fleet rows split into the two groups the official `buildFleetRows`
 * produces: live (running/pending) jobs and folded completed jobs.
 * Completed jobs are retained briefly so the user can see what just
 * finished (the "N done" expander folds them).
 */
export type FleetRows = {
  running: BackgroundTaskState[]
  done: BackgroundTaskState[]
}

/**
 * Build the row list from the unified task registry. Mirrors the official
 * `buildFleetRows` shape: live jobs first (sorted by start time so the
 * oldest-running stays at the top), then recently-completed jobs folded
 * below. A job is "recently completed" if it terminated within the fold
 * window (default 60s) — older terminal tasks are evicted by the task
 * registry itself and never reach here.
 */
export function buildFleetRows(
  tasks: { [id: string]: TaskState },
  now: number = Date.now(),
  foldWindowMs: number = 60_000,
): FleetRows {
  const all = Object.values(tasks)
  const running: BackgroundTaskState[] = []
  const done: BackgroundTaskState[] = []
  for (const t of all) {
    if (isBackgroundTask(t)) {
      running.push(t)
      continue
    }
    // Terminal task: keep only if it ended within the fold window so the
    // "N done" summary stays relevant (and doesn't grow unbounded).
    if (isTerminalTaskStatus(t.status) && t.endTime && now - t.endTime <= foldWindowMs) {
      done.push(t as BackgroundTaskState)
    }
  }
  running.sort((a, b) => a.startTime - b.startTime)
  done.sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0))
  return { running, done }
}

/**
 * A short, stable status key for a job. Used as the row's color/glyph
 * selector and as the a11y label root (mirrors `jobStatusKey`).
 */
export function jobStatusKey(task: BackgroundTaskState): TaskStatus {
  return task.status
}

/**
 * Display label for a row — the bold noun shown at the start of the row.
 * Mirrors the official `jobLabel`: the agent type for agents, the workflow
 * name for workflows, the title for remote sessions, the command for
 * shells, the agent name for teammates.
 */
export function jobLabel(task: BackgroundTaskState): string {
  switch (task.type) {
    case 'local_agent':
      return task.agentType
    case 'local_workflow':
      return task.workflowName ?? task.summary ?? task.description ?? 'workflow'
    case 'remote_agent':
      return task.title ?? task.description
    case 'in_process_teammate':
      return `@${task.identity.agentName}`
    case 'local_bash':
      return task.kind === 'monitor' ? task.description : task.command
    case 'monitor_mcp':
      return task.description
    case 'dream':
      return task.description
  }
}

/**
 * Secondary descriptor shown after the label (the " (description)" part).
 * For agents this is the prompt/Description; for workflows the summary;
 * for shells the description; for teammates the activity summary.
 */
export function jobDescription(task: BackgroundTaskState): string | undefined {
  switch (task.type) {
    case 'local_agent':
      return task.description
    case 'local_workflow':
      return task.summary ?? task.description
    case 'remote_agent':
      return task.description
    case 'in_process_teammate':
      return undefined
    case 'local_bash':
      return task.kind === 'monitor' ? undefined : task.description
    case 'monitor_mcp':
      return undefined
    case 'dream':
      return undefined
  }
}

/**
 * Theme key for the row's status glyph. Mirrors `glyphColor`: green for
 * running, amber for pending, red for failed, dim for killed/done.
 */
export function glyphColor(status: TaskStatus): keyof Theme {
  switch (status) {
    case 'running':
      return 'success'
    case 'pending':
      return 'warning'
    case 'failed':
      return 'error'
    case 'killed':
      return 'inactive'
    case 'completed':
      return 'inactive'
  }
}

/**
 * Human-readable age for a job: "12s", "1m", "2h". Used in the row's
 * trailing metadata. Mirrors `formatJobAge`.
 */
export function formatJobAge(startTime: number, endTime?: number, now: number = Date.now()): string {
  const end = endTime ?? now
  const ms = Math.max(0, end - startTime)
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/**
 * The actionable status string for a row — what the agent is doing right
 * now, or "Done"/"Failed". Mirrors `actionableStatus`. For agents this
 * comes from the progress tracker's last activity; for workflows the
 * current phase; for shells the live status; for teammates the activity
 * summary.
 */
export function actionableStatus(task: BackgroundTaskState): string {
  switch (task.type) {
    case 'local_agent': {
      const last = task.progress?.lastActivity
      if (typeof last?.activityDescription === 'string' && last.activityDescription) {
        return last.activityDescription
      }
      if (typeof last?.toolName === 'string' && last.toolName) {
        return last.toolName
      }
      return task.status === 'pending' ? 'Queued…' : 'Initializing…'
    }
    case 'local_workflow': {
      const phase = task.workflowProgress?.find(p => p.status === 'running')?.phase
      if (phase) return `Phase: ${phase}`
      if (task.status === 'pending') return 'Queued…'
      if (task.status === 'completed') return 'Done'
      return 'Running workflow…'
    }
    case 'remote_agent':
      return task.status === 'pending' ? 'Connecting…' : task.status === 'completed' ? 'Done' : 'Running remotely…'
    case 'in_process_teammate':
      return task.status === 'pending' ? 'Starting…' : 'Working…'
    case 'local_bash':
      return task.status === 'pending' ? 'Queued…' : task.status === 'completed' ? 'Done' : 'Running…'
    case 'monitor_mcp':
      return task.status === 'pending' ? 'Connecting…' : 'Monitoring…'
    case 'dream':
      return task.phase === 'updating' ? 'Updating…' : 'Reviewing…'
  }
}

/**
 * Vertical budget for the fleet panel: how many rows (including the title
 * and any fold expander) to render inline. Mirrors `fleetVerticalBudget`:
 * cap at roughly half the terminal so the input box stays usable, with a
 * sane floor and ceiling.
 */
export function fleetVerticalBudget(terminalRows: number): number {
  // Floor 4 (title + 1 row + status + fold), ceiling 12.
  const half = Math.floor(terminalRows / 2)
  return Math.max(4, Math.min(12, half))
}

/**
 * The fleet panel title. Mirrors `fleetTitle`: "Agents" + live count,
 * plus a folded-done tail when completed jobs exist.
 */
export function fleetTitle(running: number, done: number): string {
  if (running > 0 && done > 0) return `Agents · ${running} live · ${done} done`
  if (running > 0) return `Agents · ${running} live`
  if (done > 0) return `Agents · ${done} done`
  return 'Agents'
}

/**
 * Phase-1 gate stub. The official binary gates FleetView behind a
 * GrowthBook flag (`isAgentsFleetEnabled`); OCC stubs GrowthBook to true,
 * so the gate is always open locally. Phase 2 can wire a real gate.
 */
export function isAgentsFleetEnabled(): boolean {
  return true
}

/**
 * Suggestions shown in the empty state. Mirrors
 * `fleet_agent_suggestions` — a small set of built-in agent prompts the
 * user can dispatch to populate the fleet. Phase 1 ships three.
 */
export type FleetSuggestion = {
  label: string
  prompt: string
}

export function fleetAgentSuggestions(): FleetSuggestion[] {
  return [
    {
      label: 'Researcher',
      prompt:
        'Use the Agent tool to spawn a researcher that lists files under src/ for 20s, backgrounded.',
    },
    {
      label: 'Reviewer',
      prompt:
        'Use the Agent tool to spawn a reviewer that audits the recent diff, backgrounded.',
    },
    {
      label: 'Workflow',
      prompt:
        'Run a workflow that fans out 2 agents to summarize the README and CLAUDE.md.',
    },
  ]
}
