/**
 * WorkflowProgressTree — the LIVE progress tree mounted while the Workflow
 * tool runs (and reused by the /workflows detail view).
 *
 * Mirrors the official 2.1.200 binary render order (top→bottom):
 *   (1) NARRATOR LINES — emitted by the script's log() primitive; rendered
 *       as dimColor Text lines above the tree (binary line 733952: "shown as
 *       a narrator line above the progress tree").
 *   (2) PHASE GROUP BOXES — one per phase(title) call. Each box shows:
 *       - phase title (bold, "permission" color) + a dimColor agent count
 *       - PhaseScrollIndicator (when agents overflow the viewport)
 *       - agents.map(AgentRow) — per-agent row with tree chars ├─/└─, a wider
 *         bold title, a short model-name column, a dedicated time column, and
 *         the token total (NO per-row tool-call count, per the 2.1.201
 *         /workflows agent-list layout change), plus a status sub-line.
 *
 * REUSES (do not rebuild):
 *   - src/components/PhaseScrollIndicator.tsx — the ↑/↓ scroll hint.
 *   The shared src/components/AgentProgressLine.tsx (still used by the live
 *   AgentTool and FleetView rows for its tool-count+tokens line) is NOT used
 *   here: the workflow list owns its wider-title / model / time / no-tool-count
 *   layout directly.
 *
 * Data source: the WorkflowProgressData snapshot emitted via ToolCallProgress
 * (Tool.onProgress) and consumed by renderToolUseProgressMessage. Also reads
 * from LocalWorkflowTaskState.workflowProgress for the /workflows detail view.
 */
import React from 'react'
import { Box, Text } from '../ink.js'
import {
  PhaseScrollIndicator,
  computeVisibleWindow,
} from './PhaseScrollIndicator.js'
import { formatDuration, formatNumber } from '../utils/format.js'
import { truncate } from '../utils/truncate.js'
import { renderModelName } from '../utils/model/model.js'
import type {
  WorkflowPhaseProgress,
  WorkflowAgentStat,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

/** Default viewport rows when terminalSize is unavailable. */
const DEFAULT_VIEWPORT_ROWS = 10

type WorkflowProgressTreeProps = {
  /** Per-phase progress (each with its agents[] list). */
  phases: WorkflowPhaseProgress[]
  /** Narrator lines from log() — rendered dimColor above the tree. */
  narratorLines?: string[]
  /** Whether the tree is mid-run (drives AgentProgressLine spinner). */
  shouldAnimate?: boolean
  /** Visible viewport rows (from terminalSize.rows). Drives the scroll hint. */
  viewportRows?: number
}

/**
 * Render a single workflow-agent row with the 2.1.201 /workflows agent-list
 * layout: a wider bold title, a short model-name column, a dedicated time
 * column, and the token total — with NO per-row tool-call count (the shared
 * AgentProgressLine still shows tool counts for the live AgentTool/FleetView
 * rows; the workflow list drops it per the changelog). The status sub-line
 * (last activity / Initializing… / Done) is preserved below, matching the
 * binary's running→done tree transition.
 *
 * The title is dimmed while the agent is still running and full-bright once
 * resolved, mirroring AgentProgressLine's dimColor={!isResolved} emphasis.
 */
function AgentRow({
  stat,
  isLast,
}: {
  stat: WorkflowAgentStat
  isLast: boolean
  shouldAnimate: boolean
}): React.ReactNode {
  const treeChar = isLast ? '└─' : '├─'
  const isDone = stat.isResolved
  const isError = stat.isError
  const tokens = stat.latestInputTokens + stat.cumulativeOutputTokens
  // Time column: the final elapsed time once resolved, else a live value
  // derived from the captured start time (refreshed on each progress emit).
  const elapsed =
    stat.elapsedMs ??
    (stat.startTime != null
      ? Math.max(0, Date.now() - stat.startTime)
      : undefined)
  const timeStr =
    elapsed != null ? formatDuration(elapsed, { hideTrailingZeros: true }) : ''
  const modelStr = stat.model ? truncate(renderModelName(stat.model), 14) : ''
  const statusText = !isDone
    ? stat.lastActivity ?? 'Initializing…'
    : isError
      ? 'error'
      : 'Done'
  const branch = isLast ? '   ⎿  ' : '│  ⎿  '
  // Mirrors AgentProgressLine's render shape: a paddingLeft={3} Box holds the
  // tree-char Text (always dim) + a content Text (dim while running, bright
  // once done) whose inline " · "-separated segments guarantee spacing in the
  // TTY renderer. Tool-call count is intentionally absent (2.1.201 layout).
  const cols = `${modelStr ? ` · ${modelStr}` : ''}${timeStr ? ` · ${timeStr}` : ''}${tokens > 0 ? ` · ${formatNumber(tokens)} tok` : ''}`
  return (
    <Box flexDirection="column">
      <Box paddingLeft={3}>
        <Text dimColor>{treeChar} </Text>
        <Text dimColor={!isDone}>
          <Text bold>{truncate(stat.label || stat.agentType, 36)}</Text>
          {cols}
        </Text>
      </Box>
      <Box paddingLeft={3} flexDirection="row">
        <Text dimColor>{branch}</Text>
        <Text dimColor>{statusText}</Text>
      </Box>
    </Box>
  )
}

/**
 * Render a single phase group box: title (bold, permission color) + agent
 * count (dimColor) + PhaseScrollIndicator (when overflow) + agent rows.
 */
function PhaseGroupBox({
  phase,
  viewportRows,
  shouldAnimate,
  isLastPhase,
}: {
  phase: WorkflowPhaseProgress
  viewportRows: number
  shouldAnimate: boolean
  isLastPhase: boolean
}): React.ReactNode {
  const agents = phase.agents ?? []
  // The "current" index for the visible window = the last agent (auto-scroll
  // to the most recent activity). Binary fCt(selectedAgent, agents.length, viewport).
  const currentIndex = Math.max(0, agents.length - 1)
  const win = computeVisibleWindow(currentIndex, agents.length, viewportRows)
  const showIndicator = agents.length > viewportRows
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="nowrap">
        <Text bold color="permission">
          {phase.phase}
        </Text>
        <Text dimColor>
          {' · '}
          {phase.completedAgents}/{agents.length} agent
          {agents.length === 1 ? '' : 's'}
        </Text>
      </Box>
      {showIndicator && (
        <PhaseScrollIndicator win={win} total={agents.length} />
      )}
      {agents.map((stat, j) => (
        <AgentRow
          key={stat.id ?? `${phase.phase}-${j}`}
          stat={stat}
          isLast={j === agents.length - 1}
          shouldAnimate={shouldAnimate}
        />
      ))}
      {!isLastPhase && <Text>{' '}</Text>}
    </Box>
  )
}

/**
 * WorkflowProgressTree — the live tree. Narrator lines on top (dimColor),
 * then phases.map(PhaseGroupBox).
 */
export function WorkflowProgressTree({
  phases,
  narratorLines,
  shouldAnimate = false,
  viewportRows = DEFAULT_VIEWPORT_ROWS,
}: WorkflowProgressTreeProps): React.ReactNode {
  const lines = narratorLines ?? []
  return (
    <Box flexDirection="column">
      {lines.length > 0 && (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={`narrator-${i}`} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
      {phases.length === 0 && lines.length === 0 && (
        <Text dimColor>Running workflow…</Text>
      )}
      {phases.map((phase, i) => (
        <PhaseGroupBox
          key={`phase-${phase.phase}-${i}`}
          phase={phase}
          viewportRows={viewportRows}
          shouldAnimate={shouldAnimate}
          isLastPhase={i === phases.length - 1}
        />
      ))}
    </Box>
  )
}
