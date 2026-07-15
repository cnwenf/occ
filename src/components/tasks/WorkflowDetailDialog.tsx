/**
 * Detail dialog for a single background `local_workflow` task, opened from
 * the BackgroundTasksDialog (footer /tasks browser) when the user selects a
 * workflow run and presses Enter.
 *
 * Keybindings mirror ShellDetailDialog (the canonical tasks/ detail-dialog
 * pattern):
 *   - Esc / n      → confirm:no  → onDone (Dialog onCancel)
 *   - Enter        → confirm:yes  → onDone
 *   - Space        → onDone (manual, since Confirmation binds space to toggle)
 *   - ← (left)     → onBack (go back to the task list)
 *   - x            → onKill (stop the running workflow)
 *
 * The rendering of phases/agents/logs mirrors the WorkflowRunDetail body in
 * src/components/WorkflowDetailDialog.tsx (the /workflows browser) so both
 * entry points show the same content.
 *
 * `onSkipAgent` / `onRetryAgent` are accepted as props (BackgroundTasksDialog
 * wires them to the engine's skip/retry helpers) but per-agent selection UI is
 * not yet implemented here; the keys are reserved for a future agent-cursor
 * feature. The callbacks are passed through so the wiring stays intact.
 */
import type * as React from 'react'
import figures from 'figures'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { renderModelName } from '../../utils/model/model.js'
import { truncate } from '../../utils/truncate.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack?: () => void
}

function statusColor(
  status: string,
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

function durationOf(task: DeepImmutable<LocalWorkflowTaskState>): number {
  const end = task.endTime ?? Date.now()
  return Math.max(0, end - task.startTime)
}

export function WorkflowDetailDialog({
  workflow: task,
  onDone,
  onKill,
  onBack,
}: Props): React.ReactNode {
  const handleClose = (): void => {
    onDone('Workflow details dismissed', { display: 'system' })
  }

  // Esc is handled by the Dialog's confirm:no binding (onCancel → handleClose).
  // Enter is handled by confirm:yes below. (Space is handled in handleKeyDown
  // because the Confirmation context binds space to confirm:toggle, not yes.)
  useKeybindings(
    { 'confirm:yes': handleClose },
    { context: 'Confirmation' },
  )

  const isRunning = task.status === 'running' || task.status === 'pending'

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === ' ' || e.key === 'spacebar') {
      e.preventDefault()
      handleClose()
      return
    }
    if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
      return
    }
    if (e.key === 'x' && isRunning && onKill) {
      e.preventDefault()
      onKill()
    }
  }

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

  const renderInputGuide = (exitState: ExitState): React.ReactNode => {
    if (exitState.pending) {
      return <Text>Press {exitState.keyName} again to exit</Text>
    }
    return (
      <Byline>
        {onBack ? <KeyboardShortcutHint shortcut="←" action="go back" /> : null}
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
        {isRunning && onKill ? (
          <KeyboardShortcutHint shortcut="x" action="stop" />
        ) : null}
      </Byline>
    )
  }

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      <Dialog
        title={title}
        color={statusColor(task.status)}
        onCancel={handleClose}
        inputGuide={renderInputGuide}
      >
        <Box flexDirection="column" gap={1}>
          {/* Header: run id + duration + script path + summary */}
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

          {/* Agents section — per-agent rows when available, else aggregate. */}
          <Box flexDirection="column">
            <Text bold={true}>Agents</Text>
            {phases.flatMap(p => p.agents).length > 0 ? (
              phases.flatMap((p, pi) =>
                p.agents.map((a, ai) => {
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
                      <Text dimColor={a.status === 'running'}>
                        {`  ${figures.pointerSmall} `}
                      </Text>
                      <Text
                        bold={a.status === 'error'}
                        color={a.status === 'error' ? 'red' : undefined}
                        dimColor={a.status === 'running'}
                      >
                        {truncate(a.label || a.agentType, 36)}
                      </Text>
                      <Text dimColor={a.status === 'running'}>
                        {`${aModel ? ` · ${aModel}` : ''}${aTime ? ` · ${aTime}` : ''}${aTokens > 0 ? ` · ${formatNumber(aTokens)} tok` : ''}${a.status === 'running' ? ' · running' : a.status === 'error' ? ' · error' : ' · done'}`}
                      </Text>
                    </Box>
                  )
                }),
              )
            ) : agentCount > 0 ? (
              <Text>{`  ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}${tokens > 0 ? ` · ${formatNumber(tokens)} tok` : ''}${toolCalls > 0 ? ` · ${toolCalls} tool ${toolCalls === 1 ? 'call' : 'calls'}` : ''}`}</Text>
            ) : (
              <Text dimColor={true}>  No agents yet.</Text>
            )}
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
        </Box>
      </Dialog>
    </Box>
  )
}
