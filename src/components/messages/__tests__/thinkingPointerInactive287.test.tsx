/**
 * CC 2.1.287 (#25) — rtt pointer color: v286 "subtle" → v287 "inactive".
 *
 * Official v287 rtt (@~222068923): the non-brief, non-selected pointer
 * renders `color:y?"suggestion":"inactive"` where v286 had `"subtle"`.
 * HighlightedThinkingText's brief-layout branch is unchanged upstream
 * (`_=y?"suggestion":x?"subtle":"text"`) and is NOT touched by the port.
 *
 * Render-seam assertion: with the default (providerless) 'dark' theme, the
 * pointer must carry the theme's `inactive` color rgb(153,153,153) and must
 * NOT carry the old `subtle` color rgb(80,80,80). Both are distinguishable
 * 24-bit SGR sequences with chalk.level forced to 3.
 */
import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import { HighlightedThinkingText } from '../HighlightedThinkingText.js'
import { renderToAnsiStringIsolated } from '../../CustomSelect/__tests__/renderIsolated280.js'

// Dark theme (ThemeProvider DEFAULT_THEME, used providerless):
const DARK_INACTIVE_SGR = '38;2;153;153;153' // theme.inactive
const DARK_SUBTLE_SGR = '38;2;80;80;80' // theme.subtle (the v286 pointer color)

async function renderPointer(): Promise<string> {
  const originalLevel = chalk.level
  try {
    chalk.level = 3 // truecolor — same pattern as tabsNoColorCursor281.test.tsx
    return await renderToAnsiStringIsolated(
      <HighlightedThinkingText text="ultrathink about this" />,
      80,
    )
  } finally {
    chalk.level = originalLevel
  }
}

describe('2.1.287 #25: rtt non-selected pointer color (subtle → inactive)', () => {
  test('pointer renders with the theme "inactive" color', async () => {
    const out = await renderPointer()
    expect(out).toContain(DARK_INACTIVE_SGR)
  })

  test('pointer no longer renders with the old "subtle" color', async () => {
    const out = await renderPointer()
    // Body color is "text" (not dimmed/queued), so the only possible source
    // of the subtle SGR would be a regressed pointer branch.
    expect(out).not.toContain(DARK_SUBTLE_SGR)
  })

  test('the pointer glyph + text still render', async () => {
    const out = await renderPointer()
    expect(out).toContain('ultrathink about this')
  })
})
