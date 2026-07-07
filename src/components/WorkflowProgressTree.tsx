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
 *       - agents.map(AgentProgressLine) — per-agent row with tree chars
 *         ├─/└─, tool-use count, tokens, status (running/done/error)
 *
 * REUSES (do not rebuild):
 *   - src/components/AgentProgressLine.tsx — the per-agent row (tree chars,
 *     tokens, status "Initializing…"/"Done"/"Running in the background").
 *   - src/components/PhaseScrollIndicator.tsx — the ↑/↓ scroll hint.
 *
 * Data source: the WorkflowProgressData snapshot emitted via ToolCallProgress
 * (Tool.onProgress) and consumed by renderToolUseProgressMessage. Also reads
 * from LocalWorkflowTaskState.workflowProgress for the /workflows detail view.
 */
import React from 'react'
import { Box, Text } from '../ink.js'
import { AgentProgressLine } from './AgentProgressLine.js'
import {
  PhaseScrollIndicator,
  computeVisibleWindow,
} from './PhaseScrollIndicator.js'
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
 * Render a single agent row. Maps a WorkflowAgentStat to AgentProgressLine's
 * props. Uses hideType=true + name=label so the agent's label is the
 * prominent bold text (not the redundant "wf-{label}" type badge).
 */
function AgentRow({
  stat,
  isLast,
  shouldAnimate,
}: {
  stat: WorkflowAgentStat
  isLast: boolean
  shouldAnimate: boolean
}): React.ReactNode {
  return (
    <AgentProgressLine
      agentType={stat.agentType}
      name={stat.label}
      description={undefined}
      toolUseCount={stat.toolUseCount}
      tokens={stat.latestInputTokens + stat.cumulativeOutputTokens}
      isLast={isLast}
      isResolved={stat.isResolved}
      isError={stat.isError}
      shouldAnimate={shouldAnimate}
      lastToolInfo={stat.lastActivity}
      hideType={true}
    />
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
