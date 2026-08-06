import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useTheme } from '../design-system/ThemeProvider.js'

/**
 * The OCC-45 "Ion Aperture" mark.
 *
 * Design language (researched from terminal/TUI practice — gradient-string
 * multi-line gradients, btop-style HUD panels, ANSI Shadow block lettering,
 * grok-build's low-frequency shimmer; re-implemented originally, nothing
 * copied):
 *
 * - One silhouette: OCC's open C, the validated OCC-25 letterform, kept as
 *   solid block + quadrant cells so it stays crisp in every monospace font.
 * - Diagonal truecolor gradient across every occupied cell (gold → ember →
 *   ion rose). chalk down-converts automatically where truecolor is missing:
 *   256-color terminals get the nearest cube colors, 16-color terminals get
 *   the nearest basic colors, NO_COLOR terminals get plain glyphs — the
 *   silhouette always survives.
 * - One-shot diagonal light sweep (~12 fps, 1.85 s) that settles into the
 *   static gradient; reduced motion disables it entirely.
 * - Three optically redrawn tiers so the mark is monumental on wide
 *   terminals and still confident at three-ish rows.
 */

export type OccMarkMode = 'wide' | 'compact' | 'plain'

export type OccMarkArt = readonly string[]

export type Rgb = readonly [number, number, number]

function normalizeMark(lines: readonly string[]): OccMarkArt {
  const width = Math.max(...lines.map(stringWidth))
  return lines.map(line => line + ' '.repeat(width - stringWidth(line)))
}

/**
 * The open C at three resolutions. Each tier keeps the OCC-25 geometry —
 * two-cell strokes, quadrant-rounded exterior corners and aperture lips —
 * and differs only in overall scale.
 */
export const OCC_MARKS = {
  // Monumental tier for wide terminals (7 × 14).
  wide: normalizeMark([
    '▟████████████▙',
    '█████████████▛',
    '██',
    '██',
    '██',
    '█████████████▜',
    '▜████████████▛',
  ]),
  // Standard tier (7 × 10) — compact cards and the full-logo panel.
  compact: normalizeMark([
    '▟████████▙',
    '█████████▛',
    '██',
    '██',
    '██',
    '█████████▜',
    '▜████████▛',
  ]),
  // Small tier (5 × 8) — narrow borderless welcome.
  plain: normalizeMark(['▟██████▙', '██', '██', '██', '▜██████▛']),
} satisfies Record<OccMarkMode, OccMarkArt>

export function getOccMark(mode: OccMarkMode): OccMarkArt {
  return OCC_MARKS[mode]
}

export function getOccMarkWidth(art: OccMarkArt): number {
  return Math.max(...art.map(stringWidth))
}

/**
 * Gradient stops per theme family. Dark terminals get luminous plasma tones;
 * light terminals get darker saturated tones so every stop keeps ≥ 3:1
 * contrast (WCAG non-text graphics threshold) against the reference
 * background.
 */
export const GRADIENT_STOPS: Record<'dark' | 'light', readonly Rgb[]> = {
  dark: [
    [255, 199, 110], // solar gold
    [255, 116, 64], // ember orange
    [233, 60, 136], // ion rose
  ],
  light: [
    [181, 110, 0], // deep amber
    [194, 62, 24], // vermilion
    [162, 22, 82], // crimson rose
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
 * Diagonal gradient parameter for one cell: mostly horizontal (left→right)
 * with a vertical component (top→bottom) so the color flows down the spine.
 */
export function markCellT(
  art: OccMarkArt,
  row: number,
  column: number,
): number {
  const width = getOccMarkWidth(art)
  const horizontal = width > 1 ? column / (width - 1) : 0
  const vertical = art.length > 1 ? row / (art.length - 1) : 0
  return horizontal * 0.72 + vertical * 0.28
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
 * Whether a cell is inside the moving light band at the given progress
 * ([0, 1]); progress === null means the sweep has settled (no highlight).
 * The band starts and finishes outside the mark so there is no hard flash
 * on mount or when the animation lands.
 */
export function isShimmerCell(
  art: OccMarkArt,
  row: number,
  column: number,
  progress: number | null,
): boolean {
  if (progress === null) return false
  const width = getOccMarkWidth(art)
  const diagonal =
    (column + (art.length - 1 - row) * 1.6) / (width + (art.length - 1) * 1.6)
  const bandPosition = -SHIMMER_BAND_WIDTH + progress * 1.45
  return Math.abs(diagonal - bandPosition) < SHIMMER_BAND_WIDTH
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
 * which is what produces the smooth diagonal sweep.
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
