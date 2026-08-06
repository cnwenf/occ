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
  getOccMark,
  getOccMarkWidth,
  GRADIENT_STOPS,
  gradientThemeFamily,
  highlightColor,
  isShimmerCell,
  markCellT,
  OCC_MARKS,
  sampleGradient,
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

describe('OCC REPL welcome layout', () => {
  test('selects wide, compact, and plain tiers at stable boundaries', () => {
    expect(getOccWelcomeMode(120)).toBe('wide')
    expect(getOccWelcomeMode(76)).toBe('wide')
    expect(getOccWelcomeMode(75)).toBe('compact')
    expect(getOccWelcomeMode(44)).toBe('compact')
    expect(getOccWelcomeMode(43)).toBe('plain')
    expect(getOccWelcomeMode(120, true)).toBe('plain')
  })

  test('provides aligned, distinct mark art for all three tiers', () => {
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
      expect(art.every(line => !line.trim().includes(' '))).toBe(true)
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

describe('OCC Ascendant gradient engine', () => {
  test('resolves the gradient family from the theme name', () => {
    expect(gradientThemeFamily('dark')).toBe('dark')
    expect(gradientThemeFamily('dark-ansi')).toBe('dark')
    expect(gradientThemeFamily('dark-daltonized')).toBe('dark')
    expect(gradientThemeFamily('light')).toBe('light')
    expect(gradientThemeFamily('light-ansi')).toBe('light')
    expect(gradientThemeFamily('light-daltonized')).toBe('light')
  })

  test('sampleGradient hits the stops and stays inside the gamut', () => {
    const stops = GRADIENT_STOPS.dark
    expect(sampleGradient(stops, 0)).toEqual(stops[0])
    expect(sampleGradient(stops, 1)).toEqual(stops[stops.length - 1])
    expect(sampleGradient(stops, 0.5)).toEqual(stops[1])
    // Out-of-range inputs clamp instead of extrapolating.
    expect(sampleGradient(stops, -2)).toEqual(stops[0])
    expect(sampleGradient(stops, 5)).toEqual(stops[stops.length - 1])
    for (const t of [0.13, 0.37, 0.62, 0.88]) {
      const [r, g, b] = sampleGradient(stops, t)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(255)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(255)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(255)
    }
  })

  test('markCellT flows diagonally across the mark', () => {
    const art = OCC_MARKS.wide
    const topLeft = markCellT(art, 0, 0)
    const bottomRight = markCellT(art, art.length - 1, getOccMarkWidth(art) - 1)
    expect(topLeft).toBeCloseTo(0)
    expect(bottomRight).toBeCloseTo(1)
    for (let row = 0; row < art.length; row++) {
      for (let column = 0; column < getOccMarkWidth(art); column++) {
        const t = markCellT(art, row, column)
        expect(t).toBeGreaterThanOrEqual(0)
        expect(t).toBeLessThanOrEqual(1)
      }
    }
  })

  test('every gradient stop keeps 3:1 graphical contrast in its theme', () => {
    for (const stop of GRADIENT_STOPS.dark) {
      expect(
        contrastRatio(rgbString(stop), 'rgb(0,0,0)'),
      ).toBeGreaterThanOrEqual(3)
    }
    for (const stop of GRADIENT_STOPS.light) {
      expect(
        contrastRatio(rgbString(stop), 'rgb(255,255,255)'),
      ).toBeGreaterThanOrEqual(3)
    }
  })

  test('highlight lifts the base color without leaving the gamut', () => {
    const base: readonly [number, number, number] = [255, 116, 64]
    const lifted = highlightColor(base)
    expect(lifted[0]).toBeGreaterThanOrEqual(base[0])
    expect(lifted[1]).toBeGreaterThan(base[1])
    expect(lifted[2]).toBeGreaterThan(base[2])
    expect(lifted.every(channel => channel <= 255)).toBe(true)
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
    // Gradient mark art survives the render (ANSI stripped). Row 2 is the
    // tier signature (unique consecutive-block run per tier).
    expect(output).toContain(OCC_MARKS.wide[2]!.trim())
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
    expect(output).toContain(OCC_MARKS.compact[2]!.trim())
    expect(output).not.toContain(OCC_MARKS.wide[2]!.trim())
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('narrow mode uses the small mark without a decorative border', async () => {
    const output = await renderToString(
      <OccWelcome columns={36} {...BASE_PROPS} />,
      36,
    )

    expect(output).toContain(OCC_MARKS.plain[2]!.trim())
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
    expect(output).not.toContain(OCC_MARKS.plain[2]!.trim())
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
