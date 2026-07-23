import * as React from 'react'
import { describe, expect, test } from 'bun:test'
import { stringWidth } from '../../ink/stringWidth.js'
import { renderToString } from '../../utils/staticRender.js'
import {
  formatWelcomeLocation,
  getOccWelcomeMode,
  getShimmerRuns,
  OCC_WORDMARK,
  OccWelcome,
  welcomeTip,
} from '../LogoV2/OccWelcome.js'

const BASE_PROPS = {
  version: '2.1.276',
  model: 'Claude Sonnet 4.5',
  billing: 'API Usage Billing',
  cwd: '/work/occ',
  branch: 'feature/welcome',
  reducedMotion: true,
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

  test('keeps git and CJK cwd context within the requested width', () => {
    const location = formatWelcomeLocation(
      'feature/欢迎页视觉优化',
      '/工作区/非常长的项目目录/occ',
      30,
    )
    expect(location).toContain('git:')
    expect(stringWidth(location)).toBeLessThanOrEqual(30)
  })

  test('shimmer preserves the ASCII art and settles without highlights', () => {
    const active = getShimmerRuns(OCC_WORDMARK[1], 1, 0.5)
    expect(active.map(run => run.text).join('')).toBe(OCC_WORDMARK[1])
    expect(active.some(run => run.highlighted)).toBe(true)

    const settled = getShimmerRuns(OCC_WORDMARK[1], 1, null)
    expect(settled.map(run => run.text).join('')).toBe(OCC_WORDMARK[1])
    expect(settled.every(run => !run.highlighted)).toBe(true)
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
    expect(output).toContain('v2.1.276')
    expect(output).toContain('Open C Code')
    expect(output).toContain(OCC_WORDMARK[0].trim())
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
    for (const line of output.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(columns)
    }
  })

  test('plain mode removes decorative art and keeps essential information', async () => {
    const output = await renderToString(
      <OccWelcome columns={36} {...BASE_PROPS} plain />,
      36,
    )

    expect(output).toContain('OCC v2.1.276 · Open C Code')
    expect(output).toContain('Claude Sonnet 4.5')
    expect(output).toContain('git:feature/welcome')
    expect(output).toContain(welcomeTip('plain'))
    expect(output).not.toContain(OCC_WORDMARK[0].trim())
    expect(output).not.toContain('╭')
  })
})
