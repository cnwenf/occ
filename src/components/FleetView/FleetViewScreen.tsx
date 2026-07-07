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
import { isAgentsFleetEnabled, buildFleetRows } from './rowHelpers.js'
import { FleetView } from './FleetView.js'

export type FleetViewScreenProps = {
  /** Current prompt buffer (REPL inputValue). Entry keys only fire when empty. */
  inputValue: string
  /** True when a modal/permission dialog is open — disables all fleet input. */
  disabled: boolean
}

export function FleetViewScreen(props: FleetViewScreenProps): React.ReactNode {
  const { inputValue, disabled } = props
  const tasks = useAppState(s => s.tasks)
  const { rows } = useTerminalSize()

  // 1s tick so job ages / fold-window eviction re-render.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Navigation state (local — Phase 1 does not extend AppState).
  const [fleetActive, setFleetActive] = React.useState(false)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [showPreview, setShowPreview] = React.useState(false)

  const fleetRows = React.useMemo(() => buildFleetRows(tasks, now), [tasks, now])
  const hasJobs = fleetRows.running.length > 0 || fleetRows.done.length > 0

  // Clamp selection when rows shrink (e.g. an agent completes mid-nav).
  React.useEffect(() => {
    setSelectedIndex(i => Math.min(i, Math.max(0, fleetRows.running.length - 1)))
  }, [fleetRows.running.length])

  // Deactivate when there are no jobs at all (e.g. everything completed).
  React.useEffect(() => {
    if (!hasJobs && fleetActive) {
      setFleetActive(false)
      setShowPreview(false)
    }
  }, [hasJobs, fleetActive])

  const leftArrowOpensAgents = getInitialSettings().leftArrowOpensAgents ?? true

  // Entry + navigation input handler. isActive whenever the fleet could
  // plausibly intercept: jobs present (entry path) OR fleet active (nav
  // path), and not suppressed by a modal. Registered before the text input
  // because FleetViewScreen renders earlier in the JSX, so
  // stopImmediatePropagation preempts the text input.
  useInput(
    (input, key, event) => {
      if (disabled) return

      // ENTRY: not yet active. Down/left-arrow on empty input when jobs
      // exist activates the fleet and preempts the text input's history
      // nav / footer-pill selection / cursor move.
      if (!fleetActive) {
        if (!hasJobs) return
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
      if (key.upArrow) {
        event.stopImmediatePropagation()
        setSelectedIndex(i =>
          fleetRows.running.length === 0
            ? 0
            : (i - 1 + fleetRows.running.length) % fleetRows.running.length,
        )
        return
      }
      if (key.downArrow) {
        event.stopImmediatePropagation()
        setSelectedIndex(i =>
          fleetRows.running.length === 0
            ? 0
            : (i + 1) % fleetRows.running.length,
        )
        return
      }
      if (key.return) {
        event.stopImmediatePropagation()
        setShowPreview(v => !v)
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
    },
    { isActive: !disabled && (hasJobs || fleetActive) },
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
      />
    </Box>
  )
}
