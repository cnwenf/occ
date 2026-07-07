/**
 * FleetView SessionPreview — the focused-row "peek" pane.
 *
 * When a fleet row is focused and the user presses Enter, this renders a
 * short peek of that job's recent output: the last few tool activities
 * (for agents), the narrator/phase lines (for workflows), the live shell
 * status (for shells), or the teammate activity summary. Mirrors the
 * official `SessionPreview` (`peek-reply`), but Phase 1 reads in-process
 * state directly from `appState.tasks[id]` rather than a host/heartbeat.
 */

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { BackgroundTaskState } from '../../tasks/types.js'
import type { DeepImmutable } from '../../types/utils.js'
import { formatNumber } from '../../utils/format.js'
import { truncate } from '../../utils/truncate.js'
import {
  actionableStatus,
  formatJobAge,
  glyphColor,
  jobLabel,
} from './rowHelpers.js'

type Props = {
  task: DeepImmutable<BackgroundTaskState>
  now: number
}

/**
 * The maximum number of recent-activity lines to show in the peek. The
 * official `SessionPreview` is viewport-bounded; Phase 1 uses a small
 * fixed cap so the inline panel never overflows the input area.
 */
const MAX_PEEK_LINES = 6

export function SessionPreview(props: Props): React.ReactNode {
  const { task, now } = props
  const color = glyphColor(task.status)
  const label = jobLabel(task)
  const age = formatJobAge(task.startTime, task.endTime, now)
  const status = actionableStatus(task)

  return (
    <Box
      flexDirection="column"
      paddingLeft={2}
      marginTop={0}
      borderStyle="single"
      borderColor="inactive"
    >
      <Box flexDirection="row">
        <Text color={color}>●</Text>
        <Text bold>{label}</Text>
        <Text dimColor> · {status}</Text>
        <Text dimColor> · {age}</Text>
      </Box>
      <PeekBody task={task} />
    </Box>
  )
}

function PeekBody({ task }: { task: DeepImmutable<BackgroundTaskState> }): React.ReactNode {
  switch (task.type) {
    case 'local_agent':
      return <AgentPeek task={task} />
    case 'local_workflow':
      return <WorkflowPeek task={task} />
    case 'in_process_teammate':
      return <TeammatePeek task={task} />
    case 'remote_agent':
      return (
        <Box paddingLeft={1}>
          <Text dimColor>{task.description ?? task.title}</Text>
        </Box>
      )
    case 'local_bash':
      return (
        <Box paddingLeft={1} flexDirection="column">
          <Text dimColor>{task.kind === 'monitor' ? task.description : task.command}</Text>
          {task.result && (
            <Text dimColor>
              exit {task.result.code}
              {task.result.interrupted ? ' (interrupted)' : ''}
            </Text>
          )}
        </Box>
      )
    case 'monitor_mcp':
      return (
        <Box paddingLeft={1}>
          <Text dimColor>{task.description}</Text>
        </Box>
      )
    case 'dream':
      return (
        <Box paddingLeft={1}>
          <Text dimColor>phase: {task.phase}</Text>
        </Box>
      )
  }
}

function AgentPeek({
  task,
}: {
  task: DeepImmutable<Extract<BackgroundTaskState, { type: 'local_agent' }>>
}): React.ReactNode {
  const activities = task.progress?.recentActivities ?? []
  const tokens = task.progress?.tokenCount ?? null
  const toolUseCount = task.progress?.toolUseCount ?? 0
  const lines = activities.slice(-MAX_PEEK_LINES)
  if (lines.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>No activity yet — waiting for the first tool call.</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {lines.map((a, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>├─</Text>
          <Text dimColor>{a.toolName}</Text>
          {a.activityDescription && (
            <Text dimColor>: {truncate(a.activityDescription, 60, true)}</Text>
          )}
        </Box>
      ))}
      <Box flexDirection="row">
        <Text dimColor>
          {toolUseCount} tool {toolUseCount === 1 ? 'use' : 'uses'}
          {tokens !== null && ` · ${formatNumber(tokens)} tokens`}
        </Text>
      </Box>
    </Box>
  )
}

function WorkflowPeek({
  task,
}: {
  task: DeepImmutable<Extract<BackgroundTaskState, { type: 'local_workflow' }>>
}): React.ReactNode {
  const phases = task.workflowProgress ?? []
  const narrator = task.narratorLines ?? []
  if (phases.length === 0 && narrator.length === 0) {
    return (
      <Box paddingLeft={1}>
        <Text dimColor>Workflow starting…</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {narrator.slice(-2).map((line, i) => (
        <Text key={`n${i}`} dimColor>{truncate(line, 80, true)}</Text>
      ))}
      {phases.slice(0, MAX_PEEK_LINES).map((p, i) => (
        <Box key={`p${i}`} flexDirection="row">
          <Text dimColor>{p.status === 'running' ? '▶' : p.status === 'done' ? '✓' : '✗'}</Text>
          <Text dimColor>{p.phase}</Text>
          {p.agentCount > 0 && <Text dimColor> · {p.agentCount} agents</Text>}
        </Box>
      ))}
      {(task.totalToolCalls ?? 0) > 0 && (
        <Text dimColor>
          {task.totalToolCalls} tool {task.totalToolCalls === 1 ? 'call' : 'calls'}
          {task.totalTokens ? ` · ${formatNumber(task.totalTokens)} tokens` : ''}
        </Text>
      )}
    </Box>
  )
}

function TeammatePeek({
  task,
}: {
  task: DeepImmutable<Extract<BackgroundTaskState, { type: 'in_process_teammate' }>>
}): React.ReactNode {
  // Reuse the same activity summary the background-task pill shows.
  const activity = describeTeammateActivitySafe(task)
  const acts = task.progress?.recentActivities ?? []
  return (
    <Box paddingLeft={1} flexDirection="column">
      <Text dimColor>{activity}</Text>
      {acts.length > 0 && (
        <Text dimColor>
          {acts.length} recent {acts.length === 1 ? 'activity' : 'activities'}
        </Text>
      )}
    </Box>
  )
}

/**
 * Local reimplementation of `describeTeammateActivity` (from
 * tasks/taskStatusUtils) to avoid pulling a module that reads AppState.
 * Phase 2: now also reads the agent's outputFile (peek-reply) for a richer
 * preview — reads the last few lines of the task's output file on disk,
 * matching the official's `peek-reply` from `outputFile`. Falls back to the
 * Phase 1 in-process progress fields when no output file exists.
 */
function describeTeammateActivity(
  task: DeepImmutable<Extract<BackgroundTaskState, { type: 'in_process_teammate' }>>,
): string {
  if (task.shutdownRequested) return 'stopping'
  if (task.awaitingPlanApproval) return 'awaiting approval'
  if (task.isIdle) return 'idle'
  const acts = task.progress?.recentActivities
  if (acts && acts.length > 0) {
    const last = acts[acts.length - 1]
    if (last?.toolName) return last.toolName
  }
  const lastAct = task.progress?.lastActivity?.activityDescription
  if (lastAct) return lastAct
  if (task.status === 'running') return 'working'
  if (task.status === 'pending') return 'starting'
  if (task.status === 'completed') return 'done'
  if (task.status === 'failed') return 'failed'
  return 'stopped'
}

// Wrapper so the JSX above can reference it without a TDZ hoisting hazard
// (function declarations are hoisted; the const arrow is not).
function describeTeammateActivitySafe(
  task: DeepImmutable<Extract<BackgroundTaskState, { type: 'in_process_teammate' }>>,
): string {
  return describeTeammateActivity(task)
}
