/**
 * PhaseScrollIndicator — ports the official 2.1.200 binary's viewport math
 * for the workflow progress tree.
 *
 * Binary functions (decompiled from /tmp/occ-audit/claude.strings line 735610):
 *   - fCt(e,t,n) → {from, to, above, below}  (computeVisibleWindow)
 *       e = currentIndex (focused agent), t = total agents, n = viewport rows
 *       if (t <= n) return {from:0, to:t, above:0, below:0}
 *       r = floor(n/2)
 *       o = max(0, min(e - r, t - n))   // scroll so current is centered
 *       s = o + n
 *       return {from:o, to:s, above:o, below:t - s}
 *   - zJe(e,t)  → "↑ {from+1}–{to} of {total} ↓"  (formatIndicator)
 *       up   = e.from > 0 ? "↑" (↑) : " "
 *       down = e.to  < t ? "↓" (↓) : " "
 *       sep  = "–" (– en-dash, binary dOs)
 *   - odc({win, total})  → <Text dimColor wrap="truncate-end">  {indicator}</Text>
 *       (2-space indent prefix)
 *
 * Rendered per-phase when the phase's agent count exceeds the visible viewport
 * (binary hfm calls fCt(selectedAgent, agents.length, viewport) then odc).
 */
import React from 'react'
import { Text } from '../ink.js'

/** Arrow glyphs (binary ut.arrowUp / ut.arrowDown). */
const ARROW_UP = '↑'
const ARROW_DOWN = '↓'
/** En-dash separator (binary dOs = "–"). */
const RANGE_SEP = '–'

export type VisibleWindow = {
  /** First visible index (inclusive). */
  from: number
  /** Last visible index (exclusive). */
  to: number
  /** Number of items hidden above the viewport. */
  above: number
  /** Number of items hidden below the viewport. */
  below: number
}

/**
 * Compute the visible window for a scrollable list. Ports binary fCt(e,t,n).
 *
 * @param currentIndex - The focused/active item index (kept centered when
 *   possible). For the live auto-scrolling tree this is the last agent index
 *   so the most recent activity stays in view.
 * @param total - Total number of items in the list.
 * @param viewport - Number of rows the viewport can display.
 */
export function computeVisibleWindow(
  currentIndex: number,
  total: number,
  viewport: number,
): VisibleWindow {
  // Binary: if (t <= n) return {from:0, to:t, above:0, below:0}
  if (total <= viewport) {
    return { from: 0, to: total, above: 0, below: 0 }
  }
  const half = Math.floor(viewport / 2)
  // Binary: o = max(0, min(e - r, t - n))
  const from = Math.max(0, Math.min(currentIndex - half, total - viewport))
  const to = from + viewport
  return { from, to, above: from, below: total - to }
}

/**
 * Format the indicator string. Ports binary zJe(e,t).
 * Produces: "↑ {from+1}–{to} of {total} ↓" with arrows replaced by spaces
 * when there is nothing above/below.
 */
export function formatIndicator(win: VisibleWindow, total: number): string {
  const up = win.from > 0 ? ARROW_UP : ' '
  const down = win.to < total ? ARROW_DOWN : ' '
  return `${up} ${win.from + 1}${RANGE_SEP}${win.to} of ${total} ${down}`
}

type PhaseScrollIndicatorProps = {
  /** The computed visible window (from computeVisibleWindow). */
  win: VisibleWindow
  /** Total number of items in the list (agents in this phase). */
  total: number
}

/**
 * PhaseScrollIndicator — renders the "↑ 3–7 of 12 ↓" scroll hint for a phase
 * group box when its agent count overflows the viewport. Ports binary odc().
 */
export function PhaseScrollIndicator({
  win,
  total,
}: PhaseScrollIndicatorProps): React.ReactNode {
  const indicator = formatIndicator(win, total)
  // Binary odc: prefix 2 spaces, dimColor, wrap="truncate-end".
  return (
    <Text dimColor wrap="truncate-end">
      {`  ${indicator}`}
    </Text>
  )
}
