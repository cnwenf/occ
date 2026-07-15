/**
 * Detail dialog for a `monitor_mcp` background task, opened from
 * BackgroundTasksDialog when the user selects a monitor task and presses
 * Enter. Previously a null-returning stub — which trapped the user (blank
 * screen, no exit key bound).
 *
 * Keybindings (same pattern as ShellDetailDialog):
 *   - Esc / n      → confirm:no  → onDone (Dialog onCancel)
 *   - Enter        → confirm:yes  → onDone
 *   - Space        → onDone (manual; Confirmation binds space to toggle)
 *   - ← (left)     → onBack (go back to the task list)
 *   - x            → onKill (stop the running monitor)
 *
 * MonitorMcpTaskState is currently a stub type (TaskStateBase + type only),
 * so only base fields are rendered. When the task-state type is extended with
 * monitor-specific fields, render them here without changing the keybinding
 * shell.
 */
import type * as React from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import type { ExitState } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import { formatDuration } from '../../utils/format.js'
import { truncate } from '../../utils/truncate.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  onKill?: () => void
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

function durationOf(task: DeepImmutable<MonitorMcpTaskState>): number {
  const end = task.endTime ?? Date.now()
  return Math.max(0, end - task.startTime)
}

export function MonitorMcpDetailDialog({
  task,
  onDone,
  onKill,
  onBack,
}: Props): React.ReactNode {
  const handleClose = (): void => {
    onDone('Monitor details dismissed', { display: 'system' })
  }

  // Esc handled by Dialog onCancel (confirm:no). Enter via confirm:yes.
  // Space handled manually (Confirmation binds space to toggle, not yes).
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

  const title = `Monitor — ${task.status}`

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      <Dialog
        title={title}
        color={statusColor(task.status)}
        onCancel={handleClose}
        inputGuide={renderInputGuide}
      >
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text>
              <Text bold={true}>Status:</Text>
              {' '}
              {isRunning ? (
                <Text color="background">{task.status}</Text>
              ) : task.status === 'completed' ? (
                <Text color="success">{task.status}</Text>
              ) : (
                <Text color="error">{task.status}</Text>
              )}
            </Text>
            <Text>
              <Text bold={true}>Runtime:</Text> {formatDuration(durationOf(task))}
            </Text>
            <Text wrap="wrap">
              <Text bold={true}>Description:</Text> {truncate(task.description, 280)}
            </Text>
          </Box>
        </Box>
      </Dialog>
    </Box>
  )
}
