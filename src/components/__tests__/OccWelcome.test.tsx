import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../../ink/stringWidth.js'
import { renderToString } from '../../utils/staticRender.js'
import { getTheme } from '../../utils/theme.js'
import {
  formatWelcomeLocation,
  getOccLogo,
  getOccLogoWidth,
  getOccWelcomeMode,
  getShimmerRuns,
  OCC_LOGOS,
  OccWelcome,
  welcomeTip,
} from '../LogoV2/OccWelcome.js'

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

describe('OCC REPL welcome layout', () => {
  test('selects wide, compact, and plain tiers at stable boundaries', () => {
    expect(getOccWelcomeMode(120)).toBe('wide')
    expect(getOccWelcomeMode(76)).toBe('wide')
    expect(getOccWelcomeMode(75)).toBe('compact')
    expect(getOccWelcomeMode(44)).toBe('compact')
    expect(getOccWelcomeMode(43)).toBe('plain')
    expect(getOccWelcomeMode(120, true)).toBe('plain')
  })

  test('provides aligned, distinct logo art for all three tiers', () => {
    expect(getOccLogo('wide')).toBe(OCC_LOGOS.wide)
    expect(getOccLogo('compact')).toBe(OCC_LOGOS.compact)
    expect(getOccLogo('plain')).toBe(OCC_LOGOS.plain)
    expect(OCC_LOGOS.wide.length).toBeGreaterThan(OCC_LOGOS.compact.length)
    expect(OCC_LOGOS.compact.length).toBeGreaterThan(OCC_LOGOS.plain.length)

    for (const art of Object.values(OCC_LOGOS)) {
      const width = getOccLogoWidth(art)
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

  test('shimmer preserves the logo art and settles without highlights', () => {
    const line = OCC_LOGOS.wide[3]!
    const active = getShimmerRuns(line, 3, 0.5, OCC_LOGOS.wide)
    expect(active.map(run => run.text).join('')).toBe(line)
    expect(active.some(run => run.highlighted)).toBe(true)

    const settled = getShimmerRuns(line, 3, null, OCC_LOGOS.wide)
    expect(settled.map(run => run.text).join('')).toBe(line)
    expect(settled.every(run => !run.highlighted)).toBe(true)
  })

  test('settled mark retains graphical contrast in light and dark themes', () => {
    expect(
      contrastRatio(getTheme('light').claude, 'rgb(255,255,255)'),
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrastRatio(getTheme('dark').claude, 'rgb(0,0,0)'),
    ).toBeGreaterThanOrEqual(3)
  })

  test('keeps the per-session hint stable across layout tiers', () => {
    const tip = 'Press / for commands, ? for shortcuts'
    expect(welcomeTip('wide', tip)).toBe(tip)
    expect(welcomeTip('compact', tip)).toBe(tip)
    expect(welcomeTip('plain', tip)).toBe(tip)
  })

  test('wide mode renders branded hierarchy, context, and full hints', async () => {
    const output = await renderToString(
      <OccWelcome columns={100} {...BASE_PROPS} />,
      100,
    )

    expect(output).toContain('OCC')
    expect(output).toContain('v2.1.281')
    expect(output).toContain('Open C Code')
    expect(output).toContain(OCC_LOGOS.wide[1]!.trim())
    expect(output).not.toContain('___   ___   ___')
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
    expect(output).toContain('Open C Code')
    expect(output).toContain(OCC_LOGOS.compact[1]!.trim())
    expect(output).not.toContain(OCC_LOGOS.wide[1]!.trim())
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('narrow mode uses the small mark without a decorative border', async () => {
    const output = await renderToString(
      <OccWelcome columns={36} {...BASE_PROPS} />,
      36,
    )

    expect(output).toContain(OCC_LOGOS.plain[1]!.trim())
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
    expect(output).not.toContain(OCC_LOGOS.plain[1]!.trim())
    expect(output).not.toContain('___   ___   ___')
    expect(output).not.toContain('╭')
  })
})
