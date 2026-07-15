/**
 * K3 (2.1.154): Interactive browser for running/completed dynamic-workflow
 * runs. Opened by the `/workflows` command.
 *
 * Mirrors the 2.1.200 binary's `WorkflowDetailDialog` (strings line 472934;
 * component id `workflow-detail-dialog`, line 542375). The binary component
 * has two view modes — `list` (browse runs grouped by launch type) and
 * `detail` (a selected run's phases/agents/running/queued state) — toggled
 * by selecting a run (Enter) and returning (Esc). This file ports both modes
 * into one self-contained component, reading live state from the
 * AppState task registry (`appState.tasks` filtered to `local_workflow`).
 *
 * Binary render (verbatim strings):
 *   title:           "Dynamic workflows"                       (549185)
 *   subtitle counts: "N running", "M completed"                (549186-87)
 *   launch groups:   "1 background dynamic workflow" /
 *                    "N background dynamic workflows"          (507935-36)
 *                    "1 remote dynamic workflow" /
 *                    "N remote dynamic workflows"              (507931-32)
 *   empty state:     "No dynamic workflows in this session."   (549197)
 *   scroll indicator:" more above" / " more below"             (549198-99)
 *   dismissed event: "Dynamic workflows dialog dismissed"      (549211)
 *   detail id:       "workflow-detail-dialog"                  (542375)
 *   detail sections: "agents" / "phases" / "running" /
 *                    "loading" / "queued"                      (542376-82)
 *   detail empty:    "No agents yet."                          (542390)
 *   detail keys:     j/k scroll · select · x stop · r restart ·
 *                    p pause/resume · f filter · esc back ·
 *                    s save                                   (542386-96)
 *   save action:     "Save dynamic workflow"                   (542133)
 *                    "Dynamic workflow saved to <path>.
 *                     Invoke as /<name> or Workflow({name: …})"
 *                                                             (542138-42)
 *
 * 2.1.208 #25: the save dialog's user-scope path + display now honor
 * `CLAUDE_CONFIG_DIR` (via getClaudeConfigHomeDir), not a hardcoded
 * `~/.claude/workflows/`. Path math lives in
 * `src/utils/effort/workflowSavePath.ts` (mirrors the binary's `zab` /
 * `tkt` / `BP`). The dialog (WorkflowSaveDialog) toggles scope with Tab
 * and shows `{Scope} scope · {displayPath}` in the subtitle.
 *
 * Auto-refresh: the component subscribes to AppState via useAppState, so
 * the list and detail re-render live as the engine mutates task state
 * (workflowProgress / agentCount / status) — the "watch live progress"
 * destination (binary line 711471).
 *
 * NOTE on per-agent data: OCC's LocalWorkflowTaskState carries AGGREGATE
 * phase progress (WorkflowPhaseProgress = {phase, completedAgents,
 * totalAgents, agentCount}) plus aggregate agentCount/totalTokens. The
 * binary's per-agent rows (g9n() accumulator) require a WorkflowAgentStat
 * extension that is a separate gap (engine agent's file). This component
 * renders the aggregate data faithfully and shows "No agents yet." when
 * agentCount is 0/undefined — it will surface per-agent rows once the
 * task-state type is extended, without structural changes here.
 */
import * as React from 'react'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import figures from 'figures'
import { logEvent } from '../services/analytics/index.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { CommandResultDisplay } from '../commands.js'
import {
  isLocalWorkflowTask,
  killWorkflowTask,
  type LocalWorkflowTaskState,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { TaskState } from '../tasks/types.js'
import { formatDuration, formatNumber } from '../utils/format.js'
import { truncate } from '../utils/truncate.js'
import { renderModelName } from '../utils/model/model.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../ink.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { Select } from './CustomSelect/select.js'
import {
  displayWorkflowPath,
  resolveWorkflowFilePath,
  resolveWorkflowsDir,
  type WorkflowSaveScope,
} from '../utils/effort/workflowSavePath.js'

/** Project workflows dir lives in `workflowSavePath.ts` / `workflowDiscovery.ts`. */

type ViewState =
  | { mode: 'list' }
  | { mode: 'detail'; taskId: string }
  | { mode: 'save'; taskId: string }

type Props = {
  /** Called when the dialog is dismissed (Esc on the list). */
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  /** Optional: open directly to a specific run's detail view. */
  initialTaskId?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

type LaunchType = 'background' | 'remote'

/**
 * Determine a run's launch type. A task's presence in the background task
 * registry means it was background-launched (inline runs never register a
 * task). Remote is hard-denied in this build, so no run is ever 'remote' —
 * but the grouping is kept faithful to the binary for when remote lands.
 */
function launchTypeOf(_task: LocalWorkflowTaskState): LaunchType {
  // No remote-launch field exists on the task state; remote is denied in
  // checkPermissions. All registered local_workflow tasks are background.
  return 'background'
}

function statusColor(
  status: LocalWorkflowTaskState['status'],
): 'success' | 'error' | 'warning' | 'subtle' | 'permission' {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
    case 'killed':
      return 'error'
    case 'running':
      return 'permission'
    case 'pending':
      return 'warning'
    default:
      return 'subtle'
  }
}

function durationOf(task: LocalWorkflowTaskState): number {
  const end = task.endTime ?? Date.now()
  return Math.max(0, end - task.startTime)
}

/**
 * Sanitize a workflow name into a safe filename stem. Mirrors the binary's
 * `wme(name)`: replace non [A-Za-z0-9._-] with `-`, trim leading/trailing
 * dashes, fall back to "workflow" when empty.
 */
function sanitizeWorkflowName(raw: string | undefined): string {
  return (
    (raw ?? 'workflow')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  )
}

/**
 * Persist a one-off workflow script so it can be re-invoked by name.
 * Scope-aware (2.1.208 #25): user scope writes under the effective config
 * dir (`CLAUDE_CONFIG_DIR`/workflows) via `resolveWorkflowsDir`; project
 * scope writes under `<cwd>/.claude/workflows`. Returns a user-visible
 * result. `overwrite` arms a second Enter to clobber an existing file
 * (binary's EEXIST → "Press Enter again to overwrite" flow).
 */
type SaveOutcome =
  | { ok: true; msg: string; overwritten: boolean }
  | { ok: false; msg: string; exists: boolean }

function saveDynamicWorkflow(
  task: LocalWorkflowTaskState,
  scope: WorkflowSaveScope,
  overwrite: boolean,
): SaveOutcome {
  const name = sanitizeWorkflowName(task.workflowName)
  const targetDir = resolveWorkflowsDir(scope, process.cwd())
  const targetPath = resolveWorkflowFilePath(scope, name, process.cwd())
  if (!task.scriptPath || !existsSync(task.scriptPath)) {
    return {
      ok: false,
      msg: 'Script source is not available; cannot save this workflow.',
      exists: false,
    }
  }
  let source: string
  try {
    source = readFileSync(task.scriptPath, 'utf8')
  } catch {
    return {
      ok: false,
      msg: `Could not read script at ${task.scriptPath}.`,
      exists: false,
    }
  }
  const fileExists = existsSync(targetPath)
  if (fileExists && !overwrite) {
    return {
      ok: false,
      exists: true,
      msg: `Workflow "${name}" already exists at ${targetPath}. Press Enter again to overwrite, or toggle scope (Tab).`,
    }
  }
  try {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(targetPath, source, {
      encoding: 'utf8',
      flag: overwrite ? 'w' : 'wx',
    })
  } catch (e) {
    return {
      ok: false,
      exists: false,
      msg: `Failed to save: ${(e as Error).message}`,
    }
  }
  logEvent('tengu_workflow_saved', {
    workflow_name: name,
    target_path: targetPath,
    scope,
    overwritten: fileExists && overwrite,
  } as never)
  const displayPath = displayWorkflowPath(scope, name, process.cwd())
  return {
    ok: true,
    overwritten: fileExists && overwrite,
    msg: `Dynamic workflow saved to ${displayPath}. Invoke as /${name} or Workflow({name: "${name}"}) in future sessions.`,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// List mode
// ─────────────────────────────────────────────────────────────────────────

type ListOption = {
  label: React.ReactNode
  value: string
  disabled?: boolean
}

function groupCountLabel(type: LaunchType, count: number): string {
  const singular =
    type === 'background'
      ? 'background dynamic workflow'
      : 'remote dynamic workflow'
  const plural =
    type === 'background'
      ? 'background dynamic workflows'
      : 'remote dynamic workflows'
  return `${count} ${count === 1 ? singular : plural}`
}

function RunLine({
  task,
  columns,
}: {
  task: LocalWorkflowTaskState
  columns: number
}): React.ReactNode {
  const name = truncate(task.workflowName ?? task.description ?? 'workflow', 40)
  const status = task.status
  const agents = task.agentCount ?? 0
  const tokens = task.totalTokens ?? 0
  const runId = task.workflowRunId ?? task.id
  // name (bold) · status (colored) · N agents · M tok · runId (dim)
  const idMax = Math.max(8, Math.min(24, columns - 60))
  return (
    <Text>
      {`${name} · ${status} · ${agents} ${agents === 1 ? 'agent' : 'agents'}${tokens > 0 ? ` · ${formatNumber(tokens)} tok` : ''} · ${truncate(runId, idMax)}`}
    </Text>
  )
}

function ListMode({
  runs,
  onDone,
  onSelect,
}: {
  runs: LocalWorkflowTaskState[]
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onSelect: (taskId: string) => void
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const handleCancel = (): void => {
    logEvent('tengu_workflow_history_dialog_dismissed', {} as never)
    onDone('Dynamic workflows dialog dismissed', { display: 'system' })
  }

  if (runs.length === 0) {
    return (
      <Dialog title="Dynamic workflows" onCancel={handleCancel}>
        <Text>No dynamic workflows in this session.</Text>
      </Dialog>
    )
  }

  // Subtitle counts: "N running · M completed"
  const running = runs.filter(r => r.status === 'running' || r.status === 'pending').length
  const completed = runs.filter(
    r => r.status === 'completed' || r.status === 'failed' || r.status === 'killed',
  ).length
  const subtitleParts: React.ReactNode[] = []
  if (running > 0) {
    subtitleParts.push(
      <Text key="running">
        {running} running
      </Text>,
    )
  }
  if (completed > 0) {
    subtitleParts.push(
      <Text key="completed">
        {completed} completed
      </Text>,
    )
  }
  const subtitle =
    subtitleParts.length > 0 ? (
      <Text dimColor={true}>
        {subtitleParts.map((node, i) => (
          <React.Fragment key={i}>
            {i > 0 ? ' · ' : null}
            {node}
          </React.Fragment>
        ))}
      </Text>
    ) : undefined

  // Group by launch type (background first, then remote).
  const groups: LaunchType[] = ['background', 'remote']
  const options: ListOption[] = []
  for (const g of groups) {
    const groupRuns = runs.filter(r => launchTypeOf(r) === g)
    if (groupRuns.length === 0) continue
    options.push({
      label: <Text bold={true} color="subtle">{groupCountLabel(g, groupRuns.length)}</Text>,
      value: `__header_${g}`,
      disabled: true,
    })
    for (const task of groupRuns) {
      options.push({
        label: <RunLine task={task} columns={columns} />,
        value: task.id,
      })
    }
  }

  const handleChange = (value: string): void => {
    if (value.startsWith('__header_')) return
    onSelect(value)
  }

  return (
    <Dialog
      title="Dynamic workflows"
      subtitle={subtitle}
      onCancel={handleCancel}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="↑/↓" action="select" />
          <KeyboardShortcutHint shortcut="Enter" action="view" />
          <KeyboardShortcutHint shortcut="←/Esc" action="close" />
        </Byline>
      )}
    >
      <Select
        options={options}
        onChange={handleChange}
        onCancel={handleCancel}
        visibleOptionCount={10}
      />
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Detail mode
// ─────────────────────────────────────────────────────────────────────────

function WorkflowRunDetail({
  task,
  onBack,
  onDone,
  onSave,
}: {
  task: LocalWorkflowTaskState
  onBack: () => void
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  /** Open the scope-aware save dialog (2.1.208 #25). */
  onSave: () => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const [saveMsg, setSaveMsg] = React.useState<{ ok: boolean; msg: string } | null>(null)
  const isRunning = task.status === 'running' || task.status === 'pending'

  // Single-key actions: x = stop, s = save, r = restart, p = pause/resume.
  // Esc is handled by the Dialog's confirm:no binding (onCancel -> onBack),
  // so we do NOT also handle it here (avoids a double onBack). Backspace and
  // left-arrow also go back (the Dialog does not bind those).
  useInput((input, key) => {
    if (input === 'x' && isRunning) {
      void killWorkflowTask(task.id, setAppState)
      setSaveMsg({ ok: true, msg: 'Workflow stop requested.' })
      return
    }
    if (input === 's') {
      onSave()
      return
    }
    // 'r' restart / 'p' pause-resume are declared in the binary but require
    // engine-side resume/pause plumbing (engine agent's file); they are
    // wired here as no-ops-with-feedback so the keys are not silently dead.
    if (input === 'r') {
      setSaveMsg({ ok: false, msg: 'Restart requires engine resume plumbing (not yet wired).' })
      return
    }
    if (input === 'p') {
      setSaveMsg({ ok: false, msg: 'Pause/resume is not yet supported for local workflows.' })
      return
    }
    if (key.backspace || key.leftArrow) {
      onBack()
    }
  })

  const phases = task.workflowProgress ?? []
  const seedPhases = task.phases ?? []
  const hasPhaseData = phases.length > 0
  const agentCount = task.agentCount ?? 0
  const tokens = task.totalTokens ?? 0
  const toolCalls = task.totalToolCalls ?? 0
  const logs = task.logs ?? []
  const name = task.workflowName ?? task.description ?? 'workflow'
  const runId = task.workflowRunId ?? task.id

  const title = `${name} — ${task.status}`

  return (
    <Dialog
      title={title}
      color={statusColor(task.status)}
      onCancel={onBack}
      inputGuide={() => (
        <Byline>
          {isRunning ? <KeyboardShortcutHint shortcut="x" action="stop workflow" /> : null}
          <KeyboardShortcutHint shortcut="s" action="save" />
          <KeyboardShortcutHint shortcut="←/Esc" action="back" />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1}>
        {/* Header: run id + duration + script path */}
        <Box flexDirection="column">
          <Text dimColor={true}>
            Run ID: {runId} · {formatDuration(durationOf(task))}
          </Text>
          {task.scriptPath ? (
            <Text dimColor={true}>Script: {truncate(task.scriptPath, 60)}</Text>
          ) : null}
          {task.summary ? <Text>{task.summary}</Text> : null}
        </Box>

        {/* Phases section */}
        <Box flexDirection="column">
          <Text bold={true}>Phases</Text>
          {hasPhaseData ? (
            phases.map((p, i) => (
              <Text key={`phase-${i}-${p.phase}`}>
                {`  ${figures.pointerSmall} `}
                <Text bold={true}>{p.phase || '(untitled phase)'}</Text>
                {` — ${p.completedAgents}/${p.totalAgents} agents`}
                {p.agentCount > 0 ? ` · ${p.agentCount} running` : ''}
              </Text>
            ))
          ) : seedPhases.length > 0 ? (
            seedPhases.map((p, i) => (
              <Text key={`seed-${i}-${p}`} dimColor={true}>
                {`  ${figures.pointerSmall} ${p} — not started`}
              </Text>
            ))
          ) : (
            <Text dimColor={true}>  No phases started yet.</Text>
          )}
        </Box>

        {/* Agents section — per-agent rows (mirrors inline WorkflowProgressTree). */}
        <Box flexDirection="column">
          <Text bold={true}>Agents</Text>
          {phases.flatMap(p => p.agents).length > 0
            ? phases.flatMap((p, pi) =>
                p.agents.map((a, ai) => {
                  // 2.1.201 agent-list layout: wider title + short model +
                  // dedicated time column + tokens, NO per-row tool-call count.
                  const aElapsed =
                    a.elapsedMs ??
                    (a.startTime != null
                      ? Math.max(0, Date.now() - a.startTime)
                      : undefined)
                  const aTime =
                    aElapsed != null
                      ? formatDuration(aElapsed, { hideTrailingZeros: true })
                      : ''
                  const aModel = a.model
                    ? truncate(renderModelName(a.model), 14)
                    : ''
                  const aTokens = a.latestInputTokens
                  return (
                    <Box key={`agent-${pi}-${ai}-${a.id}`} flexDirection="row">
                      <Text dimColor={a.status === 'running'}>{`  ${figures.pointerSmall} `}</Text>
                      <Text bold={a.status === 'error'} color={a.status === 'error' ? 'red' : undefined} dimColor={a.status === 'running'}>{truncate(a.label || a.agentType, 36)}</Text>
                      <Text dimColor={a.status === 'running'}>{`${aModel ? ` · ${aModel}` : ''}${aTime ? ` · ${aTime}` : ''}${aTokens > 0 ? ` · ${formatNumber(aTokens)} tok` : ''}${a.status === 'running' ? ' · running' : a.status === 'error' ? ' · error' : ' · done'}`}</Text>
                    </Box>
                  )
                }),
              )
            : agentCount > 0
              ? <Text>{`  ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}${tokens > 0 ? ` · ${formatNumber(tokens)} tok` : ''}${toolCalls > 0 ? ` · ${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}` : ''}`}</Text>
              : <Text dimColor={true}>  No agents yet.</Text>}
        </Box>

        {/* Logs (narrator lines from the script's log() primitive) */}
        {logs.length > 0 ? (
          <Box flexDirection="column">
            <Text bold={true}>Logs</Text>
            {logs.slice(-6).map((l, i) => (
              <Text key={`log-${i}`} dimColor={true}>
                {`  ${l}`}
              </Text>
            ))}
          </Box>
        ) : null}

        {/* Transient action feedback */}
        {saveMsg ? (
          <Text color={saveMsg.ok ? 'success' : 'warning'}>{saveMsg.msg}</Text>
        ) : null}
      </Box>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Save dialog (2.1.208 #25 — CLAUDE_CONFIG_DIR-aware user-scope path)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Scope-aware save dialog. Mirrors the 2.1.210 binary's "Save dynamic
 * workflow" dialog: a Tab-toggleable scope (default "project"), a subtitle
 * showing `{Scope} scope · {displayPath}` (config-dir-aware for user
 * scope), and Enter to save / Esc to cancel. On EEXIST, a second Enter
 * overwrites (binary's "Press Enter again to overwrite" flow).
 *
 * The path math (resolveWorkflowsDir / displayWorkflowPath) honors
 * CLAUDE_CONFIG_DIR via getClaudeConfigHomeDir, so a relocated config dir
 * is reflected in BOTH the displayed path and the actual write target —
 * the 2.1.208 fix.
 */
function WorkflowSaveDialog({
  task,
  onDone,
  onBack,
}: {
  task: LocalWorkflowTaskState
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onBack: () => void
}): React.ReactNode {
  // Binary default scope is "project" (useState("project")); Tab toggles.
  const [scope, setScope] = React.useState<WorkflowSaveScope>('project')
  const [overwriteArmed, setOverwriteArmed] = React.useState(false)
  const [outcome, setOutcome] = React.useState<SaveOutcome | null>(null)

  const name = React.useMemo(
    () => sanitizeWorkflowName(task.workflowName),
    [task.workflowName],
  )
  const displayPath = displayWorkflowPath(scope, name, process.cwd())

  const handleToggleScope = (): void => {
    setScope(prev => (prev === 'project' ? 'user' : 'project'))
    setOverwriteArmed(false)
    setOutcome(null)
  }

  const handleSave = (): void => {
    const res = saveDynamicWorkflow(task, scope, overwriteArmed)
    if (!res.ok && res.exists) {
      // Arm overwrite: next Enter clobbers the existing file.
      setOverwriteArmed(true)
      setOutcome(res)
      return
    }
    if (res.ok) {
      onDone(res.msg, { display: 'system' })
      return
    }
    setOutcome(res)
  }

  useInput((input, key) => {
    if (key.escape) {
      onBack()
      return
    }
    if (key.tab) {
      handleToggleScope()
      return
    }
    if (key.return) {
      handleSave()
      return
    }
  })

  const scopeLabel = scope === 'project' ? 'Project' : 'User'
  const actionLabel = overwriteArmed ? 'overwrite' : 'save'

  return (
    <Dialog
      title="Save dynamic workflow"
      subtitle={
        <Text>
          {scopeLabel} scope · {displayPath}
        </Text>
      }
      onCancel={onBack}
      isCancelActive={false}
      inputGuide={() => (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action={actionLabel} />
          <KeyboardShortcutHint shortcut="Tab" action="toggle scope" />
          <KeyboardShortcutHint shortcut="Esc" action="cancel" />
        </Byline>
      )}
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Save as: <Text bold={true}>{name}</Text>
        </Text>
        {outcome ? (
          <Text color={outcome.ok ? 'success' : 'warning'}>{outcome.msg}</Text>
        ) : null}
      </Box>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Parent dialog (mode switch)
// ─────────────────────────────────────────────────────────────────────────

export function WorkflowDetailDialog(props: Props): React.ReactNode {
  const { onDone, initialTaskId } = props
  // Subscribe to the task registry — re-renders live as runs progress.
  const tasks = useAppState(s => s.tasks) ?? {}
  const [viewState, setViewState] = React.useState<ViewState>(
    initialTaskId ? { mode: 'detail', taskId: initialTaskId } : { mode: 'list' },
  )

  React.useEffect(() => {
    logEvent('tengu_workflow_history_dialog_shown', {} as never)
  }, [])

  // Collect local_workflow runs (live).
  const allTasks: TaskState[] = Object.values(tasks) as TaskState[]
  const runs = allTasks.filter(isLocalWorkflowTask) as LocalWorkflowTaskState[]

  // Focused task (live reference, or undefined if evicted). Resolved for
  // both detail and save modes so the save dialog stays on the same run.
  const detailTask =
    viewState.mode === 'detail' || viewState.mode === 'save'
      ? ((tasks as Record<string, TaskState> | undefined)?.[viewState.taskId] as
          | LocalWorkflowTaskState
          | undefined)
      : undefined
  const detailTaskValid = !!detailTask && isLocalWorkflowTask(detailTask)

  // If the selected task vanished (evicted after completion grace), fall
  // back to the list — mirrors BackgroundTasksDialog's guard. If we opened
  // straight to a detail view (initialTaskId) and there are no other runs,
  // dismiss the dialog entirely. Done in an effect to avoid updating state
  // during render.
  React.useEffect(() => {
    if (viewState.mode !== 'detail' && viewState.mode !== 'save') return
    if (detailTaskValid) return
    if (initialTaskId && runs.length === 0) {
      onDone('Dynamic workflows dialog dismissed', { display: 'system' })
      return
    }
    setViewState({ mode: 'list' })
  }, [viewState, detailTaskValid, initialTaskId, runs.length, onDone])

  if (viewState.mode === 'detail' && detailTaskValid && detailTask) {
    return (
      <WorkflowRunDetail
        task={detailTask}
        onBack={() => setViewState({ mode: 'list' })}
        onDone={onDone}
        onSave={() => setViewState({ mode: 'save', taskId: detailTask.id })}
      />
    )
  }

  if (viewState.mode === 'save' && detailTaskValid && detailTask) {
    return (
      <WorkflowSaveDialog
        task={detailTask}
        onDone={onDone}
        onBack={() => setViewState({ mode: 'detail', taskId: detailTask.id })}
      />
    )
  }

  return (
    <ListMode
      runs={runs}
      onDone={onDone}
      onSelect={taskId => setViewState({ mode: 'detail', taskId })}
    />
  )
}
