import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { stringWidth } from '../../ink/stringWidth.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { getTheme } from '../../utils/theme.js'
import {
  formatWelcomeLocation,
  getOccWelcomeMode,
  OccWelcome,
  welcomeTip,
} from '../LogoV2/OccWelcome.js'
import {
  CHEVRON_SPECS,
  CHEVRON_TONES,
  chevronBeamX,
  chevronThemeFamily,
  generateSignalChevron,
  getMarkColorMode,
  getOccMark,
  getOccMarkWidth,
  isChevronDotLit,
  isShimmerCell,
  OCC_MARKS,
  type OccMarkArt,
  type Rgb,
} from '../LogoV2/OccMark.js'
import { OccMark } from '../LogoV2/OccMark.js'

const BASE_PROPS = {
  version: '2.1.281',
  model: 'Claude Sonnet 4.5',
  billing: 'API Usage Billing',
  cwd: '/work/occ',
  branch: 'feature/welcome',
  reducedMotion: true,
}

const BRAILLE_BASE_CODE = 0x2800
const BRAILLE_LEFT_BITS = [0x01, 0x02, 0x04, 0x40] as const
const BRAILLE_RIGHT_BITS = [0x08, 0x10, 0x20, 0x80] as const

function isBrailleChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code >= BRAILLE_BASE_CODE && code <= BRAILLE_BASE_CODE + 0xff
}

/** Reflect one braille cell's dot rows (row r swaps with row 3-r). */
function mirrorBraille(char: string): string {
  if (char === ' ') return ' '
  const bits = (char.codePointAt(0) ?? BRAILLE_BASE_CODE) - BRAILLE_BASE_CODE
  let mirrored = 0
  for (let row = 0; row < 4; row++) {
    if (bits & BRAILLE_LEFT_BITS[row]!) mirrored |= BRAILLE_LEFT_BITS[3 - row]!
    if (bits & BRAILLE_RIGHT_BITS[row]!) {
      mirrored |= BRAILLE_RIGHT_BITS[3 - row]!
    }
  }
  return String.fromCodePoint(BRAILLE_BASE_CODE + mirrored)
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

function rgbString(rgb: Rgb): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
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

  test('provides aligned, braille-only mark art for all three tiers', () => {
    expect(getOccMark('wide')).toBe(OCC_MARKS.wide)
    expect(getOccMark('compact')).toBe(OCC_MARKS.compact)
    expect(getOccMark('plain')).toBe(OCC_MARKS.plain)

    // Tier sizes: wide 8 rows, compact ~7, plain ~5 (issue OCC-60).
    expect(OCC_MARKS.wide.length).toBe(8)
    expect(OCC_MARKS.compact.length).toBe(7)
    expect(OCC_MARKS.plain.length).toBe(5)
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
      for (const line of art) {
        for (const char of line) {
          if (char !== ' ') expect(isBrailleChar(char)).toBe(true)
        }
      }
      expect(art.join('\n')).not.toContain('OCC')
      expect(art.join('\n')).not.toContain('___   ___   ___')
    }
  })

  test('tier signature rows are unique across tiers', () => {
    // The e2e suite asserts pane glyphs per tier width; a signature shared
    // across tiers would make those assertions vacuous.
    const signatures = {
      wide: OCC_MARKS.wide[0]!.trim(),
      compact: OCC_MARKS.compact[0]!.trim(),
      plain: OCC_MARKS.plain[0]!.trim(),
    }
    expect(signatures.wide).not.toBe(signatures.compact)
    expect(OCC_MARKS.compact.join('\n')).not.toContain(signatures.wide)
    expect(OCC_MARKS.plain.join('\n')).not.toContain(signatures.wide)
    expect(OCC_MARKS.wide.join('\n')).not.toContain(signatures.compact)
    expect(OCC_MARKS.plain.join('\n')).not.toContain(signatures.compact)
    expect(OCC_MARKS.wide.join('\n')).not.toContain(signatures.plain)
    expect(OCC_MARKS.compact.join('\n')).not.toContain(signatures.plain)
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

describe('OCC Signal Chevron generator', () => {
  test('beam center follows the OCC-60 formula', () => {
    const spec = CHEVRON_SPECS.wide
    const centerY = (spec.gridHeight - 1) / 2
    expect(centerY).toBe(15.5)
    // Tails touch x=0, apex reaches W-2.
    expect(chevronBeamX(spec, 0)).toBe(0)
    expect(chevronBeamX(spec, spec.gridHeight - 1)).toBe(0)
    expect(chevronBeamX(spec, 15)).toBeCloseTo(27.097, 2)
    expect(chevronBeamX(spec, 16)).toBeCloseTo(27.097, 2)
    // Symmetric around the center row.
    for (let y = 0; y < 16; y++) {
      expect(chevronBeamX(spec, y)).toBe(
        chevronBeamX(spec, spec.gridHeight - 1 - y),
      )
    }
  })

  test('dot gating respects the beam radius and the grid bounds', () => {
    const spec = CHEVRON_SPECS.wide
    // Beam center is always lit.
    for (let y = 0; y < spec.gridHeight; y++) {
      const centerX = Math.round(chevronBeamX(spec, y))
      expect(isChevronDotLit(spec, centerX, y)).toBe(true)
    }
    // Far off-beam dots are not lit.
    expect(isChevronDotLit(spec, 29, 0)).toBe(false)
    expect(isChevronDotLit(spec, 0, 15)).toBe(false)
    // Out-of-grid coordinates are never lit.
    expect(isChevronDotLit(spec, -1, 0)).toBe(false)
    expect(isChevronDotLit(spec, spec.gridWidth, 0)).toBe(false)
    expect(isChevronDotLit(spec, 0, -1)).toBe(false)
    expect(isChevronDotLit(spec, 0, spec.gridHeight)).toBe(false)
  })

  test('generation is deterministic from the spec', () => {
    for (const mode of ['wide', 'compact', 'plain'] as const) {
      expect(generateSignalChevron(CHEVRON_SPECS[mode])).toEqual(
        OCC_MARKS[mode],
      )
    }
  })

  test('every tier is vertically mirror-symmetric (beam path closed)', () => {
    for (const art of Object.values(OCC_MARKS)) {
      const rows = art.length
      for (let row = 0; row < Math.floor(rows / 2); row++) {
        const top = art[row]!
        const bottom = art[rows - 1 - row]!
        const mirroredTop = [...top].map(mirrorBraille).join('')
        expect(mirroredTop).toBe(bottom)
      }
    }
  })

  test('the apex points right at the middle rows', () => {
    const art = OCC_MARKS.wide
    const width = getOccMarkWidth(art)
    // The top/bottom rows start at column 0 (the tails)…
    expect(art[0]!.charAt(0)).not.toBe(' ')
    expect(art[art.length - 1]!.charAt(0)).not.toBe(' ')
    // …and one of the two middle rows occupies the rightmost column.
    const middleOccupied =
      art[3]!.charAt(width - 1) !== ' ' || art[4]!.charAt(width - 1) !== ' '
    expect(middleOccupied).toBe(true)
  })

  test('plain tier packs a denser silhouette than the wide tier', () => {
    const density = (art: OccMarkArt): number => {
      let filled = 0
      let total = 0
      for (const line of art) {
        for (const char of line) {
          if (char === ' ') continue
          total++
          const bits = (char.codePointAt(0) ?? 0) - BRAILLE_BASE_CODE
          for (let bit = 0; bit < 8; bit++) {
            if (bits & (1 << bit)) filled++
          }
        }
      }
      // Each occupied cell carries 8 dots of capacity.
      return filled / (total * 8)
    }
    expect(density(OCC_MARKS.plain)).toBeGreaterThan(density(OCC_MARKS.wide))
  })
})

describe('OCC Signal Chevron monochrome engine', () => {
  test('resolves the tone family from the theme name', () => {
    expect(chevronThemeFamily('dark')).toBe('dark')
    expect(chevronThemeFamily('dark-ansi')).toBe('dark')
    expect(chevronThemeFamily('dark-daltonized')).toBe('dark')
    expect(chevronThemeFamily('light')).toBe('light')
    expect(chevronThemeFamily('light-ansi')).toBe('light')
    expect(chevronThemeFamily('light-daltonized')).toBe('light')
  })

  test('every tone keeps 3:1 graphical contrast in its theme', () => {
    for (const tone of [CHEVRON_TONES.dark.base, CHEVRON_TONES.dark.peak]) {
      expect(
        contrastRatio(rgbString(tone), 'rgb(0,0,0)'),
      ).toBeGreaterThanOrEqual(3)
    }
    for (const tone of [CHEVRON_TONES.light.base, CHEVRON_TONES.light.peak]) {
      expect(
        contrastRatio(rgbString(tone), 'rgb(255,255,255)'),
      ).toBeGreaterThanOrEqual(3)
    }
  })

  test('shimmer peak lifts strictly brighter than the resting base', () => {
    for (const family of ['dark', 'light'] as const) {
      const tone = CHEVRON_TONES[family]
      expect(tone.peak[0]).toBeGreaterThan(tone.base[0])
      expect(tone.peak[1]).toBeGreaterThan(tone.base[1])
      expect(tone.peak[2]).toBeGreaterThan(tone.base[2])
      for (const channel of [...tone.base, ...tone.peak]) {
        expect(channel).toBeGreaterThanOrEqual(0)
        expect(channel).toBeLessThanOrEqual(255)
      }
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

  test('color mode follows the terminal color level', () => {
    const savedLevel = chalk.level
    try {
      chalk.level = 3
      expect(getMarkColorMode()).toBe('color')
      chalk.level = 2
      expect(getMarkColorMode()).toBe('color')
      chalk.level = 1
      expect(getMarkColorMode()).toBe('silhouette')
      chalk.level = 0
      expect(getMarkColorMode()).toBe('silhouette')
    } finally {
      chalk.level = savedLevel
    }
  })

  test('silhouette mode renders braille without color escapes', async () => {
    const savedLevel = chalk.level
    try {
      chalk.level = 0
      const ansi = await renderToAnsiString(
        <OccMark mode="wide" animate={false} />,
        80,
      )
      expect(ansi).toContain(OCC_MARKS.wide[0]!.trim())
      expect(ansi).not.toContain('\x1b[38')
    } finally {
      chalk.level = savedLevel
    }
  })

  test('color mode emits the base tone on occupied cells', async () => {
    const savedLevel = chalk.level
    try {
      chalk.level = 3
      const ansi = await renderToAnsiString(
        <OccMark mode="wide" animate={false} />,
        80,
      )
      const [r, g, b] = CHEVRON_TONES.dark.base
      expect(ansi).toContain(`38;2;${r};${g};${b}`)
    } finally {
      chalk.level = savedLevel
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
    // Signal Chevron art survives the render (ANSI stripped). Row 0 is the
    // tier signature (unique braille run per tier).
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
