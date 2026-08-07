import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useTheme } from '../design-system/ThemeProvider.js'

/**
 * The OCC-60 "Signal Chevron" mark.
 *
 * The user selected direction A ("Signal Chevron") from four design
 * proposals: the REPL prompt `❯` abstracted as a braille dot-matrix light
 * beam. The design language aligns with the grok-build welcome screen —
 * near-black ground, dark-gray dot matrix, a single diagonal shimmer
 * highlight (gray → near-white). Deliberately restrained: NO color
 * gradient. It replaces the OCC-50 "Ascendant" comet mark.
 *
 * The glyph is generated, not hand-drawn. A parametric beam is lit on a
 * dot grid — center `cy = (dotHeight - 1) / 2`, per dot row
 * `fx = (dotWidth - 2) * (1 - |y - cy| / cy)`, every dot with
 * `|x - fx| <= beam` lit — then converted to braille cells (each cell is
 * 2×4 dots; left column bits 0/1/2/6, right column bits 3/4/5/7, base
 * U+2800). The two mirrored strokes meet at the right edge: a chevron.
 *
 * The rendering architecture is carried over from OCC-45/50 (the technique
 * was validated; only the identity changed):
 *
 * - One silhouette at three tiers — wide (8 rows), compact (~7 rows,
 *   stroke tightened one cell), plain (~5 rows, thick stroke so the
 *   silhouette survives small sizes).
 * - Rest state is a flat dark gray (#5a5a5a family); on light themes a
 *   darker gray variant keeps ≥ 3:1 contrast (WCAG non-text graphics
 *   threshold) against the reference background.
 * - One-shot diagonal light sweep (~12 fps, 1.8 s) toward near-white
 *   (#e1e1e1), then the clock unsubscribes and the mark settles. Reduced
 *   motion disables it entirely.
 * - Degradation ladder: chalk down-converts truecolor → 256 → 16 colors
 *   automatically and NO_COLOR yields plain glyphs — the silhouette always
 *   survives. `TERM=dumb` renders an ASCII silhouette instead of braille so
 *   nothing mojibakes on legacy terminals.
 */

export type OccMarkMode = 'wide' | 'compact' | 'plain'

export type OccMarkArt = readonly string[]

export type Rgb = readonly [number, number, number]

function normalizeMark(lines: readonly string[]): OccMarkArt {
  const width = Math.max(...lines.map(stringWidth))
  return lines.map(line => line + ' '.repeat(width - stringWidth(line)))
}

/**
 * Braille cell bit layout: each cell is 2 dot columns × 4 dot rows. The
 * left column carries dots 1/2/3/7 (bits 0, 1, 2, 6) and the right column
 * dots 4/5/6/8 (bits 3, 4, 5, 7), addressed by the dot-row offset 0–3.
 */
const BRAILLE_LEFT_BITS = [0x01, 0x02, 0x04, 0x40] as const
const BRAILLE_RIGHT_BITS = [0x08, 0x10, 0x20, 0x80] as const
const BRAILLE_BASE = 0x2800

export type ChevronSpec = {
  /** Dot-grid width in braille dots (2 dots per character column). */
  readonly dotWidth: number
  /** Dot-grid height in braille dots (4 dots per character row). */
  readonly dotHeight: number
  /** Half-thickness of the beam in dots (`|x - fx| <= beam` lights a dot). */
  readonly beam: number
}

/**
 * The three tiers are one shape downsampled, per the OCC-60 spec: wide is
 * the full 30×32 grid; compact shrinks the grid and tightens the stroke by
 * one cell; plain shrinks further and thickens the stroke so the silhouette
 * stays alive at narrow widths.
 */
export const SIGNAL_CHEVRON_SPECS: Record<OccMarkMode, ChevronSpec> = {
  wide: { dotWidth: 30, dotHeight: 32, beam: 2.1 },
  compact: { dotWidth: 24, dotHeight: 28, beam: 1.6 },
  plain: { dotWidth: 16, dotHeight: 20, beam: 2.4 },
}

/**
 * Generate one Signal Chevron tier from the parametric beam formula and
 * convert it to braille. Rows keep their global column offset (the
 * staggered chevron gesture); blank cells become ASCII spaces so the
 * silhouette composes cleanly with the renderer's space-run handling.
 */
export function generateSignalChevron(spec: ChevronSpec): OccMarkArt {
  const { dotWidth, dotHeight, beam } = spec
  const cy = (dotHeight - 1) / 2
  const charCols = Math.ceil(dotWidth / 2)
  const charRows = Math.ceil(dotHeight / 4)

  const cells: number[][] = Array.from({ length: charRows }, () =>
    Array<number>(charCols).fill(0),
  )
  for (let y = 0; y < dotHeight; y++) {
    const fx = (dotWidth - 2) * (1 - Math.abs(y - cy) / cy)
    for (let x = 0; x < dotWidth; x++) {
      if (Math.abs(x - fx) > beam) continue
      const charCol = Math.floor(x / 2)
      const charRow = Math.floor(y / 4)
      const bits = x % 2 === 0 ? BRAILLE_LEFT_BITS : BRAILLE_RIGHT_BITS
      cells[charRow]![charCol]! |= bits[y % 4]!
    }
  }

  // Global bounding box keeps the staggered gesture; unlit cells inside it
  // become ASCII spaces (the beam is contiguous, so no interior holes).
  let minCol = charCols
  let maxCol = -1
  for (const row of cells) {
    for (let col = 0; col < charCols; col++) {
      if (row[col] !== 0) {
        if (col < minCol) minCol = col
        if (col > maxCol) maxCol = col
      }
    }
  }
  if (maxCol < 0) return [' ']

  const lines = cells.map(row =>
    row
      .slice(minCol, maxCol + 1)
      .map(code => (code === 0 ? ' ' : String.fromCharCode(BRAILLE_BASE + code)))
      .join(''),
  )
  return normalizeMark(lines)
}

/**
 * The Signal Chevron at three resolutions, generated at module load. Every
 * tier is the same gesture — the REPL prompt `❯` as a dot-matrix beam —
 * redrawn at decreasing grid sizes.
 */
export const OCC_MARKS = {
  wide: generateSignalChevron(SIGNAL_CHEVRON_SPECS.wide),
  compact: generateSignalChevron(SIGNAL_CHEVRON_SPECS.compact),
  plain: generateSignalChevron(SIGNAL_CHEVRON_SPECS.plain),
} satisfies Record<OccMarkMode, OccMarkArt>

export function getOccMark(mode: OccMarkMode): OccMarkArt {
  return OCC_MARKS[mode]
}

export function getOccMarkWidth(art: OccMarkArt): number {
  return Math.max(...art.map(stringWidth))
}

/**
 * Flat mark palette per theme family — restrained by design: a dark-gray
 * dot matrix at rest, one near-white shimmer highlight. Light themes use a
 * darker gray variant so both states keep ≥ 3:1 contrast against the
 * reference background.
 */
export const MARK_COLORS: Record<
  'dark' | 'light',
  { readonly rest: Rgb; readonly highlight: Rgb }
> = {
  dark: {
    rest: [90, 90, 90], // #5a5a5a — resting dot matrix
    highlight: [225, 225, 225], // #e1e1e1 — shimmer peak
  },
  light: {
    rest: [61, 61, 61], // dark-gray variant, ≥3:1 on white
    highlight: [112, 112, 112], // shimmer peak, still ≥3:1 on white
  },
}

export function markThemeFamily(themeName: string): 'dark' | 'light' {
  return themeName.startsWith('light') ? 'light' : 'dark'
}

export function rgbColor(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

const SHIMMER_FRAME_MS = 84
const SHIMMER_DURATION_MS = 1_800
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

/**
 * Legacy-terminal guard, read lazily so tests can toggle it. `TERM=dumb`
 * predates Unicode glyph cells; braille would mojibake there, so the mark
 * degrades to an ASCII silhouette of the same chevron gesture.
 */
export function isDumbTerminal(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.TERM?.toLowerCase() === 'dumb'
}

/** ASCII silhouette of the chevron for dumb terminals — no color, no braille. */
export const DUMB_FALLBACK: OccMarkArt = normalizeMark(['\\', ' \\', ' /', '/'])

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
 * single uncolored run; every occupied cell carries the flat mark color,
 * with the shimmer band lifting cells to the highlight while it passes.
 */
function MarkRow({
  art,
  row,
  palette,
  progress,
}: {
  art: OccMarkArt
  row: number
  palette: { readonly rest: Rgb; readonly highlight: Rgb }
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
    const shimmering = isShimmerCell(art, row, column, progress)
    nodes.push(
      <Text
        key={`${row}-${column}`}
        color={rgbColor(shimmering ? palette.highlight : palette.rest)}
        bold
      >
        {char}
      </Text>,
    )
  }
  flushSpaces(`${row}-end`)
  return <Text>{nodes}</Text>
}

/** The uncolored ASCII silhouette rendered on dumb terminals. */
function DumbMarkFallback(): React.ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {DUMB_FALLBACK.map((line, row) => (
        <Text key={row}>{line}</Text>
      ))}
    </Box>
  )
}

/**
 * The animated braille mark. Kept separate from the dumb-terminal fallback
 * so hook order is never conditional.
 */
function SignalChevronMark(props: OccMarkProps): React.ReactNode {
  const mode = props.mode ?? 'compact'
  const art = getOccMark(mode)
  const [themeName] = useTheme()
  const palette = MARK_COLORS[markThemeFamily(themeName)]

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
          palette={palette}
          progress={progress}
        />
      ))}
    </Box>
  )
}

export function OccMark(props: OccMarkProps): React.ReactNode {
  // Dumb terminals get the uncolored ASCII silhouette — braille mojibakes
  // there, and there is no color to animate.
  if (isDumbTerminal()) {
    return <DumbMarkFallback />
  }
  return <SignalChevronMark {...props} />
}
