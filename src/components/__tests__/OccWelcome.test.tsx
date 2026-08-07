import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../../ink/stringWidth.js'
import { renderToString } from '../../utils/staticRender.js'
import { getTheme } from '../../utils/theme.js'
import {
  formatWelcomeLocation,
  getOccWelcomeMode,
  OccWelcome,
  welcomeTip,
} from '../LogoV2/OccWelcome.js'
import {
  DUMB_FALLBACK,
  generateSignalChevron,
  getOccMark,
  getOccMarkWidth,
  isDumbTerminal,
  isShimmerCell,
  MARK_COLORS,
  markThemeFamily,
  OCC_MARKS,
  SIGNAL_CHEVRON_SPECS,
} from '../LogoV2/OccMark.js'

const BASE_PROPS = {
  version: '2.1.281',
  model: 'Claude Sonnet 4.5',
  billing: 'API Usage Billing',
  cwd: '/work/occ',
  branch: 'feature/welcome',
  reducedMotion: true,
}

function relativeLuminance(rgb: string): number {
  const channels = rgb.match(/\d+/g)?.map(Number)
  if (!channels || channels.length !== 3) return 0
  const [red, green, blue] = channels.map(channel => {
    const normalized = channel! / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  )
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  )
  return (lighter + 0.05) / (darker + 0.05)
}

function rgbString(rgb: readonly number[]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
}

// Braille cells occupy U+2800..U+28FF. A mark row is "braille art" when its
// trimmed content is entirely braille cells (no ASCII block letters).
function isBrailleRun(line: string): boolean {
  const run = line.trim()
  return run.length > 0 && [...run].every(ch => {
    const code = ch.codePointAt(0) ?? 0
    return code >= 0x2800 && code <= 0x28ff
  })
}

// The beam formula is symmetric about its apex in DOT space, but a braille
// cell is not a vertically symmetric glyph — mirroring a row means flipping
// each cell's dot rows (0<->3, 1<->2). This maps one cell to its vertical
// mirror so the mark's symmetry can be asserted on the rendered art.
const BRAILLE_MIRROR_BITS: Array<readonly [number, number]> = [
  [0x01, 0x40], // left column, dot row 0 <-> 3
  [0x02, 0x04], // left column, dot row 1 <-> 2
  [0x08, 0x80], // right column, dot row 0 <-> 3
  [0x10, 0x20], // right column, dot row 1 <-> 2
]
function mirrorBrailleLine(line: string): string {
  return [...line.trim()]
    .map(ch => {
      const offset = (ch.codePointAt(0) ?? 0) - 0x2800
      let mirrored = 0
      for (const [a, b] of BRAILLE_MIRROR_BITS) {
        if (offset & a) mirrored |= b
        if (offset & b) mirrored |= a
      }
      return String.fromCharCode(0x2800 + mirrored)
    })
    .join('')
}

describe('OCC REPL welcome layout', () => {
  test('selects wide, compact, and plain tiers at stable boundaries', () => {
    expect(getOccWelcomeMode(120)).toBe('wide')
    expect(getOccWelcomeMode(76)).toBe('wide')
    expect(getOccWelcomeMode(75)).toBe('compact')
    expect(getOccWelcomeMode(44)).toBe('compact')
    expect(getOccWelcomeMode(43)).toBe('plain')
    expect(getOccWelcomeMode(120, true)).toBe('plain')
  })

  test('provides aligned, distinct braille mark art for all three tiers', () => {
    expect(getOccMark('wide')).toBe(OCC_MARKS.wide)
    expect(getOccMark('compact')).toBe(OCC_MARKS.compact)
    expect(getOccMark('plain')).toBe(OCC_MARKS.plain)
    expect(OCC_MARKS.wide.length).toBeGreaterThanOrEqual(
      OCC_MARKS.compact.length,
    )
    expect(getOccMarkWidth(OCC_MARKS.wide)).toBeGreaterThan(
      getOccMarkWidth(OCC_MARKS.compact),
    )
    expect(getOccMarkWidth(OCC_MARKS.compact)).toBeGreaterThan(
      getOccMarkWidth(OCC_MARKS.plain),
    )

    for (const art of Object.values(OCC_MARKS)) {
      const width = getOccMarkWidth(art)
      expect(art.every(line => stringWidth(line) === width)).toBe(true)
      expect(art.every(line => line.trim().length > 0)).toBe(true)
      // One contiguous braille run per row (the beam never breaks).
      expect(art.every(line => !line.trim().includes(' '))).toBe(true)
      expect(art.every(line => isBrailleRun(line))).toBe(true)
      expect(art.join('\n')).not.toContain('OCC')
      expect(art.join('\n')).not.toContain('___   ___   ___')
    }
  })

  test('keeps git and CJK cwd context within the requested width', () => {
    const location = formatWelcomeLocation(
      'feature/欢迎页视觉优化',
      '/工作区/非常长的项目目录/occ',
      30,
    )
    expect(location).toContain('git:')
    expect(stringWidth(location)).toBeLessThanOrEqual(30)
  })

  test('keeps the per-session hint stable across layout tiers', () => {
    const tip = 'Press / for commands, ? for shortcuts'
    expect(welcomeTip('wide', tip)).toBe(tip)
    expect(welcomeTip('compact', tip)).toBe(tip)
    expect(welcomeTip('plain', tip)).toBe(tip)
  })
})

describe('OCC Signal Chevron glyph generator', () => {
  test('is deterministic for a given spec', () => {
    for (const mode of ['wide', 'compact', 'plain'] as const) {
      const regenerated = generateSignalChevron(SIGNAL_CHEVRON_SPECS[mode])
      expect(regenerated.join('\n')).toBe(OCC_MARKS[mode].join('\n'))
    }
  })

  test('draws a right-pointing chevron (top row starts flush left)', () => {
    // The beam apex points right: row 0 begins at column 0 and the widest
    // rows sit mid-mark, so the silhouette reads as a prompt chevron.
    const wide = OCC_MARKS.wide
    expect(wide[0]!.startsWith(' ')).toBe(false)
    // Every tier is vertically symmetric about its beam apex. Braille cells
    // are not self-symmetric glyphs, so mirror each cell's dot rows before
    // comparing the top half against the bottom half.
    for (const art of Object.values(OCC_MARKS)) {
      const height = art.length
      for (let row = 0; row < Math.floor(height / 2); row++) {
        expect(mirrorBrailleLine(art[row]!)).toBe(art[height - 1 - row]!.trim())
      }
    }
  })

  test('wide tier matches the user-confirmed top stroke', () => {
    // Row 0 of the parametric mark matches the user-confirmed wide glyph.
    expect(OCC_MARKS.wide[0]!.trim()).toBe('⠛⠷⣤⣀')
  })

  test('downsamples the same shape across tiers', () => {
    expect(OCC_MARKS.wide.length).toBe(8)
    expect(OCC_MARKS.compact.length).toBeLessThanOrEqual(8)
    expect(OCC_MARKS.compact.length).toBeGreaterThanOrEqual(6)
    expect(OCC_MARKS.plain.length).toBeLessThanOrEqual(6)
    expect(OCC_MARKS.plain.length).toBeGreaterThanOrEqual(4)
  })
})

describe('OCC Signal Chevron color engine', () => {
  test('resolves the palette family from the theme name', () => {
    expect(markThemeFamily('dark')).toBe('dark')
    expect(markThemeFamily('dark-ansi')).toBe('dark')
    expect(markThemeFamily('dark-daltonized')).toBe('dark')
    expect(markThemeFamily('light')).toBe('light')
    expect(markThemeFamily('light-ansi')).toBe('light')
    expect(markThemeFamily('light-daltonized')).toBe('light')
  })

  test('rest and highlight stay grayscale (no color gradient)', () => {
    for (const palette of Object.values(MARK_COLORS)) {
      for (const [r, g, b] of [palette.rest, palette.highlight]) {
        expect(r).toBe(g)
        expect(g).toBe(b)
      }
      // The shimmer lifts toward near-white.
      expect(palette.highlight[0]).toBeGreaterThan(palette.rest[0])
    }
  })

  test('every palette state keeps 3:1 graphical contrast in its theme', () => {
    for (const state of [MARK_COLORS.dark.rest, MARK_COLORS.dark.highlight]) {
      expect(
        contrastRatio(rgbString(state), 'rgb(0,0,0)'),
      ).toBeGreaterThanOrEqual(3)
    }
    for (const state of [MARK_COLORS.light.rest, MARK_COLORS.light.highlight]) {
      expect(
        contrastRatio(rgbString(state), 'rgb(255,255,255)'),
      ).toBeGreaterThanOrEqual(3)
    }
  })

  test('shimmer band sweeps once and settles without highlights', () => {
    const art = OCC_MARKS.wide
    let highlightedAtMid = 0
    for (let row = 0; row < art.length; row++) {
      for (let column = 0; column < getOccMarkWidth(art); column++) {
        if (isShimmerCell(art, row, column, 0.5)) highlightedAtMid++
      }
    }
    expect(highlightedAtMid).toBeGreaterThan(0)

    for (let row = 0; row < art.length; row++) {
      for (let column = 0; column < getOccMarkWidth(art); column++) {
        expect(isShimmerCell(art, row, column, null)).toBe(false)
      }
    }
  })

  test('detects dumb terminals for the ASCII fallback', () => {
    expect(isDumbTerminal({ TERM: 'dumb' })).toBe(true)
    expect(isDumbTerminal({ TERM: 'Dumb' })).toBe(true)
    expect(isDumbTerminal({ TERM: 'xterm-256color' })).toBe(false)
    expect(isDumbTerminal({})).toBe(false)
    // The fallback silhouette is plain ASCII (no braille, no color needed).
    for (const line of DUMB_FALLBACK) {
      expect([...line.trim()].every(ch => ch === '\\' || ch === '/')).toBe(true)
    }
  })
})

describe('OCC REPL welcome card render', () => {
  test('wide mode renders HUD title tab, mark, labeled context, and tip', async () => {
    const output = await renderToString(
      <OccWelcome columns={100} {...BASE_PROPS} />,
      100,
    )

    // Title tab embedded in the border.
    expect(output).toContain('OCC')
    expect(output).toContain('v2.1.281')
    expect(output).toContain('Open C Code')
    // Braille mark art survives the render (ANSI stripped). Row 0 is the
    // tier signature (unique top stroke per tier).
    expect(output).toContain(OCC_MARKS.wide[0]!.trim())
    expect(output).not.toContain('___   ___   ___')
    // Labeled readout rows.
    expect(output).toContain('MODEL')
    expect(output).toContain('PROJ')
    expect(output).toContain('Claude Sonnet 4.5 · API Usage Billing')
    expect(output).toContain('git:feature/welcome')
    expect(output).toContain('/work/occ')
    expect(output).toContain(welcomeTip('wide'))
  })

  test('compact mode fits every rendered row inside the terminal', async () => {
    const columns = 60
    const output = await renderToString(
      <OccWelcome columns={columns} {...BASE_PROPS} />,
      columns,
    )

    expect(output).toContain(welcomeTip('compact'))
    expect(output).toContain(OCC_MARKS.compact[0]!.trim())
    expect(output).not.toContain(OCC_MARKS.wide[0]!.trim())
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('narrow mode uses the small mark without a decorative border', async () => {
    const output = await renderToString(
      <OccWelcome columns={36} {...BASE_PROPS} />,
      36,
    )

    expect(output).toContain(OCC_MARKS.plain[0]!.trim())
    expect(output).toContain('OCC v2.1.281 · Open C Code')
    expect(output).not.toContain('╭')
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(36)
    }
  })

  test('forced plain mode removes art and keeps essential information', async () => {
    const output = await renderToString(
      <OccWelcome columns={36} {...BASE_PROPS} plain />,
      36,
    )

    expect(output).toContain('OCC v2.1.281 · Open C Code')
    expect(output).toContain('Claude Sonnet 4.5')
    expect(output).toContain('git:feature/welcome')
    expect(output).toContain(welcomeTip('plain'))
    expect(output).not.toContain(OCC_MARKS.plain[0]!.trim())
    expect(output).not.toContain('___   ___   ___')
    expect(output).not.toContain('╭')
  })
})

describe('OCC settled mark contrast (theme tokens)', () => {
  test('brand token retains graphical contrast in light and dark themes', () => {
    expect(
      contrastRatio(getTheme('light').claude, 'rgb(255,255,255)'),
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrastRatio(getTheme('dark').claude, 'rgb(0,0,0)'),
    ).toBeGreaterThanOrEqual(3)
  })
})
