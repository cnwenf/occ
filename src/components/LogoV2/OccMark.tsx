import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import chalk from 'chalk'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { useTheme } from '../design-system/ThemeProvider.js'

/**
 * The OCC-60 "Signal Chevron" mark.
 *
 * The user selected direction A "Signal Chevron" (a REPL prompt `❯`
 * abstracted into a braille dot-matrix beam) to replace the OCC-50
 * "Ascendant" comet. The design language follows the grok-build welcome
 * screen: near-black canvas, dark-grey dot matrix, ONE diagonal shimmer
 * highlight sweeping grey → near-white — deliberately no color gradient.
 *
 * The silhouette is generated, not hand-drawn. Every tier is the same
 * formula evaluated on its own dot grid: for a grid W dots wide and H dots
 * tall with vertical center cy = (H-1)/2, each dot row y carries a beam
 * centered at fx = (W-2) * (1 - |y-cy| / cy) — apex at the middle row,
 * tails at the left edge — and every dot with |x - fx| <= radius is lit.
 * The dot grid is then packed into Unicode braille (2×4 dots per cell,
 * left column bits 0/1/2/6, right column bits 3/4/5/7, base U+2800), so
 * one terminal cell carries four dot rows and the beam stays sub-cell
 * smooth. Compact/plain tiers are the same shape downsampled by shrinking
 * the grid (and the beam radius for compact; a thickened beam keeps the
 * plain tier's silhouette solid at small scale).
 *
 * Rendering language carried over from OCC-45/50 (the engine is proven;
 * only the identity and palette changed):
 *
 * - One silhouette at three tiers; braille cells keep it crisp in every
 *   monospace font and collapse to a clean glyph stream under capture.
 * - Monochrome theme-aware tones: dark grey at rest, a near-white shimmer
 *   peak on dark themes; darker grey variants on light themes so both
 *   tones keep >= 3:1 contrast (WCAG non-text graphics threshold).
 * - One-shot diagonal light sweep (~12 fps, 1.8 s) that settles into the
 *   static matrix and unsubscribes from the animation clock.
 * - Degradation ladder: below 256-color support (16-color, NO_COLOR,
 *   TERM=dumb) the mark renders as an uncolored silhouette so legacy
 *   terminals never see quantized noise colors; reduced motion disables
 *   the sweep entirely.
 */

export type OccMarkMode = 'wide' | 'compact' | 'plain'

export type OccMarkArt = readonly string[]

export type Rgb = readonly [number, number, number]

/** Signal chevron dot-grid parameters (all sizes in braille dots). */
export type ChevronSpec = {
  /** Dot-grid width. Each braille cell spans 2 dot columns. */
  readonly gridWidth: number
  /** Dot-grid height. Each braille cell spans 4 dot rows. */
  readonly gridHeight: number
  /** Beam half-width in dots (beam center +/- radius is lit). */
  readonly beamRadius: number
}

/**
 * The three tier specs. wide is the user-confirmed 30×32 grid; compact is
 * the same shape downsampled to ~7 braille rows with the beam narrowed by
 * one dot; plain is the ~5-row thick-beam silhouette for narrow startups.
 */
export const CHEVRON_SPECS: Record<OccMarkMode, ChevronSpec> = {
  wide: { gridWidth: 30, gridHeight: 32, beamRadius: 2.1 },
  compact: { gridWidth: 26, gridHeight: 28, beamRadius: 1.1 },
  plain: { gridWidth: 20, gridHeight: 20, beamRadius: 3.1 },
}

const BRAILLE_BASE_CODE = 0x2800
// Dot-row bit values inside one braille cell (row 0..3, top to bottom).
const BRAILLE_LEFT_BITS = [0x01, 0x02, 0x04, 0x40] as const
const BRAILLE_RIGHT_BITS = [0x08, 0x10, 0x20, 0x80] as const

/**
 * Beam center x for one dot row: (W-2) at the vertical center (apex),
 * tapering linearly to 0 at the top/bottom edges (the chevron tails).
 */
export function chevronBeamX(spec: ChevronSpec, y: number): number {
  const centerY = (spec.gridHeight - 1) / 2
  return (spec.gridWidth - 2) * (1 - Math.abs(y - centerY) / centerY)
}

/** Whether the dot at (x, y) lies inside the beam. Out-of-grid is unlit. */
export function isChevronDotLit(
  spec: ChevronSpec,
  x: number,
  y: number,
): boolean {
  if (x < 0 || x >= spec.gridWidth || y < 0 || y >= spec.gridHeight) {
    return false
  }
  return Math.abs(x - chevronBeamX(spec, y)) <= spec.beamRadius
}

function normalizeMark(lines: readonly string[]): OccMarkArt {
  const width = Math.max(...lines.map(stringWidth))
  return lines.map(line => line + ' '.repeat(width - stringWidth(line)))
}

/**
 * Generate one chevron tier as braille art rows. Empty braille cells are
 * emitted as spaces so lines trim cleanly and survive any font; rows are
 * padded to a uniform width.
 */
export function generateSignalChevron(spec: ChevronSpec): OccMarkArt {
  const columns = Math.ceil(spec.gridWidth / 2)
  const rows = Math.ceil(spec.gridHeight / 4)
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    let line = ''
    for (let column = 0; column < columns; column++) {
      let bits = 0
      for (let dotRow = 0; dotRow < 4; dotRow++) {
        const y = row * 4 + dotRow
        if (isChevronDotLit(spec, column * 2, y)) {
          bits |= BRAILLE_LEFT_BITS[dotRow]!
        }
        if (isChevronDotLit(spec, column * 2 + 1, y)) {
          bits |= BRAILLE_RIGHT_BITS[dotRow]!
        }
      }
      line += bits === 0 ? ' ' : String.fromCodePoint(BRAILLE_BASE_CODE + bits)
    }
    lines.push(line.trimEnd())
  }
  return normalizeMark(lines)
}

/**
 * The Signal Chevron at three resolutions — one formula, three grids.
 * Generated at module load; pure math, so the art is deterministic and
 * can be regenerated (and verified) from CHEVRON_SPECS at any time.
 */
export const OCC_MARKS = {
  wide: generateSignalChevron(CHEVRON_SPECS.wide),
  compact: generateSignalChevron(CHEVRON_SPECS.compact),
  plain: generateSignalChevron(CHEVRON_SPECS.plain),
} satisfies Record<OccMarkMode, OccMarkArt>

export function getOccMark(mode: OccMarkMode): OccMarkArt {
  return OCC_MARKS[mode]
}

export function getOccMarkWidth(art: OccMarkArt): number {
  return Math.max(...art.map(stringWidth))
}

/**
 * Monochrome tone pair per theme family. Dark terminals rest at #5a5a5a
 * and shimmer toward near-white #e1e1e1; light terminals use darker grey
 * variants so BOTH tones keep >= 3:1 contrast against the reference
 * background (WCAG non-text graphics threshold).
 */
export type ChevronTone = {
  /** Resting dot-matrix color. */
  readonly base: Rgb
  /** Shimmer highlight peak color. */
  readonly peak: Rgb
}

export const CHEVRON_TONES: Record<'dark' | 'light', ChevronTone> = {
  dark: {
    base: [90, 90, 90], // #5a5a5a — resting matrix
    peak: [225, 225, 225], // #e1e1e1 — shimmer peak (near-white)
  },
  light: {
    base: [64, 64, 64], // #404040 — >= 3:1 against white
    peak: [117, 117, 117], // #757575 — >= 3:1 against white
  },
}

export function chevronThemeFamily(themeName: string): 'dark' | 'light' {
  return themeName.startsWith('light') ? 'light' : 'dark'
}

export function rgbColor(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

export type MarkColorMode = 'color' | 'silhouette'

/**
 * Color capability gate for the mark. chalk.level: 0 = NO_COLOR /
 * TERM=dumb / non-TTY, 1 = basic 16 colors, 2 = 256 colors, 3 =
 * truecolor. Below 256-color support the grey tones cannot be honored
 * (rgb() would quantize to unpredictable basic colors), so the mark falls
 * back to an uncolored silhouette in the terminal's own foreground — the
 * shape always survives, never as garbled color noise.
 */
export function getMarkColorMode(): MarkColorMode {
  return chalk.level >= 2 ? 'color' : 'silhouette'
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

type OccMarkProps = {
  mode?: OccMarkMode
  /**
   * Force animation on/off. When omitted, animation follows the
   * `prefersReducedMotion` setting (on by default, one-shot only).
   * Animation is always skipped in silhouette color mode — the sweep only
   * modulates color.
   */
  animate?: boolean
}

/**
 * Render one art row as colored cells. Consecutive spaces are emitted as a
 * single uncolored run; in color mode every braille cell carries the base
 * tone, or the shimmer peak while the sweep band crosses it.
 */
function MarkRow({
  art,
  row,
  colorMode,
  tone,
  progress,
}: {
  art: OccMarkArt
  row: number
  colorMode: MarkColorMode
  tone: ChevronTone
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
    if (colorMode === 'silhouette') {
      nodes.push(
        <Text key={`${row}-${column}`} bold>
          {char}
        </Text>,
      )
      continue
    }
    const shimmering = isShimmerCell(art, row, column, progress)
    nodes.push(
      <Text
        key={`${row}-${column}`}
        color={rgbColor(shimmering ? tone.peak : tone.base)}
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
  const tone = CHEVRON_TONES[chevronThemeFamily(themeName)]
  const colorMode = getMarkColorMode()

  const animate =
    colorMode === 'color' &&
    (props.animate ?? !(getInitialSettings().prefersReducedMotion ?? false))

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
          colorMode={colorMode}
          tone={tone}
          progress={progress}
        />
      ))}
    </Box>
  )
}
