/**
 * FleetView — the inline navigable agent/workflow row list.
 *
 * Renders below the input box (the composer stays pinned at the bottom;
 * fleet rows fill the area above it — matches the official
 * `mountFleetViewWithComposerBack` layout). Phase 1 reads in-process state
 * directly from `appState.tasks`; there is no daemon/heartbeat/host.
 *
 * Row bodies reuse existing primitives:
 *  - `AgentProgressLine` for local_agent rows (tree chars, tokens, status).
 *  - `BackgroundTask` for local_bash / remote_agent / in_process_teammate
 *    / local_workflow / monitor_mcp / dream rows.
 *
 * Navigation (Up/Down/Enter/Esc) is driven by the parent FleetViewScreen's
 * useInput so the entry keys can preempt the text input. This component
 * is otherwise presentational: it takes `selectedIndex`, `showPreview`,
 * and `focused` as props and renders accordingly.
 */

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { AgentProgressLine } from '../AgentProgressLine.js'
import { BackgroundTask } from '../tasks/BackgroundTask.js'
import type { BackgroundTaskState } from '../../tasks/types.js'
import type { DeepImmutable } from '../../types/utils.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { plural } from '../../utils/stringUtils.js'
import {
  actionableStatus,
  fleetAgentSuggestions,
  fleetTitle,
  fleetVerticalBudget,
  formatJobAge,
  glyphColor,
  jobDescription,
  jobLabel,
} from './rowHelpers.js'
import { SessionPreview } from './SessionPreview.js'

export type FleetViewProps = {
  /** Live + folded-done rows, precomputed by buildFleetRows. */
  rows: { running: BackgroundTaskState[]; done: BackgroundTaskState[] }
  /** Whether navigation focus is on the fleet (vs. the text input). */
  focused: boolean
  /** Index of the selected row within `rows.running` (folded-done is the expander). */
  selectedIndex: number
  /** Whether the focused row's SessionPreview peek is open. */
  showPreview: boolean
  /** Current time, for age rendering. Pass a ticking value to animate. */
  now: number
  /** Terminal row count, for the vertical budget. */
  terminalRows: number
}

export function FleetView(props: FleetViewProps): React.ReactNode {
  const { rows, focused, selectedIndex, showPreview, now, terminalRows } = props
  const { running, done } = rows
  const budget = fleetVerticalBudget(terminalRows)

  // Empty state: no live jobs and no folded-done jobs. Show onboarding +
  // suggestions (mirrors `tengu_fleetview_empty_state_shown`).
  if (running.length === 0 && done.length === 0) {
    return <FleetEmptyState focused={focused} />
  }

  const title = fleetTitle(running.length, done.length)
  // Cap visible rows to the budget (title + status line consume 2 rows).
  const maxRows = Math.max(1, budget - 2)
  const visibleRunning = running.slice(0, maxRows)
  const hidden = running.length - visibleRunning.length

  return (
    <Box flexDirection="column" paddingLeft={1} marginTop={0}>
      <Box flexDirection="row">
        <Text bold>{title}</Text>
        {focused ? (
          <Text dimColor> · ↑↓ navigate · ⏎ peek · esc back</Text>
        ) : (
          <Text dimColor> · ↓/← to navigate</Text>
        )}
      </Box>
      {visibleRunning.map((task, i) => (
        <FleetRow
          key={task.id}
          task={task}
          selected={focused && i === selectedIndex}
          isLast={i === visibleRunning.length - 1 && hidden === 0 && done.length === 0}
          now={now}
        />
      ))}
      {hidden > 0 && (
        <Box paddingLeft={1}>
          <Text dimColor>… +{hidden} more {plural(hidden, 'job')}</Text>
        </Box>
      )}
      {done.length > 0 && (
        <Box paddingLeft={1}>
          <Text dimColor>✓ {done.length} done</Text>
        </Box>
      )}
      {showPreview && focused && running[selectedIndex] && (
        <SessionPreview task={running[selectedIndex] as DeepImmutable<BackgroundTaskState>} now={now} />
      )}
    </Box>
  )
}

/**
 * A single fleet row. Renders the selection glyph + the existing row
 * primitive (AgentProgressLine for agents, BackgroundTask for the rest)
 * so visual style stays consistent with the rest of the app.
 */
function FleetRow(props: {
  task: BackgroundTaskState
  selected: boolean
  isLast: boolean
  now: number
}): React.ReactNode {
  const { task, selected, isLast, now } = props
  const glyph = selected ? '▸' : ' '
  const color = glyphColor(task.status)
  const age = formatJobAge(task.startTime, task.endTime, now)

  if (isLocalAgentTask(task)) {
    // AgentProgressLine already renders the tree char, bold agentType,
    // tool-use count, tokens, and a status line. Wrap it with the
    // selection glyph + age so it reads as a fleet row.
    return (
      <Box flexDirection="row">
        <Text color={selected ? 'claude' : undefined}>{glyph} </Text>
        <Box flexDirection="column">
          <AgentProgressLine
            agentType={task.agentType}
            description={jobDescription(task) ?? undefined}
            toolUseCount={task.progress?.toolUseCount ?? 0}
            tokens={task.progress?.tokenCount ?? null}
            isLast={isLast}
            isResolved={task.status !== 'running' && task.status !== 'pending'}
            isError={task.status === 'failed'}
            isAsync={task.isBackgrounded}
            shouldAnimate={task.status === 'running'}
            lastToolInfo={actionableStatus(task)}
          />
          <Text dimColor>   {age}</Text>
        </Box>
      </Box>
    )
  }

  // Non-agent rows: reuse BackgroundTask (local_bash / remote_agent /
  // in_process_teammate / local_workflow / monitor_mcp / dream).
  return (
    <Box flexDirection="row">
      <Text color={selected ? 'claude' : undefined}>{glyph} </Text>
      <Box flexDirection="column">
        <BackgroundTask task={task as DeepImmutable<BackgroundTaskState>} maxActivityWidth={50} />
        <Text dimColor>   {jobLabel(task)} · {age}</Text>
      </Box>
    </Box>
  )
}

function FleetEmptyState({ focused }: { focused: boolean }): React.ReactNode {
  const suggestions = fleetAgentSuggestions()
  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold>Agents</Text>
      <Text dimColor>No agents running.</Text>
      <Text dimColor>{focused ? '↓/← navigate · esc back' : 'Dispatch an agent to populate the fleet:'}</Text>
      {suggestions.map((s, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>  • {s.label}: </Text>
          <Text dimColor>{s.prompt.length > 60 ? s.prompt.slice(0, 57) + '…' : s.prompt}</Text>
        </Box>
      ))}
    </Box>
  )
}
