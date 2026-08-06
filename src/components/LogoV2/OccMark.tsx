import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useTheme } from '../design-system/ThemeProvider.js'

/**
 * The OCC-50 "Monolith Rising" mark — designed with the brandkit skill
 * (concept exploration + identity board, docs/welcome-logo-occ50.md).
 *
 * Brand idea: the terminal block cursor scales to monumental size and stands
 * on the prompt line — a 2001-style monolith as an artifact of intelligence.
 * The mark is deliberately decoupled from the "OCC" letterforms: a pure
 * symbol, not a wordmark.
 *
 * Design language (brandkit dark-developer session):
 *
 * - One silhouette: a quadrant-rounded slab (the cursor-monolith) standing on
 *   an underscore horizon (the prompt line it rises from). Solid block and
 *   quadrant cells keep it crisp in every monospace font; the horizon is a
 *   half/quarter-block course so it reads as ground, not figure.
 * - Cool plasma truecolor gradient flowing bottom→top: grounded violet base,
 *   electric blue body, ice-lit crown — "first light on the monolith". chalk
 *   down-converts automatically where truecolor is missing: 256-color
 *   terminals get the nearest cube colors, 16-color terminals the nearest
 *   basic colors — the silhouette always survives. `TERM=dumb` and
 *   screen-reader mode skip the art entirely (text-only welcome variant).
 * - One-shot rising light sweep (~12 fps, 1.85 s) — the ignition pass —
 *   that settles into the static gradient; reduced motion disables it.
 * - Three optically redrawn tiers (wide / compact / plain) so the monolith is
 *   monumental on wide terminals and still confident at five rows.
 */

export type OccMarkMode = 'wide' | 'compact' | 'plain'

export type OccMarkArt = readonly string[]

export type Rgb = readonly [number, number, number]

function normalizeMark(lines: readonly string[]): OccMarkArt {
  const width = Math.max(...lines.map(stringWidth))
  return lines.map(line => line + ' '.repeat(width - stringWidth(line)))
}

/**
 * The monolith at three resolutions. Each tier keeps the same geometry
 * family — quadrant-rounded slab on an underscore horizon — and differs in
 * scale. The plain tier trades the rounded crown for a flat top, which is
 * crisper at five rows and keeps its silhouette distinct from the compact
 * tier's in rendered-output tests.
 */
export const OCC_MARKS = {
  // Monumental tier for wide terminals (7 rows × 14 cols).
  wide: normalizeMark([
    '    ▟████▙',
    '    ██████',
    '    ██████',
    '    ██████',
    '    ██████',
    '    ██████',
    '▄▄▄▄██████▄▄▄▄',
  ]),
  // Standard tier (7 rows × 10 cols) — compact cards and the full-logo panel.
  compact: normalizeMark([
    '   ▟██▙',
    '   ████',
    '   ████',
    '   ████',
    '   ████',
    '   ████',
    '▄▄▄████▄▄▄',
  ]),
  // Small tier (5 rows × 8 cols) — narrow borderless welcome.
  plain: normalizeMark(['  ████', '  ████', '  ████', '  ████', '▂▂████▂▂']),
} satisfies Record<OccMarkMode, OccMarkArt>

export function getOccMark(mode: OccMarkMode): OccMarkArt {
  return OCC_MARKS[mode]
}

export function getOccMarkWidth(art: OccMarkArt): number {
  return Math.max(...art.map(stringWidth))
}

/**
 * Gradient stops per theme family — the OCC-50 cool plasma ramp (replacing
 * the OCC-45 fire family). Dark terminals get luminous stops; light
 * terminals get darker saturated stops so every stop keeps ≥ 3:1 contrast
 * (WCAG non-text graphics threshold) against the reference background.
 */
export const GRADIENT_STOPS: Record<'dark' | 'light', readonly Rgb[]> = {
  dark: [
    [124, 58, 237], // grounded violet (base)
    [59, 130, 246], // electric blue (body)
    [103, 232, 249], // ice cyan (crown)
  ],
  light: [
    [109, 40, 217], // violet 700
    [29, 78, 216], // blue 700
    [14, 116, 144], // cyan 800
  ],
}

export function gradientThemeFamily(themeName: string): 'dark' | 'light' {
  return themeName.startsWith('light') ? 'light' : 'dark'
}

/**
 * Piecewise-linear interpolation across the stop list. t is clamped to
 * [0, 1]; t = 0 returns the first stop, t = 1 the last.
 */
export function sampleGradient(
  stops: readonly Rgb[],
  t: number,
): Rgb {
  if (stops.length === 0) return [0, 0, 0]
  if (stops.length === 1) return stops[0]!
  const clamped = Math.min(Math.max(t, 0), 1)
  const scaled = clamped * (stops.length - 1)
  const index = Math.min(Math.floor(scaled), stops.length - 2)
  const local = scaled - index
  const from = stops[index]!
  const to = stops[index + 1]!
  return [
    Math.round(from[0] + (to[0] - from[0]) * local),
    Math.round(from[1] + (to[1] - from[1]) * local),
    Math.round(from[2] + (to[2] - from[2]) * local),
  ]
}

/**
 * Gradient parameter for one cell: mostly vertical — t = 0 at the base
 * (grounded violet) rising to t = 1 at the crown (ice cyan) — with a small
 * horizontal component so the slab's sides catch the light asymmetrically.
 */
export function markCellT(
  art: OccMarkArt,
  row: number,
  column: number,
): number {
  const width = getOccMarkWidth(art)
  const rise = art.length > 1 ? (art.length - 1 - row) / (art.length - 1) : 0
  const horizontal = width > 1 ? column / (width - 1) : 0
  return rise * 0.78 + horizontal * 0.22
}

export function rgbColor(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

/** Blend a color toward white for the transient shimmer highlight. */
export function highlightColor(rgb: Rgb, amount = 0.62): Rgb {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * amount),
    Math.round(rgb[1] + (255 - rgb[1]) * amount),
    Math.round(rgb[2] + (255 - rgb[2]) * amount),
  ]
}

const SHIMMER_FRAME_MS = 84
const SHIMMER_DURATION_MS = 1_850
const SHIMMER_BAND_WIDTH = 0.24

/**
 * Whether a cell is inside the rising light band at the given progress
 * ([0, 1]); progress === null means the sweep has settled (no highlight).
 * The band rises from the base to the crown and starts/finishes outside the
 * mark so there is no hard flash on mount or when the animation lands.
 */
export function isShimmerCell(
  art: OccMarkArt,
  row: number,
  column: number,
  progress: number | null,
): boolean {
  if (progress === null) return false
  const width = getOccMarkWidth(art)
  const rise =
    (column + (art.length - 1 - row) * 2.2) / (width + (art.length - 1) * 2.2)
  const bandPosition = -SHIMMER_BAND_WIDTH + progress * 1.45
  return Math.abs(rise - bandPosition) < SHIMMER_BAND_WIDTH
}

type OccMarkProps = {
  mode?: OccMarkMode
  /**
   * Force animation on/off. When omitted, animation follows the
   * `prefersReducedMotion` setting (on by default, one-shot only).
   */
  animate?: boolean
}

/**
 * Render one art row as colored cells. Consecutive spaces are emitted as a
 * single uncolored run; every occupied cell carries its own gradient color,
 * which is what produces the smooth vertical rise.
 */
function MarkRow({
  art,
  row,
  stops,
  progress,
}: {
  art: OccMarkArt
  row: number
  stops: readonly Rgb[]
  progress: number | null
}): React.ReactNode {
  const line = art[row]!
  const cells = [...line]
  const nodes: React.ReactNode[] = []
  let spaceRun = ''

  const flushSpaces = (key: string) => {
    if (spaceRun.length > 0) {
      nodes.push(<Text key={key}>{spaceRun}</Text>)
      spaceRun = ''
    }
  }

  for (let column = 0; column < cells.length; column++) {
    const char = cells[column]!
    if (char === ' ' || char === '\t') {
      spaceRun += ' '
      continue
    }
    flushSpaces(`${row}-sp-${column}`)
    const base = sampleGradient(stops, markCellT(art, row, column))
    const shimmering = isShimmerCell(art, row, column, progress)
    nodes.push(
      <Text
        key={`${row}-${column}`}
        color={rgbColor(shimmering ? highlightColor(base) : base)}
        bold
      >
        {char}
      </Text>,
    )
  }
  flushSpaces(`${row}-end`)
  return <Text>{nodes}</Text>
}

export function OccMark(props: OccMarkProps): React.ReactNode {
  const mode = props.mode ?? 'compact'
  const art = getOccMark(mode)
  const [themeName] = useTheme()
  const stops = GRADIENT_STOPS[gradientThemeFamily(themeName)]

  const animate =
    props.animate ?? !(getInitialSettings().prefersReducedMotion ?? false)

  const [done, setDone] = useState(!animate)
  const startTimeRef = useRef<number | null>(null)
  const [ref, time] = useAnimationFrame(done ? null : SHIMMER_FRAME_MS)

  useEffect(() => {
    if (done) return
    const timer = setTimeout(setDone, SHIMMER_DURATION_MS, true)
    return () => clearTimeout(timer)
  }, [done])

  if (startTimeRef.current === null) {
    startTimeRef.current = time
  }
  const elapsed = Math.max(0, time - startTimeRef.current)
  const progress = done ? null : Math.min(elapsed / SHIMMER_DURATION_MS, 1)

  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
      {art.map((_, row) => (
        <MarkRow
          key={row}
          art={art}
          row={row}
          stops={stops}
          progress={progress}
        />
      ))}
    </Box>
  )
}
