import * as React from 'react'
import { Text, useInterval } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'

type Props = {
  /** Unix-ms timestamp marking when the in-progress tool started (the
   *  timestamp of the last assistant message containing an in-progress
   *  tool_use). Elapsed time is computed live as `Date.now() - anchorMs`. */
  anchorMs: number
  /** Whether the group is still active (tool running). When false, the
   *  1s re-render interval is paused. */
  shouldAnimate: boolean
}

/**
 * Live elapsed-time counter shown on the collapsed tool summary line while
 * a tool is running. Re-renders every 1s via the shared clock so the
 * displayed duration ticks upward in real time. Hidden until 2s have
 * elapsed so fast-completing commands stay clean.
 *
 * Matches the official 2.1.210 binary's `tool-elapsed` component (Eip):
 * - `useInterval(shouldAnimate ? 1000 : null)` drives re-renders
 * - `Date.now() - anchorMs` computes live elapsed
 * - 2000ms threshold before showing
 * - renders ` · <bold>duration</bold>`
 */
export function ToolElapsedCounter({ anchorMs, shouldAnimate }: Props): React.ReactNode {
  // Force a re-render every 1s while the tool is running so the displayed
  // elapsed time ticks upward. Paused (null) when not animating.
  const [, setTick] = React.useState(0)
  useInterval(() => setTick(t => (t + 1) & 0x7fffffff), shouldAnimate ? 1000 : null)

  const elapsed = Date.now() - anchorMs
  if (elapsed < 2000) return null

  return <Text> · <Text bold>{formatDuration(elapsed)}</Text></Text>
}
