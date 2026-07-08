/**
 * FleetViewScreen — the inline fleet panel mounted below the input box.
 *
 * In the official 2.1.200 binary this is `mountFleetViewWithComposerBack`:
 * a full Ink screen with the composer (PromptInput) pinned at the back/
 * bottom and fleet rows filling the area above it. OCC's Phase 1 keeps the
 * existing REPL layout and injects this panel directly above the
 * PromptInput in the `bottom` block of FullscreenLayout — the composer
 * stays at the bottom, the fleet rows sit above it, matching the official
 * layout's visual contract.
 *
 * This component owns:
 *  - the `fleetActive` / `selectedIndex` / `showPreview` navigation state
 *    (kept local because Phase 1 must not extend AppState);
 *  - the entry/navigation useInput. It registers BEFORE the text input
 *    (it renders earlier in the JSX), so `stopImmediatePropagation` on
 *    entry keys (down/left-arrow on empty input) and navigation keys
 *    (up/down/enter/esc while active) preempts the text input — the user
 *    can move the fleet cursor without disturbing the prompt buffer.
 *
 * Phase 1 is local-only: the data source is `appState.tasks`. No
 * daemon/heartbeat/host abstraction here (Phase 2).
 */

import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isAgentsFleetEnabled, buildFleetRows, fleetAgentSuggestions } from './rowHelpers.js'
import { FleetView } from './FleetView.js'
import { readDaemonStatus } from '../../daemon/workerRegistry.js'
import type { WorkerRecord } from '../../daemon/types.js'

export type FleetViewScreenProps = {
  /** Current prompt buffer (REPL inputValue). Entry keys only fire when empty. */
  inputValue: string
  /** True when a modal/permission dialog is open — disables all fleet input. */
  disabled: boolean
  /** Dispatch a dispatch-suggestion prompt (empty-state Enter). Wired by REPL to setInputValue + submit. */
  onDispatch?: (prompt: string) => void
}

export function FleetViewScreen(props: FleetViewScreenProps): React.ReactNode {
  const { inputValue, disabled, onDispatch } = props
  const tasks = useAppState(s => s.tasks)
  const { rows } = useTerminalSize()

  // 1s tick so job ages / fold-window eviction re-render.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Phase 2: heartbeat liveness — 5s interval checks if running workers are
  // still alive (writes .fleetview-heartbeat for the official's liveness probe).
  React.useEffect(() => {
    const id = setInterval(() => {
      for (const task of Object.values(tasks)) {
        if (task.status === 'running' && task.pid) {
          // Write heartbeat file so the daemon/orphan watchdog can detect alive workers.
          try {
            const { writeFileSync } = require('fs')
            const { join } = require('path')
            const heartbeatPath = join(require('os').tmpdir(), `.fleetview-heartbeat-${task.pid}`)
            writeFileSync(heartbeatPath, String(Date.now()))
          } catch {}
        }
      }
    }, 5000)
    return () => clearInterval(id)
  }, [tasks])

  // Phase 3: daemon-managed background sessions. The daemon (separate process)
  // persists running worker records to ~/.claude/daemon-status.json; poll it so
  // the fleet shows cross-process daemon sessions alongside in-process tasks.
  const [daemonSessions, setDaemonSessions] = React.useState<WorkerRecord[]>([])
  React.useEffect(() => {
    const read = () => {
      try {
        setDaemonSessions(readDaemonStatus())
      } catch {
        // best-effort — leave stale
      }
    }
    read()
    const id = setInterval(read, 5000)
    return () => clearInterval(id)
  }, [])

  // Navigation state (local — Phase 1 does not extend AppState).
  const [fleetActive, setFleetActive] = React.useState(false)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [showPreview, setShowPreview] = React.useState(false)
  // Phase 2: group mode (Ctrl+g toggles 'state' <-> 'group').
  const [groupMode, setGroupMode] = React.useState<'state' | 'group'>('state')

  const fleetRows = React.useMemo(() => buildFleetRows(tasks, now), [tasks, now])
  const hasJobs = fleetRows.running.length > 0 || fleetRows.done.length > 0 || daemonSessions.length > 0

  // Clamp selection when rows shrink (e.g. an agent completes mid-nav).
  React.useEffect(() => {
    setSelectedIndex(i => Math.min(i, Math.max(0, fleetRows.running.length - 1)))
  }, [fleetRows.running.length])

  // Note: we do NOT auto-deactivate when hasJobs is false. The official shows
  // the dispatch/empty state (Researcher/Reviewer/Workflow suggestions) below
  // the input even with no running jobs, so the user can down-arrow into the
  // fleet + select + Enter to dispatch. Esc still exits (see the nav handler).

  const leftArrowOpensAgents = getInitialSettings().leftArrowOpensAgents ?? true

  // Entry + navigation input handler. isActive whenever the fleet could
  // plausibly intercept: jobs present (entry path) OR fleet active (nav
  // path), and not suppressed by a modal. Registered before the text input
  // because FleetViewScreen renders earlier in the JSX, so
  // stopImmediatePropagation preempts the text input.
  useInput(
    (input, key, event) => {
      if (disabled) return

      // ENTRY: not yet active. Down/left-arrow on empty input activates the
      // fleet and preempts the text input's history nav / footer-pill selection
      // / cursor move. This fires EVEN with no running jobs so the dispatch/
      // empty state (Researcher/Reviewer/Workflow) shows below the input —
      // matching the official fleet UX.
      if (!fleetActive) {
        if (inputValue !== '') return
        const downEntry = key.downArrow
        const leftEntry = key.leftArrow && leftArrowOpensAgents
        if (downEntry || leftEntry) {
          event.stopImmediatePropagation()
          setFleetActive(true)
          setSelectedIndex(0)
          setShowPreview(false)
        }
        return
      }

      // NAVIGATION: fleet is active. Capture up/down/enter/esc so the
      // text input doesn't also process them (cursor move / history).
      // Navigation count: running sessions, or the dispatch suggestions when empty.
      const navCount = fleetRows.running.length > 0 ? fleetRows.running.length : fleetAgentSuggestions().length
      if (key.upArrow) {
        event.stopImmediatePropagation()
        setSelectedIndex(i => navCount === 0 ? 0 : (i - 1 + navCount) % navCount)
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        setSelectedIndex(i => navCount === 0 ? 0 : (i + 1) % navCount)
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        if (fleetRows.running.length > 0) {
          // Running session: peek/attach (toggle the live preview).
          setShowPreview(v => !v)
        } else {
          // Empty state: dispatch the selected suggestion (run the agent/workflow).
          const suggestions = fleetAgentSuggestions()
          const sel = Math.min(Math.max(0, selectedIndex), suggestions.length - 1)
          const s = suggestions[sel]
          if (s && onDispatch) {
            onDispatch(s.prompt)
            setFleetActive(false)
          }
        }
        return
      }
      if (key.escape) {
        event.stopImmediatePropagation()
        // First esc closes the peek; second esc returns to the input.
        if (showPreview) {
          setShowPreview(false)
        } else {
          setFleetActive(false)
        }
        return
      }
      // Phase 2: Ctrl+g toggles group mode (state <-> group).
      if (input === 'g' && key.ctrl) {
        event.stopImmediatePropagation()
        setGroupMode(m => m === 'state' ? 'group' : 'state')
        return
      }
      // Phase 2: 'x' stops the focused job (stop_job/stop_session action).
      if (input === 'x' && fleetRows.running[selectedIndex]) {
        event.stopImmediatePropagation()
        const task = fleetRows.running[selectedIndex]
        try { require('../../utils/task/framework.js').updateTaskState(task.id, { status: 'killed' }) } catch {}
        return
      }
    },
    { isActive: !disabled && (hasJobs || fleetActive || inputValue === '') },
  )

  // Gate: Phase 1 stub is always open. Render nothing if disabled by flag.
  if (!isAgentsFleetEnabled()) return null

  // Render nothing when there are no jobs and the fleet isn't active, so
  // the panel doesn't clutter the input area on a fresh session. The empty
  // state appears once the user activates (down/left-arrow) — matching the
  // official onboarding flow.
  if (!hasJobs && !fleetActive) return null

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <FleetView
        rows={fleetRows}
        focused={fleetActive}
        selectedIndex={selectedIndex}
        showPreview={showPreview}
        now={now}
        terminalRows={rows}
        onDispatch={onDispatch}
      />
      {daemonSessions.length > 0 && (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>Daemon sessions ({daemonSessions.length})</Text>
          {daemonSessions.slice(0, 5).map(s => (
            <Text key={s.id} dimColor>
              {'  '}● {s.kind} · pid {s.pid} · {Math.max(0, Math.floor((now - s.startedAt) / 1000))}s
              {s.cwd ? ` · ${s.cwd}` : ''}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
